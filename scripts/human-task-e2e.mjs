// FT-189 · e2e: tarea asignada a «human». Servidor temporal (otro puerto y directorio de datos).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = 7600 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-human-'));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const proj = (await call('POST', '/api/projects', { name: 'Humano FT-189' })).body;
  const agent = (await call('POST', '/api/agents', { name: 'Bruno', role: 'back', engine: 'demo', projectId: proj.id })).body;
  const st = async () => (await call('GET', '/api/state')).body;
  await call('POST', `/api/projects/${proj.id}/run`, { running: true });

  const h = await call('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'La hago yo', assignedAgentId: 'human' });
  assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.assignedAgentId, 'human', JSON.stringify(h.body));
  const n = await call('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'Normal', status: 'backlog' });
  assert.equal(n.body.assignedAgentId, undefined);
  await sleep(6000); // varios ciclos del planificador (1,5 s)
  let t = (await st()).tasks.find((x) => x.id === h.body.id);
  assert.equal(t.status, 'todo'); assert.ok(!t.agentId); assert.equal(t.plannedReason, null);
  assert.equal((await st()).agents.find((a) => a.id === agent.id).status, 'idle');

  for (const s of ['backlog', 'todo', 'doing', 'review', 'done', 'discarded', 'review', 'done']) {
    const r = await call('PATCH', `/api/tasks/${h.body.id}`, { status: s });
    assert.equal(r.status, 200, `${s}: ${JSON.stringify(r.body)}`); assert.equal(r.body.status, s);
  }
  await call('PATCH', `/api/tasks/${h.body.id}`, { status: 'todo' });
  await call('POST', `/api/projects/${proj.id}/run`, { running: false });
  const ra = await call('PATCH', `/api/tasks/${h.body.id}`, { assignedAgentId: agent.id });
  assert.equal(ra.status, 200, JSON.stringify(ra.body)); assert.equal(ra.body.assignedAgentId, agent.id);
  const rh = await call('PATCH', `/api/tasks/${h.body.id}`, { assignedAgentId: 'human' });
  assert.equal(rh.body.assignedAgentId, 'human', JSON.stringify(rh));
  const rauto = await call('PATCH', `/api/tasks/${h.body.id}`, { assignedAgentId: '__auto' });
  assert.equal(rauto.body.assignedAgentId, undefined);
  await call('POST', `/api/projects/${proj.id}/run`, { running: true });
  // normal: sigue yendo a un agente
  await call('PATCH', `/api/tasks/${n.body.id}`, { status: 'todo' });
  await sleep(3000);
  const mine = (await st()).tasks.filter((x) => [n.body.id, h.body.id].includes(x.id));
  assert.ok(mine.some((x) => x.agentId || x.status !== 'todo'), 'con agente libre una tarea de agente debe arrancar');
  console.log('✔ human-task-e2e FT-189');
} catch (e) { console.error('✖', e.message); process.exitCode = 1; } finally { stop(); }
