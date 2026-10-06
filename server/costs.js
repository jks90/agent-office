// Observabilidad de costes (FT-76): telemetría por turno, desglose por causa, KPI y comparación con la línea base interactiva.
// Fuente de verdad: data/costs/<proyectoId>/<tareaId>.jsonl (una línea por turno). El resto se DERIVA de esos ficheros.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { costOf, priceOf, cacheSaving } from './pricing.js';
import { VARIANTS } from './ponytail.js'; // FT-86

const dir = () => path.join(DATA_DIR, 'costs');
const fileOf = (projectId, taskId) => path.join(dir(), String(projectId).replace(/[^\w-]/g, '_'), String(taskId).replace(/[^\w-]/g, '_') + '.jsonl');
const TOK_PER_BYTE = 0.25, TOK_PER_IMAGE = 1500; // estimación: ≈4 bytes por token; una captura ≈1 500 tokens
const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;

const bytesOf = (c) => (typeof c === 'string' ? Buffer.byteLength(c) : Array.isArray(c) ? c.reduce((n, x) => n + (x?.type === 'text' ? Buffer.byteLength(x.text || '') : 0), 0) : 0);
const imagesOf = (c) => (Array.isArray(c) ? c.filter((x) => x?.type === 'image').length : 0);
const fileArg = (input = {}) => input.file_path || input.path || input.notebook_path || null;

// ── Registro de turnos ─────────────────────────────────────────────────────
// `feed(ev)` recibe los eventos ya parseados del motor (stream-json de Claude o JSONL de Codex); `finish()` vuelca el último turno.
export function recorder({ projectId, taskId, attempt = 1, engine, model = '', role = '', variant = 'base' }) {
  if (!projectId || !taskId) return { feed() {}, finish() {} };
  const file = fileOf(projectId, taskId);
  let n = 0, cur = null, curModel = model;
  const flush = () => {
    if (!cur) return;
    const t = cur; cur = null;
    const u = t.usage, tools = t.tools.map((x) => ({ name: x.name, file: x.file || undefined, bytes: x.bytes, image: x.image || undefined }));
    const line = {
      ts: t.ts, attempt, engine, model: t.model || curModel, role, variant, turn: ++n,
      input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output,
      costUsd: round(costOf(t.model || curModel, u)), tool: tools[0]?.name || null, tools,
      bytes: tools.reduce((s, x) => s + (x.bytes || 0), 0), image: tools.some((x) => x.image),
    };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(line) + '\n'); } catch { /* la telemetría nunca rompe la tarea */ }
  };
  const num = (x) => Number(x) || 0;
  return {
    feed(ev) {
      if (!ev) return;
      if (engine === 'claude') {
        if (ev.type === 'system' && ev.model) curModel = ev.model;
        if (ev.type === 'assistant' && ev.message?.usage) {
          const m = ev.message, u = m.usage;
          if (!cur || cur.id !== m.id) { flush(); cur = { id: m.id, ts: Date.now(), tools: [], model: m.model || curModel, usage: {} }; }
          cur.usage = { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) };
          for (const c of m.content || []) if (c.type === 'tool_use' && !cur.tools.some((x) => x.id === c.id)) cur.tools.push({ id: c.id, name: c.name, file: fileArg(c.input), bytes: 0 });
        } else if (ev.type === 'user' && cur) {
          for (const c of ev.message?.content || []) {
            if (c.type !== 'tool_result') continue;
            const t = cur.tools.find((x) => x.id === c.tool_use_id);
            if (t) { t.bytes += bytesOf(c.content); if (imagesOf(c.content)) t.image = true; }
          }
        }
      } else if (engine === 'codex') {
        if (ev.type === 'item.completed' && ev.item) {
          const it = ev.item;
          cur ||= { ts: Date.now(), tools: [], usage: {} };
          if (it.type === 'command_execution') cur.tools.push({ name: 'Bash', bytes: Buffer.byteLength(it.aggregated_output || '') });
          else if (it.type === 'file_change') cur.tools.push({ name: 'Edit', file: it.changes?.[0]?.path, bytes: 0 });
          else if (it.type === 'mcp_tool_call') cur.tools.push({ name: `mcp__${it.server}__${it.tool}`, bytes: Buffer.byteLength(JSON.stringify(it.result || '')), image: /"type":"image"/.test(JSON.stringify(it.result || '')) });
        } else if (ev.type === 'turn.completed' && ev.usage) {
          cur ||= { ts: Date.now(), tools: [], usage: {} };
          const cached = num(ev.usage.cached_input_tokens);
          cur.usage = { input: Math.max(0, num(ev.usage.input_tokens) - cached), cacheRead: cached, cacheWrite: 0, output: num(ev.usage.output_tokens) };
          flush();
        }
      }
    },
    finish: flush,
  };
}

