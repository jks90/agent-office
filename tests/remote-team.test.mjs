// ES-16 · GET /api/remote/team/:projectId: plantilla compacta, oculto/inexistente 404, flag apagado 404, activity recortada.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamView } from '../server/remote-team.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = {
  schema: 2,
  projects: [{ id: 'p1', name: 'Uno', team: ['a1', 'a2'], reviewerAgentId: 'a2', managers: { a1: ['a2', 'zz'] } }, { id: 'p2', name: 'Oculto', team: [] }],
  agents: [
    { id: 'a1', name: 'Bruno', role: 'back', engine: 'claude', model: 'sonnet', avatar: 'secret' },
    { id: 'a2', name: 'Sara', role: 'qa', status: 'idle', engine: 'auto' },
    { id: 'a3', name: 'Fuera', role: 'back' },
  ],
  tasks: [{ id: 't1', code: 'X-1', projectId: 'p1', title: 'T', status: 'doing' }], settings: { hiddenProjects: ['p2'] },
};

async function boot(flag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rteam-'));
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
  try { assert.equal((await s.get('/api/remote/team/p1')).status, 404); } finally { s.stop(); }
});

test('plantilla, recortes, oculto e inexistente', async () => {
  const s = await boot(true);
  try {
    const r = await s.get('/api/remote/team/p1');
    assert.equal(r.status, 200);
    assert.equal(r.body.agents.length, 2);
    const a = r.body.agents[0];
    assert.deepEqual(Object.keys(a).sort(), ['activity', 'engine', 'id', 'kind', 'model', 'name', 'role', 'roleLabel', 'status', 'taskCode']);
    assert.equal(a.status, 'idle'); assert.equal(a.taskCode, null); assert.equal(a.avatar, undefined);
        assert.equal(r.body.reviewerId, 'a2'); assert.equal(r.body.coordinatorId, null);
    assert.deepEqual(r.body.managers, { a1: ['a2'] });
    assert.equal((await s.get('/api/remote/team/p2')).status, 404);
    assert.equal((await s.get('/api/remote/team/nope')).status, 404);
  } finally { s.stop(); }
});

test('teamView: activity recortada a 60, estado y taskCode en vivo', () => {
  const st = { agents: [{ id: 'a1', name: 'B', role: 'back', status: 'working', activity: 'x'.repeat(200), taskId: 't1' }], tasks: [{ id: 't1', code: 'X-1' }] };
  const v = teamView(st, { team: ['a1'] }, { back: { label: 'Backend', kind: 'dev' } });
  assert.equal(v.agents[0].activity.length, 60); assert.equal(v.agents[0].taskCode, 'X-1');
  assert.equal(v.agents[0].status, 'working'); assert.equal(v.agents[0].roleLabel, 'Backend');
});
