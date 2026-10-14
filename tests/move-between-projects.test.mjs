// ⇄ Mover / copiar tareas, programadas y agentes entre proyectos. Datos en un directorio temporal y proyectos parados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-move-data-'));
process.env.AO_TEST_ALLOW_UNLINKED = '1'; // proyectos sin carpeta: sin flow-test
const store = await import('../server/store.js');
const team = await import('../server/team.js');
const { get } = store;

const A = await team.createProject({ name: 'Alfa', engine: 'demo', coordinator: false });
const B = await team.createProject({ name: 'Beta', engine: 'demo', coordinator: false, defaultTeam: false });
team.updateProject(A.id, { prefix: 'ALF' }); team.updateProject(B.id, { prefix: 'BET' });
const rejects = (fn, code) => assert.throws(fn, (e) => e.status === code);

test.after(() => { store.flush(); });

test('mover tarea: código nuevo del destino, suelta dependencias y asignación de allí', () => {
  const dep = team.createTask({ projectId: A.id, title: 'Base', role: 'back' });
  const t = team.createTask({ projectId: A.id, title: 'Mover esto', role: 'back', dependsOn: [dep.id], status: 'backlog', assignedAgentId: A.team[0] });
  const child = team.createTask({ projectId: A.id, title: 'Hija', role: 'back', dependsOn: [t.id] });
  const old = t.code;
  const r = team.moveTask(t.id, B.id);
  assert.equal(r.task.projectId, B.id);
  assert.match(r.task.code, /^BET-\d+$/);
  assert.deepEqual(r.task.dependsOn, []);
  assert.equal(r.task.assignedAgentId, undefined);
  assert.equal(r.task.status, 'backlog');
  assert.deepEqual(r.task.movedFrom.code, old);
  assert.ok(!get().tasks.find((x) => x.id === child.id).dependsOn.includes(t.id));
  assert.ok(r.dropped.length >= 2);
});

test('mover tarea: no si ya empezó ni al mismo proyecto', () => {
  const t = team.createTask({ projectId: A.id, title: 'En revisión', role: 'back' });
  t.status = 'review';
  rejects(() => team.moveTask(t.id, B.id), 409);
  const u = team.createTask({ projectId: A.id, title: 'Quieta', role: 'back' });
  rejects(() => team.moveTask(u.id, A.id), 400);
  rejects(() => team.moveTask(u.id, 'noexiste'), 404);
});

test('programadas: copiar la deja desactivada y sin webhook; mover la quita del origen', () => {
  const sch = team.saveSchedule(A.id, { title: 'Diaria', role: 'back', at: '09:00', webhook: true });
  const c = team.moveSchedule(A.id, sch.id, B.id, { copy: true });
  assert.notEqual(c.id, sch.id);
  assert.equal(c.enabled, false);
  assert.equal(c.hookToken, undefined);
  assert.ok(get().projects.find((p) => p.id === A.id).schedules.some((x) => x.id === sch.id));
  const m = team.moveSchedule(A.id, sch.id, B.id);
  assert.equal(m.id, sch.id);
  assert.ok(m.hookToken);
  assert.ok(!get().projects.find((p) => p.id === A.id).schedules.some((x) => x.id === sch.id));
  assert.equal(get().projects.find((p) => p.id === B.id).schedules.length, 2);
});

test('agentes: copiar crea otro con la misma configuración; mover cambia de equipo', () => {
  const src = get().agents.find((a) => a.id === A.team[0]);
  team.updateAgent(src.id, { mcps: ['home'], skills: ['flows'] });
  const clone = team.moveAgent(src.id, A.id, B.id, { copy: true, name: 'Clon' });
  assert.notEqual(clone.id, src.id);
  assert.equal(clone.name, 'Clon');
  assert.equal(clone.role, src.role);
  assert.deepEqual(clone.mcps, ['home']);
  assert.ok(get().projects.find((p) => p.id === B.id).team.includes(clone.id));
  assert.ok(get().projects.find((p) => p.id === A.id).team.includes(src.id));
  const other = get().agents.find((a) => a.id === A.team[1]);
  team.moveAgent(other.id, A.id, B.id);
  assert.ok(!get().projects.find((p) => p.id === A.id).team.includes(other.id));
  assert.ok(get().projects.find((p) => p.id === B.id).team.includes(other.id));
  rejects(() => team.moveAgent(other.id, A.id, B.id), 409); // ya está allí
  other.status = 'working';
  const third = get().agents.find((a) => a.id === A.team[1]);
  third.status = 'working';
  rejects(() => team.moveAgent(third.id, A.id, B.id), 409); // trabajando
  third.status = 'idle'; other.status = 'idle';
});
