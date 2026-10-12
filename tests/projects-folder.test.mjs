// Proyectos manuales con carpeta obligatoria: alta, unicidad, crear carpeta en flow-test, re-vincular, huérfanos y repos
// sugeridos por los enlaces del workspace. flow-test es un servidor HTTP falso en un puerto libre; datos en un tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-projects-data-'));
const store = await import('../server/store.js');
const team = await import('../server/team.js');
const { get } = store;

// Workspace falso: carpetas en `dirs`, flows en `files`; POST /workspace/folder la añade.
const ws = { dirs: ['api', 'vacia', '_agentes', 'privado'], files: [{ path: 'api/a.flow.json', type: 'flow' }, { path: 'api/b.flow.json', type: 'flow' }, { path: 'suelto.flow.json', type: 'flow' }, { path: 'api/notas.md', type: 'doc' }] };
const created = [];
const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/workspace/flows') return send(200, { dir: '/fake', ...ws });
  if (req.url === '/workspace/folder' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    const { path: rel } = JSON.parse(raw);
    if (ws.dirs.includes(rel)) return send(409, { error: 'Ya existe' });
    ws.dirs.push(rel); created.push(rel); return send(200, { created: true, path: rel });
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
get().settings.flowTestUrl = `http://127.0.0.1:${server.address().port}`;

// Hub con enlaces simbólicos: api/repo → un repo git; api/docs (se ignora) y api/roto (enlace colgante).
const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hub-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-repo-'));
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
fs.mkdirSync(path.join(hub, 'api'));
fs.symlinkSync(repo, path.join(hub, 'api', 'Mi Repo'));
fs.symlinkSync(repo, path.join(hub, 'api', 'docs'));
fs.symlinkSync(path.join(hub, 'no-existe'), path.join(hub, 'api', 'roto'));
get().settings.workspaceHostDir = hub;

test.after(() => { store.flush(); server.close(); });

const fails = async (fn, code, re) => { try { await fn(); } catch (e) { assert.equal(e.status, code, e.message); if (re) assert.match(e.message, re); return; } assert.fail('debía fallar'); };

test('la carpeta es obligatoria y de primer nivel', async () => {
  await fails(() => team.createProject({ name: 'X' }), 400, /carpeta/);
  await fails(() => team.createProject({ name: 'X', folder: '  ' }), 400);
  await fails(() => team.createProject({ name: 'X', folder: 'api/sub' }), 400);
  await fails(() => team.createProject({ name: 'X', folder: '_agentes' }), 400);
  await fails(() => team.createProject({ name: 'X', folder: 'privado' }), 400);
  await fails(() => team.createProject({ name: 'X', folder: 'no-existe' }), 400, /No existe/);
  assert.equal(get().projects.length, 0);
});

test('alta en una carpeta existente: cuenta sus flows y lleva Coordi salvo que se desmarque', async () => {
  const p = await team.createProject({ name: 'API', folder: '/api/', engine: 'demo' });
  assert.equal(p.folder, 'api');
  assert.equal(p.flows, 2);
  assert.ok(team.teamOf(p).some((a) => a.role === 'coordinador'));
  const q = await team.createProject({ name: 'Vacía', folder: 'vacia', coordinator: false });
  assert.ok(!team.teamOf(q).some((a) => a.role === 'coordinador'));
});

test('una carpeta = un proyecto (también la raíz)', async () => {
  await fails(() => team.createProject({ name: 'Otro', folder: 'api' }), 409, /API/);
  const r = await team.createProject({ name: 'Raíz', folder: team.ROOT, coordinator: false });
  assert.equal(r.folder, team.ROOT);
  await fails(() => team.createProject({ name: 'Raíz 2', folder: team.ROOT }), 409);
  assert.equal(team.projectDir(r), hub); // sin repo, los agentes trabajan en la raíz del workspace
});

test('createFolder la crea en flow-test', async () => {
  const p = await team.createProject({ name: 'Nueva', folder: 'nueva', createFolder: true, coordinator: false });
  assert.deepEqual(created, ['nueva']);
  assert.equal(p.flows, 0);
});

test('re-vincular: solo a carpetas libres; nunca quitar la carpeta', async () => {
  const p = get().projects.find((x) => x.name === 'Nueva');
  await fails(() => team.updateProject(p.id, { folder: '' }), 400);
  await fails(() => team.updateProject(p.id, { folder: 'api' }), 409);
  await team.updateProject(p.id, { folder: 'nueva' }); // la suya: sin cambios
  await team.updateProject(p.id, { folder: 'otra', createFolder: true });
  assert.equal(p.folder, 'otra');
});

test('checkFolders no crea proyectos: marca huérfanos y refresca flows', async () => {
  const before = get().projects.length;
  ws.files.push({ path: 'api/c.flow.json', type: 'flow' });
  ws.dirs = ws.dirs.filter((d) => d !== 'vacia');
  ws.dirs.push('carpeta-sin-proyecto');
  const r = await team.checkFolders();
  assert.equal(get().projects.length, before);
  assert.deepEqual(r.orphans, ['Vacía']);
  assert.equal(get().projects.find((x) => x.name === 'API').flows, 3);
  assert.equal(get().projects.find((x) => x.name === 'Raíz').flows, 1);
  const v = get().projects.find((x) => x.name === 'Vacía');
  assert.equal(v.orphan, true);
  await team.updateProject(v.id, { folder: 'carpeta-sin-proyecto' });
  assert.equal(v.orphan, false);
});

test('workspaceFolders: carpetas válidas con su dueño', async () => {
  const { folders } = await team.workspaceFolders();
  const names = folders.map((f) => f.name);
  assert.ok(names.includes(team.ROOT) && names.includes('api') && names.includes('carpeta-sin-proyecto'));
  assert.ok(!names.includes('_agentes') && !names.includes('privado'));
  assert.equal(folders.find((f) => f.name === 'api').project.name, 'API');
  assert.equal(folders.find((f) => f.root).name, team.ROOT);
});

test('suggestRepos: enlaces a repos git (sin docs ni enlaces rotos); no toca el proyecto', async () => {
  const s = await team.suggestRepos('api');
  assert.deepEqual(s, [{ key: 'mi-repo', path: fs.realpathSync(repo) }]);
  assert.deepEqual(await team.suggestRepos(team.ROOT), []);
  assert.deepEqual(get().projects.find((x) => x.name === 'API').repos, []);
});