export function readTurns(projectId, taskId) {
  try { return fs.readFileSync(fileOf(projectId, taskId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// ── Desglose por causa ──────────────────────────────────────────────────────
// Modelo: lo que se paga en un turno = reenviar TODO el contexto (+ lo nuevo que escribió a caché) + generar la salida.
// El coste de «contexto» de cada turno se reparte entre lo que lo compone: el arranque (contexto del turno 1) y lo que
// devolvió cada herramienta en turnos anteriores (bytes/4; una imagen ≈1 500 tokens). Es una ATRIBUCIÓN estimada, no una medida.
// Los intentos anteriores al último (tirados o devueltos) van enteros a «reintentos».
export function breakdown(turns) {
  const last = Math.max(0, ...turns.map((t) => t.attempt || 1));
  const out = { arranque: 0, lecturas: 0, comandos: 0, imagenes: 0, salida: 0, reintentos: 0 };
  const files = {};
  const acc = turns.filter((t) => (t.attempt || 1) === last);
  out.reintentos = turns.filter((t) => (t.attempt || 1) !== last).reduce((s, t) => s + t.costUsd, 0);
  let start = 0; const parts = []; // parts: {kind, file, tok}
  acc.forEach((t, i) => {
    const p = priceOf(t.model);
    const outCost = (t.output * p.output) / 1e6, ctxCost = Math.max(0, t.costUsd - outCost);
    out.salida += outCost;
    const ctxTok = t.input + t.cacheRead + t.cacheWrite;
    if (i === 0) { start = ctxTok; out.arranque += ctxCost; }
    else {
      const total = start + parts.reduce((s, x) => s + x.tok, 0) || 1;
      out.arranque += ctxCost * (start / total);
      for (const x of parts) {
        const share = ctxCost * (x.tok / total);
        out[x.kind] += share;
        if (x.file) files[x.file] = (files[x.file] || 0) + share;
      }
    }
    for (const x of t.tools || []) {
      const read = /^(Read|NotebookRead)$/.test(x.name);
      if (x.bytes) parts.push({ kind: read ? 'lecturas' : 'comandos', file: read ? x.file : null, tok: x.bytes * TOK_PER_BYTE });
      if (x.image) parts.push({ kind: 'imagenes', tok: TOK_PER_IMAGE });
    }
  });
  const total = Object.values(out).reduce((s, v) => s + v, 0);
  return { ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, round(v)])), total: round(total), attempt: last, files: Object.entries(files).map(([file, usd]) => ({ file, usd: round(usd) })).sort((a, b) => b.usd - a.usd).slice(0, 10) };
}

// Resumen de una tarea: coste total, intento aceptado vs tirados, turnos, curva de contexto, caché y tiempo.
export function taskSummary(task, turns = readTurns(task.projectId, task.id)) {
  if (!turns.length) return { taskId: task.id, code: task.code, turns: 0, costUsd: task.costUsd || 0, telemetry: false };
  const last = Math.max(...turns.map((t) => t.attempt || 1));
  const acc = turns.filter((t) => (t.attempt || 1) === last);
  const sum = (a, f) => a.reduce((s, t) => s + f(t), 0);
  const ctx = (t) => t.input + t.cacheRead + t.cacheWrite;
  const totalCtx = sum(turns, ctx);
  return {
    taskId: task.id, code: task.code, role: task.role, telemetry: true,
    model: turns.at(-1).model, engine: turns.at(-1).engine, variant: turns.at(-1).variant || 'base', // FT-86
    costUsd: round(sum(turns, (t) => t.costUsd)), acceptedUsd: round(sum(acc, (t) => t.costUsd)), discardedUsd: round(sum(turns.filter((t) => (t.attempt || 1) !== last), (t) => t.costUsd)),
    attempts: last, returns: task.returns || 0, turns: turns.length, outputTokens: sum(turns, (t) => t.output), tokens: sum(turns, (t) => ctx(t) + t.output),
    curve: acc.map((t) => ctx(t)), cachePct: totalCtx ? Math.round((100 * sum(turns, (t) => t.cacheRead)) / totalCtx) : 0,
    cacheSavedUsd: round(sum(turns, (t) => cacheSaving(t.model, t.cacheRead))),
    ms: new Date(turns.at(-1).ts) - new Date(turns[0].ts), imageTurns: turns.filter((t) => t.image).length,
  };
}

export function taskDetail(task) {
  const turns = readTurns(task.projectId, task.id);
  return { ...taskSummary(task, turns), breakdown: breakdown(turns), turnList: turns.map((t) => ({ turn: t.turn, attempt: t.attempt, tool: t.tool, bytes: t.bytes, image: t.image, ctx: t.input + t.cacheRead + t.cacheWrite, output: t.output, costUsd: t.costUsd })) };
}

// ── Línea base interactiva ──────────────────────────────────────────────────
const baseFile = () => path.join(dir(), 'baseline.json');
export const readBaseline = () => { try { return JSON.parse(fs.readFileSync(baseFile(), 'utf8')); } catch { return []; } };
function saveBaseline(list) { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(baseFile(), JSON.stringify(list, null, 1)); }

// Coste por turnos de un transcript de Claude Code (~/.claude/projects/**.jsonl): un mensaje assistant por id, el último uso gana.
export function transcriptCost(file) {
  const byId = new Map(); let first = null, lastTs = null;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage) continue;
    first ||= e.timestamp; lastTs = e.timestamp || lastTs;
    byId.set(m.id || e.uuid, { model: m.model, u: { input: m.usage.input_tokens || 0, cacheRead: m.usage.cache_read_input_tokens || 0, cacheWrite: m.usage.cache_creation_input_tokens || 0, output: m.usage.output_tokens || 0 } });
  }
  let costUsd = 0, tokens = 0;
  for (const { model, u } of byId.values()) { costUsd += costOf(model, u); tokens += u.input + u.cacheRead + u.cacheWrite + u.output; }
  return { costUsd: round(costUsd), turns: byId.size, tokens, ms: first && lastTs ? new Date(lastTs) - new Date(first) : null };
}

