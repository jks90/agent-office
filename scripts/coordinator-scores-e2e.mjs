#!/usr/bin/env node
// Coordinador con notas de agentes (FT-154): puntuaciones sintéticas para cada regla (reparto, críticas, modelo por rol subir/bajar,
// banquillo, revisor automático, exclusiones) + notas reales desde un historial sintético (scores.forCoordinator). Sin IA ni servidor.
//   node scripts/coordinator-scores-e2e.mjs
import { pickByScore, scorePlan, isCritical } from '../server/coordinator.js';
import { forCoordinator } from '../server/scores.js';

let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const roles = { qa: { kind: 'qa', model: 'haiku' }, dev: { kind: 'dev' }, po: { kind: 'planner' }, coordinador: { kind: 'supervisor' } };
const ag = (id, role, o = {}) => ({ id, name: id.toUpperCase(), role, engine: 'claude', ...o });
const sc = (o) => ({ byAgentRole: {}, byAgent: {}, roleModels: [], ...o });

console.log('Reparto por nota');
{
  const a = ag('a', 'dev'), b = ag('b', 'dev'), c = ag('c', 'dev');
  const scores = sc({ byAgentRole: { 'a|dev': { score: 60, tasks: 5 }, 'b|dev': { score: 90, tasks: 5 }, 'c|dev': { score: 45, tasks: 5 } } });
  const t = { id: 't1', code: 'FT-1', role: 'dev', priority: 10 };
  const r = pickByScore(t, [a, b, c], scores);
  check('gana la mejor nota (b) y deja motivo', r.agent.id === 'b' && /B.*90.*antes que A/.test(r.why), JSON.stringify(r));
  check('si ya iba primero la mejor, sin motivo', pickByScore(t, [b, a], scores).why === null);
  check('sin notas, el orden de siempre', pickByScore(t, [a, b], null).agent.id === 'a');
  check('crítica por prioridad ≥ 85', isCritical({ priority: 85 }) && !isCritical({ priority: 84 }));
  check('crítica por reviewRequired', isCritical({ reviewRequired: true }));
  const crit = { ...t, priority: 90 };
  const r2 = pickByScore(crit, [c, a], scores);
  check('crítica: no va a quien tiene < 50 (c 45) → a', r2.agent.id === 'a' && /crítica/.test(r2.why), JSON.stringify(r2));
  const r3 = pickByScore({ ...t, reviewRequired: true }, [c], scores);
  check('crítica con solo un < 50 libre → espera (null) con motivo', r3.agent === null && /espera/.test(r3.why), JSON.stringify(r3));
  check('no crítica sí puede ir a c', pickByScore(t, [c], scores).agent.id === 'c');
  check('sin nota no se excluye en críticas', pickByScore(crit, [ag('n', 'dev')], scores).agent.id === 'n');
}

console.log('Modelo por rol');
{
  const rm = (role, model, score, tasks, engine = 'claude') => ({ role, engine, model, score, tasks });
  const team = [ag('v', 'qa', { model: 'haiku' }), ag('j', 'qa', { model: 'sonnet' }), ag('d', 'dev', { model: 'sonnet' }), ag('p', 'po', { model: 'haiku' })];
  const base = { team, roles, busy: new Set(), tasks: [] };
  let acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 50, 6), rm('qa', 'sonnet', 80, 6)] }) }).filter((x) => x.type === 'model');
  check('haiku 50 (6) y sonnet 80 → sube al agente de haiku', acts.length === 1 && acts[0].model === 'sonnet' && acts[0].agentIds.join() === 'v' && !acts[0].advisory, JSON.stringify(acts));
  check('el motivo cita notas', /50.*80/.test(acts[0]?.why || ''), acts[0]?.why);
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 50, 4), rm('qa', 'sonnet', 80, 6)] }) }).filter((x) => x.type === 'model');
  check('con < 5 tareas no propone', acts.length === 0);
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 50, 6), rm('qa', 'sonnet', 70, 6)] }) }).filter((x) => x.type === 'model');
  check('sonnet justo 70 (no > 70) no propone', acts.length === 0);
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 55, 6), rm('qa', 'sonnet', 90, 6)] }) }).filter((x) => x.type === 'model' && !x.advisory);
  check('haiku justo 55 (no < 55) no sube', acts.length === 0);
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 78, 6), rm('qa', 'sonnet', 80, 6)] }) }).filter((x) => x.type === 'model');
  check('haiku ≥ 75 → propone bajar al agente de sonnet (solo sugerencia)', acts.length === 1 && acts[0].model === 'haiku' && acts[0].agentIds.join() === 'j' && acts[0].advisory, JSON.stringify(acts));
  acts = scorePlan({ ...base, busy: new Set(['v']), scores: sc({ roleModels: [rm('qa', 'haiku', 50, 6), rm('qa', 'sonnet', 80, 6)] }) }).filter((x) => x.type === 'model');
  check('no toca a quien está trabajando', acts.length === 0);
  acts = scorePlan({ ...base, tasks: [{ status: 'todo', assignedAgentId: 'v' }], scores: sc({ roleModels: [rm('qa', 'haiku', 50, 6), rm('qa', 'sonnet', 80, 6)] }) }).filter((x) => x.type === 'model');
  check('ni a quien tiene tareas suyas esperando', acts.length === 0);
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('po', 'haiku', 20, 9), rm('po', 'sonnet', 90, 9)] }) });
  check('nunca toca al PO', acts.length === 0, JSON.stringify(acts));
  acts = scorePlan({ ...base, scores: sc({ roleModels: [rm('qa', 'haiku', 50, 6, 'codex'), rm('qa', 'sonnet', 80, 6, 'claude')] }) });
  check('modelos de motores distintos no se comparan', acts.length === 0);
}

