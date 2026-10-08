#!/usr/bin/env node
// Puntuación de agentes (FT-152): historial sintético → motivos, fichas, puntuaciones, mínimo de tareas, pesos, tendencia y
// GET /api/scores en un servidor temporal. Sin IA, sin navegador.
//   node scripts/scores-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReject, compute, reasonsOf, weightsOf, regressions, DEFAULT_WEIGHTS } from '../server/scores.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000, now = Date.now();

console.log('Clasificación de motivos');
const cases = {
  'tests-rojos': 'El e2e falla: 3 tests en rojo',
  'test-inestable': 'El test es inestable: a veces falla en CI',
  'seguridad': 'Agujero de seguridad: path traversal en la subida',
  'regresion': 'Esto es una regresión: ya no funciona la oficina',
  'choque-main': 'Tu rama choca con main en: README.md; haz git merge main',
  'sin-entregable': 'Lanzó un proceso en segundo plano y no hay cambios que revisar',
  'informe-falso': 'El informe dice 248/248 pero en realidad falla 15/18; informe falso',
  'alcance': 'No hizo lo pedido: falta el endpoint del criterio 2',
  'otro': 'Cambia el color del botón',
};
for (const [k, txt] of Object.entries(cases)) check(`«${txt.slice(0, 40)}…» → ${k}`, classifyReject(txt) === k, classifyReject(txt));
check('secretos versionados → seguridad', classifyReject('Hay secretos versionados en data/') === 'seguridad');
check('nota vacía → otro', classifyReject('') === 'otro');

console.log('Motivos del histórico');
const t0 = { id: 'x', returns: 2, reviewLog: [{ verdict: 'rejected', text: cases.seguridad }, { verdict: 'approved', text: 'ok' }, { verdict: 'rejected', text: cases['tests-rojos'] }] };
check('reviewLog → [seguridad, tests-rojos]', reasonsOf(t0).join() === 'seguridad,tests-rojos', reasonsOf(t0).join());
check('feedback sin log', reasonsOf({ returns: 1, feedback: cases['test-inestable'] }).join() === 'test-inestable');
check('rejectReasons guardados mandan', reasonsOf({ returns: 1, rejectReasons: ['alcance'], feedback: cases.seguridad }).join() === 'alcance');
check('evento TaskReviewed', reasonsOf({ id: 'e', code: 'FT-9', returns: 1 }, [{ type: 'TaskReviewed', taskCode: 'FT-9', data: { decision: 'rejected', feedback: cases['choque-main'] } }]).join() === 'choque-main');
check('sin nota → otro por cada devolución', reasonsOf({ returns: 2 }).join() === 'otro,otro');

