#!/usr/bin/env node
// Pruebas del coordinador del equipo (server/coordinator.js, función pura): cada regla y cada protección.
import { plan, IDLE_MIN } from '../server/coordinator.js';
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const roles = { java: { kind: 'dev' }, web: { kind: 'dev' }, qa: { kind: 'qa' }, po: { kind: 'planner' } };
const now = 1_000_000_000;
const ag = (id, role, engine = 'claude', extra = {}) => ({ id, name: id, role, engine, ...extra });
const tk = (id, role, status = 'todo', extra = {}) => ({ id, role, status, kind: 'work', dependsOn: [], ...extra });
const both = { claude: true, codex: true };
const types = (a) => a.map((x) => x.type).join(',');

console.log('Motor sin cuota');
let a = plan({ team: [ag('A', 'java', 'codex')], tasks: [tk('t1', 'java')], roles, engineOk: { claude: true, codex: false }, now });
check('codex sin cuota + trabajo listo + claude con margen → pasa a auto', a[0]?.type === 'engine' && a[0].engine === 'auto' && a[0].agentId === 'A', JSON.stringify(a));
check('…y no se contrata a nadie (con auto ya puede trabajar)', !a.some((x) => x.type === 'hire'));
a = plan({ team: [ag('A', 'java', 'codex')], tasks: [tk('t1', 'java')], roles, engineOk: { claude: false, codex: false }, now });
check('los dos motores sin cuota → nada', a.length === 0, JSON.stringify(a));
a = plan({ team: [ag('A', 'java', 'codex')], tasks: [tk('t1', 'web')], roles, engineOk: { claude: true, codex: false }, now });
check('sin trabajo listo para su rol → no se le cambia el motor', !a.some((x) => x.type === 'engine'));
a = plan({ team: [ag('A', 'java', 'codex')], tasks: [tk('t1', 'java')], roles, engineOk: { claude: true, codex: false }, busy: new Set(['A']), now });
check('trabajando → no se le toca', !a.some((x) => x.type === 'engine'));

console.log('Rol atascado');
a = plan({ team: [ag('W', 'web')], bench: [ag('J', 'java', 'auto')], tasks: [tk('t1', 'java')], roles, engineOk: both, now });
check('trabajo de java sin nadie y uno en el banquillo → vuelve (sign)', a[0]?.type === 'sign' && a[0].agentId === 'J', JSON.stringify(a));
a = plan({ team: [ag('W', 'web')], tasks: [tk('t1', 'java')], roles, engineOk: both, margin: { claude: 10, codex: 60 }, now });
check('sin banquillo → contrata con el motor de más margen (codex)', a[0]?.type === 'hire' && a[0].role === 'java' && a[0].engine === 'codex', JSON.stringify(a));
a = plan({ team: [ag('J', 'java')], tasks: [tk('t1', 'java'), tk('t2', 'java')], roles, engineOk: both, now });
check('2 listas y 1 agente → no hace falta reforzar', a.length === 0, JSON.stringify(a));
a = plan({ team: [ag('J', 'java')], tasks: ['1', '2', '3', '4'].map((i) => tk('t' + i, 'java')), roles, engineOk: both, now });
check('4 listas y 1 agente (≥3 por agente) → refuerza', a[0]?.type === 'hire' && a[0].role === 'java', JSON.stringify(a));
a = plan({ team: [ag('J', 'java')], tasks: [tk('t0', 'java', 'doing'), tk('t1', 'java', 'todo', { dependsOn: ['t0'] }), tk('t2', 'java', 'todo', { dependsOn: ['t0'] }), tk('t3', 'java', 'todo', { dependsOn: ['t0'] })], roles, engineOk: both, now });
check('las que esperan dependencias no cuentan como listas', a.length === 0, JSON.stringify(a));

console.log('Mesas llenas');
const full = (extra = {}) => [ag('PO', 'po'), ag('Q1', 'qa', 'codex'), ag('Q2', 'qa', 'claude'), ag('W1', 'web'), ag('W2', 'web'), ag('D1', 'web'), ag('D2', 'web'), ag('X', 'web', 'claude', extra)];
const idle = (min) => Object.fromEntries(full().map((x) => [x.id, now - min * 60_000]));
a = plan({ team: full(), tasks: [tk('t1', 'java'), tk('q', 'qa', 'backlog')], roles, engineOk: both, idleSince: idle(IDLE_MIN + 5), now });
check('sin mesa: un ocioso al banquillo y se contrata java', types(a) === 'bench,hire' && a[1].role === 'java', JSON.stringify(a.map((x) => x.why)));
a = plan({ team: full(), tasks: [tk('t1', 'java')], roles, engineOk: both, idleSince: idle(IDLE_MIN - 5), now });
check('ociosos de hace poco (< IDLE_MIN) → no se toca a nadie', a.length === 0, JSON.stringify(a));
const team1 = [ag('PO', 'po'), ag('Q', 'qa'), ag('W1', 'web', 'claude'), ag('W2', 'web'), ag('W3', 'web'), ag('W4', 'web'), ag('W5', 'web'), ag('W6', 'web')];
a = plan({ team: team1, tasks: [tk('t1', 'java'), tk('q1', 'qa', 'todo', { dependsOn: ['t1'] }), tk('w', 'web', 'todo', { assignedAgentId: 'W1' }), ...['W2', 'W3', 'W4', 'W5', 'W6'].map((w) => tk('p' + w, 'web', 'todo', { preferAgentId: w }))], roles, engineOk: both, idleSince: Object.fromEntries(team1.map((x) => [x.id, now - 60 * 60_000])), now });
check('nunca al PO, ni al único QA con QA pendiente, ni a quien tiene tareas suyas', a.length === 0, JSON.stringify(a.map((x) => x.why)));
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
