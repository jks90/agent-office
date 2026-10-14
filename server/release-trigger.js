// 🚀 Disparo automático «Publicar X.Y.Z» (FT-174; rehecho con el perfil de release). Sin IA: detecta épicas completas y bugs
// aprobados QUE TOCAN flow-test (las de otros proyectos o solo de agent-office no publican flow-test), propone la versión en
// 🔔 Para ti (y avisa por Telegram si está activo) y, solo con ✅, encarga DOS tareas: «Documentar X.Y.Z» (documentalista de
// releases, skill prod, sobre main) y «Publicar X.Y.Z» (agente de Release; la ejecuta AgentOffice: scripts/release/run-all.sh),
// que depende de la primera. El paso 03 del pipeline comprueba la documentación antes de publicar nada.
// Las funciones de decisión son puras; la orquestación recibe sus dependencias para probarse sin publicar nada.
//   · épica completa: todas sus tareas (mismo prefijo de título «FT-E: …» o mismo `epic`) en Hecho/Descartada.
//   · bug aprobado: título «Bug»/«Fix»/«Regresión» o reporte 📮, en Hecho.
//   · minor si hay funcionalidad (épica), patch si solo hay bugs. Varios disparos a la vez → UNA pregunta que los agrupa.
//   · ❌ o timeout (12 h) → no publica; lo propuesto queda acumulado para la siguiente pregunta.
//   · mutex persistente (data/release-trigger.json): nunca dos publicaciones (ni dos preguntas) a la vez.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, ROOT } from './store.js';
import { allRoles } from './roles.js';
import { publishSelf } from './selfupdate.js';

const gitRun = async (dir, ...args) => (await promisify(execFile)('git', ['-C', dir, ...args], { timeout: 60_000 })).stdout;

const FILE = path.join(DATA_DIR, 'release-trigger.json');
export const ASK_STALE_MS = 13 * 3600e3;  // la pregunta caduca a las 12 h (FT-170); 1 h de margen
export const RUN_STALE_MS = 2 * 3600e3;   // un run-all que no termina en 2 h se da por muerto
export const DISPATCH_STALE_MS = 24 * 3600e3; // documentar + publicar: si en 24 h no ha terminado, se libera para volver a proponer
const DONE = ['done', 'discarded'];

const load = () => { try { return { published: [], pending: [], lock: null, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { published: [], pending: [], lock: null }; } };
const save = (s) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); };

export const isBug = (t) => /^\s*(📮\s*)?(bug|fix|regresi[oó]n)\b/i.test(t.title || '') || /📮/.test(t.title || '') || t.source?.kind === 'report';
const isRelease = (t) => !!t.releaseVersion || t.role === 'release' || /^(Publicar|Documentar) \d+\.\d+\.\d+/.test(t.title || '');
export const touches = (t, key = 'flow-test') => t.repo === key || !!t.repos?.[key];
const epicKey = (t) => t.epic || (/^\s*([^:\n]{1,24}):/.exec(t.title || '')?.[1] ?? '').trim();

/** Qué hay publicable ahora: [{key, kind:'epic'|'bug', label, taskIds}]. `published` = ids ya cubiertos por una publicación.
 *  Solo cuenta lo que toca el repo `repoKey` (flow-test): épicas con sus partes (epicParts, todas resueltas) o, a la antigua,
 *  2+ tareas con el mismo prefijo «X: …» en el título; y bugs aprobados. */
