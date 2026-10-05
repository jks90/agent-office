#!/usr/bin/env node
// Prueba de humo del Guide Agent (FT-6): servidor temporal con motor demo + un chat REAL con Claude (necesita `claude` con sesión).
// Manda las frases de los flujos A-D del documento y comprueba qué tools llama y los efectos en el estado.
//
//   node scripts/guide-smoke.mjs            # cuatro flujos; sale con código 1 si alguno falla
//   node scripts/guide-smoke.mjs --keep     # no borra los datos temporales (se imprime la ruta)
//
// flow-test se simula con un stub de `GET /access` para pasar el candado de suite. Las confirmaciones del Guide (FT-4)
// se contestan «Sí» sin tocar la UI.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const port = 7600 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guide-smoke-'));
const base = `http://127.0.0.1:${port}`;
const CLIENT = 'smoke';

const stub = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"trial","daysLeft":30}'));
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } stub.close(); if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* el servidor aún escribe: queda en /tmp */ } } else console.log('datos:', dataDir); };
process.on('exit', cleanup);

const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escucha el SSE global: órdenes `ui` (app.openArtifact/navigate…) que el Guide manda a la UI.
const uiCmds = [];
const listenUi = () => (async () => {
  const r = await fetch(base + '/events');
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^event: ui$/m.test(block)) uiCmds.push(JSON.parse(block.match(/^data: (.*)$/m)[1]));
    }
  }
})().catch((e) => console.error("SSE:", e.message));

// Contesta «Sí» a las confirmaciones del Guide (kind:'confirm').
let confirmations = 0;
const answerer = setInterval(async () => {
  try { for (const q of await api('GET', '/api/questions')) if (q.kind === 'confirm') { confirmations++; await api('POST', `/api/questions/${q.id}/answer`, { answer: 'Sí' }); } } catch { /* servidor parado */ }
}, 500);
answerer.unref();