console.log('Plantilla');
{
  const team = [ag('a', 'dev'), ag('b', 'dev'), ag('c', 'dev'), ag('d', 'dev'), ag('p', 'po'), ag('r', 'dev', { autoReviewer: true })];
  const scores = sc({ byAgent: { a: { score: 39, tasks: 5 }, b: { score: 40, tasks: 5 }, c: { score: 86, tasks: 5 }, d: { score: 20, tasks: 4 }, p: { score: 10, tasks: 5 }, r: { score: 95, tasks: 5 } } });
  const acts = scorePlan({ team, roles, busy: new Set(), tasks: [], scores });
  const bench = acts.filter((x) => x.type === 'bench'), rev = acts.filter((x) => x.type === 'reviewer');
  check('< 40 en 5 tareas → banquillo (solo sugerencia)', bench.length === 1 && bench[0].agentId === 'a' && bench[0].advisory && /39/.test(bench[0].why), JSON.stringify(bench));
  check('40 justo y < 5 tareas no salen', !bench.some((x) => ['b', 'd'].includes(x.agentId)));
  check('> 85 → revisor automático de su rol', rev.length === 1 && rev[0].agentId === 'c' && rev[0].role === 'dev' && rev[0].advisory, JSON.stringify(rev));
  check('el PO no sale, ni quien ya es revisor', !acts.some((x) => ['p', 'r'].includes(x.agentId)));
  const busyActs = scorePlan({ team, roles, busy: new Set(['a', 'c']), tasks: [], scores });
  check('quien trabaja no sale', busyActs.length === 0, JSON.stringify(busyActs));
  check('sin notas no hay acciones', scorePlan({ team, roles, scores: null }).length === 0);
}

console.log('Notas desde el historial (forCoordinator)');
{
  const now = Date.now(), DAY = 86_400_000;
  let n = 0;
  const mk = (o) => { const at = now - 3 * DAY; const t = { id: 't' + ++n, code: 'FT-' + (300 + n), projectId: 'p', kind: 'task', status: 'done', returns: 0, costUsd: 1, startedAt: at - 300_000, updatedAt: at, role: 'qa', ...o };
    t.modelHistory = [{ model: o.model, engine: 'claude', attempt: 1, at: at - 300_000 }]; delete t.model; return t; };
  const bad = (i) => mk({ model: 'haiku', agentId: 'v', returns: 3, budgetHitCount: 1, reviewLog: [4, 5, 6].map((d) => ({ verdict: 'rejected', text: 'Informe falso: dice 248/248 pero en realidad falla', at: now - d * DAY })), costUsd: 4 + i });
  const state = { settings: {}, agents: [ag('v', 'qa', { model: 'haiku' }), ag('j', 'qa', { model: 'sonnet' })],
    tasks: [...[1, 2, 3, 4, 5, 6].map(bad), ...[1, 2, 3, 4, 5, 6].map(() => mk({ model: 'sonnet', agentId: 'j', costUsd: 0.5 }))] };
  const s = forCoordinator(state, { now });
  const lo = s.roleModels.find((x) => x.model === 'haiku'), hi = s.roleModels.find((x) => x.model === 'sonnet');
  check('nota por rol+modelo: haiku bajo, sonnet alto', lo && hi && lo.score < 55 && hi.score > 70, JSON.stringify(s.roleModels));
  check('byAgentRole y byAgent con las 5 últimas', s.byAgentRole['j|qa']?.score > 70 && s.byAgent.v?.tasks === 5 && s.byAgent.v.score < s.byAgent.j.score, JSON.stringify([s.byAgentRole, s.byAgent]));
  const acts = scorePlan({ team: state.agents, roles, busy: new Set(), tasks: [], scores: s });
  check('de punta a punta: sube a v a sonnet y propone a j de revisor', acts.some((x) => x.type === 'model' && x.agentIds[0] === 'v' && x.model.includes('sonnet')) && acts.some((x) => x.type === 'reviewer' && x.agentId === 'j'), JSON.stringify(acts.map((x) => x.why)));
}

console.log(failed ? `\n${failed} fallos` : '\n✅ coordinator-scores-e2e OK');
process.exit(failed ? 1 : 0);
