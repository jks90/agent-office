// ES-17 · GET /api/remote/agents/:projectId/:agentId: detalle del agente, recortes, sin secretos/rutas, oculto, flag, inexistente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentView } from '../server/remote-team.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = {
  schema: 2,
  projects: [{ id: 'p1', name: 'Uno', team: ['a1', 'a2'] }, { id: 'p2', name: 'Oculto', team: ['a3'] }],
  agents: [{ id: 'a1', name: 'Bruno', role: 'back', engine: 'claude' }, { id: 'a2', name: 'Sara', role: 'qa' }, { id: 'a3', name: 'Z', role: 'back' }],
  tasks: [{ id: 't1', code: 'X-1', projectId: 'p1', title: 'T', status: 'done', agentId: 'a1', updatedAt: 1 }],
  settings: { hiddenProjects: ['p2'] },
};

async function boot(flag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ragent-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, AO_DATA_DIR: dir, AO_PORT: String(port), AO_HOST: '127.0.0.1' };
  if (flag) env.AO_REMOTE_MIC = 'on'; else delete env.AO_REMOTE_MIC;
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((res, rej) => { child.stdout.on('data', (d) => /AgentOffice en/.test(String(d)) && res()); child.on('exit', () => rej(new Error('servidor caído'))); setTimeout(() => rej(new Error('timeout')), 15000); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };
  return { get, stop: () => child.kill() };
}

test('flag apagado: 404', async () => {
  const s = await boot(false);
  try { assert.equal((await s.get('/api/remote/agents/p1/a1')).status, 404); } finally { s.stop(); }
});

test('detalle por HTTP (sin tarea actual), oculto e inexistente', async () => {
  const s = await boot(true);
  try {
    const r = await s.get('/api/remote/agents/p1/a1');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['activity', 'currentTask', 'description', 'engine', 'kind', 'model', 'name', 'recentTasks', 'role', 'roleLabel', 'skills', 'stats', 'status', 'systemPrompt']);
    assert.equal(r.body.currentTask, null); assert.equal(r.body.stats.done, 1);
    assert.deepEqual(r.body.recentTasks, [{ code: 'X-1', title: 'T', status: 'done' }]);
    assert.equal((await s.get('/api/remote/agents/p1/a3')).status, 404); // no está en la plantilla
    assert.equal((await s.get('/api/remote/agents/p1/nope')).status, 404);
    assert.equal((await s.get('/api/remote/agents/p2/a3')).status, 404); // proyecto oculto
  } finally { s.stop(); }
});

test('agentView: tarea actual, recortes y sin secretos ni rutas', () => {
  const st = {
    agents: [{ id: 'a1', name: 'B', role: 'x', status: 'working', activity: 'ab '.repeat(80), taskId: 't2', skills: ['/home/u/skill', 'tdd'] }],
    tasks: [{ id: 't2', code: 'X-2', projectId: 'p', title: 'Dos', status: 'doing', agentId: 'a1', updatedAt: 5 }, { id: 't3', code: 'X-3', projectId: 'p', title: 'Rev', status: 'review', agentId: 'a1', updatedAt: 9 }],
  };
  const roles = { x: { label: 'X', kind: 'dev', model: 'opus', description: 'd '.repeat(300), skills: ['lint'], system: 'Lee /home/keromanix/dev/app/secret.txt y usa API_KEY=abc123 sk-abcdefghijklmnop. ' + 'z '.repeat(1000) } };
  const v = agentView(st, { id: 'p', team: ['a1'] }, roles, 'a1');
  assert.deepEqual(v.currentTask, { code: 'X-2', title: 'Dos' });
  assert.equal(v.recentTasks[0].code, 'X-3'); assert.deepEqual(v.stats, { done: 0, enRevision: 1 });
  assert.equal(v.model, 'opus'); assert.equal(v.description.length, 300); assert.equal(v.activity.length, 60);
  assert.equal(v.systemPrompt.length, 1200);
  assert.doesNotMatch(v.systemPrompt, /home\/keromanix|abc123|sk-abc/);
  assert.deepEqual(v.skills, ['lint', 'tdd']);
});
