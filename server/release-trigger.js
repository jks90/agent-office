// 🚀 Disparo automático «Publicar X.Y.Z» (FT-174). Sin IA: detecta épicas completas y bugs aprobados, propone la versión por
// Telegram (FT-170: ✅/❌) y, solo con ✅, lanza scripts/release/run-all.sh (FT-173). Las funciones de decisión son puras;
// la orquestación recibe sus dependencias (tareas, Telegram, run-all, versión) para probarse sin publicar nada.
//   · épica completa: todas sus tareas (mismo prefijo de título «FT-E: …» o mismo `epic`) en Hecho/Descartada.
//   · bug aprobado: título «Bug»/«Fix»/«Regresión» o reporte 📮, en Hecho.
//   · minor si hay funcionalidad (épica), patch si solo hay bugs. Varios disparos a la vez → UNA pregunta que los agrupa.
//   · ❌ o timeout (12 h) → no publica; lo propuesto queda acumulado para la siguiente pregunta.
//   · mutex persistente (data/release-trigger.json): nunca dos publicaciones (ni dos preguntas) a la vez.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './store.js';

const FILE = path.join(DATA_DIR, 'release-trigger.json');
export const ASK_STALE_MS = 13 * 3600e3;  // la pregunta caduca a las 12 h (FT-170); 1 h de margen
export const RUN_STALE_MS = 2 * 3600e3;   // un run-all que no termina en 2 h se da por muerto
const DONE = ['done', 'discarded'];

const load = () => { try { return { published: [], pending: [], lock: null, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { published: [], pending: [], lock: null }; } };
const save = (s) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); };

export const isBug = (t) => /^\s*(📮\s*)?(bug|fix|regresi[oó]n)\b/i.test(t.title || '') || /📮/.test(t.title || '') || t.source?.kind === 'report';
const isRelease = (t) => t.role === 'release' || /^Publicar \d+\.\d+\.\d+/.test(t.title || '');
const epicKey = (t) => t.epic || (/^\s*([^:\n]{1,24}):/.exec(t.title || '')?.[1] ?? '').trim();

/** Qué hay publicable ahora: [{key, kind:'epic'|'bug', label, taskIds}]. `published` = ids ya cubiertos por una publicación. */
export function detect(tasks, published = []) {
  const done = new Set(published), items = [];
  const work = tasks.filter((t) => t.kind !== 'plan' && !isRelease(t));
  const groups = new Map();
  for (const t of work) { const k = epicKey(t); if (k && !/^(planificar|publicar)$/i.test(k)) groups.set(k, [...(groups.get(k) || []), t]); }
  const inEpic = new Set();
  for (const [k, ts] of groups) {
    if (ts.length < 2 || !ts.every((t) => DONE.includes(t.status)) || !ts.some((t) => t.status === 'done')) continue;
    if (ts.every((t) => done.has(t.id))) continue;
    ts.forEach((t) => inEpic.add(t.id));
    items.push({ key: `epic:${k}`, kind: 'epic', label: `Épica ${k} (${ts.filter((t) => t.status === 'done').length} tareas)`, taskIds: ts.map((t) => t.id) });
  }
  for (const t of work) {
    if (t.status !== 'done' || done.has(t.id) || inEpic.has(t.id) || !isBug(t)) continue;
    items.push({ key: `bug:${t.id}`, kind: 'bug', label: `Bug: ${t.title}`, taskIds: [t.id] });
  }
  return items;
}

/** minor si hay funcionalidad (alguna épica), patch si solo hay bugs. */
export function bump(version, items) {
  const [a, b, c] = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  return items.some((i) => i.kind === 'epic') ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

export function question(version, items) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const what = items.some((i) => i.kind === 'epic') ? (items.some((i) => i.kind === 'bug') ? 'épica + bugs' : 'épica completa') : 'bugs';
  return `🚀 ¿Publico la ${version}? · ${what} · ${items.map((i) => esc(i.label)).join('; ')} · ✅/❌`;
}

// ── Mutex persistente ────────────────────────────────────────────────────────────────────────
const fresh = (l) => l && Date.now() - l.at < (l.phase === 'running' ? RUN_STALE_MS : ASK_STALE_MS);
/** Toma el mutex (síncrono: dos llamadas simultáneas no pueden ganar a la vez). `from` = fase desde la que se puede promocionar. */
export function acquire(id, phase, from = null) {
  const s = load();
  if (from ? !(fresh(s.lock) && s.lock.id === id && s.lock.phase === from) : fresh(s.lock)) return false;
  s.lock = { id, phase, at: Date.now() };
  save(s);
  return true;
}
export function release(id) { const s = load(); if (s.lock?.id === id) { s.lock = null; save(s); } }
export const state = () => load();