console.log('Historial sintético');
let n = 0;
const D5 = now - 5 * DAY;
// Estilo «histórico»: solo t.modelHistory (modelo/instante del intento), sin attemptsLog; el agente sale de t.agentId.
const mk = (o) => {
  const dur = o.dur ?? 300_000, upd = o.updatedAt ?? D5;
  const t = { id: 't' + (++n), code: o.code || `FT-${200 + n}`, projectId: 'p1', kind: 'task', status: 'done', returns: 0, costUsd: 1, startedAt: upd - dur, updatedAt: upd, modelHistory: o.model ? [{ model: o.model, engine: 'claude', attempt: 1, at: upd - dur - (o.returns ? 2 * DAY : 0) }] : undefined, ...o };
  delete t.dur; delete t.model;
  return t;
};
const rejLog = (text, at) => [{ verdict: 'rejected', text, at }];
const tasks = [
  // Julia (sonnet, qa-suite): 4 aprobadas a la primera, baratas y rápidas; una por el revisor automático
  ...[1, 2, 3, 4].map((i) => mk({ role: 'qa-suite', agentId: 'julia', model: 'sonnet', costUsd: 0.4, autoApproved: i === 1 ? { by: 'auto-qa' } : undefined })),
  // Vera (haiku, qa-suite): informe falso, tests rojos, un tope (solo contador: t.budgetHit ya se limpió) y una limpia; caras y lentas
  mk({ role: 'qa-suite', agentId: 'vera', model: 'haiku', returns: 1, reviewLog: rejLog(cases['informe-falso'], now - 6 * DAY), costUsd: 3, dur: 1_200_000 }),
  mk({ role: 'qa-suite', agentId: 'vera', model: 'haiku', returns: 1, reviewLog: rejLog(cases['tests-rojos'], now - 6 * DAY), costUsd: 4, dur: 1_500_000 }),
  mk({ role: 'qa-suite', agentId: 'vera', model: 'haiku', budgetHitCount: 1, costUsd: 3, dur: 1_200_000 }),
  mk({ role: 'qa-suite', agentId: 'vera', model: 'haiku', costUsd: 1.2, dur: 900_000 }),
  // Atribución por intento: la 1.ª entrega la hizo Vera con haiku (informe falso / README con errores) y la 2.ª Julia con sonnet, bien
  ...[['FT-119', cases['informe-falso']], ['FT-120', 'El README reescrito tiene errores: no coincide con lo que hace el código']].map(([code, txt]) => mk({
    code, role: 'qa-suite', agentId: 'julia', returns: 1, rejectAt: [now - 7 * DAY], reviewLog: rejLog(txt, now - 7 * DAY), costUsd: 2, dur: 300_000,
    attemptsLog: [{ attempt: 1, agentId: 'vera', agentName: 'Vera', engine: 'claude', model: 'haiku', startedAt: now - 8 * DAY }, { attempt: 2, agentId: 'julia', agentName: 'Julia', engine: 'claude', model: 'sonnet', startedAt: D5 - 300_000 }],
  })),
  // Dev: FT-122 causó una regresión (la cita FT-126); atasco ya limpiado (solo stuckCount) y tope por evento
  mk({ code: 'FT-122', role: 'dev', agentId: 'ana', model: 'sonnet', dur: 600_000 }),
  mk({ code: 'FT-123', role: 'dev', agentId: 'ana', model: 'sonnet', returns: 1, reviewLog: rejLog(cases.seguridad, now - 6 * DAY), dur: 600_000 }),
  mk({ code: 'FT-124', role: 'dev', agentId: 'ana', model: 'sonnet', stuckCount: 1, dur: 600_000 }),
  mk({ code: 'FT-125', role: 'dev', agentId: 'ana', model: 'sonnet', dur: 600_000 }),
  mk({ code: 'FT-126', role: 'dev', agentId: 'ana', model: 'sonnet', title: 'Arreglar oficina. Regresión FT-122', dur: 600_000 }),
  // Bea: 3 tareas SIN coste ni duración: coste y tiempo no cuentan (ni como 1)
  ...[1, 2, 3].map(() => mk({ role: 'dev', agentId: 'bea', costUsd: null, startedAt: undefined })),
  // Agente retirado con nombre guardado (attemptsLog) y otro sin ningún rastro
  ...[1, 2, 3].map(() => mk({ role: 'docs', agentId: 'gone', agentName: 'Tomás', model: 'sonnet', attemptsLog: [{ attempt: 1, agentId: 'gone', agentName: 'Tomás', engine: 'claude', model: 'sonnet', startedAt: D5 - 300_000 }] })),
  ...[1, 2, 3].map(() => mk({ role: 'docs', agentId: 'ghost', model: 'sonnet' })),
  // Ventana anterior (40 días): tendencia de Julia
  ...[1, 2, 3].map(() => mk({ role: 'qa-suite', agentId: 'julia', model: 'sonnet', returns: 1, reviewLog: rejLog(cases['tests-rojos'], now - 41 * DAY), updatedAt: now - 40 * DAY })),
  // No cuentan: fuera de ventana, otro proyecto, sin terminar
  mk({ code: 'FT-OLD', role: 'qa-suite', agentId: 'julia', model: 'sonnet', updatedAt: now - 100 * DAY }),
  mk({ code: 'FT-P2', role: 'qa-suite', agentId: 'julia', model: 'sonnet', projectId: 'p2' }),
  mk({ code: 'FT-REV', role: 'qa-suite', agentId: 'julia', status: 'review' }),
];
const agents = [{ id: 'julia', name: 'Julia', role: 'qa-suite', engine: 'claude' }, { id: 'vera', name: 'Vera', role: 'qa-suite', engine: 'claude' }, { id: 'ana', name: 'Ana', role: 'dev', engine: 'claude' }, { id: 'bea', name: 'Bea', role: 'dev', engine: 'claude' }];
const events = [{ type: 'AgentBlocked', taskCode: 'FT-125', ts: D5 - 100_000, data: { reason: 'budget' } }];
const state = { settings: {}, agents, tasks };
const by = (list, k) => list.find((x) => x.key === k);

