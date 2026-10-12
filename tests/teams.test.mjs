// 👥 Plantillas de equipo (server/teams.js + marketplace kind «team»): listar las de serie, aplicarlas a un proyecto (roles que
// faltan, skills, banquillo antes que contratar, tope de 8 mesas, coordinador) y exportar/importar el equipo de un proyecto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-teams-data-'));
const store = await import('../server/store.js');
const cat = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-teams-cat-'));
store.get().settings.catalogDir = cat;
store.get().settings.workspaceHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-teams-ws-')); // inventario de skills acotado
const team = await import('../server/team.js');
const teams = await import('../server/teams.js');
const mp = await import('../server/marketplace.js');
const { allRoles } = await import('../server/roles.js');
const { get } = store;

test.after(() => store.flush());

const newProject = (name) => team.createProject({ name, folder: team.ROOT === 'default' && !get().projects.some((p) => p.folder === 'default') ? 'default' : undefined, engine: 'demo', coordinator: false, defaultTeam: false });

test('las 4 plantillas de serie se listan con sus miembros', () => {
  const l = teams.listTemplates();
  assert.deepEqual(l.map((t) => t.id).sort(), ['api', 'docs-ops', 'unity-game', 'web-app']);
  const web = l.find((t) => t.id === 'web-app');
  assert.equal(web.members.length, 5);
  assert.ok(web.newRoles.includes('documentalista'));
  assert.ok(web.skills.includes('flows'));
});

test('aplicar web-app: instala rol y skill, contrata, da flows al QA y añade Coordi', async () => {
  const p = await newProject('Tienda');
  const r = teams.applyBuiltin('web-app', p.id);
  assert.deepEqual(r.rolesInstalled, ['documentalista']);
  assert.ok(fs.existsSync(path.join(cat, 'roles', 'plantillas', 'documentalista.md')));
  assert.deepEqual(r.skillsInstalled, ['flows']);
  assert.ok(fs.existsSync(path.join(cat, 'skills', 'flows', 'SKILL.md')) && fs.existsSync(path.join(cat, 'skills', 'flows', 'references', 'flow-schema.md')));
  assert.equal(r.hired.length, 5);
  assert.equal(r.coordinator, true);
  const members = get().agents.filter((a) => p.team.includes(a.id));
  assert.equal(members.length, 6);
  assert.deepEqual(members.find((a) => a.role === 'qa').skills, ['flows']);
  assert.equal(allRoles().documentalista.skills[0], 'flows');
  // Sugeridas (4 de front + 2 de back): las que haya en este PC pasan al catálogo, las demás se avisan; ninguna se pierde
  assert.equal(new Set([...r.suggested.added, ...r.suggested.missing]).size, 6, JSON.stringify(r.suggested));
});

test('segunda vez: no duplica, conserva el rol y la skill; banquillo antes que contratar', async () => {
  const p = get().projects.find((x) => x.name === 'Tienda');
  const again = teams.applyBuiltin('web-app', p.id);
  assert.equal(again.hired.length, 0);
  assert.equal(again.skipped.length, 5);
  assert.deepEqual(again.rolesKept, ['documentalista']);
  assert.deepEqual(again.skillsKept, ['flows']);
  // Un back al banquillo → otro proyecto con «api» lo ficha en vez de contratar a otro
  const back = get().agents.find((a) => p.team.includes(a.id) && a.role === 'back');
  team.setTeam(p.id, { remove: [back.id] });
  const q = await team.createProject({ name: 'Servicio', folder: undefined, engine: 'demo', coordinator: false, defaultTeam: false }).catch(() => null)
    || (get().projects.push({ id: 'p2', name: 'Servicio', folder: 'x', repos: [], team: [] }), get().projects.at(-1));
  const r = teams.applyBuiltin('api', q.id, { coordinator: false });
  assert.ok(r.fromBench.some((x) => x.startsWith(back.name)), JSON.stringify(r));
  assert.equal(r.coordinator, false, 'la casilla del alta manda sobre la plantilla');
});

test('tope de 8 mesas: lo que no cabe se avisa', async () => {
  const p = { id: 'p3', name: 'Lleno', folder: 'y', repos: [], team: [] };
  get().projects.push(p);
  for (let i = 0; i < 7; i++) team.hire({ projectId: p.id, name: `X${i}`, role: 'back', engine: 'demo' });
  const r = teams.applyBuiltin('docs-ops', p.id);
  assert.equal(p.team.length, 8);
  assert.equal(r.benched.length, 1);
});

test('exportar el equipo de un proyecto (kind team) e importarlo en otro', () => {
  const p = get().projects.find((x) => x.name === 'Tienda');
  const pkg = mp.exportPackage('team', p.id, 'public');
  assert.equal(pkg.kind, 'team');
  const paths = pkg.files.map((f) => f.path);
  assert.ok(paths.includes('team.json') && paths.includes('roles/documentalista.md') && paths.includes('skills/flows/SKILL.md'), paths.join(','));
  const spec = JSON.parse(Buffer.from(pkg.files.find((f) => f.path === 'team.json').content, 'base64').toString());
  assert.ok(!spec.members.some((m) => m.role === 'coordinador'), 'el coordinador no va como miembro: va como «coordinator»');
  assert.equal(spec.coordinator, true);
  assert.equal(pkg.memory, undefined);
  assert.throws(() => mp.importPackage(pkg, {}), (e) => e.status === 400 && e.needsConfirm === 'project');
  const dest = { id: 'p4', name: 'Copia', folder: 'z', repos: [], team: [] };
  get().projects.push(dest);
  const r = mp.importPackage(pkg, { projectId: dest.id });
  assert.equal(r.kind, 'team');
  assert.ok(dest.team.length >= 4);
});

test('🔒 plantilla privada: guardar el equipo de un proyecto, listarla, aplicarla en otro y borrarla', () => {
  const p = get().projects.find((x) => x.name === 'Tienda');
  const saved = teams.saveLocal(p.id, { name: 'Mi tienda base' });
  assert.equal(saved.id, 'mine:mi-tienda-base');
  assert.ok(fs.existsSync(path.join(cat, 'plantillas-equipo', 'mi-tienda-base', 'team.json')));
  assert.ok(fs.existsSync(path.join(cat, 'plantillas-equipo', 'mi-tienda-base', 'roles', 'documentalista.md')));
  const l = teams.listTemplates();
  const mine = l.find((t) => t.id === saved.id);
  assert.ok(mine && mine.mine && mine.icon === '🔒');
  assert.equal(l.at(-1).id, saved.id, 'las privadas van después de las de serie');
  const dest = { id: 'p5', name: 'Otra', folder: 'w', repos: [], team: [] };
  get().projects.push(dest);
  const r = teams.applyBuiltin(saved.id, dest.id);
  assert.ok(dest.team.length >= 5, JSON.stringify(r));
  assert.ok(r.skillsKept.includes('flows') || !r.skillsInstalled.length, 'usa las skills del catálogo, no las copia');
  assert.deepEqual(teams.deleteLocal(saved.id), { ok: true });
  assert.ok(!teams.listTemplates().some((t) => t.id === saved.id));
  assert.throws(() => teams.deleteLocal('web-app'), (e) => e.status === 400, 'las de serie no se borran');
});