// POST /api/costs/baseline {code, title?, transcript? | costUsd?, files?, lines?}. El transcript debe estar bajo ~/.claude.
export function addBaseline(b, fail) {
  const code = String(b.code || '').trim();
  if (!code) throw fail(400, 'Falta el código de la tarea (p. ej. FT-66)');
  let m = { costUsd: Number(b.costUsd) || 0, turns: Number(b.turns) || null, tokens: null, ms: null };
  if (b.transcript) {
    const f = path.resolve(String(b.transcript).replace(/^~/, os.homedir()));
    if (!f.startsWith(path.join(os.homedir(), '.claude') + path.sep) || !fs.existsSync(f)) throw fail(400, 'El transcript debe existir y estar bajo ~/.claude');
    m = transcriptCost(f);
  }
  if (!(m.costUsd > 0)) throw fail(400, 'Sin coste: pasa `transcript` o `costUsd`');
  const entry = { code, title: String(b.title || ''), ...m, files: Number(b.files) || null, lines: Number(b.lines) || null, source: b.transcript ? 'transcript' : 'manual', addedAt: Date.now() };
  saveBaseline([...readBaseline().filter((x) => x.code !== code), entry]);
  return entry;
}

// ── KPI y comparación ───────────────────────────────────────────────────────
const linesOf = (diffStat) => { const m = /(\d+) insertion|(\d+) deletion/g; let n = 0, x; while ((x = m.exec(diffStat || ''))) n += Number(x[1] || x[2]); return n; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const weekOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

function group(rows, key) {
  const g = {};
  for (const r of rows) (g[r[key] || '—'] ||= []).push(r);
  return Object.entries(g).map(([k, a]) => ({ key: k, tasks: a.length, costUsd: round(a.reduce((s, r) => s + r.costUsd, 0), 4), perApprovedUsd: round(mean(a.map((r) => r.costUsd)), 4), firstTryPct: Math.round((100 * a.filter((r) => !r.returns).length) / a.length) })).sort((x, y) => y.costUsd - x.costUsd);
}

// FT-86: comparación base vs ponytail (solo tareas aprobadas): coste, tokens, salida, devoluciones y líneas del diff, por tarea.
export function byVariant(rows) {
  return VARIANTS.map((v) => {
    const a = rows.filter((r) => r.status === 'done' && (r.variant || 'base') === v), n = a.length, per = (f) => (n ? round(a.reduce((s, r) => s + (f(r) || 0), 0) / n, 4) : null);
    return { key: v, tasks: n, costUsd: round(a.reduce((s, r) => s + r.costUsd, 0), 4), perApprovedUsd: per((r) => r.costUsd), tokens: per((r) => r.tokens), outputTokens: per((r) => r.outputTokens), returns: per((r) => r.returns), lines: per((r) => r.lines), firstTryPct: n ? Math.round((100 * a.filter((r) => !r.returns).length) / n) : null };
  });
}

export function overview(state, now = Date.now(), { variant = '' } = {}) {
  const projName = (id) => state.projects.find((p) => p.id === id)?.name || id;
  const allRows = state.tasks.filter((t) => t.kind !== 'plan' && (t.costUsd > 0 || readTurns(t.projectId, t.id).length)).map((t) => {
    const turns = readTurns(t.projectId, t.id), s = taskSummary(t, turns);
    return { ...s, status: t.status, title: t.title, projectId: t.projectId, project: projName(t.projectId), returns: t.returns || 0, costUsd: s.telemetry ? s.costUsd : t.costUsd || 0, updatedAt: t.updatedAt, lines: linesOf(t.diffStat), breakdown: s.telemetry ? breakdown(turns) : null };
  });
  const rows = VARIANTS.includes(variant) ? allRows.filter((r) => (r.variant || 'base') === variant) : allRows; // FT-86: filtro por variante
  const done = rows.filter((r) => r.status === 'done');
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const base = readBaseline(), bAvg = mean(base.map((b) => b.costUsd));
  const agentAvg = mean(done.map((r) => r.costUsd));
  const bLine = base.filter((b) => b.lines), dLine = done.filter((r) => r.lines);
  const perLine = { agent: dLine.length ? round(dLine.reduce((s, r) => s + r.costUsd, 0) / dLine.reduce((s, r) => s + r.lines, 0), 5) : null, interactive: bLine.length ? round(bLine.reduce((s, b) => s + b.costUsd, 0) / bLine.reduce((s, b) => s + b.lines, 0), 5) : null };
  const ratioPct = bAvg && done.length ? Math.round((100 * agentAvg) / bAvg) : null;
  const ratioLinePct = perLine.agent != null && perLine.interactive ? Math.round((100 * perLine.agent) / perLine.interactive) : null;
  const target = Number(state.settings?.costTargetPct) || 100;
  const cmp = ratioLinePct ?? ratioPct; // normalizado por líneas cuando hay datos de ambos lados
  const weeks = {};
  for (const r of done) (weeks[weekOf(r.updatedAt)] ||= []).push(r.costUsd);
  const days = [];
  for (let i = 6; i >= 0; i--) { const d0 = new Date(now - i * 864e5).setHours(0, 0, 0, 0), a = done.filter((r) => r.updatedAt >= d0 && r.updatedAt < d0 + 864e5); days.push({ day: new Date(d0).toISOString().slice(0, 10), approved: a.length, perApprovedUsd: round(mean(a.map((r) => r.costUsd)), 4) }); }
  const kpi = {
    totalUsd: round(total, 4), approved: done.length, perApprovedUsd: round(agentAvg, 4), medianApprovedUsd: round(median(done.map((r) => r.costUsd)), 4),
    firstTryPct: done.length ? Math.round((100 * done.filter((r) => !r.returns).length) / done.length) : null,
    discardedUsd: round(rows.reduce((s, r) => s + (r.discardedUsd || 0), 0), 4), costPerReturnUsd: round(mean(rows.filter((r) => r.returns).map((r) => (r.discardedUsd || 0) / r.returns)), 4),
    cacheSavedUsd: round(rows.reduce((s, r) => s + (r.cacheSavedUsd || 0), 0), 4),
    interactiveUsd: base.length ? round(bAvg, 4) : null, perLine, ratioPct, ratioLinePct, targetPct: target, meetsTarget: cmp == null ? null : cmp <= target,
  };
  const weekly = Object.entries(weeks).sort().map(([week, a]) => { const avg = mean(a); const pct = bAvg ? Math.round((100 * avg) / bAvg) : null; return { week, approved: a.length, perApprovedUsd: round(avg, 4), ratioPct: pct, meetsTarget: pct == null ? null : pct <= target }; });
  return { kpi, trend7d: days, weekly, byRole: group(done, 'role'), byModel: group(done, 'model'), byEngine: group(done, 'engine'), byProject: group(done, 'project'), byVariant: byVariant(allRows), variant: VARIANTS.includes(variant) ? variant : '', baseline: base, tasks: rows.sort((a, b) => b.updatedAt - a.updatedAt).map(({ curve, ...r }) => ({ ...r, curve })), recommendations: recommend(rows, kpi, target, cmp) };
}

// Recomendaciones automáticas a partir de los datos (FT-76 · fase 4). Reglas simples y explicables; solo con muestra suficiente.
export function recommend(rows, kpi, target, cmp) {
  const rec = [], tel = rows.filter((r) => r.breakdown);
  const sum = (f) => tel.reduce((s, r) => s + f(r.breakdown), 0), tot = sum((b) => b.total);
  if (tot > 0) {
    const share = (k) => Math.round((100 * sum((b) => b[k])) / tot);
    if (share('arranque') >= 40) rec.push({ kind: 'arranque', text: `El arranque (prompt de sistema + memoria + skills + herramientas) es el ${share('arranque')} % del gasto: recorta skills/MCP del rol y el briefing.` });
    if (share('reintentos') >= 25) rec.push({ kind: 'reintentos', text: `Los intentos tirados o devueltos suponen el ${share('reintentos')} % del gasto: afina el enunciado de las tareas (criterios de hecho claros) antes de lanzarlas.` });
    if (share('comandos') >= 30) rec.push({ kind: 'comandos', text: `Las salidas de comandos/e2e son el ${share('comandos')} % del gasto: filtra la salida (rtk, tail, grep) y ejecuta los e2e una sola vez.` });
    if (share('imagenes') >= 15) rec.push({ kind: 'imagenes', text: `Las imágenes son el ${share('imagenes')} % del gasto: limita las capturas a una por tarea.` });
    const byFile = {};
    for (const r of tel) for (const f of r.breakdown.files) { const k = `${r.project}|${f.file}`; byFile[k] = (byFile[k] || 0) + f.usd; }
    const projTot = {}; for (const r of tel) projTot[r.project] = (projTot[r.project] || 0) + r.breakdown.total;
    for (const [k, usd] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      const [proj, file] = k.split('|'), pct = Math.round((100 * usd) / projTot[proj]);
      if (pct >= 15) rec.push({ kind: 'fichero', text: `El ${pct} % del coste de ${proj} son lecturas de ${path.basename(file)}: léelo por tramos, dale un índice de código o pártelo.` });
    }
  }
  const done = rows.filter((r) => r.status === 'done'), pairs = {};
  for (const r of done) (pairs[r.role] ||= {})[r.model] ||= [], pairs[r.role][r.model].push(r);
  for (const [role, models] of Object.entries(pairs)) {
    const st = Object.entries(models).filter(([, a]) => a.length >= 3).map(([m, a]) => ({ m, n: a.length, ft: Math.round((100 * a.filter((x) => !x.returns).length) / a.length), usd: mean(a.map((x) => x.costUsd)) }));
    if (st.length < 2) continue;
    const cheap = st.reduce((a, b) => (b.usd < a.usd ? b : a)), good = st.reduce((a, b) => (b.ft > a.ft ? b : a));
    if (cheap.m !== good.m && good.ft - cheap.ft >= 20) rec.push({ kind: 'modelo', text: `${role} en ${cheap.m}: ${cheap.ft} % aprobadas a la primera frente a ${good.ft} % en ${good.m} → sube a ${good.m} (cuesta ${cheap.usd.toFixed(2)} $ vs ${good.usd.toFixed(2)} $ por tarea).` });
  }
  if (cmp != null && cmp > target) rec.push({ kind: 'objetivo', text: `El coste por tarea aprobada es el ${cmp} % del interactivo (objetivo ≤ ${target} %): empieza por la recomendación de mayor porcentaje.` });
  return rec;
}

// Export plano (una fila por turno) para CSV/flows.
export function exportRows(state) {
  const rows = [];
  for (const t of state.tasks) for (const x of readTurns(t.projectId, t.id)) rows.push({ project: t.projectId, task: t.code || t.id, ...x, tools: undefined });
  return rows;
}
export const toCsv = (rows) => { const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] !== undefined)); return [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n'); };
