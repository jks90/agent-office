// FT-160 · team.js como máquina de estados de tareas. Datos en un directorio temporal, proyecto parado (tick no lanza nada)
// y motor `demo`: sin red ni claude/codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-data-'));
const store = await import('../server/store.js');
const team = await import('../server/team.js');
const review = await import('../server/review.js');
const { get } = store;

const project = await team.createProject({ name: 'Unit Team', engine: 'demo' });
const mk = (title, extra = {}) => team.createTask({ projectId: project.id, title, role: 'back', ...extra });
const status = (id) => get().tasks.find((t) => t.id === id)?.status;
const rejects = async (fn, code) => { try { await fn(); } catch (e) { assert.equal(e.status, code, e.message); return; } assert.fail('debía fallar'); };
const toReview = (t) => { t.status = 'review'; t.reviewAt = Date.now(); return t; }; // lo que haría runTask al terminar

test.after(() => { store.flush(); });

test('estados válidos y datos aislados', () => {
  assert.deepEqual(team.STATUSES, ['backlog', 'todo', 'doing', 'review', 'done', 'failed', 'discarded']);
  assert.ok([...team.RESOLVED].every((s) => ['done', 'discarded'].includes(s)));
  assert.ok(store.DATA_DIR.startsWith(os.tmpdir()));
  assert.equal(project.running, false);
});

test('createTask: valida, asigna código correlativo y filtra dependsOn inexistentes', () => {
  assert.throws(() => mk('  '), (e) => e.status === 400);
  assert.throws(() => mk('x', { role: 'nope' }), (e) => e.status === 400);
  assert.throws(() => mk('x', { repo: 'no-existe' }), (e) => e.status === 400);
  const a = mk('A');
  const b = mk('B', { dependsOn: [a.id, 'fantasma'] });
  assert.equal(a.status, 'todo');
  assert.notEqual(a.code, b.code);
  assert.equal(Number(b.code.split('-')[1]), Number(a.code.split('-')[1]) + 1);
  assert.deepEqual(b.dependsOn, [a.id]);
  assert.equal(mk('Bk', { status: 'backlog' }).status, 'backlog');
  assert.equal(mk('raro', { status: 'doing' }).status, 'todo'); // no se crea «en curso»
});

test('transiciones manuales: backlog/todo/discarded sí; doing/review/done no', () => {
  const t = mk('T1');
  assert.equal(team.updateTask(t.id, { status: 'backlog' }).status, 'backlog');
  assert.equal(team.updateTask(t.id, { status: 'todo' }).status, 'todo');
  for (const bad of ['doing', 'review', 'done', 'failed']) assert.throws(() => team.updateTask(t.id, { status: bad }), (e) => e.status === 409, bad);
  assert.equal(status(t.id), 'todo');
  assert.equal(team.updateTask(t.id, { status: 'discarded' }).status, 'discarded');
  assert.equal(team.updateTask(t.id, { status: 'todo' }).status, 'todo'); // se puede recuperar
});

test('transiciones inválidas: tareas empezadas no se mueven a mano ni se editan en curso', () => {
  const t = mk('T2');
  toReview(t);
  assert.throws(() => team.updateTask(t.id, { status: 'todo' }), (e) => e.status === 409);
  t.status = 'doing';
  assert.throws(() => team.updateTask(t.id, { title: 'otro' }), (e) => e.status === 409);
  assert.throws(() => team.assignTask(t.id, null), (e) => e.status === 409);
  t.status = 'done';
  assert.throws(() => team.updateTask(t.id, { status: 'backlog' }), (e) => e.status === 409);
});

test('approve/reject solo en el estado que toca', async () => {
  const t = mk('T3');
  await rejects(() => team.approve(t.id), 409);          // todo no se aprueba
  await rejects(() => team.reject(t.id, 'no'), 409);     // ni se devuelve
  await rejects(() => team.approve('nada'), 404);
  toReview(t);
  await team.approve(t.id);
  assert.equal(t.status, 'done');
  assert.equal(t.reviewLog.at(-1).verdict, 'approved');
  await rejects(() => team.approve(t.id), 409);          // ya hecha
});

test('revisión: devolver vuelve a «todo», escala modelo (con tope) y deja feedback', async () => {
  const t = mk('T4');
  toReview(t);
  await team.reject(t.id, 'Falta un test. Y más.');
  assert.equal(t.status, 'todo');
  assert.equal(t.returns, 1);
  assert.equal(t.escalations, 1);
  assert.match(t.feedback, /Falta un test/);
  assert.equal(t.agentId, null);
  assert.equal(t.reviewAt, undefined);
  for (let i = 0; i < 4; i++) { toReview(t); await team.reject(t.id, 'otra'); }
  assert.equal(t.escalations, 2); // MAX_ESCALATIONS
  assert.equal(t.returns, 5);
  t.status = 'failed';
  await team.reject(t.id, 'reintento'); // una fallida también se devuelve, sin escalar de nuevo
  assert.equal(t.status, 'todo');
});

