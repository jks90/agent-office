#!/usr/bin/env node
// e2e de FT-64 · agrupar tareas del mismo repo y rol para aprovechar la caché del prompt (motor demo, sin tokens).
// Servidor temporal: 1) con 1 agente, A1·B1·A2 (creadas en ese orden) se reparten A1, A2, B1; 2) con 2 agentes y
// maxParallel 2, C1·D1·C2 lanzan C1 y C2 a la vez y D1 espera; 3) orderTodo con la afinidad apagada vuelve al orden clásico.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-affinity-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => { if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })); res.writeHead(404).end('{}'); }).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

// Anota el orden en que cada tarea pasa a «doing» (con el instante) hasta que todas han terminado
async function observe(ids, ms = 120_000) {
  const order = [], t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ts = (await call('GET', '/api/state')).tasks.filter((t) => ids.includes(t.id));
    for (const t of ts) if (t.status !== 'todo' && !order.find((o) => o.id === t.id)) order.push({ id: t.id, at: Date.now() });
    if (ts.every((t) => ['review', 'done', 'failed'].includes(t.status))) return order;
    await sleep(100);
  }
  return order;
}

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const repos = ['a', 'b', 'c', 'd'].map((k) => { const d = path.join(tmp, 'r' + k); fs.mkdirSync(d); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d }); fs.writeFileSync(path.join(d, 'x'), k); execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=e', 'commit', '-qm', 'i'], { cwd: d }); return { key: k, path: d }; });
  const p = await call('POST', '/api/projects', { name: 'afin', repos, engine: 'demo' });
  const mk = async (title, repo) => (await call('POST', '/api/tasks', { projectId: p.id, title, role: 'back', repo })).id;

  console.log('Un agente: A1 · B1 · A2');
  const [a1, b1, a2] = [await mk('A1', 'a'), await mk('B1', 'b'), await mk('A2', 'a')];
  const o1 = (await (async () => { await call('POST', `/api/projects/${p.id}/run`, { running: true }); return observe([a1, b1, a2]); })()).map((o) => o.id);
  check('orden de reparto A1 → A2 (misma caché) → B1', o1.join() === [a1, a2, b1].join(), o1.join());

  console.log('Dos agentes en paralelo: C1 · D1 · C2');
  await call('POST', `/api/projects/${p.id}/run`, { running: false });
  await call('POST', '/api/agents', { projectId: p.id, name: 'Beto', role: 'back', engine: 'demo' });
  await call('POST', '/api/settings', { maxParallel: 2 });
  const [c1, d1, c2] = [await mk('C1', 'c'), await mk('D1', 'd'), await mk('C2', 'c')];
  const o2 = await (async () => { await call('POST', `/api/projects/${p.id}/run`, { running: true }); return observe([c1, d1, c2]); })();
  const ids2 = o2.map((o) => o.id);
  check('C1 y C2 salen juntas y D1 la última', ids2.join() === [c1, c2, d1].join() && o2[1].at - o2[0].at < 3000, ids2.join());

  console.log('Orden con la afinidad apagada (orderTodo)');
  const { orderTodo } = await import(path.join(ROOT, 'server/affinity.js'));
  const ts = [{ id: 'x1', createdAt: 1 }, { id: 'y1', createdAt: 2 }, { id: 'x2', createdAt: 3 }];
  check('sin afinidad: el más antiguo primero', orderTodo(ts).map((t) => t.id).join() === 'x1,y1,x2');
  check('con afinidad: la caliente antes que la más antigua, y la prioridad manda', orderTodo(ts, (t) => t.id === 'x2').map((t) => t.id).join() === 'x2,x1,y1' && orderTodo([...ts, { id: 'p', createdAt: 9, priority: 1 }], (t) => t.id === 'x2')[0].id === 'p');
} catch (e) { failed++; console.log('✗ error:', e.message); }
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo OK');
process.exit(failed ? 1 : 0);
