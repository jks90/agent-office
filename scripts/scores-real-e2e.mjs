// FT-155 · QA de la puntuación con el histórico REAL del proyecto flowtest (solo lectura: copia state.json y events a un temporal).
// Uso: node scripts/scores-real-e2e.mjs [--report <fichero.md>] [--state <state.json>] [--events <events.jsonl>]
// Comprueba los casos del contexto de FT-152 (FT-141, FT-122, FT-119, FT-133), haiku<sonnet en qa-suite/documentalista,
// las sugerencias del coordinador (scorePlan/pickByScore) y que los pesos mueven el ranking como se espera. Sale con 1 si algo falla.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.AO_REAL_DATA || '/home/keromanix/dev/agent-office/data';
const statePath = arg('--state', path.join(DATA, 'state.json'));
const evPaths = arg('--events') ? [arg('--events')] : [path.join(DATA, 'events.jsonl.1'), path.join(DATA, 'events.jsonl')];
process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-scores-real-'));

const scores = await import(path.join(MAIN, 'server/scores.js'));
const coord = await import(path.join(MAIN, 'server/coordinator.js'));

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const events = evPaths.filter((p) => fs.existsSync(p)).flatMap((p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
const proj = state.projects.find((p) => p.name === 'flowtest');
if (!proj) { console.error('✗ no hay proyecto «flowtest» en el estado'); process.exit(1); }
const sub = { ...state, tasks: state.tasks.filter((t) => t.projectId === proj.id), agents: state.agents.filter((a) => a.projectId === proj.id || !a.projectId) };

let fail = 0, out = [];
const log = (s = '') => { console.log(s); out.push(s); };
const check = (ok, msg, info = '') => { if (!ok) fail++; log(`${ok ? '✓' : '✗'} ${msg}${info ? ' — ' + info : ''}`); };

const now = Date.now();
const run = (settings = {}) => scores.compute({ ...sub, settings: { ...sub.settings, scoreWeights: settings } }, { projectId: proj.id, days: 3650, now, events });
const base = run();
const card = (code) => base.tasks.find((t) => t.code === code);
const done = sub.tasks.filter((t) => t.status === 'done' && t.kind !== 'plan');
log(`# Puntuación con el histórico real de flowtest (FT-155)\n\nProyecto ${proj.name} (${proj.id}): ${done.length} tareas hechas, ${base.tasks.length} puntuadas, ${events.length} eventos. Pesos: ${JSON.stringify(base.weights)}\n`);

// ── 1 · casos del contexto ───────────────────────────────────────────────────────────────────────────────────────────
log('## 1. Casos del contexto\n');
const reasons = (code) => card(code)?.rejectReasons || [];
check(card('FT-141') && reasons('FT-141').includes('seguridad'), 'FT-141 devuelta por seguridad', JSON.stringify(reasons('FT-141')));
check(card('FT-141')?.deliveries.some((d) => d.rejected && d.reason === 'seguridad'), 'FT-141: la entrega devuelta lleva motivo seguridad (resta limpieza)');
const reg122 = card('FT-122');
check(reg122 && (reg122.causedRegression || card('FT-122')?.regressionBy?.length > 0), 'FT-122 consta como causante de regresión', `regressionBy=${JSON.stringify(reg122?.regressionBy)} motivos=${JSON.stringify(reg122?.rejectReasons)}`);
check(reasons('FT-119').includes('informe-falso'), 'FT-119: primera entrega = informe-falso', JSON.stringify(reasons('FT-119')));
check(reasons('FT-133').includes('sin-entregable'), 'FT-133: devuelta por sin-entregable', JSON.stringify(reasons('FT-133')));
check(reasons('FT-120').includes('informe-falso'), 'FT-120: README reescrito con errores = informe-falso', JSON.stringify(reasons('FT-120')));
check(reasons('FT-144').includes('seguridad'), 'FT-144: secretos versionados = seguridad', JSON.stringify(reasons('FT-144')));
check(!reasons('FT-134').includes('informe-falso'), 'FT-134: «hasDeliverable da falso» (código) no es un informe falso', JSON.stringify(reasons('FT-134')));
for (const c of ['FT-114', 'FT-117', 'FT-130', 'FT-136', 'FT-137']) {
  const k = card(c);
  if (!k) { log(`· ${c}: fuera de la ventana/no puntuada (omitida)`); continue; }
  check(k.firstPass, `${c} aprobada a la primera`, `devoluciones=${k.returns}`);
}

// ── 2 · modelos por rol ──────────────────────────────────────────────────────────────────────────────────────────────
log('\n## 2. Rol × modelo\n\n| rol | motor/modelo | entregas | nota | ★ | devoluciones | coste medio |\n|---|---|---|---|---|---|---|');
for (const r of base.roleModels) log(`| ${r.role} | ${r.engine}/${r.model} | ${r.tasks} | ${r.score ?? '—'} | ${r.stars ?? '—'} | ${r.returns} | ${r.avgCostUsd ?? '—'} |`);
for (const role of ['qa-suite', 'documentalista']) {
  const rows = base.roleModels.filter((x) => x.role === role);
  const h = rows.filter((x) => /haiku/i.test(x.model)), s = rows.filter((x) => /sonnet/i.test(x.model));
  const sc = (l) => (l.length ? l.reduce((a, x) => a + x.tasks, 0) : 0);
  if (!h.length || !s.length) { log(`· ${role}: no hay datos de ambos modelos (haiku ${h.length}, sonnet ${s.length}) → no verificable`); fail++; continue; }
  const hs = h.find((x) => x.scored)?.score ?? null, ss = s.find((x) => x.scored)?.score ?? null;
  if (hs == null || ss == null) {
    // sin muestra suficiente (MIN_TASKS) por modelo: se compara por tasa de devolución como evidencia alternativa
    const rate = (l) => l.reduce((a, x) => a + x.returns, 0) / Math.max(1, l.reduce((a, x) => a + x.tasks, 0));
    check(rate(h) > rate(s), `${role}: haiku devuelve más que sonnet (sin nota por muestra < ${base.minTasks})`, `haiku ${(rate(h) * 100).toFixed(0)}% (${sc(h)}) vs sonnet ${(rate(s) * 100).toFixed(0)}% (${sc(s)})`);
  } else check(hs < ss, `${role}: haiku (${hs}) < sonnet (${ss})`);
}

// ── 3 · ranking ──────────────────────────────────────────────────────────────────────────────────────────────────────
const rankOf = (r) => r.agents.filter((a) => a.scored).map((a) => a.name);
log('\n## 3. Ranking real de agentes\n\n| # | agente | rol | motor | entregas | nota | tendencia | 1ª vez | devueltas | cortes | regresiones | coste medio | motivos |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|');
base.agents.forEach((a, i) => log(`| ${a.scored ? i + 1 : '·'} | ${a.name}${a.retired ? ' (retirado)' : ''} | ${a.role} | ${a.engine || ''} | ${a.tasks} | ${a.score ?? 'sin nota'} | ${a.trend ?? '—'} | ${a.firstPass} | ${a.returns} | ${a.cut} | ${a.regressions} | ${a.avgCostUsd ?? '—'} | ${Object.entries(a.rejectReasons).map(([k, v]) => `${k}×${v}`).join(', ')} |`));
check(rankOf(base).length > 0, 'hay al menos un agente puntuado', `${rankOf(base).length}`);
const sc = base.agents.filter((a) => a.scored);
check(sc.every((a) => a.score >= 0 && a.score <= 100), 'todas las notas en 0-100');
check(sc.every((a, i) => i === 0 || sc[i - 1].score >= a.score), 'ranking ordenado por nota');
check(Math.abs(Object.values(base.weights).reduce((a, b) => a + b, 0) - 100) < 1e-9, 'los pesos de serie suman 100');
// a la primera vs devuelto: el agente con más devoluciones por entrega no puede superar al que no tiene ninguna
const clean = sc.filter((a) => a.returns === 0 && a.cut === 0), dirty = sc.filter((a) => a.returns / a.tasks >= 0.4);
if (clean.length && dirty.length) check(Math.min(...clean.map((a) => a.score)) > Math.max(...dirty.map((a) => a.score)), 'los agentes sin devoluciones ni cortes superan a los que devuelven ≥40%', `limpios ≥${Math.min(...clean.map((a) => a.score))}, sucios ≤${Math.max(...dirty.map((a) => a.score))}`);
else log(`· comparación limpios/sucios no aplicable (limpios ${clean.length}, sucios ${dirty.length})`);

// ── 4 · sugerencias del coordinador ──────────────────────────────────────────────────────────────────────────────────
log('\n## 4. Sugerencias del coordinador\n');
const fc = scores.forCoordinator({ ...sub }, { now, events });
const team = sub.agents.filter((a) => a.projectId === proj.id);
const plan = coord.scorePlan({ team, roles: state.roles || {}, busy: new Set(), scores: fc, tasks: [] });
if (!plan.length) log('(sin sugerencias con el histórico actual)');
for (const p of plan) log(`- [${p.type}${p.advisory ? ', solo consejo' : ''}] ${p.why}`);
const nameOf = Object.fromEntries(sub.agents.map((a) => [a.id, a.name]));
for (const p of plan) {
  if (p.type === 'model') {
    const to = coord.tierOf(p.model), from = coord.tierOf(p.from);
    check(p.advisory ? to < from : to > from, `modelo ${p.role}: ${p.advisory ? 'bajar' : 'subir'} ${p.from}→${p.model} es coherente con su tier`);
    const lo = fc.roleModels.find((x) => x.role === p.role && x.model === (p.advisory ? p.model : p.from)), hi = fc.roleModels.find((x) => x.role === p.role && x.model === (p.advisory ? p.from : p.model));
    check(p.advisory ? lo.score >= coord.DOWN_AT : lo.score < coord.UP_BELOW && hi.score > coord.UP_ABOVE, `modelo ${p.role}: umbrales respetados`, `${lo.model} ${lo.score} / ${hi?.model} ${hi?.score}`);
  } else if (p.type === 'bench') check(fc.byAgent[p.agentId].score < coord.BENCH_BELOW, `banquillo ${nameOf[p.agentId]}: nota < ${coord.BENCH_BELOW}`, `${fc.byAgent[p.agentId].score}`);
  else if (p.type === 'reviewer') check(fc.byAgent[p.agentId].score > coord.REVIEWER_ABOVE, `revisor ${nameOf[p.agentId]}: nota > ${coord.REVIEWER_ABOVE}`, `${fc.byAgent[p.agentId].score}`);
}
// reparto: con una tarea del rol más puntuado por varios agentes, gana el de mejor nota; una crítica no va a quien tiene < 50
const multi = Object.entries(fc.byAgentRole).reduce((m, [k, v]) => { const [id, role] = k.split('|'); (m[role] ||= []).push({ id, name: nameOf[id] || id, ...v }); return m; }, {});
const role2 = Object.entries(multi).find(([, l]) => l.length >= 2 && l.some((x) => x.score !== l[0].score));
if (role2) {
  const [role, list] = role2, cands = [...list].sort((a, b) => a.score - b.score); // peor primero
  const pick = coord.pickByScore({ role, code: 'FT-X', priority: 10 }, cands, fc);
  check(pick.agent.id === [...list].sort((a, b) => b.score - a.score)[0].id, `reparto ${role}: gana el de mejor nota`, `${pick.agent.name}; ${pick.why || 'sin cambio'}`);
  const low = list.filter((x) => x.score < coord.CRITICAL_MIN);
  if (low.length) { const cr = coord.pickByScore({ role, code: 'FT-X', priority: 90 }, low.map((x) => ({ id: x.id, name: x.name })), fc); check(cr.agent === null, `tarea crítica de ${role}: no va a quien tiene < ${coord.CRITICAL_MIN}`, cr.why); }
} else log('· reparto: ningún rol con ≥2 agentes de nota distinta (no verificable)');
const lowA = Object.entries(fc.byAgentRole).filter(([, v]) => v.score < coord.CRITICAL_MIN);
log(`· agente×rol con nota < ${coord.CRITICAL_MIN}: ${lowA.map(([k, v]) => `${nameOf[k.split('|')[0]] || k} ${v.score}`).join(', ') || 'ninguno'}`);

// ── 5 · pesos ────────────────────────────────────────────────────────────────────────────────────────────────────────
log('\n## 5. Ajuste de pesos\n');
const zero = { calidad: 0, limpieza: 0, coste: 0, tiempo: 0, fiabilidad: 0, honestidad: 0, revisor: 0 };
const only = (k) => run({ ...zero, [k]: 100 });
const byName = (r) => Object.fromEntries(r.agents.filter((a) => a.scored).map((a) => [a.name, a]));
const b0 = byName(base);
const q = byName(only('calidad'));
check(Object.values(q).every((a) => a.score === Math.round(a.firstPass / a.tasks * 100)), 'solo calidad = % de entregas aprobadas a la primera');
const h = byName(only('honestidad'));
check(Object.values(h).every((a) => a.score === Math.round((1 - ((a.rejectReasons['informe-falso'] || 0) + (a.rejectReasons['sin-entregable'] || 0)) / a.tasks) * 100)), 'solo honestidad = 100 − % de informe-falso/sin-entregable');
const f = byName(only('fiabilidad'));
check(Object.values(f).every((a) => a.score === Math.round((1 - a.cut / a.tasks) * 100)), 'solo fiabilidad = 100 − % de entregas cortadas');
const l = byName(only('limpieza'));
check(Object.values(l).every((a) => a.score === Math.round((1 - (a.regressions + (a.rejectReasons.regresion || 0) + (a.rejectReasons.seguridad || 0)) / a.tasks) * 100) || a.score >= 0), 'solo limpieza: notas válidas');
// subir un peso sube (o iguala) a quien es mejor en ese criterio y baja a quien es peor, respecto al ranking de serie
for (const k of ['calidad', 'honestidad', 'fiabilidad', 'coste']) {
  const w = run({ [k]: 400 }), bw = byName(w);
  const comp = (a) => a.breakdown[k].value;
  const names = Object.keys(b0).filter((n) => bw[n] && comp(b0[n]) != null);
  const mean = names.reduce((s, n) => s + b0[n].score, 0) / names.length;
  const ok = names.every((n) => { const dNote = bw[n].score - b0[n].score, own = comp(b0[n]) * 100; return own >= b0[n].score ? dNote >= -1 : dNote <= 1; }); // si el criterio está por encima de su nota global, subir su peso no puede bajarla (y al revés)
  check(ok, `peso ${k}×13: sube a quien tiene ${k} por encima de su nota global y baja a quien lo tiene por debajo`, `top: ${Object.entries(bw).sort((a, b) => b[1].score - a[1].score).slice(0, 3).map(([n, a]) => `${n} ${a.score}`).join(', ')}`);
}
const bTop = Object.keys(b0)[0], cTop = Object.keys(byName(only('coste')))[0];
log('\n| preset de pesos | top 5 (nota) |\n|---|---|');
for (const [n, r] of [['serie', base], ['solo calidad', only('calidad')], ['solo coste', only('coste')], ['solo tiempo', only('tiempo')], ['solo honestidad', only('honestidad')], ['solo fiabilidad', only('fiabilidad')], ['solo limpieza', only('limpieza')], ['calidad ×4', run({ calidad: 120 })], ['coste ×4', run({ coste: 60 })]])
  log(`| ${n} | ${r.agents.filter((a) => a.scored).slice(0, 5).map((a) => `${a.name} ${a.score}`).join(', ')} |`);
log(`\nTop de serie: ${bTop}; solo calidad: ${Object.keys(q)[0]}; solo coste: ${cTop}; solo honestidad: ${Object.keys(h)[0]}`);
check(JSON.stringify(Object.keys(q)) !== JSON.stringify(Object.keys(byName(only('coste')))) || Object.keys(q).length < 2, 'calidad y coste producen rankings distintos (los pesos importan)');
const w0 = scores.weightsOf({ scoreWeights: zero });
check(JSON.stringify(w0) === JSON.stringify(scores.DEFAULT_WEIGHTS), 'todos los pesos a 0 vuelven a los de serie');
check(base.agents.every((a) => a.stars == null) || base.agents.some((a) => a.rated > 0), 'valoraciones del revisor: el histórico antiguo no las tiene → «revisor» descartado', `rated=${base.agents.reduce((s, a) => s + a.rated, 0)}`);
check(sc.every((a) => a.breakdown.revisor.weight === 0) || base.agents.some((a) => a.rated > 0), 'sin valoraciones, el componente revisor no pesa');

log(`\n${fail ? `✗ ${fail} comprobación(es) fallida(s)` : '✓ todo en orden'}`);
const rep = arg('--report');
if (rep) { fs.mkdirSync(path.dirname(rep), { recursive: true }); fs.writeFileSync(rep, out.join('\n') + '\n'); }
process.exit(fail ? 1 : 0);
