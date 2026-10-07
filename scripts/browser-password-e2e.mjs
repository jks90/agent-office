#!/usr/bin/env node
// FT-137 · e2e: el agente teclea contraseñas que el usuario le da (con 🛡) sin dejarlas en ningún registro.
// Driver FAKE (AO_BROWSER=fake) y Guía `fake` con guion. Comprueba: 🛡 enmascarada, tecleo tras «Sí», «No» no teclea,
// contraseña no dada en el chat → 403 sin 🛡, tarjeta → 403 (requestHuman) y 0 apariciones del valor en todo data/, SSE y logs.
//
//   node scripts/browser-password-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bpass-e2e-'));
const homeDir = path.join(tmp, 'home'); fs.mkdirSync(homeDir, { recursive: true });
let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const PW = 'T0rre-9931-xQ', PW2 = 'Otra-Clave-77!', PW3 = 'Ajena-Clave-55';
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

let proc = null, serverLog = '';
const cleanup = () => { try { proc?.kill('SIGTERM'); } catch { /* parado */ } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  const dir = path.join(tmp, 'data'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace'), browserPolicy: { default: 'ask', domains: { 'example.test': 'allow' } } } }));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dir, AO_GUIDE_FAKE: '1', AO_DESKTOP: 'fake', AO_BROWSER: 'fake', AO_BROWSER_FAKE_TRACE: path.join(tmp, 'typed.jsonl') } });
  proc.stdout.on('data', (d) => { serverLog += d; }); proc.stderr.on('data', (d) => { serverLog += d; });
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ao-client': 'bpass-e2e' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) }; };
  if (!(await until(async () => { try { return (await call('GET', '/api/state')).ok; } catch { return false; } }))) throw new Error(`El servidor no arrancó:\n${serverLog}`);
  await call('POST', '/api/settings', { guideProvider: 'fake' });

  // SSE global (/events) en segundo plano durante toda la prueba: nada de la contraseña debe pasar por ahí
  let sseText = '';
  const ac = new AbortController();
  fetch(`${base}/events`, { signal: ac.signal }).then(async (r) => { for await (const c of r.body) sseText += Buffer.from(c).toString(); }).catch(() => {});

  // Chat con el Guía fake: responde las 🛡 con `answers` y guarda lo que se preguntó
  const asked = [];
  async function chat(text, script, { chatId, answers = [] } = {}) {
    const r = await fetch(`${base}/api/guide/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': 'bpass-e2e' }, body: JSON.stringify({ chatId, text: `${text} ::${JSON.stringify(script)}` }) });
    const events = []; let done = false;
    const q = [...answers];
    const watcher = (async () => {
      while (!done) {
        const p = (await call('GET', '/api/questions')).body.find((x) => x.kind === 'confirm');
        if (p) { asked.push(p); await call('POST', `/api/questions/${p.id}/answer`, { answer: q.shift() ?? 'No' }); }
        await sleep(80);
      }
    })();
    let buf = ''; const dec = new TextDecoder();
    for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = b.split('\n').find((l) => l.startsWith('data: ')); if (d) events.push(JSON.parse(d.slice(6))); } }
    done = true; await watcher;
    return { events, chatId: events.find((e) => e.type === 'chat')?.chat.id, results: events.filter((e) => e.type === 'tool_result') };
  }
  const typed = () => { try { return fs.readFileSync(path.join(tmp, 'typed.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }; // lo que recibió el driver (fuera de data/)
  const nav = (u) => ({ tool: 'browser.navigate', args: { url: u } });
  const snap = { tool: 'browser.snapshot', args: {} };

  section('con 🛡 «Sí»: teclea la contraseña dada en el chat');
  const a = await chat(`Entra en example.test con usuario marta y contraseña ${PW}`, [nav('https://example.test/login'), snap, { tool: 'browser.type', args: { ref: 'e2', text: 'marta' } }, { tool: 'browser.type', args: { ref: 'e5', text: PW } }], { answers: ['Sí'] });
  const q1 = asked[0];
  check('una 🛡 con la pregunta «¿Escribir la contraseña en «example.test» (campo Contraseña)?»', asked.length === 1 && /¿Escribir la contraseña en «example\.test» \(campo Contraseña\)\?/.test(q1?.question || ''), JSON.stringify(asked.map((x) => x.question)));
  check('la 🛡 muestra el valor enmascarado', /••••••/.test(q1?.context || '') && !(q1?.context || '').includes(PW), q1?.context);
  check('el usuario (ref e2) no pidió 🛡 y la contraseña (e5) sí → 2 tool_result ok', a.results.filter((r) => r.ok).length >= 4, JSON.stringify(a.results.map((r) => [r.ok, r.result.slice(0, 80)])));
  check('el driver recibió la contraseña en el campo e5 (se tecleó de verdad)', typed().some((t) => t.ref === 'e5' && t.text === PW));
  const tc = a.events.find((e) => e.type === 'tool_call' && e.args?.ref === 'e5');
  check('el tool_call del SSE llega enmascarado', tc?.args.text === '••••••', JSON.stringify(tc));

  section('con 🛡 «No»: no se teclea y se ofrece requestHuman');
  await call('POST', '/api/guide/tool', { name: 'browser.navigate', args: { url: 'https://example.test/login?otra=1' } });
  const b = await chat(`Prueba con la contraseña ${PW2}`, [nav('https://example.test/login?n=2'), snap, { tool: 'browser.type', args: { ref: 'e5', text: PW2 } }], { answers: ['No'] });
  const rb = b.results.at(-1);
  check('la tool falla (403) y menciona browser.requestHuman', rb && !rb.ok && /requestHuman/.test(rb.result), rb?.result);
  check('no se tecleó (el driver no recibió PW2)', !typed().some((t) => t.text === PW2));

  section('contraseña que el usuario NO dio en este chat → 403 sin 🛡');
  const before = asked.length;
  const c = await chat('Entra en la web', [nav('https://example.test/login?n=3'), snap, { tool: 'browser.type', args: { ref: 'e5', text: PW3 } }], { answers: ['Sí'] });
  const rc = c.results.at(-1);
  check('rechazada sin preguntar al usuario', rc && !rc.ok && /conversación/.test(rc.result) && asked.length === before, JSON.stringify({ rc, n: asked.length - before }));
  const d = await chat('Entra otra vez', [nav('https://example.test/login?n=4'), snap, { tool: 'browser.type', args: { ref: 'e5', text: PW } }], { answers: ['Sí'] });
  check('la contraseña de OTRO chat tampoco vale', !d.results.at(-1).ok && asked.length === before);
  const viaApi = await call('POST', '/api/guide/tool', { name: 'browser.type', args: { ref: 'e5', text: PW } });
  check('sin chat (agente de tarea por API/MCP) → 403', viaApi.status === 403, JSON.stringify(viaApi.body));

  section('tarjeta/pago: sigue siendo requestHuman');
  const e = await chat('Paga con mi tarjeta 4111111111111111', [nav('https://example.test/pago'), snap, { tool: 'browser.type', args: { ref: 'e5', text: '4111111111111111' } }], { answers: ['Sí'] });
  const re = e.results.at(-1);
  check('campo «Número de tarjeta» → 403 con requestHuman y sin 🛡', re && !re.ok && /requestHuman/.test(re.result) && asked.length === before, JSON.stringify(re));

  section('sin eco: 0 apariciones de las contraseñas');
  await sleep(500); ac.abort();
  const files = []; const walk = (p) => { for (const f of fs.readdirSync(p, { withFileTypes: true })) { const x = path.join(p, f.name); f.isDirectory() ? walk(x) : files.push(x); } }; walk(dir);
  const count = (s, v) => s.split(v).length - 1;
  for (const [label, v] of [['PW', PW], ['PW2', PW2], ['PW3', PW3]]) {
    // el fake lleva el guion dentro del mensaje: en los chats donde el usuario NO dio ese valor aparece por construcción, así que solo cuentan los chats A y B
    const hitsFiles = files.filter((f) => !(/guide[\\/]g_/.test(f) && ![a.chatId, b.chatId].some((id) => f.includes(id))) && fs.readFileSync(f, 'utf8').includes(v)).map((f) => path.relative(dir, f));
    check(`${label} no aparece en data/ (audit, chats, estado, preguntas)`, hitsFiles.length === 0, hitsFiles.join(', '));
    check(`${label} no aparece en el SSE global ni en los logs del servidor`, count(sseText, v) === 0 && count(serverLog, v) === 0);
    const leaks = [a, b, c, d].flatMap((x, i) => x.events.filter((ev) => ev.type !== 'chat').filter((ev) => JSON.stringify(ev).includes(v)).map((ev) => `chat ${'ABCD'[i]}: ${JSON.stringify(ev).slice(0, 160)}`));
    check(`${label} no aparece en los eventos del chat`, leaks.length === 0, leaks.join(' | '));
  }
  const audit = fs.readFileSync(path.join(dir, 'guide-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ap = audit.find((x) => x.tool === 'browser.type' && x.args?.ref === 'e5' && x.confirmed);
  check('el audit registra el tecleo confirmado solo con nº de caracteres', ap && ap.args.chars === PW.length && !('text' in ap.args), JSON.stringify(ap));
  const saved = JSON.stringify((await call('GET', `/api/guide/chats/${a.chatId}`)).body);
  check('el chat guardado conserva el tool_call con la contraseña enmascarada', saved.includes('••••••') && !saved.includes(PW));
} catch (e) {
  failed++; console.log(`  ✗ excepción: ${e.stack || e}`);
}
console.log(`\n${failed ? '✗' : '✓'} ${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
