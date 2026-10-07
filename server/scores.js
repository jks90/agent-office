// Puntuación de agentes (FT-152): ficha de rendimiento por agente, rol y modelo. Funciones puras sobre el historial (tareas + eventos);
// nada de IA. `classifyReject` clasifica por reglas la nota de una devolución; `compute` agrega y puntúa 0-100.
const DAY = 86_400_000;
export const MIN_TASKS = 3; // por debajo no se puntúa (sin muestra suficiente)
export const REASONS = ['tests-rojos', 'test-inestable', 'seguridad', 'regresion', 'choque-main', 'sin-entregable', 'informe-falso', 'alcance', 'otro'];
export const DEFAULT_WEIGHTS = { calidad: 35, limpieza: 20, coste: 15, tiempo: 10, fiabilidad: 10, honestidad: 10 };

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
const modelOf = (t) => t.modelHistory?.[t.modelHistory.length - 1]?.model || t.lastModel || '';
const engineOf = (t) => t.modelHistory?.[t.modelHistory.length - 1]?.engine || t.lastEngine || '';
const doneAt = (t) => t.updatedAt || t.createdAt || 0;

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

// Ficha de una tarea terminada.
export function taskCard(t, { estimates = {}, regs = new Map(), events = [] } = {}) {
  const reasons = reasonsOf(t, events), est = estimates[t.role] || null;
  const by = t.autoApproved ? t.autoApproved.by || 'auto' : 'human';
  return {
    id: t.id, code: t.code || null, role: t.role, agentId: t.agentId || t.lastAgentId || null, engine: engineOf(t), model: modelOf(t),
    firstPass: !(t.returns > 0), returns: t.returns || 0, rejectReasons: reasons,
    costUsd: t.costUsd || 0, estimateUsd: est, costRatio: est && t.costUsd > 0 ? +(t.costUsd / est).toFixed(2) : null,
    durationMs: t.startedAt && t.updatedAt ? Math.max(0, t.updatedAt - t.startedAt) : null,
    cut: !!(t.stuck || t.budgetHit || t.cuts > 0), approvedBy: by === 'human' ? 'persona' : 'revisor', approver: by,
    causedRegression: (regs.get(t.code) || []).length > 0, regressionBy: regs.get(t.code) || [], finishedAt: doneAt(t),
  };
}

// Puntuación 0-100 de un grupo de fichas (null si hay menos de MIN_TASKS). Cada componente va de 0 a 1.
function scoreOf(cards, weights, durMedian) {
  const n = cards.length;
  if (n < MIN_TASKS) return null;
  const avg = (f) => cards.reduce((s, c) => s + f(c), 0) / n;
  const has = (c, ...ks) => c.rejectReasons.some((r) => ks.includes(r));
  const parts = {
    calidad: avg((c) => (c.firstPass ? 1 : 0)),
    limpieza: avg((c) => (c.causedRegression || has(c, 'regresion', 'seguridad') ? 0 : 1)),
    coste: avg((c) => (c.costRatio == null ? 1 : lerp(c.costRatio, 1.25, 3))), // hasta 1,25× la estimación no resta; a 3× es 0
    tiempo: avg((c) => (!c.durationMs || !durMedian ? 1 : lerp(c.durationMs / durMedian, 1.5, 4))),
    fiabilidad: avg((c) => (c.cut ? 0 : 1)),
    honestidad: avg((c) => (has(c, 'informe-falso', 'sin-entregable') ? 0 : 1)),
  };
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  const score = Math.round(Object.entries(weights).reduce((s, [k, w]) => s + w * parts[k], 0) / total * 100);
  return { score, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { value: +v.toFixed(2), weight: weights[k], points: +(weights[k] / total * 100 * v).toFixed(1) }])) };
}

function group(cards, keyOf, extra, weights, durMed, prev) {
  const m = new Map();
  for (const c of cards) { const k = keyOf(c); if (k) (m.get(k) || m.set(k, []).get(k)).push(c); }
  return [...m].map(([key, list]) => {
    const sc = scoreOf(list, weights, durMed[list[0].role] || 0);
    const before = scoreOf(prev.filter((c) => keyOf(c) === key), weights, durMed[list[0].role] || 0);
    const reasons = {};
    for (const c of list) for (const r of c.rejectReasons) reasons[r] = (reasons[r] || 0) + 1;
    const cost = list.reduce((s, c) => s + c.costUsd, 0);
    return {
      key, ...extra(list[0]), tasks: list.length, scored: !!sc, score: sc?.score ?? null, trend: sc && before ? sc.score - before.score : null, breakdown: sc?.parts || null,
      firstPass: list.filter((c) => c.firstPass).length, returns: list.reduce((s, c) => s + c.returns, 0), rejectReasons: reasons,
      cut: list.filter((c) => c.cut).length, regressions: list.filter((c) => c.causedRegression).length, autoApproved: list.filter((c) => c.approvedBy === 'revisor').length,
      costUsd: +cost.toFixed(4), avgCostUsd: +(cost / list.length).toFixed(4),
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tasks - a.tasks);
}

// compute(state, {projectId, days, now, estimates, events}) → { days, weights, minTasks, tasks, agents, roles, models, roleModels }
export function compute(state, { projectId = '', days = 30, now = Date.now(), estimates = {}, events = [] } = {}) {
  days = Math.max(1, Math.min(3650, Math.round(Number(days)) || 30));
  const weights = weightsOf(state.settings);
  const all = state.tasks.filter((t) => t.kind !== 'plan');
  const regs = regressions(all);
  const done = all.filter((t) => t.status === 'done' && (!projectId || t.projectId === projectId));
  const card = (t) => taskCard(t, { estimates, regs, events });
  const cur = done.filter((t) => doneAt(t) > now - days * DAY && doneAt(t) <= now).map(card);
  const prev = done.filter((t) => doneAt(t) > now - 2 * days * DAY && doneAt(t) <= now - days * DAY).map(card);
  const durMed = {};
  for (const r of new Set(cur.concat(prev).map((c) => c.role))) durMed[r] = median(cur.concat(prev).filter((c) => c.role === r && c.durationMs).map((c) => c.durationMs));
  const names = Object.fromEntries((state.agents || []).map((a) => [a.id, a]));
  const modelKey = (c) => (c.model ? `${c.engine || '?'}/${c.model}` : '');
  const g = (cards, keyOf, extra, p) => group(cards, keyOf, extra, weights, durMed, p);
  return {
    days, projectId: projectId || null, weights, minTasks: MIN_TASKS, from: now - days * DAY, to: now,
    tasks: cur,
    agents: g(cur, (c) => c.agentId, (c) => ({ agentId: c.agentId, name: names[c.agentId]?.name || c.agentId, role: names[c.agentId]?.role || c.role, engine: names[c.agentId]?.engine || c.engine }), prev),
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
