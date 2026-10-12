#!/usr/bin/env node
// FT-189 / FT-193 · e2e de las tareas asignadas a «human». Servidor temporal (puerto libre, AO_DATA_DIR temporal, token propio, motor demo).
// Comprueba: (a) el agente libre no la coge · (b) tras reiniciar el servidor tampoco · (c) PATCH a review y done · (d) sin ReviewPending
// ni pendiente de revisión, y la de agente sí · (e) tarea normal se asigna y termina · (f) asignado inválido 4xx y reasignar a un agente.
//   node scripts/human-task-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-human-'));
const token = 'e2e-human-' + Math.random().toString(36).slice(2);
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server;
const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: dataDir, AO_TOKEN: token }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state', { headers: { authorization: `Bearer ${token}` } })).status < 500) return; } catch { /* aún no */ } await sleep(100); }
  throw new Error('el servidor temporal no arrancó');
};
const halt = async () => { if (!server) return; const s = server; server = null; const done = new Promise((r) => s.once('exit', r)); s.kill('SIGTERM'); await Promise.race([done, sleep(5000)]); };
const cleanup = () => { try { server?.kill('SIGKILL'); } catch { /* parado */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
const raw = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const api = async (...a) => { const r = await raw(...a); if (r.status >= 400) throw new Error(`${a[0]} ${a[1]} → ${r.status} ${r.j.error || ''}`); return r.j; };
const state = () => api('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
const events = async (type, t) => (await api('GET', '/api/events?limit=2000')).filter((e) => e.type === type && (e.taskId === t.id || e.taskCode === t.code || e.data?.taskCode === (t.code || t.id)));
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; };

try {
  await start();
  // Trampa conocida: un estado nuevo no guarda «schema», y el primer reinicio aplica la migración antigua y vacía project.team.
  // Se reinicia una vez con el estado vacío para que el reinicio de (b) pruebe solo lo de FT-189 (hallazgo aparte, ver informe).
  await api('POST', '/api/settings', { reviewNudgeMin: 0 }); await sleep(800); await halt(); await start();
  const proj = await api('POST', '/api/projects', { name: 'Humano FT-193' });
  const agent = await api('POST', '/api/agents', { name: 'Bruno', role: 'back', engine: 'demo', projectId: proj.id });
  await api('PATCH', `/api/projects/${proj.id}/team`, { add: [agent.id] }); // fichado: así sí podría cogerla
  await api('POST', '/api/settings', { reviewNudgeMin: 0 }); // el aviso de revisión salta en el siguiente ciclo
  await api('POST', `/api/projects/${proj.id}/run`, { running: true });

  console.log('(a) agente libre + tarea humana en todo');
  const h = await raw('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'La hago yo', assignedAgentId: 'human' });
  check('crear con assignedAgentId=human → 200', h.status === 200 && h.j.assignedAgentId === 'human', JSON.stringify(h.j));
  const hid = h.j.id;
  await sleep(6000); // varios ciclos del planificador
  let t = await task(hid);
  check('tras varios ciclos sigue en todo, sin agente', t.status === 'todo' && !t.agentId, `${t.status} ${t.agentId}`);
  check('no se marca «sin agente para el rol»', !t.plannedReason, String(t.plannedReason));
  check('el agente sigue libre', (await state()).agents.find((a) => a.id === agent.id).status === 'idle');

  console.log('(b) reinicio del servidor');
  await sleep(1500); await halt(); await start();
  t = await task(hid);
  check('la tarea sigue asignada a human y en todo tras reiniciar', t?.assignedAgentId === 'human' && t.status === 'todo', JSON.stringify(t));
  await sleep(6000);
  t = await task(hid);
  check('tras reiniciar y esperar ciclos, el agente tampoco la coge', t.status === 'todo' && !t.agentId, `${t.status} ${t.agentId}`);

  console.log('(c) el usuario la mueve a mano');
  for (const s of ['review', 'done']) {
    const r = await raw('PATCH', `/api/tasks/${hid}`, { status: s });
    check(`PATCH status=${s} → 200`, r.status === 200 && r.j.status === s, `${r.status} ${JSON.stringify(r.j)}`);
  }

  console.log('(d) avisos de revisión');
  await raw('PATCH', `/api/tasks/${hid}`, { status: 'review' });
  const ag = await api('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'De agente en review', status: 'review' });
  const agTask = await waitFor(async () => { const x = await task(ag.id); return x?.status === 'review' && x.nudged ? x : null; }, 20000);
  check('la tarea de agente en review emite ReviewPending', !!agTask && (await events('ReviewPending', ag)).length > 0);
  await sleep(6000);
  const hv = await task(hid);
  check('la tarea humana en review NO emite ReviewPending', (await events('ReviewPending', hv)).length === 0);
  check('ni se marca como avisada (nudged)', !hv.nudged);
  check('ni emite review-alert/review-now', (await api('GET', '/api/events?limit=2000')).every((e) => !/review-(alert|now)/.test(JSON.stringify(e)) || !JSON.stringify(e).includes(hv.code || hid)));
  const pend = await raw('GET', '/api/guide/pending').catch(() => null);
  if (pend && pend.status === 200) check('pendientes de revisión no incluyen la humana', !JSON.stringify(pend.j).includes(hv.code || hid));
  await api('PATCH', `/api/tasks/${hid}`, { status: 'done' });
  await api('PATCH', `/api/tasks/${ag.id}`, { status: 'done' }).catch(() => {});

  console.log('(e) tarea de agente normal');
  const n = await api('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'Normal' });
  const nt = await waitFor(async () => { const x = await task(n.id); return x && ['review', 'done'].includes(x.status) ? x : null; }, 60000);
  check('se asigna al agente y se completa (review/done)', !!nt && nt.agentId === agent.id, JSON.stringify(await task(n.id)));

  console.log('(f) asignado inválido y reasignación');
  const bad1 = await raw('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'x', assignedAgentId: 'no-existe' });
  check('crear con agente inexistente → 4xx', bad1.status >= 400 && bad1.status < 500, String(bad1.status));
  const h2 = await api('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'Humana 2', assignedAgentId: 'human', status: 'backlog' });
  const bad2 = await raw('PATCH', `/api/tasks/${h2.id}`, { assignedAgentId: 'no-existe' });
  check('editar con agente inexistente → 4xx', bad2.status >= 400 && bad2.status < 500, String(bad2.status));
  check('la tarea sigue siendo humana tras el rechazo', (await task(h2.id)).assignedAgentId === 'human');
  const re = await raw('PATCH', `/api/tasks/${h2.id}`, { assignedAgentId: '__auto', status: 'todo' });
  check('reasignar de human a automático → 200 y sin human', re.status === 200 && !re.j.assignedAgentId, JSON.stringify(re.j));
  const taken = await waitFor(async () => { const x = await task(h2.id); return x && (x.agentId || x.status !== 'todo') ? x : null; }, 30000);
  check('tras reasignar, un agente la coge', !!taken, 'sigue en todo sin agente');
} catch (e) { failed++; console.error('✗ excepción:', e.message); }
await halt(); cleanup();
console.log(failed ? `\n✗ ${failed} fallo(s)` : '\n✓ human-task-e2e FT-193: todo bien');
process.exit(failed ? 1 : 0);
