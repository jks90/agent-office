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
const mk = (o) => ({ id: 't' + (++n), code: o.code || `FT-${200 + n}`, projectId: 'p1', kind: 'task', status: 'done', returns: 0, costUsd: 1, startedAt: now - 5 * DAY - 600_000, updatedAt: now - 5 * DAY, ...o });
const hist = (model, extra = {}) => ({ modelHistory: [{ model, engine: 'claude' }], ...extra });
const tasks = [
  // Julia (sonnet, qa-suite): 4 aprobadas a la primera, una por el revisor automático
  ...[1, 2, 3, 4].map((i) => mk({ role: 'qa-suite', agentId: 'julia', ...hist('sonnet'), autoApproved: i === 1 ? { by: 'auto-qa' } : undefined })),
  // Vera (haiku, qa-suite): informe falso, tests rojos, un tope y una limpia
  mk({ role: 'qa-suite', agentId: 'vera', ...hist('haiku'), returns: 1, reviewLog: [{ verdict: 'rejected', text: cases['informe-falso'] }] }),
  mk({ role: 'qa-suite', agentId: 'vera', ...hist('haiku'), returns: 1, reviewLog: [{ verdict: 'rejected', text: cases['tests-rojos'] }], costUsd: 4 }),
  mk({ role: 'qa-suite', agentId: 'vera', ...hist('haiku'), budgetHit: true }),
  mk({ role: 'qa-suite', agentId: 'vera', ...hist('haiku') }),
  // Dev: FT-122 causó una regresión (la cita FT-126); 3 tareas → puntuado
  mk({ code: 'FT-122', role: 'dev', agentId: 'ana', ...hist('sonnet') }),
  mk({ code: 'FT-123', role: 'dev', agentId: 'ana', ...hist('sonnet'), returns: 1, reviewLog: [{ verdict: 'rejected', text: cases.seguridad }] }),
  mk({ code: 'FT-124', role: 'dev', agentId: 'ana', ...hist('sonnet'), stuck: { reason: 'bucle' } }),
  mk({ code: 'FT-126', role: 'dev', agentId: 'ana', ...hist('sonnet'), title: 'Arreglar oficina. Regresión FT-122' }),
  // Bea: solo 2 tareas → sin puntuación
  mk({ role: 'dev', agentId: 'bea', ...hist('sonnet') }), mk({ role: 'dev', agentId: 'bea', ...hist('sonnet') }),
  // antiguas (ventana anterior, 40 días): tendencia de Julia
  ...[1, 2, 3].map(() => mk({ role: 'qa-suite', agentId: 'julia', ...hist('sonnet'), returns: 1, reviewLog: [{ verdict: 'rejected', text: cases['tests-rojos'] }], updatedAt: now - 40 * DAY, startedAt: now - 40 * DAY - 600_000 })),
  // fuera de ventana, otro proyecto y sin terminar: no cuentan
  mk({ role: 'qa-suite', agentId: 'julia', ...hist('sonnet'), updatedAt: now - 100 * DAY }),
  mk({ role: 'qa-suite', agentId: 'julia', ...hist('sonnet'), projectId: 'p2' }),
  mk({ role: 'qa-suite', agentId: 'julia', status: 'review' }),
];
const agents = [{ id: 'julia', name: 'Julia', role: 'qa-suite', engine: 'claude' }, { id: 'vera', name: 'Vera', role: 'qa-suite', engine: 'claude' }, { id: 'ana', name: 'Ana', role: 'dev', engine: 'claude' }, { id: 'bea', name: 'Bea', role: 'dev', engine: 'claude' }];
const state = { settings: {}, agents, tasks };
const by = (list, k) => list.find((x) => x.key === k);

