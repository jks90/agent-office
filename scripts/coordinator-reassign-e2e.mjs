#!/usr/bin/env node
// FT-121 · e2e (snapshots sintéticos) del coordinador: reasigna ociosos antes de contratar, devuelve el rol prestado,
// no toca al PO ni a ocupados, y avisa/lanza las revisiones que bloquean.
import { plan, reviewPlan, IDLE_MIN } from '../server/coordinator.js';
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const roles = { back: { kind: 'dev' }, diseno: { kind: 'dev' }, office: { kind: 'dev' }, qa: { kind: 'qa' }, po: { kind: 'planner' } };
const now = 1_000_000_000_000;
const ag = (id, role, extra = {}) => ({ id, name: id, role, engine: 'claude', ...extra });
const tk = (id, role, status = 'todo', extra = {}) => ({ id, role, status, kind: 'work', dependsOn: [], title: id, ...extra });
const ok = { claude: true, codex: true };
const idle = (ids, min = IDLE_MIN + 5) => Object.fromEntries(ids.map((i) => [i, now - min * 60_000]));
const repos = [{ key: 'ft', roles: ['office', 'diseno'] }];

console.log('Reasignar antes que contratar');
let a = plan({ team: [ag('Sofia', 'diseno'), ag('Pepe', 'back')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['Sofia', 'Pepe']), repos, now });
check('rol sin nadie + ocioso del mismo kind → retarget (y no hire)', a.length === 1 && a[0].type === 'retarget' && a[0].role === 'office' && /Sofia|Pepe/.test(a[0].agentId) && !/hire/.test(a.map((x) => x.type).join()), JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['Sofia'], 2), repos, now });
check('ocioso hace poco (< IDLE_MIN) → no se reasigna (se contrata)', a[0]?.type === 'hire', JSON.stringify(a));
a = plan({ team: [ag('PO', 'po')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['PO']), repos, now });
check('nunca al PO', !a.some((x) => x.type === 'retarget'), JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno')], tasks: [tk('t1', 'office')], roles, engineOk: ok, busy: new Set(['Sofia']), idleSince: idle(['Sofia']), repos, now });
check('nunca a quien trabaja', !a.some((x) => x.type === 'retarget'), JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno')], tasks: [tk('t1', 'office'), tk('t2', 'diseno', 'todo', { assignedAgentId: 'Sofia' })], roles, engineOk: ok, idleSince: idle(['Sofia']), repos, now });
check('ni a quien tiene trabajo listo/suyo', !a.some((x) => x.type === 'retarget'), JSON.stringify(a));
a = plan({ team: [ag('Q', 'qa')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['Q']), repos, now });
check('otro kind (qa → dev) no se reasigna', !a.some((x) => x.type === 'retarget'), JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['Sofia']), repos: [{ key: 'x', roles: ['office'] }], now });
check('repo que no admite su rol → no se reasigna', !a.some((x) => x.type === 'retarget'), JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno'), ag('Otro', 'office', { }), ], tasks: [tk('t1', 'office')], roles, engineOk: ok, busy: new Set(['Otro']), idleSince: idle(['Sofia']), repos, now });
check('con un ocupado del rol (cap>0) se reasigna al libre', a[0]?.type === 'retarget', JSON.stringify(a));
a = plan({ team: [ag('Sofia', 'diseno'), ag('Otro', 'office')], tasks: [tk('t1', 'office')], roles, engineOk: ok, idleSince: idle(['Sofia']), repos, now });
check('hay alguien libre del rol → nada', a.length === 0, JSON.stringify(a));

console.log('Devolver el rol');
const lent = ag('Sofia', 'office', { homeRole: 'diseno' });
a = plan({ team: [lent], tasks: [tk('t1', 'diseno'), tk('t2', 'office', 'done')], roles, engineOk: ok, repos, now });
check('sin trabajo listo del rol prestado → restore a homeRole', a[0]?.type === 'restore' && a[0].role === 'diseno', JSON.stringify(a));
a = plan({ team: [lent], tasks: [tk('t2', 'office')], roles, engineOk: ok, repos, now });
check('con trabajo listo del rol prestado → se queda', !a.some((x) => x.type === 'restore'), JSON.stringify(a));
a = plan({ team: [lent], tasks: [], roles, engineOk: ok, busy: new Set(['Sofia']), repos, now });
check('trabajando → no se devuelve', !a.some((x) => x.type === 'restore'), JSON.stringify(a));
a = plan({ team: [lent], tasks: [tk('t1', 'back')], roles, engineOk: ok, idleSince: idle(['Sofia']), repos, now });
check('un prestado no se vuelve a prestar', !a.some((x) => x.type === 'retarget' && x.agentId === 'Sofia'), JSON.stringify(a));

console.log('Revisión que bloquea');
const rv = (extra = {}) => tk('R', 'back', 'review', { code: 'FT-114', reviewAt: now - 30 * 60_000, ...extra });
const dep = (id) => tk(id, 'back', 'todo', { code: id, dependsOn: ['R'] });
const base = { reviewNudgeMin: 10, now };
let r = reviewPlan({ ...base, tasks: [rv(), dep('FT-115'), dep('FT-116')], reviewPolicy: 'auto' });
check('política auto + no obligatoria → review-now', r.length === 1 && r[0].type === 'review-now' && /bloquea a 2/.test(r[0].why), JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ reviewRequired: true }), dep('FT-115'), dep('FT-116'), dep('FT-117'), dep('FT-118'), dep('FT-119')], reviewPolicy: 'auto-qa' });
check('reviewRequired → review-alert «bloquea a 5»', r.length === 1 && r[0].type === 'review-alert' && r[0].required && /bloquea a 5/.test(r[0].why), JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv(), dep('FT-115')], reviewPolicy: 'manual' });
check('política manual → aviso (no se lanza nada)', r[0]?.type === 'review-alert' && !r[0].required, JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ reviewNote: 'sensibles' }), dep('FT-115')], reviewPolicy: 'auto' });
check('ya retenida por la automática → aviso', r[0]?.type === 'review-alert', JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ blockKicked: true }), dep('FT-115')], reviewPolicy: 'auto' });
check('ya lanzada y sigue en revisión → aviso, no se relanza', r[0]?.type === 'review-alert', JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ reviewAt: now - 3 * 60_000 }), dep('FT-115')], reviewPolicy: 'auto' });
check('menos de reviewNudgeMin → nada', r.length === 0, JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv()], reviewPolicy: 'auto' });
check('no bloquea a nadie → nada', r.length === 0, JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ reviewRequired: true, blockAlerted: true }), dep('FT-115')], reviewPolicy: 'auto' });
check('aviso ya dado → no se repite', r.length === 0, JSON.stringify(r));
r = reviewPlan({ ...base, tasks: [rv({ reviewing: 'auto' }), dep('FT-115')], reviewPolicy: 'auto' });
check('revisándose ya → nada', r.length === 0, JSON.stringify(r));

console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
