// 🧑‍💼 Guía: fichar agentes (agent.hire) y crear roles (role.create), siempre con permiso (🛡).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ghire-'));
const store = await import('../server/store.js');
const cat = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ghire-cat-'));
store.get().settings.catalogDir = cat;
const { allRoles } = await import('../server/roles.js');
const { tools } = await import('../server/guide/tools.js');
const by = Object.fromEntries(tools.map((t) => [t.name, t]));

test.after(() => store.flush());

test('agent.hire y role.create piden SIEMPRE permiso (irreversible) con el detalle de lo que se crea', async () => {
  store.get().projects.push({ id: 'pdemo', name: 'demos', team: [], repos: [] });
  const d = await by['agent.hire'].dynamic({ name: 'Nora', role: 'navegante', projectId: 'demos' });
  assert.equal(d.policy, 'irreversible');
  assert.match(d.question, /Nora.*en demos/);
  assert.match(d.context, /Rol: navegante[\s\S]*Proyecto: demos/);
  const r = await by['role.create'].dynamic({ id: 'Demo Web', description: 'Hace demos', system: 'Abre la app y la recorre', browser: true });
  assert.equal(r.policy, 'irreversible');
  assert.match(r.question, /«demo-web» con navegador/);
  assert.match(r.context, /Navegador: sí[\s\S]*Abre la app/);
});

test('agent.hire: ficha en el equipo del proyecto; rol inexistente → 400 antes de preguntar', async () => {
  const out = by['agent.hire'].handler({ name: 'Nora', role: 'navegante', projectId: 'demos' });
  assert.deepEqual({ ...out, id: undefined }, { id: undefined, name: 'Nora', role: 'navegante', engine: 'auto', project: 'demos' });
  assert.ok(store.get().projects.find((p) => p.id === 'pdemo').team.includes(out.id));
  const bench = by['agent.hire'].handler({ name: 'Leo', role: 'qa' });
  assert.equal(bench.project, null, 'sin proyecto queda en el banquillo');
  await assert.rejects(by['agent.hire'].dynamic({ name: 'X', role: 'no-existe' }), (e) => e.status === 400);
  await assert.rejects(by['agent.hire'].dynamic({ name: 'X', role: 'qa', projectId: 'nope' }), (e) => e.status === 404);
});

test('role.create: escribe el rol en el catálogo con navegador; no pisa uno existente (409) ni los de serie', async () => {
  const out = by['role.create'].handler({ id: 'demo', description: 'Demos en vivo', kind: 'docs', system: 'Recorre la app y cuenta lo que ves', browser: true });
  assert.equal(out.role, 'demo'); assert.equal(out.browser, true);
  const txt = fs.readFileSync(path.join(cat, 'roles', 'demo.md'), 'utf8');
  assert.match(txt, /name: demo[\s\S]*kind: docs[\s\S]*tools: browser[\s\S]*Recorre la app/);
  assert.ok(allRoles().demo);
  await assert.rejects(by['role.create'].dynamic({ id: 'demo', description: 'x', system: 'y' }), (e) => e.status === 409);
  await assert.rejects(by['role.create'].dynamic({ id: 'navegante', description: 'x', system: 'y' }), (e) => e.status === 409);
  assert.throws(() => by['role.create'].handler({ id: 'otro', description: 'x', system: '  ' }), (e) => e.status === 400);
});