/**
 * Un ciclo. deps: { tasks():[], version():string, createTask(o)→task, updateTask(id,patch), sendConfirm, waitConfirm, runAll(version)→{ok,out} }.
 * Devuelve {action:'none'|'busy'|'asked'|'no'|'timeout'|'published'|'failed', ...}.
 */
export async function check(deps) {
  const s0 = load();
  const found = detect(deps.tasks(), s0.published);
  const items = [...new Map([...s0.pending, ...found].map((i) => [i.key, i])).values()];
  if (!items.length) return { action: 'none' };
  const version = bump(deps.version(), items), id = `release-${version}`;
  if (!acquire(id, 'asking')) return { action: 'busy' };       // ya hay una pregunta o una publicación en curso
  try {
    // La tarea «Publicar X.Y.Z»: si quedó una acumulada de un ❌ anterior, se reutiliza con la versión nueva.
    const body = items.map((i) => `- ${i.label}`).join('\n');
    const old = deps.tasks().find((t) => isRelease(t) && t.status === 'backlog');
    let task = old;
    if (old) deps.updateTask(old.id, { title: `Publicar ${version}`, description: body });
    else task = deps.createTask({ title: `Publicar ${version}`, description: body, role: 'release', status: 'backlog', source: { kind: 'release-trigger' } });
    const s = load(); s.pending = items; save(s);
    const sent = await deps.sendConfirm(question(version, items), id);
    if (!sent) { release(id); return { action: 'no', reason: 'sin Telegram: no se publica', version }; }
    const ans = await deps.waitConfirm(id);
    if (ans !== 'yes') { release(id); return { action: ans === 'no' ? 'no' : 'timeout', version, taskId: task?.id }; }
    const r = await runRelease(version, items, deps, id);
    if (task) deps.updateTask(task.id, { status: r.action === 'published' ? 'done' : 'backlog' });
    return { ...r, version, taskId: task?.id };
  } catch (e) { release(id); throw e; }
}

/** ✅ recibido: lanza run-all UNA vez. Con una publicación en curso (o ya hecha) no lanza otra. */
export async function runRelease(version, items, deps, id = `release-${version}`) {
  if (!acquire(id, 'running', 'asking')) return { action: 'busy' };
  try {
    const r = await deps.runAll(version);
    if (!r.ok) return { action: 'failed', out: r.out };
    const s = load();
    s.published = [...new Set([...s.published, ...items.flatMap((i) => i.taskIds)])];
    s.pending = s.pending.filter((p) => !items.some((i) => i.key === p.key));
    save(s);
    return { action: 'published' };
  } finally { release(id); }
}

// ── Dependencias reales ──────────────────────────────────────────────────────────────────────
/** Directorio de flow-test (de ahí salen la versión y scripts/release): settings.flowTestDir o un repo del proyecto llamado flow-test*. */
export function flowTestDir(st) {
  const repos = st.projects.flatMap((p) => p.repos || []).map((r) => r.path);
  return st.settings.flowTestDir || repos.find((p) => /flow-test/.test(path.basename(p))) || null;
}

export function realDeps(team, store, telegram) {
  const dir = () => flowTestDir(store.get());
  return {
    tasks: () => store.get().tasks,
    version: () => JSON.parse(fs.readFileSync(path.join(dir(), 'package.json'), 'utf8')).version,
    createTask: (o) => team.createTask({ projectId: store.get().projects.find((p) => flowTestDir({ projects: [p], settings: {} }))?.id || store.get().projects[0]?.id, ...o }),
    updateTask: (id, patch) => { const t = store.get().tasks.find((x) => x.id === id); if (t) { Object.assign(t, patch); store.changed(); } },
    sendConfirm: telegram.sendConfirm, waitConfirm: telegram.waitConfirm,
    // RELEASE_NOTIFY_CMD recibe el mensaje como argumento y por stdin; el envío es el de Telegram (bin/ao-telegram.mjs).
    runAll: (version) => new Promise((resolve) => {
      const env = { ...process.env, RELEASE_NOTIFY_CMD: `node ${path.join(ROOT, 'bin', 'ao-telegram.mjs')}` };
      const p = spawn('bash', ['scripts/release/run-all.sh', version], { cwd: dir(), env });
      let out = '';
      p.stdout.on('data', (d) => { out = (out + d).slice(-4000); }); p.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
      p.on('error', (e) => resolve({ ok: false, out: e.message }));
      p.on('close', (code) => resolve({ ok: code === 0, out }));
    }),
  };
}
