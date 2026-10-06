#!/usr/bin/env node
// e2e del coordinador: guardar la política por proyecto, «Aplicar» contrata a quien falta (con un modelo de ese motor) y lo
// deja en el registro (coordLog) y como evento TeamAdjusted; apagado no hace nada.
import { spawn } from 'node:child_process';
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
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-coord-'));
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => { if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })); res.writeHead(404).end('{}'); }).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'ws'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: path.join(tmp, 'home'), AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' } });
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* aún no */ } await sleep(100); }
  const p = await call('POST', '/api/projects', { name: 'coord', engine: 'demo' });
  const st0 = await call('GET', '/api/state');
  const teamBefore = st0.projects.find((x) => x.id === p.id).team.length;
  // un rol que nadie del equipo tiene, con trabajo listo
  await call('POST', '/api/roles', { id: 'raro', kind: 'dev', model: 'sonnet', system: 'Rol de prueba.' });
  await call('POST', '/api/tasks', { projectId: p.id, title: 'Para el rol raro', role: 'raro' });
  const off = await call('POST', `/api/projects/${p.id}/coordinate`);
  check('«Aplicar» funciona aunque esté apagado (pasada manual) y contrata al que falta', off.applied?.length === 1 && /raro/.test(off.applied[0]), JSON.stringify(off));
  const st = await call('GET', '/api/state');
  const pr = st.projects.find((x) => x.id === p.id);
  const hired = st.agents.find((a) => a.role === 'raro');
  check('el contratado está en el equipo con el rol, motor claude y modelo sonnet', !!hired && pr.team.includes(hired.id) && hired.engine === 'claude' && hired.model === 'sonnet' && pr.team.length === teamBefore + 1, JSON.stringify(hired));
  check('queda en el registro del coordinador', pr.coordLog?.length === 1 && pr.coordLog[0].type === 'hire', JSON.stringify(pr.coordLog));
  const evs = await call('GET', '/api/events?limit=50');
  check('evento TeamAdjusted', (evs.events || evs).some?.((e) => e.type === 'TeamAdjusted'), JSON.stringify(evs).slice(0, 200));
  await call('PATCH', `/api/projects/${p.id}`, { coordinator: 'suggest' });
  check('guarda «solo sugerir»', (await call('GET', '/api/state')).projects.find((x) => x.id === p.id).coordinator === 'suggest');
  await call('PATCH', `/api/projects/${p.id}`, { coordinator: '' });
  check('«Apagado» quita la política', !(await call('GET', '/api/state')).projects.find((x) => x.id === p.id).coordinator);
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
