// ES-34 · Oficina compacta: contrato HTTP, autenticación, privacidad y presupuesto UTF-8.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { officeView } from '../server/remote-team.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOKEN = 'es34-test-token';
const state = {
  schema: 2,
  projects: [
    { id: 'new', name: 'Nuevo', createdAt: 2, team: ['a2'], running: false },
    { id: 'old', name: 'Antiguo', createdAt: 1, team: ['a1'], running: true, repos: [{ path: '/private/repo' }] },
    { id: 'empty', name: 'Sin equipo', team: [] },
    { id: 'hidden', name: 'Oculto', team: ['a1'] },
  ],
  agents: [
    { id: 'a1', name: 'Sara', role: 'qa', status: 'working', taskId: 't1', activity: 'Probando con tildes áéí '.repeat(10), avatar: 'secret', identity: 'private' },
    { id: 'a2', name: 'Bruno', role: 'back' },
    { id: 'outside', name: 'Fuera', role: 'back' },
  ],
  tasks: [{ id: 't1', code: 'ES-34', projectId: 'old', status: 'done', description: 'private' }],
  settings: { hiddenProjects: ['hidden'] },
};

async function boot(t, enabled) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-office-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const env = { ...process.env, AO_DATA_DIR: dir, AO_HOST: '127.0.0.1', AO_PORT: String(20000 + Math.floor(Math.random() * 20000)), AO_TOKEN: TOKEN };
  if (enabled) env.AO_REMOTE_MIC = 'on'; else delete env.AO_REMOTE_MIC;
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout al arrancar')), 15000);
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      const match = output.match(/AgentOffice en http:\/\/[^:]+:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('servidor caído')); });
  });
  return async (token = TOKEN) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/remote/office`, { headers: token ? { 'x-ao-token': token } : {} });
    return { status: r.status, body: await r.json() };
  };
}

test('office HTTP: 200, forma exacta, orden y sin campos privados; 401 sin token o incorrecto', async (t) => {
  const get = await boot(t, true);
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body, officeView({ ...state, agents: state.agents.map((a) => ({ ...a, status: 'idle', activity: '', taskId: null })) }, {}));
  assert.deepEqual(body.projects.map((p) => p.id), ['old', 'new']);
  assert.deepEqual(Object.keys(body.projects[0]).sort(), ['agents', 'id', 'name', 'running']);
  assert.deepEqual(Object.keys(body.projects[0].agents[0]).sort(), ['activity', 'id', 'name', 'status', 'taskCode']);
  assert.doesNotMatch(JSON.stringify(body), /avatar|identity|repos|prompt|private|secret|engine|model/);
  assert.equal((await get(null)).status, 401);
  assert.equal((await get('wrong')).status, 401);
});

test('office HTTP: flag apagado devuelve 404', async (t) => {
  const get = await boot(t, false);
  assert.equal((await get()).status, 404);
  assert.equal((await get(null)).status, 404);
});

test('officeView: estado vivo, running, actividad de 60 caracteres y secretos tachados', () => {
  const out = officeView(state, {});
  assert.equal(out.projects[0].running, true);
  assert.equal(out.projects[1].running, false);
  const a = out.projects[0].agents[0];
  assert.equal(a.status, 'working');
  assert.equal(a.taskCode, 'ES-34');
  assert.equal(a.activity.length, 60);
  assert.equal(out.truncated, undefined);
  const dirty = structuredClone(state);
  dirty.agents[0].activity = 'Lee /home/user/private/file y API_KEY=abc123 sk-abcdefghijklmnop';
  assert.doesNotMatch(JSON.stringify(officeView(dirty, {})), /home\/user|abc123|sk-abc/);
  assert.deepEqual(officeView({ projects: [], agents: [], tasks: [] }, {}), { projects: [] });
});

test('officeView: máximo 12000 bytes incluso con Unicode, muchas plantas y campos desmesurados', () => {
  const agents = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, name: '漢'.repeat(40), activity: '漢 '.repeat(60) }));
  const st = { agents, tasks: [], projects: [{ id: 'p', name: 'P', team: agents.map((a) => a.id) }] };
  const original = JSON.stringify(st);
  const out = officeView(st, {});
  assert.equal(out.truncated, true);
  assert.ok(out.projects[0].agents.length > 0 && out.projects[0].agents.length < agents.length);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 12000);
  assert.equal(out.projects[0].agents[0].id, 'a0');
  assert.equal(JSON.stringify(st), original);
  st.projects = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: '漢'.repeat(100), team: ['a0'] }));
  const many = officeView(st, {});
  assert.equal(many.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 12000);
});
