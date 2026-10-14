// 🪪 Identidad inmutable del agente: nace con uid, nombre de nacimiento y físico (muñeco 3D); renombrar es un bautizo;
// copiar = clon (misma identidad); al compartir (paquete de agente o de equipo) viaja intacta y retocada se rechaza.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-identity-data-'));
process.env.AO_TEST_ALLOW_UNLINKED = '1';
const store = await import('../server/store.js');
store.get().settings.catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-identity-cat-'));
store.get().settings.workspaceHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-identity-ws-'));
const identity = await import('../server/identity.js');
const team = await import('../server/team.js');
const teams = await import('../server/teams.js');
const mp = await import('../server/marketplace.js');
const { get } = store;

test.after(() => store.flush());
const rejects = (fn, code) => assert.throws(fn, (e) => e.status === code);

test('el físico es determinista por semilla y válido', () => {
  assert.deepEqual(identity.avatarFromSeed(42), identity.avatarFromSeed(42));
  const seen = new Set(Array.from({ length: 200 }, (_, i) => JSON.stringify(identity.avatarFromSeed(i))));
  assert.ok(seen.size > 190, 'semillas distintas → físicos distintos');
  const id = identity.newIdentity('Berta');
  assert.match(id.uid, /^ag_[0-9a-f-]{36}$/);
  assert.equal(identity.verify(JSON.parse(JSON.stringify(id)))?.uid, id.uid);
  assert.ok(Object.isFrozen(id) && Object.isFrozen(id.avatar));
});

test('verify rechaza una identidad retocada o mal formada', () => {
  const id = JSON.parse(JSON.stringify(identity.newIdentity('Berta')));
  assert.equal(identity.verify({ ...id, birthName: 'Otra' }), null);
  assert.equal(identity.verify({ ...id, avatar: { ...id.avatar, accessory: 'cap' === id.avatar.accessory ? 'glasses' : 'cap' } }), null);
  assert.equal(identity.verify({ ...id, avatar: { ...id.avatar, base: 'robot' } }), null);
  assert.equal(identity.verify(null), null);
});

test('un agente antiguo conserva su muñeco (hash(name + id))', () => {
  const a = { id: 'abc123', name: 'Pepe', createdAt: 1 };
  const l = identity.legacyIdentity(a);
  assert.equal(l.avatar.base, identity.CHARACTERS[identity.hash('Pepeabc123') % 12]);
  assert.equal(l.birthName, 'Pepe');
  assert.ok(identity.verify(JSON.parse(JSON.stringify(l))));
});

test('contratar da identidad; renombrar es un bautizo y la identidad no cambia', () => {
  const a = team.hire({ name: 'Berta', role: 'back', engine: 'demo' });
  const before = JSON.stringify(a.identity);
  assert.equal(a.identity.birthName, 'Berta');
  team.updateAgent(a.id, { name: 'Contable' });
  team.updateAgent(a.id, { name: 'Contable' }); // mismo nombre: sin bautizo nuevo
  team.updateAgent(a.id, { name: 'Tesorera' });
  assert.equal(a.name, 'Tesorera');
  assert.equal(JSON.stringify(a.identity), before);
  assert.deepEqual(a.baptisms.map((b) => [b.from, b.to]), [['Berta', 'Contable'], ['Contable', 'Tesorera']]);
  rejects(() => team.updateAgent(a.id, { identity: { ...a.identity, birthName: 'X' } }), 409);
  team.updateAgent(a.id, { identity: a.identity }); // la misma: se ignora
});

test('copiar a otro proyecto = clon con la misma identidad', async () => {
  const A = await team.createProject({ name: 'Alfa', engine: 'demo', coordinator: false, defaultTeam: false });
  const B = await team.createProject({ name: 'Beta', engine: 'demo', coordinator: false, defaultTeam: false });
  const a = team.hire({ projectId: A.id, name: 'Lola', role: 'front', engine: 'demo' });
  const c = team.moveAgent(a.id, A.id, B.id, { copy: true });
  assert.notEqual(c.id, a.id);
  assert.equal(c.identity.uid, a.identity.uid);
  assert.equal(c.identity.fingerprint, a.identity.fingerprint);
  assert.equal(c.identity.birthName, 'Lola');
  assert.deepEqual(c.baptisms.map((b) => b.to), ['Lola (copia)']);
});

test('paquete de agente: viaja su identidad y bautizos; retocada → 422', async () => {
  const P = await team.createProject({ name: 'Gamma', engine: 'demo', coordinator: false, defaultTeam: false });
  const a = team.hire({ projectId: P.id, name: 'Rita', role: 'back', engine: 'demo' });
  team.updateAgent(a.id, { name: 'Rita la Cantaora' });
  const pkg = JSON.parse(JSON.stringify(mp.exportPackage('agent', a.id, 'team')));
  assert.equal(pkg.meta.identity.uid, a.identity.uid);
  const r = mp.importPackage(pkg, { projectId: P.id });
  assert.notEqual(r.agent.id, a.id);
  assert.equal(r.agent.identity.uid, a.identity.uid);
  assert.equal(r.agent.identity.birthName, 'Rita');
  assert.equal(r.agent.name, 'Rita la Cantaora');
  assert.deepEqual(r.agent.baptisms.map((b) => b.to), ['Rita la Cantaora']);
  // Instalarlo con otro nombre = bautizo al llegar
  const r2 = mp.importPackage(pkg, { projectId: P.id, agentName: 'Rita 2' });
  assert.deepEqual(r2.agent.baptisms.map((b) => b.to), ['Rita la Cantaora', 'Rita 2']);
  const bad = JSON.parse(JSON.stringify(pkg)); bad.meta.identity.avatar.outfit = '#000000';
  rejects(() => mp.importPackage(bad, { projectId: P.id }), 422);
});

test('equipo: los miembros llevan su identidad y se reutiliza al mismo agente (no a otro del mismo rol)', async () => {
  const S = await team.createProject({ name: 'Origen', engine: 'demo', coordinator: false, defaultTeam: false });
  const x = team.hire({ projectId: S.id, name: 'Xavi', role: 'qa', engine: 'demo' });
  const { spec } = teams.teamSpecOf(S.id);
  assert.equal(spec.members[0].identity.uid, x.identity.uid);
  const other = team.hire({ name: 'Otro QA', role: 'qa', engine: 'demo' }); // en el banquillo, mismo rol
  const D = await team.createProject({ name: 'Destino', engine: 'demo', coordinator: false, defaultTeam: false });
  const json = JSON.parse(JSON.stringify(spec));
  const res = teams.applyTeam({ spec: json, roles: {}, skills: {}, origin: 'marketplace' }, D.id, { coordinator: false });
  const got = get().agents.filter((a) => D.team.includes(a.id));
  assert.equal(got.length, 1);
  assert.equal(got[0].identity.uid, x.identity.uid, 'clon de Xavi, no «Otro QA»');
  assert.notEqual(got[0].id, other.id);
  assert.equal(res.hired.length, 1);
  json.members[0].identity.birthName = 'Falso';
  const E = await team.createProject({ name: 'Eps', engine: 'demo', coordinator: false, defaultTeam: false });
  rejects(() => teams.applyTeam({ spec: json, roles: {}, skills: {}, origin: 'marketplace' }, E.id, { coordinator: false }), 422);
});