export function detect(tasks, published = [], { repoKey = 'flow-test' } = {}) {
  const done = new Set(published), items = [];
  const work = tasks.filter((t) => t.kind !== 'plan' && !isRelease(t));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const inEpic = new Set();
  for (const e of work.filter((t) => t.epicParts?.length)) {
    const parts = e.epicParts.map((id) => byId.get(id)).filter(Boolean);
    if (!parts.length || !parts.every((t) => DONE.includes(t.status)) || !parts.some((t) => t.status === 'done')) continue;
    if (!parts.some((t) => touches(t, repoKey)) && !touches(e, repoKey)) continue;
    const ids = [e.id, ...parts.map((t) => t.id)];
    ids.forEach((id) => inEpic.add(id));
    if (ids.every((id) => done.has(id))) continue;
    items.push({ key: `epic:${e.code || e.id}`, kind: 'epic', label: `Épica ${e.code ? e.code + ' ' : ''}${e.title} (${parts.filter((t) => t.status === 'done').length} tareas)`, taskIds: ids });
  }
  const groups = new Map();
  for (const t of work) { if (inEpic.has(t.id) || !touches(t, repoKey)) continue; const k = epicKey(t); if (k && !/^(planificar|publicar|documentar)$/i.test(k)) groups.set(k, [...(groups.get(k) || []), t]); }
  for (const [k, ts] of groups) {
    if (ts.length < 2 || !ts.every((t) => DONE.includes(t.status)) || !ts.some((t) => t.status === 'done')) continue;
    ts.forEach((t) => inEpic.add(t.id));
    if (ts.every((t) => done.has(t.id))) continue;
    items.push({ key: `epic:${k}`, kind: 'epic', label: `Épica ${k} (${ts.filter((t) => t.status === 'done').length} tareas)`, taskIds: ts.map((t) => t.id) });
  }
  for (const t of work) {
    if (t.status !== 'done' || done.has(t.id) || inEpic.has(t.id) || !isBug(t) || !touches(t, repoKey)) continue;
    items.push({ key: `bug:${t.id}`, kind: 'bug', label: `Bug: ${t.code ? t.code + ' ' : ''}${t.title}`, taskIds: [t.id] });
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
  return `🚀 ¿Publico flow-test ${version}? (${what}): ${items.map((i) => esc(i.label)).join('; ')}`;
}

// ── Mutex persistente ────────────────────────────────────────────────────────────────────────
const fresh = (l) => l && Date.now() - l.at < (l.phase === 'running' ? RUN_STALE_MS : l.phase === 'dispatched' ? DISPATCH_STALE_MS : ASK_STALE_MS);
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
 * Un ciclo. deps: { tasks():[], version():string, createTask(o)→task, updateTask(id,patch), ask(text,id)→'yes'|'no'|'timeout',
 *   askPending(id)→bool, notify(text), agentFor(kind)→agent|null, docsDirs:[] }.
 * Devuelve {action:'baseline'|'none'|'busy'|'no'|'timeout'|'no-agent'|'dispatched'|'published'|'failed', ...}.
 */
export async function check(deps) {
  const s0 = load();
  // 1.ª vez: lo que ya está hecho se da por publicado (si no, propondría publicar todo el historial)
  if (!s0.baselineAt) { save({ ...s0, published: deps.tasks().filter((t) => DONE.includes(t.status)).map((t) => t.id), pending: [], lock: null, baselineAt: Date.now() }); return { action: 'baseline' }; }
  // Encargado a los agentes: se sigue la tarea «Publicar»
  if (s0.lock?.phase === 'dispatched' && fresh(s0.lock)) {
    const pub = deps.tasks().find((t) => t.id === s0.lock.publishId);
    if (pub?.status === 'done') {
      const s = load();
      s.published = [...new Set([...s.published, ...(s0.lock.items || []).flatMap((i) => i.taskIds)])];
      s.pending = s.pending.filter((p) => !(s0.lock.items || []).some((i) => i.key === p.key));
      s.lock = null; save(s);
      deps.notify?.(`✅ flow-test ${s0.lock.version} publicada en Hub, local, serverman y cloud`);
      return { action: 'published', version: s0.lock.version };
    }
    if (!pub || ['failed', 'discarded'].includes(pub.status)) {
      release(s0.lock.id);
      deps.notify?.(`❌ La publicación de flow-test ${s0.lock.version} no terminó: ${pub?.error ? String(pub.error).split('\n')[0] : 'tarea fallida o descartada'}. Lo pendiente se volverá a proponer.`);
      return { action: 'failed', version: s0.lock.version };
    }
    return { action: 'busy' };
  }
  // Una pregunta que se perdió con un reinicio: se libera para volver a preguntar
  if (s0.lock?.phase === 'asking' && fresh(s0.lock) && deps.askPending && !deps.askPending(s0.lock.id)) release(s0.lock.id);
  const found = detect(deps.tasks(), s0.published, { repoKey: deps.repoKey || 'flow-test' });
  const items = [...new Map([...s0.pending, ...found].map((i) => [i.key, i])).values()];
  if (!items.length) return { action: 'none' };
  const version = bump(deps.version(), items), id = `release-${version}`;
  if (!acquire(id, 'asking')) return { action: 'busy' };       // ya hay una pregunta o una publicación en curso
  try {
    const body = items.map((i) => `- ${i.label}`).join('\n');
    const s = load(); s.pending = items; save(s);
    deps.notify?.(`🚀 ¿Publico flow-test ${version}? Contesta en AgentOffice ▸ 🔔 Para ti.\n${body}`);
    const ans = await deps.ask(question(version, items), id);
    if (ans !== 'yes') { release(id); return { action: ans === 'no' ? 'no' : 'timeout', version }; }
    return dispatch(version, items, deps, id);
  } catch (e) { release(id); throw e; }
}

/** Encarga «Documentar X.Y.Z» (docs, skill prod, sobre main) y «Publicar X.Y.Z» (Release: run-all.sh) con el lock ya cogido. */
function dispatch(version, items, deps, id) {
  try {
    const body = items.map((i) => `- ${i.label}`).join('\n');
    const docsAgent = deps.agentFor('docs-release'), relAgent = deps.agentFor('release');
    if (!relAgent) { release(id); deps.notify?.('⚠ No hay ningún agente de Release en el equipo de flowtest: fíchalo (rol «Release») y lo vuelvo a proponer.'); return { action: 'no-agent', version }; }
    const doc = deps.createTask({ title: `Documentar ${version}`, role: docsAgent?.role || 'release-docs-flowtest', status: 'todo', assignedAgentId: docsAgent?.id,
      description: `Documenta flow-test ${version} siguiendo la skill «prod» (pasos 1, 4 y 5): CLAUDE.md, docs/arquitectura-detallada.md y README de flow-test (sin tocar la línea **Version:**), el repo público y el manual Obsidian. Entra:\n${body}`,
      onMain: true, onMainDirs: deps.docsDirs || [], autoApprove: true, releaseOf: version, source: { kind: 'release-trigger' } });
    const pub = deps.createTask({ title: `Publicar ${version}`, role: relAgent.role, status: 'todo', assignedAgentId: relAgent.id, dependsOn: [doc.id],
      description: `scripts/release/run-all.sh ${version} (lo ejecuta AgentOffice). Entra:\n${body}`, releaseVersion: version, autoApprove: true, source: { kind: 'release-trigger' } });
    const s2 = load(); s2.lock = { id, phase: 'dispatched', at: Date.now(), version, items, docId: doc.id, publishId: pub.id }; save(s2);
    return { action: 'dispatched', version, docId: doc.id, publishId: pub.id };
  } catch (e) { release(id); throw e; }
}

// ── 🚀 Publicación programada (⏰ diaria, p. ej. 18:00): si hay cambios sin publicar, se publica TODO en bloque sin preguntar ──
// flow-test: commits en main desde el último «chore(release): X.Y.Z» → minor si alguno es feat, patch si no → Documentar + Publicar.
// AgentOffice: si su main va por delante de origin, git push (publishSelf). Sin cambios en ninguno → no hace nada.
export async function pendingChanges(dir, gitRun) {
  const last = (await gitRun(dir, 'log', '-1', '--format=%H %s', '--grep=^chore(release): ')).trim();
  const [sha, ...subj] = last.split(' ');
  const range = sha ? `${sha}..HEAD` : 'HEAD';
  const lines = (await gitRun(dir, 'log', '--no-merges', '--format=%h %s', range)).split('\n').filter(Boolean);
  return { since: sha ? subj.join(' ') : null, commits: lines, feat: lines.some((l) => /^\S+ feat(\(|:|!)/.test(l)) };
}
export async function scheduledRelease(deps) {
  const out = { flowTest: null, agentOffice: null };
  if (deps.aoAhead) {
    const ahead = await deps.aoAhead();
    out.agentOffice = ahead > 0 ? { ahead, ...(await deps.aoPublish(`publicación programada: ${ahead} commit(s)`)) } : { ahead: 0 };
  }
  const p = await deps.pending();
  if (!p.commits.length) { out.flowTest = { action: 'none', since: p.since }; return out; }
  const s0 = load();
  if (s0.lock && fresh(s0.lock)) { out.flowTest = { action: 'busy', lock: s0.lock.phase }; return out; }
  const version = bump(deps.version(), [{ kind: p.feat ? 'epic' : 'bug' }]), id = `release-${version}`;
  if (!acquire(id, 'asking')) { out.flowTest = { action: 'busy' }; return out; }
  const items = [{ key: `git:${version}`, kind: p.feat ? 'epic' : 'bug', label: `${p.commits.length} cambio(s) desde ${p.since || 'el inicio'}: ${p.commits.slice(0, 8).join(' · ')}${p.commits.length > 8 ? ' …' : ''}`, taskIds: [] }];
  deps.notify?.(`🚀 Publicación programada: flow-test ${version} (${p.commits.length} cambio(s)). Encargo documentar y publicar.`);
  out.flowTest = dispatch(version, items, deps, id);
  return out;
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

/** FT-175: cómo se lanza run-all. Dry-run salvo `settings.releaseDryRun === false`; el aviso recibe el mensaje en "$1"; stdin cerrado. */
export function runAllSpec(version, settings = {}) {
  const dry = settings.releaseDryRun !== false;
  return {
    dry,
    args: ['scripts/release/run-all.sh', ...(dry ? ['--dry-run'] : []), version],
    env: { ...process.env, RELEASE_NOTIFY_CMD: `node ${path.join(ROOT, 'bin', 'ao-telegram.mjs')} "$1"` },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

export function realDeps(team, store, telegram, questions) {
  const dir = () => flowTestDir(store.get());
  const same = (a, b) => !!a && !!b && path.resolve(a) === path.resolve(b);
  const project = () => store.get().projects.find((p) => (p.repos || []).some((r) => same(r.path, dir())));
  const repoKey = (project()?.repos || []).find((r) => same(r.path, dir()))?.key || 'flow-test';
  const teamOf = () => { const p = project(); return p ? store.get().agents.filter((a) => (p.team || []).includes(a.id)) : []; };
  return {
    repoKey,
    tasks: () => { const p = project(); return store.get().tasks.filter((t) => !p || t.projectId === p.id); },
    version: () => JSON.parse(fs.readFileSync(path.join(dir(), 'package.json'), 'utf8')).version,
    createTask: (o) => {
      const { onMain, onMainDirs, releaseVersion, releaseOf, autoApprove, ...rest } = o;
      // Los campos de release van en `extra`: createTask los pone ANTES de arrancar la tarea (si se añaden después, el agente ya
      // ha empezado sin ellos: «Documentar» acababa en un worktree en vez de sobre main)
      return team.createTask({ projectId: project()?.id, ...rest, extra: { onMain, onMainDirs, releaseVersion, releaseOf, autoApprove } });
    },
    updateTask: (id, patch) => { const t = store.get().tasks.find((x) => x.id === id); if (t) { Object.assign(t, patch); store.changed(); } },
    ask: (text, id) => questions.choose({ question: text, context: `release:${id}`, options: ['✅ Publicar', '❌ Ahora no'], timeoutMs: ASK_STALE_MS - 3600e3 })
      .then((a) => (a === '✅ Publicar' ? 'yes' : a ? 'no' : 'timeout'), () => 'timeout'),
    askPending: (id) => questions.list().some((q) => q.context === `release:${id}`),
    notify: (text) => { try { if (telegram.config().enabled) telegram.send(text).catch(() => {}); } catch { /* sin Telegram */ } },
    // release = un agente de tipo «release» del equipo; docs-release = uno con la skill «prod» (documentalista de releases)
    agentFor: (kind) => teamOf().find((a) => { const r = allRoles()[a.role]; return kind === 'release' ? r?.kind === 'release' : r?.kind === 'docs' && (r.skills || []).includes('prod'); }) || null,
    docsDirs: store.get().settings.releaseDocsDirs || ['~/dev/flow-test-public', '~/JksDocs'],
    // 🚀 publicación programada
    pending: () => pendingChanges(dir(), gitRun),
    aoAhead: async () => { try { await gitRun(ROOT, 'fetch', '--quiet'); } catch { /* sin red: se compara con lo último conocido */ } try { return Number((await gitRun(ROOT, 'rev-list', '--count', '@{u}..HEAD')).trim()) || 0; } catch { return 0; } },
    aoPublish: (reason) => publishSelf(reason),
  };
}