check('regresión detectada: FT-126 cita FT-122', (regressions(tasks).get('FT-122') || []).includes('FT-126'));
const r = compute(state, { projectId: 'p1', events, now });
const codes = r.tasks.map((c) => c.code);
check('ventana: sin FT-OLD, FT-P2 ni FT-REV', !['FT-OLD', 'FT-P2', 'FT-REV'].some((c) => codes.includes(c)));
const julia = by(r.agents, 'julia'), vera = by(r.agents, 'vera'), ana = by(r.agents, 'ana'), bea = by(r.agents, 'bea');
check('Julia puntúa alto (≥90) y Vera claramente por debajo', julia.score >= 90 && vera.score < julia.score - 15, `${julia.score} vs ${vera.score}`);
check('Julia: 1 aprobada por el revisor automático', julia.autoApproved === 1);
check('Julia: tendencia positiva frente a los 30 días anteriores', julia.trend > 0, String(julia.trend));
check('Vera: motivos informe-falso (x3 con FT-119/120) y tests-rojos', vera.rejectReasons['informe-falso'] === 3 && vera.rejectReasons['tests-rojos'] === 1, JSON.stringify(vera.rejectReasons));
check('Vera: fiabilidad < 1 por el tope solo contado (budgetHitCount)', vera.cut === 1 && vera.breakdown.fiabilidad.value < 1, JSON.stringify(vera.breakdown.fiabilidad));
check('Vera: honestidad < 1', vera.breakdown.honestidad.value < 1);

console.log('Coste y duración frente a la mediana del rol');
check('Julia (barata) gasta bien: coste ≥ 0.7; Vera (3-4× la mediana) peor', julia.breakdown.coste.value >= 0.7 && vera.breakdown.coste.value < julia.breakdown.coste.value - 0.3, `${julia.breakdown.coste.value} vs ${vera.breakdown.coste.value}`);
check('Vera (lenta) puntúa menos en tiempo que Julia', vera.breakdown.tiempo.value < julia.breakdown.tiempo.value, `${julia.breakdown.tiempo.value} vs ${vera.breakdown.tiempo.value}`);
check('coste y tiempo NO valen 1 para todos', new Set(r.agents.filter((a) => a.scored).map((a) => a.breakdown.coste.value)).size > 1);
check('Bea sin coste ni duración: ambos componentes descartados (null, peso 0), no 1', bea.scored && bea.breakdown.coste.value === null && bea.breakdown.tiempo.value === null && bea.breakdown.coste.weight === 0, JSON.stringify(bea.breakdown));
check('Ana: regresión causada + seguridad + atasco (contador) + tope (evento)', ana.regressions === 1 && ana.rejectReasons.seguridad === 1 && ana.cut === 2 && ana.breakdown.limpieza.value < 1, JSON.stringify([ana.regressions, ana.rejectReasons, ana.cut]));

console.log('Atribución por intento');
const hk = by(r.models, 'claude/haiku'), sn = by(r.models, 'claude/sonnet');
check('FT-119 y FT-120: la 1.ª entrega falsa es de haiku → honestidad de haiku < 1', hk.breakdown.honestidad.value < 1 && hk.rejectReasons['informe-falso'] === 3, JSON.stringify(hk.rejectReasons));
check('sonnet no carga con ellas: honestidad 1', sn.breakdown.honestidad.value === 1, String(sn.breakdown.honestidad.value));
const c119 = r.tasks.find((c) => c.code === 'FT-119');
check('ficha FT-119: 2 entregas, haiku/Vera rechazada y sonnet/Julia aprobada', c119.deliveries.length === 2 && c119.deliveries[0].model === 'haiku' && c119.deliveries[0].agentId === 'vera' && c119.deliveries[0].reason === 'informe-falso' && c119.deliveries[1].model === 'sonnet' && c119.deliveries[1].agentId === 'julia' && !c119.deliveries[1].rejected, JSON.stringify(c119.deliveries.map((d) => [d.agentId, d.model, d.reason])));
const rhk = by(r.roleModels, 'qa-suite|claude/haiku'), rsn = by(r.roleModels, 'qa-suite|claude/sonnet');
check('qa-suite haiku vs sonnet: el modelo importa', rhk.score != null && rsn.score != null && rsn.score > rhk.score + 15, `${rhk.score} vs ${rsn.score}`);
check('rol qa-suite agregado', !!by(r.roles, 'qa-suite') && !!by(r.roles, 'dev'));

