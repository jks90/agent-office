// FT-160 · coordinador del equipo (server/coordinator.js, puro). Migrado de scripts/coordinator-unit.mjs y ampliado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, reviewPlan, matches, canWork, IDLE_MIN } from '../server/coordinator.js';

const roles = { java: { kind: 'dev' }, web: { kind: 'dev' }, qa: { kind: 'qa' }, po: { kind: 'planner' }, fullstack: { kind: 'dev', handles: ['java', 'web'] } };
const now = 1_000_000_000;
const ag = (id, role, engine = 'claude', extra = {}) => ({ id, name: id, role, engine, ...extra });
const tk = (id, role, status = 'todo', extra = {}) => ({ id, role, status, kind: 'work', dependsOn: [], ...extra });
const both = { claude: true, codex: true };
const types = (a) => a.map((x) => x.type).join(',');

test('helpers: matches y canWork', () => {
  assert.ok(matches(ag('F', 'fullstack'), 'java', roles));
  assert.ok(!matches(ag('W', 'web'), 'java', roles));
  assert.ok(canWork(ag('A', 'x', 'auto'), { claude: false, codex: true }));
  assert.ok(!canWork(ag('A', 'x', 'codex'), { claude: true, codex: false }));
});

test('motor sin cuota: codex sin cuota con trabajo listo pasa a auto y no se contrata', () => {
  const a = plan({ team: [ag('A', 'java', 'codex')], tasks: [tk('t1', 'java')], roles, engineOk: { claude: true, codex: false }, now });
  assert.equal(a[0]?.type, 'engine');
  assert.equal(a[0].engine, 'auto');
  assert.equal(a[0].agentId, 'A');
  assert.ok(!a.some((x) => x.type === 'hire'));
});

test('motor sin cuota: sin motor alternativo, sin trabajo de su rol o trabajando → no se toca', () => {
  const team = [ag('A', 'java', 'codex')];
  assert.deepEqual(plan({ team, tasks: [tk('t1', 'java')], roles, engineOk: { claude: false, codex: false }, now }), []);
  assert.ok(!plan({ team, tasks: [tk('t1', 'web')], roles, engineOk: { claude: true, codex: false }, now }).some((x) => x.type === 'engine'));
  assert.ok(!plan({ team, tasks: [tk('t1', 'java')], roles, engineOk: { claude: true, codex: false }, busy: new Set(['A']), now }).some((x) => x.type === 'engine'));
});

test('rol atascado: vuelve el del banquillo; sin banquillo contrata con el motor de más margen', () => {
  let a = plan({ team: [ag('W', 'web')], bench: [ag('J', 'java', 'auto')], tasks: [tk('t1', 'java')], roles, engineOk: both, now });
  assert.equal(a[0]?.type, 'sign');
  assert.equal(a[0].agentId, 'J');
  a = plan({ team: [ag('W', 'web')], tasks: [tk('t1', 'java')], roles, engineOk: both, margin: { claude: 10, codex: 60 }, now });
  assert.equal(a[0]?.type, 'hire');
  assert.equal(a[0].role, 'java');
  assert.equal(a[0].engine, 'codex');
});

test('refuerzo: 2 listas/1 agente no; 4 listas/1 agente sí; las que esperan dependencias no cuentan', () => {
  const team = [ag('J', 'java')];
  assert.deepEqual(plan({ team, tasks: [tk('t1', 'java'), tk('t2', 'java')], roles, engineOk: both, now }), []);
  const a = plan({ team, tasks: ['1', '2', '3', '4'].map((i) => tk('t' + i, 'java')), roles, engineOk: both, now });
  assert.equal(a[0]?.type, 'hire');
  const dep = (id) => tk(id, 'java', 'todo', { dependsOn: ['t0'] });
  assert.deepEqual(plan({ team, tasks: [tk('t0', 'java', 'doing'), dep('t1'), dep('t2'), dep('t3')], roles, engineOk: both, now }), []);
});