// Un turno del chat: devuelve los eventos del proveedor ya agrupados.
async function say(chatId, text) {
  const r = await fetch(base + '/api/guide/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT }, body: JSON.stringify({ chatId, text }) });
  if (!r.ok) throw new Error(`chat → ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
  const out = { chatId, calls: [], results: new Map(), text: '', error: null };
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i).match(/^data: (.*)$/m)[1]); buf = buf.slice(i + 2);
      if (ev.type === 'chat') out.chatId = ev.chat.id;
      else if (ev.type === 'text') out.text += (out.text ? '\n' : '') + ev.text;
      else if (ev.type === 'tool_call') out.calls.push(ev);
      else if (ev.type === 'tool_result') out.results.set(ev.id, ev);
      else if (ev.type === 'error') out.error = ev.error;
    }
  }
  return out;
}
const names = (t) => t.calls.map((c) => c.name);
const resultOf = (t, name) => { const c = t.calls.find((x) => x.name === name); return c && t.results.get(c.id); };

const checks = [];
const check = (flow, label, ok, extra = '') => { checks.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); };
const show = (t) => console.log(`    tools: ${names(t).join(', ') || '(ninguna)'}\n    «${t.text.replace(/\s+/g, ' ').slice(0, 220)}»${t.error ? '\n    ERROR: ' + t.error : ''}`);

try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  listenUi();
  await api('POST', '/api/settings', { flowTestUrl: `http://127.0.0.1:${stub.address().port}` });
  await api('GET', '/api/suite');
  // Proyecto propio con el equipo por defecto y motor demo (no depende de las carpetas del flow-test real).
  const proj = await api('POST', '/api/projects', { name: 'Smoke Guide', engine: 'demo' });
  const pid = proj.id;
  const projects = [proj];
  // Estado de partida: una tarea de back en marcha con el motor demo (la que el usuario «tiene delante»).
  const base1 = await api('POST', '/api/tasks', { projectId: pid, role: 'back', title: 'Login con email: endpoint POST /api/login' });
  await api('POST', `/api/projects/${pid}/run`, { running: true });
  for (let i = 0; i < 60 && (await api('GET', '/api/state')).tasks.find((t) => t.id === base1.id)?.status !== 'doing'; i++) await sleep(500);
  await api('POST', '/api/context', { view: 'tasks', projectId: pid, openTaskId: base1.id });
  const code = base1.code;
  console.log(`Servidor ${base} · proyecto ${projects[0].name} · tarea abierta ${code}\n`);

  let chat = null;

  console.log('A · «Créame una tarea para solucionar esto»');
  const before = (await api('GET', '/api/state')).tasks.length;
  const a = await say(null, 'Créame una tarea para solucionar esto: el login devuelve 500 cuando el email viene en mayúsculas.');
  chat = a.chatId; show(a);
  const after = (await api('GET', '/api/state')).tasks;
  const created = after.find((t) => t.title && /login|email|mayúscul/i.test(t.title) && t.id !== base1.id);
  check('A', 'llama a task.create', names(a).includes('task.create'));
  check('A', 'hay una tarea nueva en el estado, en el proyecto abierto, con rol', after.length === before + 1 && created?.projectId === pid && !!created?.role, created ? `${created.code} · ${created.role} · «${created.title}»` : '');
  check('A', 'la respuesta cita el código creado', !!created && a.text.includes(created.code));
  check('A', 'se pidió confirmación (política write=confirm)', confirmations > 0);

  console.log('\nB · «¿Cómo va?»');
  const b = await say(chat, '¿Cómo va?');
  show(b);
  const st = (await api('GET', '/api/state')).tasks.find((t) => t.id === base1.id);
  check('B', 'consulta con task.getStatus / agent.getLastActions', names(b).some((n) => ['task.getStatus', 'agent.getLastActions'].includes(n)));
  check('B', 'no vuelve a preguntar qué tarea (la cita)', b.text.includes(code));
  check('B', 'sin errores', !b.error);

  console.log('\nC · «Páralo»');
  const c = await say(chat, 'Páralo.');
  show(c);
  const stopCall = c.calls.find((x) => ['task.stop', 'task.pause', 'agent.message'].includes(x.name));
  const sr = stopCall && c.results.get(stopCall.id);
  check('C', 'llama a task.stop (o pause / agent.message)', !!stopCall, stopCall?.name);
  check('C', 'si FT-5 aún no está (501) lo cuenta tal cual, sin simularlo', !sr || sr.ok || /no disponible|a[uú]n no|todav[ií]a|501|no est[áa] implementad/i.test(c.text), sr && !sr.ok ? sr.result.slice(0, 80) : 'ok');

  console.log('\nD · «Enséñame lo que ha cambiado»');
  const d = await say(chat, 'Enséñame lo que ha cambiado.');
  show(d);
  check('D', 'llama a agent.getModifiedFiles', names(d).includes('agent.getModifiedFiles'));
  check('D', 'llama a app.openArtifact', names(d).includes('app.openArtifact'));
  console.log('    órdenes ui:', JSON.stringify(uiCmds.map((u) => [u.type, u.taskId, u.client])));
  check('D', 'la UI recibe la orden openTask de esa tarea', uiCmds.some((u) => u.type === 'openTask' && u.taskId === base1.id));

  console.log('\nPersistencia');
  const saved = await api('GET', `/api/guide/chats/${chat}`);
  const list = await api('GET', '/api/guide/chats');
  check('P', 'el chat queda guardado con mensajes, tool calls y resultados', saved.messages.filter((m) => m.role === 'user').length === 4 && saved.messages.some((m) => m.role === 'tool' && m.result != null));
  check('P', 'GET /api/guide/chats lo lista', list.some((x) => x.id === chat));
} catch (e) {
  console.error('Error:', e.stack);
  if (serverLog.trim()) console.error(serverLog.trim());
  checks.push(false);
}
const bad = checks.filter((x) => !x).length;
console.log(`\n${bad ? '✗' : '✓'} ${checks.length - bad}/${checks.length} comprobaciones`);
process.exit(bad ? 1 : 0);