console.log('Agentes retirados');
check('con nombre guardado → «Tomás», retirado', by(r.agents, 'gone')?.name === 'Tomás' && by(r.agents, 'gone').retired);
check('sin rastro → «(agente retirado)», nunca el id', by(r.agents, 'ghost')?.name === '(agente retirado)');
check('agente vivo → su nombre actual', julia.name === 'Julia' && !julia.retired);

console.log('Mínimo de tareas');
const hist2 = compute({ ...state, tasks: tasks.filter((t) => t.agentId !== 'bea').concat(tasks.filter((t) => t.agentId === 'bea').slice(0, 2)) }, { projectId: 'p1', now });
const bea2 = by(hist2.agents, 'bea');
check('Bea con 2 tareas: sin puntuación', bea2.scored === false && bea2.score === null && bea2.tasks === 2);
const card = r.tasks.find((c) => c.code === 'FT-122');
check('ficha: FT-122 causó regresión, aprobada por persona', card.causedRegression && card.regressionBy[0] === 'FT-126' && card.approvedBy === 'persona');
check('ficha: duración', card.durationMs === 600_000);
check('ventana de 60 días incluye lo de hace 40', compute(state, { projectId: 'p1', days: 60, now }).tasks.length === r.tasks.length + 3);

console.log('Pesos');
check('pesos de serie suman 100', Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0) === 100);
const onlyHonest = compute({ ...state, settings: { scoreWeights: { calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0, honestidad: 10 } } }, { projectId: 'p1', events, now });
check('solo honestidad: Julia 100 y Vera = su honestidad', by(onlyHonest.agents, 'julia').score === 100 && by(onlyHonest.agents, 'vera').score === Math.round(vera.breakdown.honestidad.value * 100), String(by(onlyHonest.agents, 'vera').score));
check('pesos todos a 0 → de serie', weightsOf({ scoreWeights: { calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0, honestidad: 0 } }).calidad === 35);

console.log('GET /api/scores');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-scores-'));
const port = 7700 + Math.floor(Math.random() * 90);
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: 'http://localhost:9', workspaceHostDir: dataDir }, projects: [{ id: 'p1', name: 'P', folder: 'p', repos: [], team: [] }], agents, tasks, logs: {} }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const j = await (await fetch(`${base}/api/scores?projectId=p1`)).json();
  const jv = j.agents?.find((a) => a.key === 'julia');
  check('agentes, roles, modelos y rol+modelo con desglose', j.agents?.length >= 5 && j.roles?.length === 3 && j.models?.length === 2 && j.roleModels?.length >= 2 && jv?.breakdown?.calidad, JSON.stringify(Object.keys(j)));
  check('Julia puntuada con nombre', jv?.name === 'Julia' && jv?.score >= 90, String(jv?.score));
  check('agente retirado con nombre en la API', j.agents.find((a) => a.key === 'ghost')?.name === '(agente retirado)');
  const j2 = await (await fetch(`${base}/api/scores?days=7`)).json();
  check('?days= se respeta', j2.days === 7);
  const s = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scoreWeights: { honestidad: 10, calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0 } }) });
  const j3 = await (await fetch(`${base}/api/scores?projectId=p1`)).json();
  check('settings.scoreWeights recalcula (caché invalidada)', s.ok && j3.agents.find((a) => a.key === 'julia').score === 100 && j3.agents.find((a) => a.key === 'vera').score < 100, String(j3.agents.find((a) => a.key === 'vera')?.score));
} finally { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} fallos` : '\n✅ scores-e2e OK');
process.exit(failed ? 1 : 0);