check('regresión detectada: FT-126 cita FT-122', (regressions(tasks).get('FT-122') || []).includes('FT-126'));
const r = compute(state, { projectId: 'p1', estimates: { 'qa-suite': 1, dev: 1 }, now });
check('tareas en ventana (14 de p1)', r.tasks.length === 14, String(r.tasks.length));
const julia = by(r.agents, 'julia'), vera = by(r.agents, 'vera'), ana = by(r.agents, 'ana'), bea = by(r.agents, 'bea');
check('Julia 100 (todo a la primera, barata, sin cortes)', julia.score === 100, String(julia.score));
check('Julia: 1 aprobada por el revisor automático', julia.autoApproved === 1);
check('Julia: tendencia +N frente a los 30 días anteriores', julia.trend > 0, String(julia.trend));
check('Vera puntúa por debajo de Julia', vera.score != null && vera.score < julia.score - 20, String(vera.score));
check('Vera: motivos informe-falso y tests-rojos', vera.rejectReasons['informe-falso'] === 1 && vera.rejectReasons['tests-rojos'] === 1, JSON.stringify(vera.rejectReasons));
check('Vera: 1 corte por tope', vera.cut === 1);
check('Vera: honestidad 0.75 y fiabilidad 0.75', vera.breakdown.honestidad.value === 0.75 && vera.breakdown.fiabilidad.value === 0.75, JSON.stringify(vera.breakdown));
check('Vera: coste penalizado (4× la estimación)', vera.breakdown.coste.value < 1);
check('Ana: regresión causada + seguridad + atasco', ana.regressions === 1 && ana.rejectReasons.seguridad === 1 && ana.cut === 1 && ana.breakdown.limpieza.value === 0.5, JSON.stringify(ana.breakdown));
check('Bea (2 tareas): sin puntuación', bea.scored === false && bea.score === null && bea.tasks === 2);
check('rol qa-suite agrega 8 tareas', by(r.roles, 'qa-suite').tasks === 8);
const hk = by(r.roleModels, 'qa-suite|claude/haiku'), sn = by(r.roleModels, 'qa-suite|claude/sonnet');
check('qa-suite haiku vs sonnet: el modelo importa', hk.score != null && sn.score != null && sn.score > hk.score, `${hk.score} vs ${sn.score}`);
check('modelos claude/haiku y claude/sonnet', !!by(r.models, 'claude/haiku') && !!by(r.models, 'claude/sonnet'));
const card = r.tasks.find((c) => c.code === 'FT-122');
check('ficha: FT-122 causó regresión', card.causedRegression && card.regressionBy[0] === 'FT-126' && card.approvedBy === 'persona');
check('ficha: duración y coste frente a estimación', card.durationMs === 600_000 && card.costRatio === 1 && card.estimateUsd === 1);
check('ventana de 7 días excluye lo de hace 40', compute(state, { projectId: 'p1', days: 7, now }).tasks.length === 14);
check('ventana de 60 días incluye lo de hace 40', compute(state, { projectId: 'p1', days: 60, now }).tasks.length === 17);

console.log('Pesos');
check('pesos de serie suman 100', Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0) === 100);
const onlyHonest = compute({ ...state, settings: { scoreWeights: { calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0, honestidad: 10 } } }, { projectId: 'p1', now });
check('solo honestidad: Vera 75, Julia 100', by(onlyHonest.agents, 'vera').score === 75 && by(onlyHonest.agents, 'julia').score === 100, String(by(onlyHonest.agents, 'vera').score));
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
  check('agentes, roles y modelos con desglose', j.agents?.length === 4 && j.roles?.length === 2 && j.models?.length === 2 && jv?.breakdown?.calidad, JSON.stringify(Object.keys(j)));
  check('Julia puntuada con nombre', jv?.name === 'Julia' && jv?.score === 100, String(jv?.score));
  const j2 = await (await fetch(`${base}/api/scores?days=7`)).json();
  check('?days= se respeta', j2.days === 7);
  const s = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scoreWeights: { honestidad: 10, calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0 } }) });
  const j3 = await (await fetch(`${base}/api/scores?projectId=p1`)).json();
  check('settings.scoreWeights recalcula (caché invalidada)', s.ok && j3.agents.find((a) => a.key === 'vera').score === 75, String(j3.agents.find((a) => a.key === 'vera')?.score));
} finally { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} fallos` : '\n✅ scores-e2e OK');
process.exit(failed ? 1 : 0);
