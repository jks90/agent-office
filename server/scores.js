// Puntuación de agentes (FT-152): ficha de rendimiento por agente, rol y modelo. Funciones puras sobre el historial (tareas + eventos);
// nada de IA. `classifyReject` clasifica por reglas la nota de una devolución; `compute` agrega y puntúa 0-100.
const DAY = 86_400_000;
export const MIN_TASKS = 3; // por debajo no se puntúa (sin muestra suficiente)
export const REASONS = ['tests-rojos', 'test-inestable', 'seguridad', 'regresion', 'choque-main', 'sin-entregable', 'informe-falso', 'alcance', 'otro'];
export const DEFAULT_WEIGHTS = { calidad: 30, limpieza: 20, coste: 15, tiempo: 5, fiabilidad: 10, honestidad: 10, revisor: 10 }; // FT-153: «revisor» = valoración 1-5 de quien aprueba/devuelve; sin valoraciones se descarta y no pesa

// Orden = prioridad: gana la primera regla que encaja (lo más grave y específico primero).
const RULES = [
  ['informe-falso', /informe (falso|inventado|enga)|falso|inventad|miente|no coincide con (lo|la)|\b\d+\s*\/\s*\d+\b.*(pero|en realidad|realmente)|en realidad (falla|fallan|no)/],
  ['seguridad', /seguridad|traversal|inyecci|secreto|credencial|vulnerab|agujero|\bxss\b|\bcsrf\b|token versionad|clave versionad|\.\.\//],
  ['sin-entregable', /sin entregable|no (entreg|dej[oó] (nada|ning))|no hay (cambios|commit|diff|entregable|rama)|sin cambios|rama vac[ií]a|segundo plano|background|nada que revisar/],
  ['test-inestable', /inestable|flaky|intermitente|a veces (falla|pasa)|de forma aleatoria|condici[oó]n de carrera/],
  ['tests-rojos', /(test|tests|prueba|pruebas|e2e|suite|check|lint|build)\b.{0,60}(fall|rojo|roto|no pasa|no pasan|error)|(fall|rojo|roto|no pasa).{0,60}(test|prueba|e2e|suite)/],
  ['regresion', /regresi[oó]n|\brompe\b|rompi[oó]|dej[oó] de funcionar|ya no funciona/],
  ['choque-main', /tu rama choca|conflicto|conflict|choca con|choque con/],
  ['alcance', /no (hizo|hace|cumple|implementa|implement[oó]|es lo que se pidi|se pidi)|falta\w*|lo que se pid|criterio|especificaci|alcance|incomplet|no (toca|tocar)|fuera de (lo|la)/],
];
const flat = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const RULES_FLAT = RULES.map(([k, re]) => [k, new RegExp(flat(re.source), 'i')]);

// Motivo de una devolución a partir de su nota (feedback / reviewNote). Sin nota o sin regla → «otro».
export function classifyReject(text) {
  const s = flat(text);
  for (const [k, re] of RULES_FLAT) if (re.test(s)) return k;
  return 'otro';
}

// Motivos de las devoluciones de una tarea: los guardados (t.rejectReasons, FT-152) o, en el histórico, los deducidos
// de las notas «rejected» de reviewLog, de los eventos TaskReviewed y, en último caso, de las líneas de t.feedback.
export function reasonsOf(t, events = []) {
  if (Array.isArray(t.rejectReasons) && t.rejectReasons.length) return t.rejectReasons;
  let notes = (t.reviewLog || []).filter((r) => r.verdict === 'rejected').map((r) => r.text);
  if (!notes.length) notes = events.filter((e) => e.type === 'TaskReviewed' && (e.taskId === t.id || (t.code && e.taskCode === t.code)) && (e.data?.decision || e.decision) === 'rejected').map((e) => e.data?.feedback ?? e.feedback);
  if (!notes.length && t.feedback) notes = String(t.feedback).split('\n').filter(Boolean);
  let out = notes.map(classifyReject);
  const n = t.returns || 0;
  if (n && !out.length) out = Array(n).fill('otro');
  if (n && out.length > n) out = out.slice(-n); // el log solo guarda 20: nunca más motivos que devoluciones
  while (n && out.length < n) out.push('otro');
  return out;
}

// Pesos efectivos: los de settings.scoreWeights (>=0) sobre los de serie; si todos son 0 vuelven los de serie.
export function weightsOf(settings = {}) {
  const w = { ...DEFAULT_WEIGHTS };
  for (const [k, v] of Object.entries(settings.scoreWeights || {})) if (k in w && Number.isFinite(Number(v)) && Number(v) >= 0) w[k] = Number(v);
  return Object.values(w).some((v) => v > 0) ? w : { ...DEFAULT_WEIGHTS };
}

const median = (v) => { if (!v.length) return 0; const x = [...v].sort((a, b) => a - b); return x[Math.floor(x.length / 2)]; };
const lerp = (x, good, bad) => Math.max(0, Math.min(1, (bad - x) / (bad - good))); // 1 en `good`, 0 en `bad`
const doneAt = (t) => t.updatedAt || t.createdAt || 0;
const evData = (e) => e.data || e;
const RETIRED = '(agente retirado)';

// Regresiones: tareas cuyo texto cita a otra como «Regresión FT-xxx» / «rompe FT-xxx» → código citado → [quién la cita].
export function regressions(tasks) {
  const out = new Map();
  for (const t of tasks) {
    const txt = `${t.title || ''}\n${t.description || ''}\n${t.feedback || ''}`;
    for (const m of txt.matchAll(/(?:regresi[oó]n|rompe|rompi[oó]|romp[ií]a)\s*(?:de|con|en|:)?\s*([A-Z]{1,6}-\d+)/gi)) {
      const code = m[1].toUpperCase();
      if (code !== t.code) (out.get(code) || out.set(code, []).get(code)).push(t.code || t.id);
    }
  }
  return out;
}

const evsOf = (t, events, type) => events.filter((e) => e.type === type && (e.taskId === t.id || (t.code && e.taskCode === t.code)));

// Intentos de la tarea [{attempt, agentId, agentName, engine, model, startedAt, cut}] ordenados. Con t.attemptsLog (FT-152) tal cual;
// en el histórico se deduce de t.modelHistory (modelo/motor/instante de cada intento) + eventos TaskAssigned/AgentStarted (agente y nombre)
// y de los AgentBlocked (stuck/budget) por instante.
export function attemptsOf(t, events = []) {
  let list;
  if (t.attemptsLog?.length) list = t.attemptsLog.map((a) => ({ ...a }));
  else {
    const started = evsOf(t, events, 'AgentStarted'), assigned = evsOf(t, events, 'TaskAssigned');
    const hist = t.modelHistory?.length ? t.modelHistory : [{ model: t.lastModel || '', engine: t.lastEngine || '', attempt: t.attempts || 1, at: t.startedAt || 0 }];
    list = hist.map((h, i) => {
      const n = h.attempt || i + 1;
      const st = started.find((e) => evData(e).attempt === n), as = assigned.find((e) => evData(e).attempt === n);
      return { attempt: n, agentId: st?.agentId || as?.agentId || (i === hist.length - 1 ? t.agentId : null) || null, agentName: evData(as || {}).agentName || '', engine: h.engine || '', model: h.model || '', startedAt: h.at || 0 };
    });
  }
  list.sort((a, b) => a.startedAt - b.startedAt);
  const blocks = evsOf(t, events, 'AgentBlocked').filter((e) => ['stuck', 'budget'].includes(evData(e).reason));
  for (const e of blocks) { const a = [...list].reverse().find((x) => x.startedAt <= e.ts) || list[0]; if (a && !a.cut) a.cut = evData(e).reason; }
  const last = list[list.length - 1];
  if (last && !last.cut && (t.stuck || t.budgetHit)) last.cut = t.stuck ? 'stuck' : 'budget';
  // contadores acumulados sin intento localizado (histórico sin log ni eventos): al último intento
  if (last && !list.some((a) => a.cut) && (t.stuckCount || t.budgetHitCount || t.cuts)) last.cut = t.stuckCount ? 'stuck' : 'budget';
  return list;
}

// Devoluciones [{reason, at}] con su motivo (reasonsOf) y el instante: t.rejectAt, reviewLog o eventos TaskReviewed.
function rejectionsOf(t, events) {
  const reasons = reasonsOf(t, events);
  let times = Array.isArray(t.rejectAt) ? t.rejectAt : [];
  if (times.length < reasons.length) times = (t.reviewLog || []).filter((r) => r.verdict === 'rejected').map((r) => r.at);
  if (times.length < reasons.length) times = evsOf(t, events, 'TaskReviewed').filter((e) => evData(e).decision === 'rejected').map((e) => e.ts);
  const off = Math.max(0, times.length - reasons.length);
  return reasons.map((reason, i) => ({ reason, at: times[off + i] || null }));
}

// Entregas de la tarea: cada vez que el agente la entregó a Revisión. Las devueltas llevan su motivo y se atribuyen al intento
// (agente + modelo) que las hizo; la última (la aprobada) cierra la tarea y es a la que se atribuye una regresión posterior.
export function deliveriesOf(t, { events = [], agentNames = {}, regs = new Map() } = {}) {
  const attempts = attemptsOf(t, events), rejs = rejectionsOf(t, events), n = rejs.length + 1;
  const attemptAt = (at, i) => (at ? [...attempts].reverse().find((a) => a.startedAt <= at) : null) || attempts[Math.min(i, attempts.length - 1)] || {};
  const cost = t.costUsd > 0 ? t.costUsd / n : null; // sin telemetría por intento: el coste de la tarea se reparte entre sus entregas
  return Array.from({ length: n }, (_, i) => {
    const rej = rejs[i], at = rej ? rej.at : doneAt(t), a = attemptAt(at, i);
    const rv = (t.ratings || []).filter((r) => r.n === i && r.rating).pop(); // FT-153: valoración del revisor de ESTA entrega
    const agentId = a.agentId || t.agentId || null;
    return {
      code: t.code || null, role: t.role, agentId, agentName: agentNames[agentId] || a.agentName || t.agentName || RETIRED,
      engine: a.engine || '', model: a.model || '', rejected: !!rej, reason: rej ? rej.reason : null,
      rating: rv ? rv.rating : null, ratedBy: rv ? rv.by : null, title: t.title || '', cut: a.cut || null, costUsd: cost, durationMs: a.startedAt && at ? Math.max(0, at - a.startedAt) : null,
      causedRegression: !rej && (regs.get(t.code) || []).length > 0, finishedAt: at || doneAt(t),
    };
  });
}

// Ficha de una tarea terminada.
export function taskCard(t, { estimates = {}, regs = new Map(), events = [], agentNames = {} } = {}) {
  const est = estimates[t.role] || null, by = t.autoApproved ? t.autoApproved.by || 'auto' : 'human';
  const deliveries = deliveriesOf(t, { events, agentNames, regs }), final = deliveries[deliveries.length - 1];
  return {
    id: t.id, code: t.code || null, role: t.role, agentId: final.agentId, agentName: final.agentName, engine: final.engine, model: final.model,
    firstPass: !(t.returns > 0), returns: t.returns || 0, rejectReasons: deliveries.filter((d) => d.rejected).map((d) => d.reason),
    costUsd: t.costUsd || 0, estimateUsd: est, costRatio: est && t.costUsd > 0 ? +(t.costUsd / est).toFixed(2) : null,
    durationMs: final.durationMs, cut: deliveries.some((d) => d.cut), cuts: deliveries.filter((d) => d.cut).length,
    approvedBy: by === 'human' ? 'persona' : 'revisor', approver: by,
    causedRegression: final.causedRegression, regressionBy: regs.get(t.code) || [], finishedAt: doneAt(t), deliveries,
  };
}

// Puntuación 0-100 de un grupo de entregas (null si hay menos de MIN_TASKS). Cada componente va de 0 a 1.
// coste y tiempo se miden contra la MEDIANA DEL ROL (1 = la mitad o menos, 0 = el triple o más); una entrega sin dato no cuenta
// (ni como 1): si el grupo no tiene ningún dato de ese componente, se descarta y los demás pesos se reparten.
function scoreOf(units, weights, med) {
  const n = units.length;
  if (n < MIN_TASKS) return null;
  const avg = (f) => units.reduce((s, c) => s + f(c), 0) / n;
  const mean = (f) => { const v = units.map(f).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const has = (c, ...ks) => c.reason && ks.includes(c.reason);
  const rel = (v, m) => (v == null || !m ? null : lerp(v / m, 0.5, 3));
  const parts = {
    calidad: avg((c) => (c.rejected ? 0 : 1)),
    limpieza: avg((c) => (c.causedRegression || has(c, 'regresion', 'seguridad') ? 0 : 1)),
    coste: mean((c) => rel(c.costUsd, med.cost[c.role])),
    tiempo: mean((c) => rel(c.durationMs, med.dur[c.role])),
    fiabilidad: avg((c) => (c.cut ? 0 : 1)),
    honestidad: avg((c) => (has(c, 'informe-falso', 'sin-entregable') ? 0 : 1)),
    revisor: mean((c) => (c.rating ? (c.rating - 1) / 4 : null)), // FT-153: 1★ = 0, 5★ = 1; las entregas sin valorar no cuentan
  };
  const used = Object.keys(parts).filter((k) => parts[k] != null);
  const total = used.reduce((s, k) => s + weights[k], 0);
  if (!total) return null;
  const score = Math.round(used.reduce((s, k) => s + weights[k] * parts[k], 0) / total * 100);
  return { score, parts: Object.fromEntries(Object.keys(parts).map((k) => [k, parts[k] == null ? { value: null, weight: 0, points: 0 } : { value: +parts[k].toFixed(2), weight: weights[k], points: +(weights[k] / total * 100 * parts[k]).toFixed(1) }])) };
}

function group(units, keyOf, extra, weights, med, prev, names = {}) {
  const m = new Map();
  for (const c of units) { const k = keyOf(c); if (k) (m.get(k) || m.set(k, []).get(k)).push(c); }
  return [...m].map(([key, list]) => {
    const sc = scoreOf(list, weights, med);
    const before = scoreOf(prev.filter((c) => keyOf(c) === key), weights, med);
    const reasons = {};
    for (const c of list) if (c.reason) reasons[c.reason] = (reasons[c.reason] || 0) + 1;
    const costs = list.map((c) => c.costUsd).filter((x) => x != null), cost = costs.reduce((s, x) => s + x, 0);
    return {
      key, ...extra(list[0], key), tasks: list.length, scored: !!sc, score: sc?.score ?? null, trend: sc && before ? sc.score - before.score : null, breakdown: sc?.parts || null,
      firstPass: list.filter((c) => !c.rejected).length, returns: list.filter((c) => c.rejected).length, rejectReasons: reasons,
      cut: list.filter((c) => c.cut).length, regressions: list.filter((c) => c.causedRegression).length, autoApproved: list.filter((c) => c.autoApproved).length,
      stars: (() => { const v = list.map((c) => c.rating).filter(Boolean); return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null; })(), // FT-153: media de las valoraciones 1-5
      rated: list.filter((c) => c.rating).length,
      lastReturns: list.filter((c) => c.rejected).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 5).map((c) => ({ code: c.code, title: c.title, reason: c.reason, at: c.finishedAt, rating: c.rating })),
      costUsd: +cost.toFixed(4), avgCostUsd: costs.length ? +(cost / costs.length).toFixed(4) : null,
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tasks - a.tasks);
}

// compute(state, {projectId, days, now, estimates, events}) → { days, weights, minTasks, tasks, agents, roles, models, roleModels }
// Las unidades que se puntúan son ENTREGAS (una por cada vez que se entregó a Revisión), atribuidas al agente y modelo del intento.
export function compute(state, { projectId = '', days = 30, now = Date.now(), estimates = {}, events = [] } = {}) {
  days = Math.max(1, Math.min(3650, Math.round(Number(days)) || 30));
  const weights = weightsOf(state.settings);
  const all = state.tasks.filter((t) => t.kind !== 'plan');
  const regs = regressions(all);
  const agentNames = Object.fromEntries((state.agents || []).map((a) => [a.id, a.name]));
  const done = all.filter((t) => t.status === 'done' && (!projectId || t.projectId === projectId));
  const card = (t) => taskCard(t, { estimates, regs, events, agentNames });
  const curT = done.filter((t) => doneAt(t) > now - days * DAY && doneAt(t) <= now).map(card);
  const prevT = done.filter((t) => doneAt(t) > now - 2 * days * DAY && doneAt(t) <= now - days * DAY).map(card);
  const units = (cards) => cards.flatMap((c) => c.deliveries.map((d) => ({ ...d, autoApproved: !d.rejected && c.approvedBy === 'revisor' })));
  const cur = units(curT), prev = units(prevT);
  const med = { cost: {}, dur: {} };
  for (const r of new Set(cur.concat(prev).map((c) => c.role))) {
    const rs = cur.concat(prev).filter((c) => c.role === r);
    med.cost[r] = median(rs.map((c) => c.costUsd).filter((x) => x > 0));
    med.dur[r] = median(rs.map((c) => c.durationMs).filter((x) => x > 0));
  }
  const names = Object.fromEntries((state.agents || []).map((a) => [a.id, a]));
  const modelKey = (c) => (c.model ? `${c.engine || '?'}/${c.model}` : '');
  const g = (list, keyOf, extra, p) => group(list, keyOf, extra, weights, med, p);
  return {
    days, projectId: projectId || null, weights, minTasks: MIN_TASKS, from: now - days * DAY, to: now,
    tasks: curT,
    agents: g(cur, (c) => c.agentId, (c, k) => ({ agentId: k, name: names[k]?.name || c.agentName || RETIRED, retired: !names[k], role: names[k]?.role || c.role, engine: names[k]?.engine || c.engine }), prev),
    roles: g(cur, (c) => c.role, (c) => ({ role: c.role }), prev),
    models: g(cur, modelKey, (c) => ({ engine: c.engine, model: c.model }), prev),
    roleModels: g(cur, (c) => (c.model ? `${c.role}|${modelKey(c)}` : ''), (c) => ({ role: c.role, engine: c.engine, model: c.model }), prev), // p. ej. qa-suite con haiku frente a qa-suite con sonnet
  };
}


// Caché por última tarea: el histórico entero solo se recalcula si cambió algo (nº de tareas, última actualización, devoluciones, pesos).
let cache = { sig: '', byKey: new Map() };
export function cached(state, opts = {}) {
  const ts = state.tasks;
  const sig = `${ts.length}|${ts.reduce((m, t) => Math.max(m, t.updatedAt || 0), 0)}|${ts.reduce((n, t) => n + (t.returns || 0), 0)}|${JSON.stringify(state.settings.scoreWeights || {})}|${Math.floor((opts.now || Date.now()) / 3_600_000)}`;
  if (cache.sig !== sig) cache = { sig, byKey: new Map() };
  const key = `${opts.projectId || ''}|${opts.days || 30}`;
  if (!cache.byKey.has(key)) cache.byKey.set(key, compute(state, opts));
  return cache.byKey.get(key);
}