test('freno anti-bucle: devolución automática cuenta ciclos; la humana los reinicia', async () => {
  const t = mk('T5');
  for (let i = 1; i <= 3; i++) { toReview(t); await team.reject(t.id, 'auto', [], [], 'Revisor'); assert.equal(t.autoReviews, i); }
  toReview(t);
  await team.reject(t.id, 'humano');
  assert.equal(t.autoReviews, undefined);
  assert.deepEqual(t.reviewLog.slice(-1).map((x) => [x.by, x.verdict]), [['human', 'rejected']]);
});

test('aprobación automática: guarda quién y el veredicto', async () => {
  const t = mk('T6');
  toReview(t);
  await team.approve(t.id, { by: 'Revisor', verdict: { text: 'todo ok' } });
  assert.equal(t.status, 'done');
  assert.equal(t.autoApproved.by, 'Revisor');
  assert.equal(t.autoApproved.text, 'todo ok');
});

test('dependsOn: editar quita autorreferencias; borrar una tarea la quita de las dependientes', async () => {
  const a = mk('Da'), b = mk('Db');
  team.updateTask(b.id, { dependsOn: [a.id, b.id, 'fantasma'] });
  assert.deepEqual(b.dependsOn, [a.id]);
  await team.deleteTask(a.id);
  assert.deepEqual(b.dependsOn, []);
  const doing = mk('Dc');
  doing.status = 'doing';
  await rejects(() => team.deleteTask(doing.id), 409);
});

test('descartadas: se ven como resueltas para el resto y no se planifican', () => {
  const a = mk('Xa', { status: 'backlog' });
  const b = mk('Xb', { dependsOn: [a.id] });
  const view = (id) => review.decorate(get().tasks).find((t) => t.id === id);
  assert.equal(view(b.id).waitingOn[0].id, a.id);
  team.updateTask(a.id, { status: 'discarded' });
  assert.equal(view(b.id).waitingOn, undefined);
  assert.equal(team.withPlannedAgents(get()).find((t) => t.id === a.id).plannedAgentId, undefined); // no es backlog/todo/failed: sin campos
});

test('reasignación: assignTask fija el agente, valida equipo y estado, y null vuelve a elegir por rol', () => {
  const t = mk('Ra');
  const back = get().agents.find((a) => a.role === 'back');
  const front = get().agents.find((a) => a.role === 'front');
  assert.equal(team.assignTask(t.id, front.id).assignedAgentId, front.id);
  assert.equal(team.withPlannedAgents(get()).find((x) => x.id === t.id).plannedAgentId, front.id); // manda lo fijado aunque el rol sea back
  assert.equal(team.assignTask(t.id, null).assignedAgentId, undefined);
  assert.equal(team.withPlannedAgents(get()).find((x) => x.id === t.id).plannedAgentId, back.id);
  assert.throws(() => team.assignTask(t.id, 'nadie'), (e) => e.status === 404);
  const ajeno = store.newId();
  get().agents.push({ id: ajeno, name: 'Ajeno', role: 'back', engine: 'demo', status: 'idle' });
  assert.throws(() => team.assignTask(t.id, ajeno), (e) => e.status === 400); // fuera del equipo del proyecto
});

test('plannedAgentFor: libre antes que ocupado; agente fijado ya fuera del equipo → motivo', () => {
  const roles = { back: { handles: [] }, full: { handles: ['back'] } };
  const p = { team: ['a', 'b', 'c'] };
  const ags = [{ id: 'a', role: 'back' }, { id: 'b', role: 'back' }, { id: 'c', role: 'full' }, { id: 'z', role: 'back' }];
  assert.equal(team.plannedAgentFor(p, { role: 'back' }, ags, { roles, isBusy: (a) => a.id === 'a' }).id, 'b');
  assert.equal(team.plannedAgentFor(p, { role: 'back' }, ags, { roles, isBusy: () => true }).id, 'a');     // todos ocupados: el primero
  assert.equal(team.plannedAgentFor(p, { role: 'back', assignedAgentId: 'c' }, ags, { roles }).id, 'c');   // handles
  assert.equal(team.plannedAgentFor(p, { role: 'back', assignedAgentId: 'z' }, ags, { roles }), null);    // z no está en el equipo
  assert.equal(team.plannedAgentFor(p, { role: 'qa' }, ags, { roles }), null);
});

test('waitsForNotice: detecta promesas de avisar en segundo plano', () => {
  assert.ok(team.waitsForNotice('El servidor sigue corriendo en segundo plano, me aviso cuando acabe'));
  assert.ok(team.waitsForNotice('will notify me'));
  assert.ok(!team.waitsForNotice('Terminado, todo verificado.'));
});
