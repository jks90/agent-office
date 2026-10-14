// ES-4 · Rutas compactas de tareas del mando (/api/remote/tasks/...): orden, filtro, paginación, recortes, 404 y flag apagado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mk = (i, status, extra = {}) => ({ id: `t${i}`, code: `X-${i}`, projectId: 'p1', title: `Tarea ${i}`, status, description: '', summary: '', role: 'back', agentId: 'a1', updatedAt: 1000 + i, ...extra });
const tasks = [
  ...Array.from({ length: 25 }, (_, i) => mk(i + 1, 'todo')),
  mk(30, 'done'), mk(31, 'review', { title: 'T'.repeat(200), description: 'd'.repeat(3000), summary: 's'.repeat(2000), attachments: [{ x: 1 }] }),
  mk(32, 'backlog'), mk(33, 'done', { archived: 5 }), mk(40, 'todo', { projectId: 'p2' }),
];
const state = { projects: [{ id: 'p1', name: 'Uno' }, { id: 'p2', name: 'Oculto' }], agents: [{ id: 'a1', name: 'Bruno', role: 'back' }], tasks, settings: { hiddenProjects: ['p2'] } };

async function boot(flag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rt-'));
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
  try {
    assert.equal((await s.get('/api/remote/tasks/p1')).status, 404);
    assert.equal((await s.get('/api/remote/tasks/p1/t1')).status, 404);
  } finally { s.stop(); }
});

test('lista, filtro, paginación y detalle', async () => {
  const s = await boot(true);
  try {
    let r = await s.get('/api/remote/tasks/p1');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 27); // sin backlog, sin archivadas, sin otros proyectos
    assert.equal(r.body.tasks.length, 10);
    assert.deepEqual(Object.keys(r.body.tasks[0]).sort(), ['agent', 'code', 'id', 'status', 'title']);
    assert.equal(r.body.tasks[0].id, 't31'); // más reciente primero
    assert.equal(r.body.tasks[0].title.length, 80);
    assert.equal(r.body.tasks[0].agent, 'Bruno');
    r = await s.get('/api/remote/tasks/p1?status=todo&limit=500');
    assert.equal(r.body.total, 25); assert.equal(r.body.tasks.length, 20);
    r = await s.get('/api/remote/tasks/p1?status=todo&offset=20&limit=20');
    assert.equal(r.body.tasks.length, 5);
    assert.equal((await s.get('/api/remote/tasks/p1?status=backlog')).status, 400);
    assert.equal((await s.get('/api/remote/tasks/p1?limit=x')).status, 400);
    r = await s.get('/api/remote/tasks/p1/t31');
    assert.equal(r.body.description.length, 1500); assert.equal(r.body.summary.length, 800);
    assert.equal(r.body.role, 'back'); assert.equal(r.body.attachments, undefined);
    assert.equal((await s.get('/api/remote/tasks/p1/X-30')).body.id, 't30');
  } finally { s.stop(); }
});

test('404: proyecto inexistente u oculto, tarea inexistente o de otro proyecto', async () => {
  const s = await boot(true);
  try {
    for (const p of ['/api/remote/tasks/nope', '/api/remote/tasks/p2', '/api/remote/tasks/p2/t40', '/api/remote/tasks/p1/nope', '/api/remote/tasks/p1/t40'])
      assert.equal((await s.get(p)).status, 404, p);
  } finally { s.stop(); }
});