test('dependsOn: una dependencia descartada o hecha libera a la tarea', () => {
  const team = [ag('J', 'java')];
  const tasks = (st) => [tk('d', 'java', st), ...['1', '2', '3', '4'].map((i) => tk('t' + i, 'java', 'todo', { dependsOn: ['d'] }))];
  assert.equal(plan({ team, tasks: tasks('discarded'), roles, engineOk: both, now })[0]?.type, 'hire');
  assert.equal(plan({ team, tasks: tasks('done'), roles, engineOk: both, now })[0]?.type, 'hire');
  assert.deepEqual(plan({ team, tasks: tasks('review'), roles, engineOk: both, now }), []);
});

const full = (extra = {}) => [ag('PO', 'po'), ag('Q1', 'qa', 'codex'), ag('Q2', 'qa', 'claude'), ag('W1', 'web'), ag('W2', 'web'), ag('D1', 'web'), ag('D2', 'web'), ag('X', 'web', 'claude', extra)];
const idle = (min) => Object.fromEntries(full().map((x) => [x.id, now - min * 60_000]));

test('mesas llenas: con repos separados por rol → banquillo + contratación (FT-121)', () => {
  const a = plan({ team: full(), tasks: [tk('t1', 'java'), tk('q', 'qa', 'backlog')], roles, engineOk: both, idleSince: idle(IDLE_MIN + 5), repos: [{ roles: ['java'] }, { roles: ['web'] }], now });
  assert.equal(types(a), 'bench,hire');
  assert.equal(a[1].role, 'java');
});

test('mesas llenas: ociosos de hace poco no se tocan', () => {
  assert.deepEqual(plan({ team: full(), tasks: [tk('t1', 'java')], roles, engineOk: both, idleSince: idle(IDLE_MIN - 5), now }), []);
});

test('mesas llenas: nunca al PO, ni al único QA con QA pendiente, ni a quien tiene tareas suyas', () => {
  const team = [ag('PO', 'po'), ag('Q', 'qa'), ag('W1', 'web'), ag('W2', 'web'), ag('W3', 'web'), ag('W4', 'web'), ag('W5', 'web'), ag('W6', 'web')];
  const tasks = [tk('t1', 'java'), tk('q1', 'qa', 'todo', { dependsOn: ['t1'] }), tk('w', 'web', 'todo', { assignedAgentId: 'W1' }), ...['W2', 'W3', 'W4', 'W5', 'W6'].map((w) => tk('p' + w, 'web', 'todo', { preferAgentId: w }))];
  const a = plan({ team, tasks, roles, engineOk: both, idleSince: Object.fromEntries(team.map((x) => [x.id, now - 60 * 60_000])), now });
  assert.deepEqual(a, []);
});

test('reviewPlan: política automática lanza la revisión una sola vez; manual/obligatoria alerta', () => {
  const rv = (extra = {}) => tk('r', 'java', 'review', { code: 'FT-1', title: 'x', reviewAt: now - 20 * 60_000, ...extra });
  const blocked = tk('b', 'java', 'todo', { code: 'FT-2', dependsOn: ['r'] });
  const snap = (over) => ({ tasks: [rv(over.t), blocked], reviewPolicy: over.policy, reviewNudgeMin: 10, now });
  assert.equal(reviewPlan(snap({ policy: 'auto' }))[0]?.type, 'review-now');
  assert.equal(reviewPlan(snap({ policy: 'auto', t: { blockKicked: true } }))[0]?.type, 'review-alert');
  assert.equal(reviewPlan(snap({ policy: 'manual' }))[0]?.type, 'review-alert');
  assert.equal(reviewPlan(snap({ policy: 'auto', t: { reviewRequired: true } }))[0]?.type, 'review-alert');
  assert.deepEqual(reviewPlan(snap({ policy: 'manual', t: { blockAlerted: true } })), []);
  assert.deepEqual(reviewPlan({ ...snap({ policy: 'auto' }), now: now - 15 * 60_000 }), []); // lleva < 10 min
  assert.deepEqual(reviewPlan({ tasks: [rv()], reviewPolicy: 'auto', now }), []);              // no bloquea a nadie
});
