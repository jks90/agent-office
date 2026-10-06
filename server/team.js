// El equipo: proyectos (con uno o varios repos), agentes (roles de serie o de fichero .md), tareas y el planificador.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { orderTodo, CACHE_WINDOW_MS } from './affinity.js';
import * as codes from './codes.js';
import * as questions from './questions.js';
import * as events from './events.js';
import * as git from './git.js';
import { allRoles, roleOf } from './roles.js';
import { parseTasks } from './engines/describe.js';
import { addUsage, codexCostUsd } from './usage.js';
import { recorder as costRecorder } from './costs.js'; // FT-76
import * as demo from './engines/demo.js';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import * as local from './engines/local.js';
import { suiteOk, mcpUrl, flowTestUrl } from './suite.js';
import { engineEnv, cachedEnginesStatus } from './engines/auth.js';
import * as boards from './boards/index.js';
import { linkSkillsInto } from './skills.js';
import { cleanContext, describeContext } from './task-context.js';
import * as quota from './quota.js';
import { briefingFor } from './briefing.js';
import { detectQuotaHit } from './quota-pause.js';
import * as memory from './memory.js';
import * as codeindex from './codeindex.js';
import * as compact from './compact.js';
import * as stuck from './stuck.js';
import * as review from './review.js'; // FT-56
import * as ladder from './model-ladder.js';

const ENGINES = { demo, claude, codex, local }; // FT-54: local = IA local (LM Studio/Ollama) por el runner de Codex
export const ENGINE_IDS = ['auto', 'claude', 'codex', 'local', 'demo'];

// Motor automático: el que tenga sesión y menos trabajo en curso (empate → Claude). Sin ninguno con sesión → error claro.
const MODEL_OF = ladder.MODEL_OF;
// FT-45: con el guardarraíl de cuota activo, un motor con la sesión agotada no es candidato; entre los que quedan manda el margen.
const guardOn = () => get().settings.quotaGuard !== false;
function pickEngine(agent, exclude = null) {
  if (agent.engine !== 'auto') return agent.engine;
  const st = cachedEnginesStatus();
  const ok = (e) => st ? !!st[e]?.loggedIn : e === 'claude'; // sin estado aún (arranque): solo Claude
  const load = (e) => [...jobs.values()].filter((j) => j.engine === e).length;
  const autoSet = ['claude', 'codex', ...(get().settings.local?.allowAuto ? ['local'] : [])]; // FT-54: la IA local solo si el usuario la permite (más lenta y menos capaz)
  const logged = autoSet.filter(ok).filter((e) => e !== exclude || !autoSet.filter(ok).some((x) => x !== exclude)); // FT-66: el motor sin cuota solo si no hay otro
  if (!logged.length) throw new Error('Motor automático: ni Claude ni Codex tienen sesión (Ajustes ▸ Motores de IA)');
  const free = guardOn() ? logged.filter((e) => !quota.gate(e).block) : logged;
  const m = (e) => quota.margin(e) ?? 50; // sin dato: margen neutro
  return (free.length ? free : logged).sort((a, b) => m(b) - m(a) || load(a) - load(b) || (a === 'claude' ? -1 : b === 'claude' ? 1 : a === 'codex' ? -1 : 1))[0];
}

// FT-45 · ¿Puede este agente arrancar ahora? {ok:true} | {wait:true} (aún sin primera lectura de cuota) | {ok:false, message, engine, percent}
function quotaCheck(agent) {
  if (!guardOn()) return { ok: true };
  const engines = agent.engine === 'auto' ? ['claude', 'codex', ...(get().settings.local?.allowAuto ? ['local'] : [])].filter((e) => { const st = cachedEnginesStatus(); return st ? !!st[e]?.loggedIn : e === 'claude'; }) : [agent.engine];
  const gates = engines.map((e) => quota.gate(e));
  if (!gates.length || gates.some((g) => !g.block && !g.wait)) return { ok: true };
  if (gates.some((g) => g.wait)) return { wait: true };
  return { ok: false, ...gates.sort((a, b) => (a.resetsAt || Infinity) - (b.resetsAt || Infinity))[0] }; // el que antes se reinicia
}
// Deja la tarea en `todo` avisando una sola vez (log + evento) mientras dure el bloqueo; al despejarse, `tick` la retoma.
function quotaHold(p, agent, t, g) {
  if (t.activity === g.message) return;
  const first = !t.quotaBlocked;
  t.activity = g.message; t.quotaBlocked = true;
  if (first) { log(agent.id, `${g.message} (${t.code || '#' + t.id})`); events.emit('AgentBlocked', events.ctxOf(t, agent), { reason: 'quota', engine: g.engine, percent: g.percent, resetsAt: g.resetsAt }); }
  changed();
}
const quotaRelease = (t) => { if (t.quotaBlocked) { delete t.quotaBlocked; t.activity = ''; } };

// FT-66 · ¿Puede seguir ya una tarea pausada por falta de cuota? Pasada la hora de reinicio y con margen según quota.js;
// o antes, si el agente es `auto` (con `quotaFailover`) y el OTRO motor tiene sesión y margen; o si el usuario pulsó «Reanudar ya».
function quotaReady(t, agent) {
  const qp = t.quotaPaused;
  if (qp.force) return true;
  const now = Date.now();
  if (agent.engine === 'auto' && get().settings.quotaFailover !== false) {
    const st = cachedEnginesStatus();
    const other = ['claude', 'codex'].find((e) => e !== qp.engine && (st ? !!st[e]?.loggedIn : false));
    if (other && !quota.gate(other).block) return true;
  }
  if (now < (qp.resetsAt || 0)) return false;
  const g = quota.gate(qp.engine);
  if (g.block) { qp.resetsAt = g.resetsAt || now + 15 * 60_000; t.activity = pausedLabel(t); changed(); return false; }
  return true;
}
const NAME_OF = { claude: 'Claude', codex: 'Codex', local: 'IA local' };
const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const pausedLabel = (t) => `⏸ sin cuota de ${NAME_OF[t.quotaPaused.engine] || t.quotaPaused.engine}: sigue sola a las ${hhmm(t.quotaPaused.resetsAt)}`;
// «Reanudar ya» (botón de la tarjeta): ignora la hora de reinicio y el guardarraíl en el siguiente reparto.
export function resumeNow(id) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (!t.quotaPaused) throw fail(409, 'La tarea no está pausada por cuota');
  t.quotaPaused.force = true;
  changed(); tick();
  return { ok: true };
}

// FT-60 · Modelo del intento. Un modelo fijado a mano (agente o rol) manda y no entra en la cascada; si no, escalera del motor:
// empieza en el peldaño barato y sube con t.escalations (salvo plan / minModel de la tarea o del rol). Devuelve { model, level, why }.
const modelFor = (engineId, agent, role, t = null) => {
  if (engineId === 'local') { const w = agent.engine === 'local' ? agent.model : ''; return { model: w && !MODEL_OF.claude.test(w) ? w : get().settings.local?.model || '', level: null, why: 'local' }; } // FT-54: cualquier nombre que liste el servidor
  const wanted = agent.model || role.model || '';
  if (wanted && MODEL_OF[engineId]?.test(wanted)) return { model: wanted, level: null, why: 'fijado' };
  const st = get().settings;
  const lad = ladder.ladderFor(engineId, st);
  if (!lad.length) return { model: '', level: null, why: '' };
  return ladder.pick(engineId, lad, { floor: t?.minModel || role.minModel || '', plan: t?.kind === 'plan', escalations: t?.escalations || 0, all: ladder.ladders(st) });
};
const cleanMinModel = (v) => { const m = String(v || '').trim(); return m && Object.values(MODEL_OF).some((re) => re.test(m)) ? m.slice(0, 60) : ''; };
// Sube un peldaño la tarea (el próximo intento usa el siguiente modelo). Máximo MAX_ESCALATIONS; false si ya no puede.
export function escalate(t, reason) {
  if ((t.escalations || 0) >= ladder.MAX_ESCALATIONS) return false;
  t.escalations = (t.escalations || 0) + 1;
  log(t.agentId, `⬆ ${t.code || t.id}: el próximo intento sube de modelo (${reason})`);
  return true;
}
export const STATUSES = ['backlog', 'todo', 'doing', 'review', 'done', 'failed', 'discarded'];
// «Descartada»: no se va a hacer (duplicada, absorbida por otra, ya no aplica). Como dependencia cuenta como resuelta.
export const RESOLVED = new Set(['done', 'discarded']);

const { get, changed, newId, log } = store;
const jobs = new Map(); // agentId -> { stop, taskId, engine, pid?, pause?, resume?, message?, requeue? }
// Al apagar el servidor se matan los motores en marcha: van `detached` (grupo propio) y fuera de systemd sobrevivirían.
store.onShutdown(() => { for (const j of jobs.values()) { try { j.stop?.(); } catch { /* ya terminó */ } } });

const DEFAULT_TEAM = [
  { name: 'Olivia', role: 'po' },
  { name: 'Bruno', role: 'back' },
  { name: 'Frida', role: 'front' },
  { name: 'Quique', role: 'qa' },
];
// Plantilla de un proyecto = agentes fichados (project.team). Los demás están en el banquillo, disponibles para cualquier proyecto.
export const teamOf = (p) => { const ids = new Set(p?.team || []); return get().agents.filter((a) => ids.has(a.id)); };

const fail = (status, message) => Object.assign(new Error(message), { status });
const findOr404 = (list, id, what) => list.find((x) => x.id === id || (x.code && x.code === String(id).toUpperCase())) || (() => { throw fail(404, `${what} no encontrado`); })();
const expand = (p) => String(p || '').trim().replace(/^~(?=\/|$)/, process.env.HOME);

// ── Proyectos ──────────────────────────────────────────────────────────────
// repos: [{ key, path, roles? }] o el campo antiguo repoPath (un solo repo, clave «main»).
async function resolveRepos({ repos, repoPath }) {
  const list = Array.isArray(repos) && repos.length ? repos : (repoPath?.trim() ? [{ key: 'main', path: repoPath }] : []);
  const out = [];
  for (const r of list) {
    const dir = expand(r.path);
    if (!dir) continue;
    if (!fs.existsSync(dir)) throw fail(400, `No existe la carpeta ${dir}`);
    let info;
    try { info = await git.repoInfo(dir); } catch { throw fail(400, `${dir} no es un repositorio git`); }
    const key = String(r.key || path.basename(info.path)).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'main';
    if (out.some((x) => x.key === key)) throw fail(400, `Clave de repo repetida: ${key}`);
    out.push({ key, path: info.path, baseBranch: info.baseBranch, roles: Array.isArray(r.roles) ? r.roles : [] });
  }
  return out;
}

// ── Sincronización con el workspace de flow-test: cada carpeta de primer nivel de flows/ es un proyecto;
// los flows de la raíz van al proyecto «default». Los proyectos no se borran solos: si la carpeta desaparece
// quedan marcados (orphan) para que el usuario decida.
export async function syncWorkspace() {
  let files, dir;
  try {
    const r = await fetch(`${flowTestUrl()}/workspace/flows`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    files = j.files || []; dir = j.dir || null;
  } catch (e) { throw fail(502, `No pude leer el workspace de flow-test: ${e.message}`); }
  const counts = new Map([['default', 0]]);
  for (const f of files) {
    if (f.type && f.type !== 'flow') continue;
    const parts = String(f.path).split('/');
    const folder = parts.length > 1 ? parts[0] : 'default';
    if (folder.startsWith('.') || folder.startsWith('_')) continue; // _agentes (catálogo) y similares no son proyectos
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  const s = get();
  let created = 0;
  const hostDir = expand(s.settings.workspaceHostDir);
  for (const [folder, n] of counts) {
    let p = s.projects.find((x) => x.folder === folder);
    if (!p) {
      p = { id: newId(), name: folder === 'default' ? 'default' : folder, folder, repos: [], repoPath: null, baseBranch: null, running: false, team: [], createdAt: Date.now() };
      s.projects.push(p);
      if (!s.agents.length) DEFAULT_TEAM.forEach((m) => { const a = newAgent({ ...m, engine: 'auto' }); s.agents.push(a); p.team.push(a.id); }); // primer arranque: equipo base
      created++;
    }
    p.flows = n;
    p.orphan = false;
    if (folder !== 'default' && hostDir) await autoRepos(p, path.join(hostDir, folder));
  }
  for (const p of s.projects) if (p.folder && !counts.has(p.folder)) p.orphan = true;
  s.workspace = { dir, folders: [...counts.keys()], syncedAt: Date.now() };
  changed();
  return { created, folders: [...counts.keys()], dir };
}

// Repos deducidos de los enlaces simbólicos de la carpeta del proyecto en el hub (p. ej. unityhouse/servidor → …/servidor/flows):
// cada enlace que apunte dentro de un repo git aporta ese repo (clave = nombre del enlace). No pisa lo configurado a mano.
async function autoRepos(p, folderPath) {
  let entries;
  try { entries = fs.readdirSync(folderPath, { withFileTypes: true }); } catch { return; }
  p.repos = p.repos || [];
  for (const e of entries) {
    if (!e.isSymbolicLink() || e.name === 'docs') continue;
    let real;
    try { real = fs.realpathSync(path.join(folderPath, e.name)); } catch { continue; }
    let info;
    try { info = await git.repoInfo(real); } catch { continue; }
    if (p.repos.some((r) => r.path === info.path)) continue;
    const key = e.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (p.repos.some((r) => r.key === key)) continue;
    p.repos.push({ key, path: info.path, baseBranch: info.baseBranch, roles: [], auto: true });
  }
  p.repoPath = p.repos[0]?.path || null; p.baseBranch = p.repos[0]?.baseBranch || null;
}

export async function createProject({ name, repoPath, repos, engine = 'demo', folder = null }) {
  if (!name?.trim()) throw fail(400, 'El proyecto necesita un nombre');
  const list = await resolveRepos({ repos, repoPath });
  if (!ENGINE_IDS.includes(engine)) engine = 'auto';
  const s = get();
  const project = { id: newId(), name: name.trim(), folder: folder || null, repos: list, repoPath: list[0]?.path || null, baseBranch: list[0]?.baseBranch || null, running: false, team: [], createdAt: Date.now() };
  s.projects.push(project);
  if (!s.agents.length) DEFAULT_TEAM.forEach((m) => { const a = newAgent({ ...m, engine }); s.agents.push(a); project.team.push(a.id); });
  changed();
  return project;
}

export async function updateProject(id, patch) {
  const p = findOr404(get().projects, id, 'Proyecto');
  if (patch.name?.trim()) p.name = patch.name.trim();
  if (patch.folder !== undefined) p.folder = patch.folder || null;
  if (patch.prefix !== undefined) p.prefix = codes.normalizePrefix(patch.prefix) || null; // las tareas ya numeradas conservan su código
  if (patch.repos) {
    p.repos = await resolveRepos({ repos: patch.repos });
    p.repoPath = p.repos[0]?.path || null;
    p.baseBranch = p.repos[0]?.baseBranch || null;
  }
  changed();
  return p;
}

export function deleteProject(id) {
  const s = get();
  findOr404(s.projects, id, 'Proyecto');
  const p = s.projects.find((x) => x.id === id);
  for (const a of teamOf(p)) if (jobs.get(a.id)?.taskId && s.tasks.find((t) => t.id === jobs.get(a.id).taskId)?.projectId === id) jobs.get(a.id).stop();
  s.projects = s.projects.filter((x) => x.id !== id); // los agentes se quedan en el banquillo
  s.tasks = s.tasks.filter((t) => t.projectId !== id);
  changed();
}

export function setRunning(id, running) {
  const p = findOr404(get().projects, id, 'Proyecto');
  p.running = !!running;
  changed();
  tick();
}

// El repo de una tarea: el que diga la tarea; si no, el que declare su rol; si no, el primero.
export function repoOfTask(p, t) {
  const repos = p.repos || [];
  return repos.find((r) => r.key === t.repo) || repos.find((r) => (r.roles || []).includes(t.role)) || repos[0] || null;
}

// ── Agentes ────────────────────────────────────────────────────────────────
function newAgent({ name, role, engine = 'auto', model = '' }) {
  return { id: newId(), name, role, engine, model: model || roleOf(role)?.model || '', status: 'idle', activity: '', taskId: null, createdAt: Date.now() };
}

// Contratar = alta en la empresa (y, si se indica proyecto, fichaje directo en su plantilla).
export function hire({ projectId = null, name, role, engine, model }) {
  const s = get();
  const p = projectId ? findOr404(s.projects, projectId, 'Proyecto') : null;
  if (!roleOf(role)) throw fail(400, 'Rol desconocido');
  if (!name?.trim()) throw fail(400, 'El agente necesita un nombre');
  if (p && p.team.length >= 8) throw fail(400, 'La oficina tiene 8 mesas: no caben más agentes en este proyecto');
  const agent = newAgent({ name: name.trim(), role, engine: ENGINE_IDS.includes(engine) ? engine : 'auto', model: model || '' });
  s.agents.push(agent);
  if (p) p.team.push(agent.id);
  changed();
  return agent;
}

// Fichar / mandar al banquillo (no borra al agente).
export function setTeam(projectId, { add = [], remove = [] }) {
  const s = get();
  const p = findOr404(s.projects, projectId, 'Proyecto');
  for (const id of add) { findOr404(s.agents, id, 'Agente'); if (!p.team.includes(id)) { if (p.team.length >= 8) throw fail(400, 'La oficina tiene 8 mesas'); p.team.push(id); } }
  p.team = p.team.filter((id) => !remove.includes(id));
  changed();
  tick();
  return p.team;
}

export function updateAgent(id, patch) {
  const a = findOr404(get().agents, id, 'Agente');
  if (patch.name?.trim()) a.name = patch.name.trim();
  if (ENGINE_IDS.includes(patch.engine)) a.engine = patch.engine;
  if (typeof patch.model === 'string') a.model = patch.model.trim();
  if (patch.role && roleOf(patch.role)) a.role = patch.role;
  changed();
  return a;
}

export function fire(id) {
  const s = get();
  findOr404(s.agents, id, 'Agente');
  jobs.get(id)?.stop();
  s.agents = s.agents.filter((a) => a.id !== id);
  changed();
}

export function stopAgent(id) {
  const job = jobs.get(id);
  if (!job) throw fail(409, 'Ese agente no está trabajando');
  const t = get().tasks.find((x) => x.id === job.taskId);
  events.emit('AgentPaused', events.ctxOf(t, { id }), { reason: 'stopped-by-user' });
  job.stop();
}

// ── Control de workers (FT-5): pausar, reanudar y mensaje en caliente ──────
const jobOf = (id) => {
  const a = findOr404(get().agents, id, 'Agente');
  const job = jobs.get(a.id);
  if (!job) throw fail(409, 'Ese agente no está trabajando');
  return { a, job, t: get().tasks.find((x) => x.id === job.taskId) };
};

// SIGSTOP al grupo de procesos del motor (el agente queda congelado: ps STAT T); la tarea sigue `doing`.
export function pauseAgent(id) {
  const { a, job, t } = jobOf(id);
  if (a.status === 'paused') throw fail(409, 'El agente ya está en pausa');
  if (!job.pause) throw fail(409, 'El agente aún se está preparando; inténtalo en un momento');
  job.pause();
  Object.assign(a, { status: 'paused', pausedActivity: a.activity, activity: 'En pausa' });
  events.emit('AgentPaused', events.ctxOf(t, a), { reason: 'paused-by-user', pid: job.pid || null });
  log(a.id, '⏸ En pausa');
  changed();
  return a;
}

export function resumeAgent(id) {
  const { a, job, t } = jobOf(id);
  if (a.status !== 'paused') throw fail(409, 'El agente no está en pausa');
  job.resume();
  Object.assign(a, { status: 'working', activity: a.pausedActivity || 'Retomando el trabajo', pausedActivity: undefined });
  events.emit('AgentResumed', events.ctxOf(t, a), { reason: 'resumed-by-user' });
  log(a.id, '▶ Reanudado');
  changed();
  return a;
}

// Restricción persistente de la tarea: va SIEMPRE en el prompt (también tras Devolver o reintentar).
export function addConstraint(taskId, text, origin = 'user') {
  const t = findOr404(get().tasks, taskId, 'Tarea');
  text = String(text || '').trim();
  if (!text) throw fail(400, 'La restricción necesita texto');
  (t.constraints ||= []).push({ text: text.slice(0, 2000), at: Date.now(), origin });
  events.emit('UserInstructionAdded', events.ctxOf(t), { kind: 'constraint', text: text.slice(0, 500), origin });
  changed();
  return t;
}

// Mensaje del cliente a un agente en marcha. Claude: se inyecta en su turno por stdin (stream-json).
// Codex/demo: no admiten entrada en caliente → se para al agente y se reencola LA MISMA tarea (misma rama) con el mensaje en el prompt.
export function messageAgent(id, { text, constraint = false, origin = 'user' } = {}) {
  text = String(text || '').trim();
  if (!text) throw fail(400, 'Falta el texto del mensaje');
  const { a, job, t } = jobOf(id);
  if (constraint) addConstraint(t.id, text, origin);
  else events.emit('UserInstructionAdded', events.ctxOf(t, a), { kind: 'message', text: text.slice(0, 500), origin });
  if (job.message?.(text)) {
    log(a.id, `✉ Mensaje del cliente: ${text}`);
    changed();
    return { delivered: 'live', agent: a.id, task: t.id };
  }
  (t.pendingMessages ||= []).push({ text: text.slice(0, 2000), at: Date.now(), origin });
  if (!job.stop || !job.pause) { changed(); return { delivered: 'queued', agent: a.id, task: t.id }; } // aún preparando: el mensaje entra en el prompt
  job.requeue = true;
  log(a.id, `✉ Mensaje del cliente (el motor no admite mensajes en caliente: se reencola la tarea): ${text}`);
  job.stop();
  changed();
  return { delivered: 'requeued', agent: a.id, task: t.id };
}

// ── Tareas ─────────────────────────────────────────────────────────────────
export function createTask({ projectId, title, description = '', role, repo = null, dependsOn = [], kind = 'work', goal = null, images = [], files = [], attachments = [], status = 'todo', source = null, context = null, skills = [], priority = 0, sizeChecked = false, minModel = '', checks = [], reviewRequired = false }) {
  // attachments (subidos): imágenes → images (las ve el agente), el resto → files (se citan en el prompt)
  for (const a of attachments) { if (/\.(png|jpe?g|webp)$/i.test(a.path)) images = [...images, a.path]; else files = [...files, a.path]; }
  const s = get();
  const p = findOr404(s.projects, projectId, 'Proyecto');
  if (!title?.trim()) throw fail(400, 'La tarea necesita un título');
  if (!roleOf(role)) throw fail(400, 'Rol desconocido');
  if (repo && !(p.repos || []).some((r) => r.key === repo)) throw fail(400, `El proyecto no tiene el repo «${repo}»`);
  const task = {
    id: newId(), projectId, kind, goal, title: title.trim(), description: String(description || '').trim(), role, repo: repo || null,
    dependsOn: (Array.isArray(dependsOn) ? dependsOn : []).filter((d) => s.tasks.some((t) => t.id === d)),
    status: ['backlog', 'todo', 'review', 'done'].includes(status) ? status : 'todo',
    agentId: null, branch: null, summary: '', diffStat: '', error: null, feedback: '', source, files: files.filter((f) => fs.existsSync(f)),
    constraints: [], priority: Math.max(0, Math.min(100, Number(priority) || 0)), context: cleanContext(context), skills: (Array.isArray(skills) ? skills : []).map(String).slice(0, 10), costUsd: null, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  if (Array.isArray(checks) && checks.length) task.checks = checks.map((c) => String(c).trim()).filter(Boolean).slice(0, 6); // FT-56: verificaciones que declara la tarea
  if (reviewRequired) task.reviewRequired = true; // FT-56: nunca se aprueba sola
  if (cleanMinModel(minModel)) task.minModel = cleanMinModel(minModel); // FT-60: esta tarea no empieza por el peldaño barato
  if (sizeChecked) task.sizeChecked = true; // FT-63: ya troceada por el PO, no se vuelve a evaluar
  codes.assignCode(s.tasks, p, task);
  task.feedbackImages = copyImages(task, images);
  s.tasks.push(task);
  events.emit('TaskCreated', events.ctxOf(task), { title: task.title, role: task.role, kind: task.kind, status: task.status, dependsOn: task.dependsOn, source: task.source?.kind || null });
  changed();
  if (task.status === 'review') { task.reviewAt = Date.now(); if (!source) setImmediate(() => autoReview(p, task).catch(() => {})); } // FT-56: creada ya en revisión (API/Guía)
  if (!source) boards.createRemote(p, task).catch(() => {});
  tick();
  return task;
}

// Tableros online: sincronizar (pull + push de lo cambiado aquí) y reflejar cambios de estado.
export const syncBoard = (projectId) => boards.syncBoard(findOr404(get().projects, projectId, 'Proyecto'), { createTask, roles: allRoles() });
// Igualar los dos lados: pull/push de lo que ya está enlazado y, si faltan tarjetas fuera, exportarlas en segundo plano.
export async function syncAll(projectId) {
  const p = findOr404(get().projects, projectId, 'Proyecto');
  const r = await syncBoard(projectId);
  const pending = get().tasks.filter((t) => t.projectId === p.id && t.source?.kind !== p.board.kind && t.kind !== 'plan').length;
  if (pending && !p.board.job?.running) boards.exportAll(p);
  return { ...r, exporting: pending };
}
const reflect = (t, comment) => { const p = projectOf(t); if (p?.board && t.source?.kind === p.board.kind) boards.pushStatusSoon(p, t, comment); };

export function updateTask(id, patch) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  const p = projectOf(t);
  if (t.status === 'doing') throw fail(409, 'Para al agente antes de editar la tarea');
  const before = `${t.title}\n${t.description}`;
  if (patch.title?.trim()) t.title = patch.title.trim();
  if (typeof patch.description === 'string') t.description = patch.description.trim();
  if (`${t.title}\n${t.description}` !== before && p?.board && t.source?.kind === p.board.kind) boards.pushContentSoon(p, t);
  if (patch.role && roleOf(patch.role)) t.role = patch.role;
  if (patch.repo !== undefined) {
    if (patch.repo && !(p.repos || []).some((r) => r.key === patch.repo)) throw fail(400, `El proyecto no tiene el repo «${patch.repo}»`);
    t.repo = patch.repo || null;
  }
  if (patch.status && patch.status !== t.status) {
    // FT-27: antes un cambio no permitido se ignoraba en silencio; ahora avisa con el motivo.
    if (!['backlog', 'todo', 'discarded'].includes(patch.status)) throw fail(409, 'A esa columna no se mueve a mano: «En curso» la ocupa el agente, y «Revisión»/«Hecho» se alcanzan al terminar (Aprobar / Devolver en la tarjeta)');
    if (!['backlog', 'todo', 'failed', 'discarded'].includes(t.status)) throw fail(409, 'Solo se mueven entre Backlog, Por hacer y Descartada las tareas que no han empezado; esta ya está en curso, en revisión o hecha');
    t.status = patch.status;
    t.error = null;
    reflect(t);
  }
  if (Array.isArray(patch.dependsOn)) t.dependsOn = patch.dependsOn.filter((d) => d !== id && s.tasks.some((x) => x.id === d));
  if (typeof patch.minModel === 'string') t.minModel = cleanMinModel(patch.minModel) || undefined; // FT-60
  t.updatedAt = Date.now();
  changed();
  tick();
  return t;
}

// Fija qué agente hará la tarea (FT-4); null = vuelve a elegirse por rol. Solo antes de empezar.
export function assignTask(id, agentId) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (!['backlog', 'todo', 'failed'].includes(t.status)) throw fail(409, 'Solo se puede asignar una tarea que no ha empezado');
  if (agentId) {
    const a = findOr404(s.agents, agentId, 'Agente');
    if (!(projectOf(t)?.team || []).includes(a.id)) throw fail(400, `${a.name} no está fichado en el proyecto de la tarea`);
    t.assignedAgentId = a.id;
  } else delete t.assignedAgentId;
  t.updatedAt = Date.now();
  changed();
  tick();
  return t;
}

export function planGoal(projectId, goal, { attachments = [], title = '' } = {}) {
  if (!goal?.trim()) throw fail(400, 'Escribe un objetivo');
  const s = get();
  const planner = teamOf(s.projects.find((p) => p.id === projectId)).find((a) => roleOf(a.role)?.kind === 'planner');
  if (!planner) throw fail(400, 'El equipo no tiene PO/orquestador: contrata uno para planificar');
  return createTask({ projectId, kind: 'plan', goal: goal.trim(), role: planner.role, title: `Planificar: ${(title || goal).trim().slice(0, 80)}`, description: goal.trim(), attachments });
}

export async function deleteTask(id) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (t.status === 'doing') throw fail(409, 'Para al agente antes de borrar la tarea');
  const p = projectOf(t);
  for (const x of taskRepos(p, t)) await git.cleanup(p, x.repo, t, x.dir); // FT-44: todos los worktrees/ramas de la tarea
  s.tasks = s.tasks.filter((x) => x.id !== id);
  for (const o of s.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== id);
  changed();
}

export async function approve(id, { by = null, verdict = null } = {}) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  const p = projectOf(t);
  if (t.branch) {
    // FT-44: una rama por repo. Primero se pone al día cada una (si alguna choca vuelve al agente con el detalle de ESE repo)
    // y solo entonces se fusionan todas, para no dejar a medias una tarea que choca en el segundo repo.
    // Si la rama ya no existe es que se fusionó y limpió en un intento anterior (p. ej. un reinicio perdió el estado): solo falta marcarla.
    const live = [];
    for (const x of taskRepos(p, t)) {
      if (await git.branchExists(x.repo, x.branch)) live.push(x);
      else log(t.agentId, `ℹ ${t.code || t.id}: la rama ${x.branch} ya estaba fusionada en ${x.key}`);
    }
    for (const x of live) await syncWithBase(p, x, t, { onConflict: 'reject' }); // FT-19: desfasada → se actualiza con la base; si choca, vuelve al agente
    for (const x of live) {
      try { await git.merge(x.repo, { branch: x.branch }); } catch (e) { throw fail(409, e.message); }
      await git.cleanup(p, x.repo, t, x.dir);
    }
  }
  t.status = 'done';
  t.updatedAt = Date.now();
  events.emit('TaskReviewed', events.ctxOf(t), { decision: 'approved', merged: !!t.branch, ...(by ? { by, verdict } : {}) });
  if (by) { t.autoApproved = { by, text: verdict?.text || '', at: Date.now() }; reviewNote(t, by, 'approved', verdict?.text); } else reviewNote(t, 'human', 'approved');
  delete t.reviewNote; delete t.reviewing;
  changed();
  refreshReviews().catch(() => {}); // FT-19: la base avanzó: las demás ramas en revisión pueden haberse desfasado
  reflect(t, `✅ Aprobada en AgentOffice${t.summary ? `\n\n${t.summary.slice(0, 1500)}` : ''}`);
  tick();
}

export async function reject(id, feedback = '', images = [], attachments = [], by = null) {
  const t = findOr404(get().tasks, id, 'Tarea');
  for (const a of attachments) { if (/\.(png|jpe?g|webp)$/i.test(a.path)) images = [...images, a.path]; else t.files = [...(t.files || []), a.path]; }
  if (!['review', 'failed'].includes(t.status)) throw fail(409, 'Solo se devuelven tareas en revisión o fallidas');
  // La rama y el worktree se conservan: el agente corrige sobre su intento anterior.
  t.returns = (t.returns || 0) + 1; // FT-76: devoluciones (KPI «aprobadas a la primera»)
  if (feedback.trim()) t.feedback = [t.feedback, feedback.trim()].filter(Boolean).join('\n');
  // FT-60: devolver desde revisión = el modelo barato no bastó → el reintento sube de peldaño (desde «fallida» ya subió al fallar;
  // y si se cortó por el tope de gasto, un modelo más caro no arregla nada: sigue con el mismo).
  if (t.status === 'review' && !t.budgetHit) escalate(t, 'devuelta desde revisión');
  delete t.budgetHit;
  // FT-75: cada corrección de una revisión se recuerda (la primera frase) para no repetir el error en otras tareas
  if (feedback.trim() && t.agentId && get().settings.agentMemory !== false) memory.addLesson(t.projectId, t.agentId, `Corrección de revisión: ${feedback.trim().split(/(?<=[.!?])\s|\n/)[0]}`, t.code || t.id);
  t.feedbackImages = copyImages(t, images);
  events.emit('TaskReviewed', events.ctxOf(t), { decision: 'rejected', feedback: feedback.trim().slice(0, 500), ...(by ? { by, verdict: { approve: false } } : {}) });
  if (by) { t.autoReviews = (t.autoReviews || 0) + 1; reviewNote(t, by, 'rejected', feedback); } else { delete t.autoReviews; reviewNote(t, 'human', 'rejected', feedback); } // FT-56: una devolución humana reinicia el tope de ciclos automáticos
  delete t.reviewNote; delete t.reviewing; delete t.autoApproved; delete t.reviewAt; delete t.nudged;
  if (feedback.trim()) events.emit('UserInstructionAdded', events.ctxOf(t), { kind: 'feedback', text: feedback.trim().slice(0, 500) });
  for (const e of Object.values(t.repos || {})) e.diffStat = '';
  Object.assign(t, { status: 'todo', agentId: null, diffStat: '', error: null, behind: 0, conflicts: [], mergeKey: null, updatedAt: Date.now() });
  changed();
  reflect(t, feedback.trim() ? `↩ Devuelta en AgentOffice: ${feedback.trim().slice(0, 1000)}` : undefined);
  tick();
}

// ── Revisión visible y automática (FT-56) ──────────────────────────────────
// Historial de la tarea: qué se decidió, quién y por qué (las 20 últimas entradas).
function reviewNote(t, by, verdict, text) {
  (t.reviewLog ||= []).push({ at: Date.now(), by, verdict, text: String(text || '').slice(0, 600) });
  t.reviewLog = t.reviewLog.slice(-20);
}
const reviewing = new Set();
const BASE_FILES = /^diff --git a\/(.+?) b\//gm;
// Verificaciones declaradas, ejecutadas en el worktree (o en el repo si la tarea no tiene rama, p. ej. motor demo). → { ok, failed? }
async function runChecks(cwd, checks) {
  for (const c of checks) {
    const ok = await new Promise((r) => { const ch = spawn('sh', ['-c', c], { cwd, stdio: 'ignore', timeout: 300_000 }); ch.on('error', () => r(false)); ch.on('close', (code) => r(code === 0)); });
    if (!ok) return { ok: false, failed: c };
  }
  return { ok: true };
}
async function runReviewer(p, t, repo, cwd, checks) {
  const s = get();
  const agent = s.agents.find((a) => a.id === t.agentId) || teamOf(p)[0];
  const engineId = ENGINES[s.settings.reviewEngine] && s.settings.reviewEngine !== 'auto' ? s.settings.reviewEngine : (ENGINES[t.lastEngine] ? t.lastEngine : 'demo');
  const role = Object.values(allRoles()).find((r) => r.kind === 'qa') || roleOf(agent.role) || roleOf('back');
  const job = await ENGINES[engineId].start({
    agent, task: t, project: p, cwd, mode: engineId === 'demo' ? 'review' : 'work', goal: null, roles: teamRoles(p),
    prompt: review.reviewPrompt(t, repo?.baseBranch || 'main', checks), system: role.system, model: modelFor(engineId, agent, role),
    kind: 'dev', roleTools: null, hasSkills: false, images: [], budgetUsd: Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3,
    effort: ['low', 'medium', 'high'].includes(s.settings.agentEffort) ? s.settings.agentEffort : 'medium',
    env: { ...engineEnv(engineId), AO_URL: `http://127.0.0.1:${process.env.AO_PORT || 7420}`, AO_TASK: t.id, AO_AGENT: 'revisor' },
    onActivity: () => {}, onLog: (line) => log(agent.id, `🔎 ${line}`), onTool: () => {}, onUsage: () => {},
  });
  const timer = setTimeout(() => job.stop?.(), 15 * 60_000);
  try { const res = await job.done; if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd; return review.parseVerdict(res.summary); } finally { clearTimeout(timer); }
}
// Al llegar a «Revisión» (reviewPolicy auto-qa | auto). Nunca toca tareas reviewRequired, con tope/atasco, ni con ficheros sensibles.
export async function autoReview(p, t) {
  const s = get(), policy = review.policyOf(s.settings);
  if (policy === 'manual' || t.status !== 'review' || t.kind === 'plan' || reviewing.has(t.id)) return;
  const hold = (why) => { t.reviewNote = why; reviewNote(t, 'auto', 'skipped', why); changed(); };
  reviewing.add(t.id);
  try {
    if (t.reviewRequired) return hold('✋ marcada «revisión obligatoria»: la revisa una persona');
    if (t.budgetHit || t.stuck) return hold('✋ terminó cortada (tope de gasto o atasco): la revisa una persona');
    if ((t.autoReviews || 0) >= review.MAX_AUTO_CYCLES) return hold('⚠️ dos revisiones automáticas fallidas: la revisa una persona');
    const repo = repoOfTask(p, t);
    const checks = review.declaredChecks(t);
    const dirOk = t.branch && fs.existsSync(git.worktreeDir(p, t));
    const cwd = dirOk ? git.worktreeDir(p, t) : (repo?.path || store.DATA_DIR);
    let patch = '';
    if (t.branch && repo) { try { patch = await git.diff(repo, t); } catch { /* sin diff */ } }
    const files = patch ? [...patch.matchAll(BASE_FILES)].map((m) => m[1]) : [...String(t.diffStat || '').matchAll(/^\s*(\S+)\s+\|/gm)].map((m) => m[1]);
    const hits = review.sensitiveHits(files, patch, review.sensitiveList(s.settings));
    if (hits.length) return hold(`✋ toca ficheros sensibles (${hits.slice(0, 3).join(', ')}): la revisa una persona`);
    if (policy === 'auto' && !checks.length) return; // sin verificaciones declaradas se comporta como manual
    t.reviewing = policy; changed();
    if (policy === 'auto') {
      const r = await runChecks(cwd, checks);
      if (t.status !== 'review') return;
      if (!r.ok) return hold(`✋ la verificación «${r.failed}» falló: no se aprueba sola`);
      await approve(t.id, { by: 'auto', verdict: { approve: true, text: `pasan las verificaciones declaradas (${checks.join('; ')})` } });
      return;
    }
    const v = await runReviewer(p, t, repo, cwd, checks); // auto-qa
    if (t.status !== 'review') return; // un humano decidió mientras tanto
    if (!v) return hold('✋ el revisor no devolvió un veredicto válido: la revisa una persona');
    if (v.approve) await approve(t.id, { by: 'auto-qa', verdict: { approve: true, text: v.reasons.join('; ') || 'sin objeciones' } });
    else await reject(t.id, v.feedback || v.reasons.join('\n') || 'El revisor automático pide cambios.', [], [], 'auto-qa');
  } catch (e) { hold(`✋ la revisión automática falló (${e.message}): la revisa una persona`); }
  finally { reviewing.delete(t.id); delete t.reviewing; changed(); }
}

// Aviso proactivo: pasados reviewNudgeMin minutos en revisión, evento ReviewPending (una vez por entrada en revisión).
export function reviewNudge(now = Date.now()) {
  const s = get(), min = review.nudgeMin(s.settings);
  let any = false;
  for (const t of s.tasks.filter((x) => x.status === 'review' && !x.nudged && !x.reviewing)) {
    const minutes = Math.floor((now - review.waitingSince(t)) / 60000);
    if (minutes < min) continue;
    t.nudged = true; any = true;
    events.emit('ReviewPending', events.ctxOf(t), { taskCode: t.code || t.id, minutes, blocks: review.blocksOf(s.tasks, t).map((b) => b.code) });
  }
  if (any) changed();
  return any;
}
setInterval(reviewNudge, 5000).unref();

// ── Fusión sin conflictos a mano (FT-19) ───────────────────────────────────
// Comprobación previa: cuántos commits de la base le faltan a la rama en revisión y si la fusión chocaría (solo rutas).
// Se recalcula en segundo plano (no en cada snapshot) y solo cuando cambia la base o la rama; el resultado viaja en la tarea por SSE.
export async function refreshMergeState(t) {
  const p = projectOf(t);
  const xs = p && t.branch && t.status === 'review' ? taskRepos(p, t) : [];
  if (!xs.length) return false;
  const sts = [];
  for (const x of xs) { // FT-44: por repo; la tarea agrega (behind = suma, conflicts = rutas, con «repo:» delante fuera del principal)
    let st;
    try { st = await git.mergeState(x.repo, { branch: x.branch }); } catch { st = null; } // rama ya fusionada/borrada o repo ilocalizable: sin datos
    sts.push({ x, st });
  }
  const key = sts.map(({ st }) => st?.key || '').join('|');
  if (t.mergeKey === key) return false;
  const was = JSON.stringify([t.behind, t.conflicts]);
  const ok = sts.filter(({ st }) => st);
  for (const { x, st } of ok) if (t.repos?.[x.key]) Object.assign(t.repos[x.key], { behind: st.behind, conflicts: st.conflicts });
  Object.assign(t, ok.length ? { mergeKey: key, behind: ok.reduce((n, { st }) => n + st.behind, 0), conflicts: ok.flatMap(({ x, st }) => st.conflicts.map((f) => x.main ? f : `${x.key}:${f}`)) } : { mergeKey: null, behind: 0, conflicts: [] });
  return JSON.stringify([t.behind, t.conflicts]) !== was || !!ok.length;
}
let refreshing = false;
async function refreshReviews() {
  if (refreshing) return;
  refreshing = true;
  try {
    let any = false;
    for (const t of get().tasks.filter((x) => x.status === 'review' && x.branch)) any = (await refreshMergeState(t)) || any;
    if (any) changed();
  } finally { refreshing = false; }
}
setInterval(refreshReviews, 10_000).unref();

const CONFLICT_MARK = 'Tu rama choca con';
const conflictText = (base, files, x) => `${CONFLICT_MARK} ${base}${x && !x.main ? ` (repo ${x.key}, tu worktree ${x.dir})` : ''} en: ${files.join(', ')}; haz \`git merge ${base}\` en tu worktree, resuelve los conflictos conservando lo de ambos lados, verifica y vuelve a confirmar.`;

// Mete la base en la rama de la tarea (merge dentro de su worktree). x = { repo, key, dir, branch }.
// → { updated, behind } o, con conflicto, { conflicts } sin tocar el worktree.
async function mergeBaseInto(p, x, t) {
  const { repo, dir, branch } = x;
  if (!fs.existsSync(dir)) throw fail(409, `La tarea ${t.code || t.id} no tiene su worktree (${dir}): no se puede actualizar la rama`);
  const behind = Number(await git.git(repo.path, 'rev-list', '--count', `${branch}..${repo.baseBranch}`));
  if (!behind) return { updated: false, behind: 0, conflicts: [] };
  const r = await git.updateFromBase(dir, repo.baseBranch);
  if (r.conflicts.length) {
    events.emit('TaskConflict', events.ctxOf(t), { base: repo.baseBranch, repo: x.key, files: r.conflicts.slice(0, 50), behind });
    return { updated: false, behind, conflicts: r.conflicts };
  }
  events.emit('TaskUpdatedFromBase', events.ctxOf(t), { base: repo.baseBranch, repo: x.key, behind });
  return { updated: true, behind, conflicts: [] };
}

// Antes de fusionar o desde «Actualizar con main»: rama al día → no hace nada; desfasada → merge de la base; choca → (onConflict 'reject') vuelve al agente.
async function syncWithBase(p, x, t, { onConflict = 'reject' } = {}) {
  const r = await mergeBaseInto(p, x, t);
  const where = x.main ? '' : ` (repo ${x.key})`;
  if (r.conflicts.length && onConflict === 'reject') {
    const msg = conflictText(x.repo.baseBranch, r.conflicts, x);
    await reject(t.id, msg);
    throw Object.assign(fail(409, `${t.code || t.id} choca con ${x.repo.baseBranch}${where} en ${r.conflicts.join(', ')}: devuelta al agente para que lo resuelva`), { conflicts: r.conflicts });
  }
  if (r.updated) {
    const stat = await git.diffStat(x.repo, { branch: x.branch });
    if (x.main) t.diffStat = stat;
    if (t.repos?.[x.key]) t.repos[x.key].diffStat = stat;
    t.mergeKey = null; // se recalcula
    await refreshMergeState(t);
    t.updatedAt = Date.now();
    changed();
  }
  return r;
}

// «Actualizar con main» (tarjeta y tool del Guide task.updateFromBase): entra limpio → lista para aprobar; choca → vuelve al agente con el feedback automático.
export async function updateFromBase(id) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  if (!t.branch) throw fail(409, 'La tarea no tiene rama propia (motor demo): no hay nada que actualizar');
  const p = projectOf(t);
  let updated = false, behind = 0;
  const bases = new Set();
  for (const x of taskRepos(p, t)) { // FT-44: cada repo con rama
    if (!(await git.branchExists(x.repo, x.branch))) throw fail(409, `La rama ${x.branch} ya no existe en ${x.key}`);
    bases.add(x.repo.baseBranch);
    let r;
    try { r = await syncWithBase(p, x, t, { onConflict: 'reject' }); } catch (e) {
      if (e.conflicts) return { task: t.id, code: t.code, updated: false, returned: true, conflicts: e.conflicts || [], message: e.message };
      throw e;
    }
    updated ||= r.updated; behind += r.behind;
  }
  const base = [...bases].join('/');
  return { task: t.id, code: t.code, updated, returned: false, behind, conflicts: [], message: updated ? `Rama actualizada con ${base} (${behind} commits): lista para aprobar` : `La rama ya estaba al día con ${base}` };
}

// Imágenes adjuntas (capturas, referencias): se copian a data/ para que el agente las vea (codex --image, claude con Read).
function copyImages(t, images) {
  const out = [];
  const dir = path.join(store.DATA_DIR, 'feedback', t.id);
  for (const [i, src] of (Array.isArray(images) ? images : []).slice(0, 8).entries()) {
    if (!/\.(png|jpe?g|webp)$/i.test(src) || !fs.existsSync(src)) throw fail(400, `No encuentro la imagen ${src}`);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${t.attempts}-${i + 1}${path.extname(src).toLowerCase()}`);
    fs.copyFileSync(src, dest);
    out.push(dest);
  }
  return out;
}

export async function taskDiff(id) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (!t.branch) return t.diffStat ? `(motor demo: no hay cambios reales)\n\n${t.diffStat}` : '(sin cambios)';
  const p = projectOf(t);
  const xs = taskRepos(p, t);
  const parts = [];
  for (const x of xs) { // FT-44: un bloque por repo con cambios (con cabecera si hay varios)
    const d = await git.diff(x.repo, { branch: x.branch });
    if (d) parts.push(xs.length > 1 ? `══ repo ${x.key} · rama ${x.branch} ══\n${d}` : d);
  }
  const d = parts.join('\n\n');
  return d.length > 300_000 ? d.slice(0, 300_000) + '\n… (recortado)' : d || '(sin cambios)';
}

// FT-44: repos de la tarea con rama y worktree → [{ repo, key, dir, branch, main }]. El principal (repoOfTask) usa t.branch y el
// worktree de siempre; el resto vienen de t.repos (`{ key: { branch, diffStat, sha } }`).
export function taskRepos(p, t) {
  const main = p && repoOfTask(p, t);
  if (!main || !t.branch) return [];
  const out = [{ repo: main, key: main.key, branch: t.branch, dir: git.worktreeDir(p, t), main: true }];
  for (const [key, e] of Object.entries(t.repos || {})) {
    const repo = key !== main.key && (p.repos || []).find((r) => r.key === key);
    if (repo) out.push({ repo, key, branch: e.branch || t.branch, dir: git.extraWorktreeDir(p, t, repo), main: false });
  }
  return out;
}
const projectOf = (t) => get().projects.find((p) => p.id === t.projectId);
const depsDone = (t) => t.dependsOn.every((d) => RESOLVED.has(get().tasks.find((x) => x.id === d)?.status));

// ── Importar un tablero de flow-test (notas = tarjetas, textos de pizarra = listas) ──────────────
const COLUMN_STATUS = [[/revisi/i, 'review'], [/hecho|done/i, 'done'], [/en curso|progreso|doing/i, 'todo']];
const ROLE_RULES = [
  [/\b(qa|prueba|probar|test|verific)/i, 'qa'],
  [/\b(api|servidor|server|backend|portal|admin|postgres|sqlite|ledger|blockchain|red\b|netcode|sala|lobby|paquetes|persist|endpoint|contrato|seguridad|cuenta)/i, 'back'],
  [/\b(unity|juego|apk|webgl|m[oó]vil|blender|escena|parkour|coche|moto|mando|fps|zona|tesela|terreno|osm|mapa|textura|edificio|carretera|men[uú]|tutorial|dispar|vehículo|vehiculo|minimapa|animaci)/i, 'front'],
  [/\b(concepto|ficha|dise[ñn]o|core loop|roadmap|decisi|documentar|credencial)/i, 'po'],
];
const stripMarks = (s) => String(s || '').replace(/^[\s⚪🟢🟡🔴✅▶👤🤖🧠⛓🔍📋📜🔐⏸🧹🧪🌐🏪🧊🔫☁️🟠🟣⚫]+/u, '').trim();

export async function importFlow(projectId, flowPath) {
  const s = get();
  const p = findOr404(s.projects, projectId, 'Proyecto');
  if (!flowPath?.trim()) throw fail(400, 'Indica la ruta del flow (p. ej. entorno/tablero.flow.json)');
  let flow;
  try {
    const r = await fetch(`${flowTestUrl()}/workspace/flow?path=${encodeURIComponent(flowPath.trim())}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    flow = (await r.json()).flow;
  } catch (e) { throw fail(502, `No pude leer el flow en flow-test: ${e.message}`); }
  const notes = flow?.infoNodes || [];
  // Listas: textos de la pizarra en la franja de cabeceras (la fila más alta con varios textos), ordenados por x.
  const texts = (flow?.drawings || []).filter((d) => d.type === 'text' && d.text?.trim());
  const rows = new Map();
  for (const t of texts) { const k = Math.round(t.y / 30); rows.set(k, [...(rows.get(k) || []), t]); }
  const header = [...rows.values()].filter((r) => r.length >= 3).sort((a, b) => b.length - a.length)[0] || [];
  const columns = header.map((t) => ({ x: t.x, name: t.text.trim() })).sort((a, b) => a.x - b.x);
  const columnFor = (x) => [...columns].reverse().find((c) => c.x <= x + 8) || columns[0] || { name: '' };
  const skipColumn = (name) => /equipo|reglas|formulario/i.test(name);
  const existing = new Map(s.tasks.filter((t) => t.projectId === p.id && t.source?.flow === flowPath).map((t) => [t.source.nodeId, t]));
  const roles = allRoles();
  let created = 0, updated = 0, skipped = 0;
  for (const n of notes) {
    const col = columnFor(n.position?.x ?? 0);
    const title = stripMarks(n.name);
    if (!title || skipColumn(col.name) || /cómo se usa|revisar las \d+ tarjetas|formulario/i.test(title)) { skipped++; continue; }
    const status = (COLUMN_STATUS.find(([re]) => re.test(col.name)) || [null, 'backlog'])[1];
    // El rol lo decide el título; el contenido solo desempata (y nunca a QA: casi toda tarjeta dice «probar»).
    const byTitle = ROLE_RULES.find(([re]) => re.test(title));
    const byBody = ROLE_RULES.filter(([, r]) => r !== 'qa').find(([re]) => re.test(n.content || ''));
    const role = (byTitle || byBody || [null, 'back'])[1];
    const source = { flow: flowPath, nodeId: n.id, column: col.name, name: n.name };
    const prev = existing.get(n.id);
    if (prev) {
      prev.title = title; prev.description = String(n.content || '').trim(); prev.source = source;
      if (!prev.branch && roles[role]) prev.role = role;
      if (['backlog', 'todo', 'review', 'done'].includes(prev.status) && prev.status !== 'todo' && !prev.branch) prev.status = status;
      prev.updatedAt = Date.now();
      updated++;
    } else {
      createTask({ projectId: p.id, title, description: n.content || '', role: roles[role] ? role : 'back', status, source });
      created++;
    }
  }
  changed();
  return { created, updated, skipped, columns: columns.map((c) => c.name), flowName: flow?.name || flowPath };
}

export async function listFlows() {
  try {
    const r = await fetch(`${flowTestUrl()}/workspace/flows`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.files || []).filter((f) => f.type === 'flow').map((f) => ({ path: f.path, name: f.name || f.path }));
  } catch (e) { throw fail(502, `No pude listar los flows de flow-test: ${e.message}`); }
}

// ── Planificador ───────────────────────────────────────────────────────────
// FT-50 · Quién hará una tarea (regla única del planificador y de la tarjeta): el agente fijado con «Asignar a…»
// (`assignedAgentId`), o los del equipo del proyecto cuyo rol es el de la tarea o lo atiende (`handles`); libre antes que
// ocupado. Función pura: `agents` son los agentes de la empresa (se filtran por `project.team`), `roles` el catálogo ya
// cargado (evita releer los .md por tarea) y `isBusy` cómo saber si un agente está ocupado (el planificador mira sus jobs).
export function plannedAgentFor(project, task, agents, { roles = allRoles(), isBusy = (a) => a.status !== 'idle' } = {}) {
  const ids = new Set(project?.team || []);
  const fits = (a) => task.assignedAgentId ? a.id === task.assignedAgentId : (a.role === task.role || (roles[a.role]?.handles || []).includes(task.role));
  const candidates = (agents || []).filter((a) => ids.has(a.id) && fits(a));
  return candidates.find((a) => !isBusy(a)) || candidates[0] || null;
}
// Campos calculados para el snapshot (no se persisten): `plannedAgentId` y, si nadie puede hacerla, `plannedReason`.
export function withPlannedAgents(s) {
  const roles = allRoles();
  return s.tasks.map((t) => {
    if (!['backlog', 'todo', 'failed'].includes(t.status)) return t;
    const p = s.projects.find((x) => x.id === t.projectId);
    const a = plannedAgentFor(p, t, s.agents, { roles });
    const assigned = t.assignedAgentId && s.agents.find((x) => x.id === t.assignedAgentId);
    const reason = a ? null : assigned ? `${assigned.name} ya no está en el equipo del proyecto` : `sin agente para el rol ${roles[t.role]?.label || t.role} en el equipo`;
    return { ...t, plannedAgentId: a?.id || null, plannedReason: reason };
  });
}

// FT-64 · Afinidad de caché: la caché de prompt dura ~5 min, y dos tareas seguidas del mismo repo+rol+motor comparten el
// prefijo estable (system del rol + reglas + briefing). Se recuerda qué se lanzó y cuándo terminó cada «repo|rol|motor».
const recentRuns = new Map(); // `${proyecto}|${repo}|${rol}|${motor}` → instante en que terminó
const warmKey = (p, t, engine) => `${p.id}|${repoOfTask(p, t)?.key || ''}|${t.role}|${engine}`;
const affinityOn = () => get().settings.cacheAffinity !== false;

export function tick() {
  const s = get();
  if (!suiteOk()) return; // sin flow-test vigente, el equipo no arranca nada
  const roles = allRoles();
  for (const p of s.projects) {
    if (!p.running) continue;
    const team = teamOf(p);
    let slots = (s.settings.maxParallel || 4) - team.filter((a) => jobs.has(a.id)).length;
    const todoAll = s.tasks.filter((t) => t.projectId === p.id && t.status === 'todo');
    // Entradas calientes: lo que corre ahora (motor del agente si no es `auto`) y lo terminado hace <5 min
    const hot = new Set();
    const activeRepos = new Set(); // repos con alguna tarea corriendo (o lanzada en este tick)
    if (affinityOn()) {
      for (const [k, at] of recentRuns) if (Date.now() - at < CACHE_WINDOW_MS) hot.add(k); else recentRuns.delete(k);
      for (const a of team) {
        const j = jobs.get(a.id), jt = j && s.tasks.find((x) => x.id === j.taskId);
        if (!jt || jt.projectId !== p.id) continue;
        activeRepos.add(repoOfTask(p, jt)?.key || '');
        hot.add(warmKey(p, jt, j.engine || a.engine));
      }
    }
    const plannedEngine = (t) => plannedAgentFor(p, t, team, { roles, isBusy: () => false })?.engine;
    const isWarm = (t) => { const e = plannedEngine(t); return !!e && (e === 'auto' ? [...hot].some((k) => k.startsWith(warmKey(p, t, ''))) : hot.has(warmKey(p, t, e))); };
    const todo = orderTodo(todoAll, affinityOn() ? isWarm : undefined); // FT-66: las pausadas por cuota, las primeras
    for (const t of todo) {
      if (slots <= 0) break;
      if (!depsDone(t)) continue;
      // FT-64: con repos ya ocupados y otra tarea de ellos esperando, no se abre un repo distinto (su caché no se compartiría)
      const repoKey = repoOfTask(p, t)?.key || '';
      if (affinityOn() && activeRepos.size && !activeRepos.has(repoKey) && todo.some((o) => o !== t && o.status === 'todo' && depsDone(o) && activeRepos.has(repoOfTask(p, o)?.key || ''))) continue;
      // FT-66: una tarea pausada por cuota vuelve con su mismo agente si está libre; si no, la regla de FT-50 (la que ve el usuario en la tarjeta)
      const pref = t.preferAgentId && team.find((a) => a.id === t.preferAgentId && !jobs.has(a.id));
      const agent = pref || plannedAgentFor(p, t, team, { roles, isBusy: (a) => jobs.has(a.id) });
      if (!agent || jobs.has(agent.id)) continue;
      if (t.quotaPaused && !quotaReady(t, agent)) continue; // FT-66: sin cuota → espera a su hora (o sigue con el otro motor si es `auto`)
      if (splitIfBig(p, t)) continue; // FT-63: tarea grande → al PO en vez de lanzarla entera
      const q = quotaCheck(agent);
      if (q.wait) continue;
      if (!q.ok) { quotaHold(p, agent, t, q); continue; }
      quotaRelease(t);
      slots--;
      activeRepos.add(repoKey);
      runTask(p, agent, t);
    }
  }
}
setInterval(tick, 1500).unref();

// FT-63: una tarea nueva que parece grande (muchas piezas, «y además…», estimación cercana al tope) no se lanza entera: se manda al PO
// como «Planificar:» para que la trocee, y la original queda en Backlog enlazada (`splitInto`). Se evalúa una sola vez por tarea.
// Ajustes ▸ bigTasks: 'plan' (por defecto) · 'suggest' (solo avisa y la lanza) · 'off'. Sin PO en el equipo, solo avisa.
function splitIfBig(p, t) {
  if (t.kind !== 'work' || t.sizeChecked || t.attempts || t.reused || t.quotaPaused) return false;
  t.sizeChecked = true;
  const mode = get().settings.bigTasks || 'plan';
  if (mode === 'off') return false;
  const capUsd = Number(get().settings.maxTaskUsd) > 0 ? Number(get().settings.maxTaskUsd) : 3;
  const reason = compact.bigTaskReason(t, { estimate: costEstimates()[t.role], capUsd });
  if (!reason) return false;
  t.sizeHint = reason;
  const planner = mode === 'plan' && teamOf(p).find((a) => roleOf(a.role)?.kind === 'planner');
  if (!planner) { log(null, `⚠ ${t.code || t.id} parece grande (${reason}): conviene trocearla`); changed(); return false; }
  t.status = 'backlog'; // antes de crear el plan: createTask() vuelve a llamar a tick()
  try {
    const plan = planGoal(p.id, `Esta tarea es grande (${reason}) y no debe lanzarse entera a un solo agente: trocéala en tareas pequeñas, verificables y con su rol.\n\nTarea ${t.code || '#' + t.id}: ${t.title}\n\n${t.description}`, { title: t.title });
    t.splitInto = plan.id;
    log(null, `✂ ${t.code || t.id} parece grande (${reason}): enviada al PO para trocearla (${plan.code || plan.id})`);
    events.emit('TaskSplitRequested', events.ctxOf(t), { reason, planTaskId: plan.id });
  } catch (e) { t.status = 'todo'; delete t.splitInto; log(null, `⚠ No pude enviar ${t.code || t.id} al PO: ${e.message}`); changed(); return false; }
  changed();
  return true;
}

const teamRoles = (p) => [...new Set(teamOf(p).filter((a) => roleOf(a.role)?.kind !== 'planner').map((a) => a.role))];

// Cómo preguntar al cliente desde la tarea (bin/ao-ask.mjs espera la respuesta y la imprime) + lo ya respondido.
const askRules = () => [
    '',
    'PREGUNTAR AL CLIENTE: si una decisión es suya (no se resuelve leyendo el código ni el documento: reglas de negocio, nombres que verá el usuario, qué opción prefiere), pregunta ANTES de implementar con:',
    `  node ${path.join(store.ROOT, 'bin', 'ao-ask.mjs')} "¿Pregunta cerrada?" --opt "Opción A" --opt "Opción B" [--context "qué cambia con cada opción"]`,
    'El comando se queda esperando (puede tardar minutos) e imprime la respuesta elegida o escrita; úsala y sigue. Una pregunta cada vez, máximo 3 por tarea, con opciones concretas. Si imprime «SIN RESPUESTA», decide tú con el criterio más conservador y déjalo bien visible en el resumen final.',
  ].join('\n');
const askAnswers = (t) => { const prev = (t.questions || []).filter((q) => q.answer != null); return prev.length ? `Respuestas del cliente ya dadas en esta tarea (no vuelvas a preguntarlas):\n${prev.map((q) => `- ${q.question} → ${q.answer}`).join('\n')}` : ''; };
const askBlock = (t) => [askRules(), askAnswers(t)].join('\n');

// FT-5: restricciones del cliente (siempre) y mensajes recibidos en la ejecución anterior (si se reencoló).
const clientBlock = (t) => [
  (t.constraints || []).length ? `\nRestricciones del cliente (obligatorias, aplican a todo el trabajo):\n${t.constraints.map((c) => `- ${c.text}`).join('\n')}` : '',
  (t.pendingMessages || []).length ? `\nIndicaciones que el cliente añadió mientras trabajabas (aplícalas):\n${t.pendingMessages.map((m) => `- ${m.text}`).join('\n')}` : '',
].join('');

// FT-44: rutas de trabajo del agente. Una copia aislada (git worktree, rama ao/<código>) por CADA repo del proyecto; escribir en
// los checkouts principales se prohíbe (no tienen rama ni revisión y AgentOffice puede servirlos en caliente).
function worktreesBlock(p, t) {
  const xs = taskRepos(p, t);
  if (xs.length < 2) return `Trabajas en una copia aislada del repo (git worktree) en la rama ${t.branch}. No cambies de rama ni hagas push.`;
  return [
    `Trabajas en copias aisladas (git worktree) de los repos del proyecto, todas en la rama ${t.branch}. No cambies de rama ni hagas push.`,
    ...xs.map((x) => `- «${x.key}»${x.main ? ' (tu directorio de trabajo)' : ''}: escribe SOLO en ${x.dir} (checkout principal: ${x.repo.path}, solo para consultar).`),
    'PROHIBIDO escribir en los checkouts principales: lo escrito fuera de estos worktrees no se revisa, no se confirma ni se fusiona. Si el trabajo toca otro repo, hazlo en SU worktree de arriba.',
  ].join('\n');
}

function buildPrompt(p, agent, t) {
  if (t.kind === 'plan') {
    const roles = teamRoles(p);
    const repos = p.repos || [];
    return [
      `Objetivo del equipo: ${t.goal}`,
      clientBlock(t),
      '',
      repos.length ? `Repositorios del proyecto (estás en ${repos[0].path}): ${repos.map((r) => `«${r.key}» = ${r.path} (rama ${r.baseBranch})`).join(' · ')}. Lee su documentación y código para entender el contexto.` : 'No hay repositorio: planifica solo a partir del objetivo.',
      `Divide el objetivo en tareas pequeñas para estos roles: ${roles.join(', ')}.`,
      'Cada tarea debe poder hacerla un agente solo, en una rama aparte, y ser verificable.',
      'Las tareas de QA van al final y dependen de lo que verifican.',
      roles.some((r) => roleOf(r)?.kind === 'docs') ? `Si el objetivo cambia cómo funciona algo o añade una pieza nueva, incluye al final una tarea para el rol de documentación (${roles.filter((r) => roleOf(r)?.kind === 'docs').join('/')}) que lo documente en flow-test (carpeta «${p.folder || 'default'}/»), dependiente de las tareas que documenta.` : '',
      '',
      t.feedbackImages?.length ? `Imágenes adjuntas a la petición (míralas; están en ${t.feedbackImages.join(', ')}).` : '',
      t.files?.length ? `Ficheros adjuntos a la petición (léelos): ${t.files.join(', ')}.` : '',
      'Si la petición es una sola cosa concreta, devuelve UNA tarea (no la trocees sin motivo). Decide tú a qué rol y repo va.',
      askBlock(t),
      'Responde SOLO con un bloque JSON (máximo 6 tareas):',
      '```json',
      `[{"title": "…", "description": "qué hacer y cómo saber que está bien", "role": "${roles.join('|')}", ${repos.length > 1 ? `"repo": "${repos.map((r) => r.key).join('|')}", ` : ''}"dependsOn": [índices de tareas anteriores de esta lista]}]`,
      '```',
    ].join('\n');
  }
  const done = get().tasks.filter((x) => t.dependsOn.includes(x.id));
  // FT-59: orden pensado para la caché de prompts (prefijo idéntico entre tareas/turnos del mismo agente y repo):
  // 1) PARTE ESTABLE — nada que cambie por tarea (ni ids, ni fechas, ni rama) — 2) PARTE VARIABLE al final.
  return [
    // ── estable ──
    p.folder ? `Carpeta del proyecto en el workspace de flow-test: «${p.folder}/» (ahí viven sus flows y su documentación; guarda ahí lo que generes con flow-test).` : '',
    'Trabajas en una copia aislada del repo (git worktree), en tu propia rama. No cambies de rama ni hagas push.',
    'Lo que dejes sin confirmar se confirmará solo al terminar.',
    (() => { const r = repoOfTask(p, t); return r?.path ? '\n' + briefingFor(r.path) + (t.codeIndexOn ? '\n' + codeindex.BRIEFING_LINE : '') + '\n' : ''; })(), // FT-58: aviso del índice de código
    get().settings.agentMemory !== false ? memory.promptBlock(p.id, agent.id) : '', // FT-75: lecciones de tareas anteriores
    askRules(),
    economyBlock(t.codeIndexOn),
    get().settings.agentMemory !== false ? memory.PROMPT_ASK : '',
    'Al acabar, responde con un resumen breve: qué cambiaste y cómo lo probaste.',
    '',
    '════════ TAREA (lo anterior es común a todas las tareas) ════════',
    // ── variable ──
    `Tarea ${t.code || '#' + t.id}: ${t.title}`,
    `Rama de esta tarea: ${t.branch}`,
    '',
    t.description,
    t.context ? `\n${describeContext(t.context, true)}.` : '',
    t.resumeAfterQuota ? '\nSe cortó por falta de cuota de la suscripción; continúa donde lo dejaste (tu avance está en esta rama: mira `git log` y `git diff` contra la base).' : '',
    clientBlock(t),
    done.length ? `\nTrabajo previo del equipo (ya fusionado):\n${done.map((d) => `- ${d.title}: ${d.summary}`).join('\n')}` : '',
    t.feedback ? `\nComentarios de la revisión anterior (corrígelos):\n${t.feedback}` : '',
    t.baseConflict ? `\nOJO: ${t.baseConflict}` : '',
    t.compactNotes !== undefined ? compact.notesBlock(t.compactNotes) : '', // FT-63
    t.feedbackImages?.length ? `\nImágenes adjuntas (míralas con atención antes de cambiar nada; también están en ${t.feedbackImages.join(', ')}).` : '',
    t.files?.length ? `\nFicheros adjuntos (léelos antes de empezar): ${t.files.join(', ')}` : '',
    t.reused ? '\nEn esta rama ya está tu intento anterior (mira `git log` y `git diff` contra la rama base): parte de él y corrige lo que pide la revisión, sin rehacer lo que ya estaba bien.' : '',
    worktreesBlock(p, t), // FT-44: worktrees de los demás repos del proyecto (parte variable: rutas de esta tarea)
    t.code ? `Cita el código ${t.code} en lo que documentes (changelog, README, flows, tablero) para que la tarea se pueda rastrear.` : '',
    askAnswers(t),
  ].join('\n');
}

// Reglas para gastar menos tokens (cada turno reenvía TODO lo leído: un fichero de 140 KB leído entero pesa ~35k tokens
// en cada paso que queda). Medido el 6 OCT: las tareas de UI rondaban los 6 $ por leer ficheros enteros y repetir capturas/e2e.
function economyBlock(codeIndexOn) {
  return [
    '',
    'Gasta pocos tokens (cada fichero que lees se reenvía en todos los pasos siguientes):',
    codeIndexOn ? codeindex.ECONOMY_RULE : '', // FT-58
    '- Ficheros grandes (más de ~400 líneas, p. ej. public/app.js, public/office3d.js, server/team.js, README.md): NUNCA los leas enteros. Localiza con Grep (-n) y lee solo el tramo con Read offset/limit.',
    '- No vuelvas a leer lo que ya leíste; no hagas `cat` de ficheros largos ni de salidas largas: recorta con `| tail -30`, `| head`, `grep`.',
    '- Pruebas: ejecuta el e2e/verificación UNA vez cuando creas que está bien; repite solo si falló. Capturas de pantalla: como mucho 1 (otra solo si la primera muestra un fallo), y solo si la tarea es visual.',
    '- Ve al grano: el briefing del repo ya te da la estructura; no lo explores con ls -R/find/wc.',
    '- Para explorar más de 3 ficheros (entender un módulo, buscar todos los usos de algo), delega en el subagente «explorador» (herramienta Task/Agent, si tu motor la tiene) y trabaja con su resumen; lee tú solo los tramos que vayas a editar.',
    '- Si te acercas al tope de gasto de la tarea, deja el trabajo en un estado coherente y resume qué falta.',
  ].join('\n');
}

async function runTask(p, agent, t) {
  const s = get();
  jobs.set(agent.id, { stop() {}, taskId: t.id, engine: agent.engine === 'auto' ? null : agent.engine }); // ocupado DESDE YA (antes de cualquier await), o el mismo tick le daría dos tareas
  Object.assign(t, { status: 'doing', agentId: agent.id, error: null, attempts: t.attempts + 1, updatedAt: Date.now() });
  Object.assign(agent, { status: 'working', taskId: t.id, activity: t.kind === 'plan' ? 'Leyendo el objetivo' : 'Preparando su copia del repo' });
  changed();
  log(agent.id, `▶ ${t.code || '#' + t.id} ${t.title}`);
  const ev = events.ctxOf(t, agent);
  events.emit('TaskAssigned', ev, { agentName: agent.name, role: agent.role, attempt: t.attempts });
  events.emit('AgentStarted', ev, { engine: agent.engine, attempt: t.attempts });
  if (t.attempts > 1) events.emit('AgentResumed', ev, { reason: 'retry', attempt: t.attempts });
  reflect(t, `▶ ${agent.name} (${roleOf(agent.role)?.label || agent.role}) empieza a trabajar en AgentOffice`);

  let engineId;
  let agentError = false; // FT-60: el motor terminó con error (no un fallo de git/preparación)
  const resumingQuota = !!t.quotaPaused;
  const excludeEngine = t.quotaPaused && Date.now() < (t.quotaPaused.resetsAt || 0) && !t.quotaPaused.force ? t.quotaPaused.engine : null;
  if (resumingQuota) { t.resumeAfterQuota = true; events.emit('AgentResumed', events.ctxOf(t, agent), { reason: 'quota-reset', engine: t.quotaPaused.engine }); delete t.quotaPaused; delete t.preferAgentId; t.activity = ''; }
  try { engineId = pickEngine(agent, excludeEngine); } catch (e) { Object.assign(t, { status: 'failed', error: e.message, agentId: null }); Object.assign(agent, { status: 'idle', taskId: null, activity: '' }); jobs.delete(agent.id); log(agent.id, '❌ ' + e.message); events.emit('AgentFailed', ev, { error: e.message.slice(0, 500) }); changed(); return; }
  const engine = ENGINES[engineId] || demo;
  const real = engineId !== 'demo';
  agent.activeEngine = engineId;
  events.emit('AgentProgress', ev, { activity: `Motor ${engineId}`, engine: engineId });
  if (agent.engine === 'auto') log(agent.id, `🤖 Motor automático → ${engineId}`);
  const role = roleOf(agent.role) || roleOf('back');
  const roles = teamRoles(p);
  const repo = repoOfTask(p, t);
  let cwd = repo?.path || store.DATA_DIR;
  const outside = {}; // FT-44: `git status` de cada checkout principal antes de empezar (guardarraíl)
  let addDirs = [];

  try {
    if (real && t.kind !== 'plan') {
      if (!repo) throw new Error('Los motores claude/codex necesitan que el proyecto tenga un repositorio git');
      t.repo = repo.key;
      const wt = await git.createWorktree(p, repo, t);
      cwd = wt.path;
      t.branch = wt.branch;
      t.reused = !!wt.reused;
      t.baseConflict = null;
      // FT-44: un worktree y una rama ao/<código> en CADA repo del proyecto (el principal es el de siempre)
      t.outsideWrites = null;
      const prevRepos = t.repos || {};
      t.repos = { [repo.key]: { ...prevRepos[repo.key], branch: wt.branch } };
      for (const r of p.repos || []) {
        if (r.key === repo.key) continue;
        try {
          const w = await git.createWorktree(p, r, t, git.extraWorktreeDir(p, t, r));
          t.repos[r.key] = { ...prevRepos[r.key], branch: w.branch };
          log(agent.id, `🌿 ${w.reused ? 'Sigue en' : 'Rama'} ${w.branch} en el repo ${r.key}`);
        } catch (e) { log(agent.id, `⚠ No pude crear el worktree en ${r.key}: ${e.message}`); }
      }
      for (const r of p.repos || []) outside[r.key] = await git.statusLines(r.path);
      addDirs = taskRepos(p, t).filter((x) => !x.main).map((x) => x.dir);
      if (wt.reused) {
        log(agent.id, `↺ Sigue sobre su intento anterior en ${wt.branch}`);
        // FT-19: si la base avanzó, se actualiza antes de arrancar; si choca, el conflicto va en el prompt (salvo que ya esté en el feedback de la devolución)
        for (const x of taskRepos(p, t)) {
          try {
            const r = await mergeBaseInto(p, x, t);
            if (r.updated) log(agent.id, `⬆ Rama actualizada con ${x.repo.baseBranch} (${r.behind} commits)${x.main ? '' : ` en ${x.key}`}`);
            if (r.conflicts.length) { log(agent.id, `⚠ La rama choca con ${x.repo.baseBranch} en ${r.conflicts.join(', ')}${x.main ? '' : ` (repo ${x.key})`}`); if (!(t.feedback || '').includes(CONFLICT_MARK) && !t.baseConflict) t.baseConflict = conflictText(x.repo.baseBranch, r.conflicts, x); }
          } catch (e) { log(agent.id, `⚠ No pude actualizar con ${x.repo.baseBranch}: ${e.message}`); }
        }
      } else log(agent.id, `🌿 Rama ${wt.branch} en el repo ${repo.key}`);
      if (engineId === 'claude' && role.skills?.length) { const linked = linkSkillsInto(cwd, role.skills); if (linked.length) log(agent.id, `🧩 Skills: ${linked.join(', ')}`); }
    }
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    // FT-58: índice de código del repo (se reindexa si cambió HEAD); sin él o si falla, el agente trabaja como siempre
    const codeIndex = repo?.path && codeindex.enabled(s.settings) ? await codeindex.ensure(repo.key, repo.path, (m) => log(agent.id, m)) : null;
    t.codeIndexOn = !!codeIndex;
    // FT-63: la ejecución se repite por «segmentos». Si el contexto pasa del umbral se pide el estado (NOTAS.md), se corta y se
    // relanza con un contexto limpio y las notas en el prompt. Sin umbral alcanzado hay un solo segmento, como siempre.
    const at = t.kind === 'plan' ? 0 : compact.threshold(s.settings.compactAt);
    const pickedModel = modelFor(engineId, agent, role, t); // FT-60: peldaño de la escalera ({model, level, why})
    const model = pickedModel.model;
    let res;
    for (let seg = 0; ; seg++) {
    const prompt = buildPrompt(p, agent, t);
    t.pendingMessages = []; // ya van en el prompt
    const baseUsage = t.usage || null; // FT-26: consumo de intentos anteriores; t.usage es acumulado y se actualiza en vivo
    agent.usage = null; // sesión nueva
    const rec = costRecorder({ projectId: t.projectId, taskId: t.id, attempt: t.attempts, engine: engineId, model: model || '', role: t.role }); // FT-76
    const cmp = { asked: false, cut: false };
    delete t.stuck;
    // FT-62: detector de atascos. 1.ª señal → aviso en caliente (Claude: stdin; Codex/demo: se reencola la tarea con el aviso);
    // si tras el aviso vuelve a saltar → se corta y va a Revisión. t.stuckWarned sobrevive al reencolado.
    const stuckLimits = { ...stuck.limits(s.settings), enabled: stuck.limits(s.settings).enabled && t.kind !== 'plan' };
    const probe = t.branch ? async () => `${await git.git(cwd, 'status', '--porcelain')}\n${await git.git(cwd, 'diff', '--stat')}` : null;
    const newDetector = () => stuck.createDetector({ limits: stuckLimits, isCode: role.kind === 'dev', probe });
    let detector = newDetector();
    if (pickedModel.model) { // FT-60: historial de modelos de la tarea (la tarjeta enseña «haiku → sonnet»)
      (t.modelHistory ||= []).push({ model: pickedModel.model, engine: engineId, attempt: t.attempts, why: pickedModel.why, at: Date.now() });
      t.modelHistory = t.modelHistory.slice(-10);
      log(agent.id, `🧠 Modelo ${pickedModel.model} (${pickedModel.why}${t.escalations ? `, escalada ${t.escalations}` : ''})`);
    }
    const onStuck = (signal) => {
      const entry = jobs.get(agent.id);
      if (!signal || !entry?.stop || entry.stuck || entry.requeue) return;
      if (t.stuckWarned) { // ya avisado y sigue: se corta (lo hecho queda en la rama)
        entry.stuck = signal;
        log(agent.id, `⚠️ ${t.code || t.id}: atascado (${signal}) tras el aviso → se corta y va a revisión`);
        entry.stop();
        return;
      }
      t.stuckWarned = true;
      detector = newDetector(); // tras el aviso, la señal tiene que repetirse desde cero
      const text = stuck.nudgeText(signal);
      log(agent.id, `⚠️ ${t.code || t.id}: parece atascado (${signal}) → aviso al agente`);
      events.emit('AgentProgress', ev, { activity: 'Aviso: parece que da vueltas', stuck: true });
      if (entry.message?.(text, true)) return;
      (t.pendingMessages ||= []).push({ text, at: Date.now(), origin: 'agentoffice' }); // el motor no admite avisos en caliente: reencolada con el aviso en el prompt
      entry.requeue = true;
      entry.stop();
    };
    const job = await engine.start({ // FT-54: el motor local prueba el servidor antes de lanzar
      onEvent: (e) => rec.feed(e),
      agent, task: t, project: p, cwd, mode: t.kind === 'plan' ? 'plan' : 'work', goal: t.goal, roles,
      prompt, addDirs,
      images: (t.feedbackImages || []).filter((f) => fs.existsSync(f)),
      system: role.system,
      model,
      kind: role.kind, roleTools: role.tools, hasSkills: !!role.skills?.length, // FT-59: herramientas acotadas por rol
      // Reintento de la MISMA tarea en su worktree (<50 min o tras pausa por cuota) y solo con una sesión DEL MISMO motor (FT-57); en un relanzamiento por compactación (seg>0, FT-63) se empieza limpio.
      resumeSession: seg === 0 && t.reused && t.sessionId && (t.sessionEngine || 'claude') === engineId && (t.resumeAfterQuota || Date.now() - (t.sessionAt || 0) < 50 * 60_000) ? t.sessionId : null,
      maxTokens: Number(s.settings.maxTaskTokens) > 0 ? Number(s.settings.maxTaskTokens) : null, // FT-57: tope en tokens (Codex; por defecto el equivalente a budgetUsd)
      budgetUsd: Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3, // tope por intento (Ajustes ▸ «Tope de gasto por tarea»)
      effort: ['low', 'medium', 'high'].includes(s.settings.agentEffort) ? s.settings.agentEffort : 'medium',
      codeIndex,
      mcpUrl: ['qa', 'docs'].includes(role.kind) ? mcpUrl() : null, // QA y documentalista hablan con flow-test por MCP
      env: { ...engineEnv(engineId), AO_URL: `http://127.0.0.1:${process.env.AO_PORT || 7420}`, AO_TASK: t.id, AO_AGENT: agent.name },
      onActivity: (text) => { agent.activity = text; events.emit('AgentProgress', ev, { activity: text }); changed(); },
      onTool: (c) => { events.emit(c.phase === 'started' ? 'AgentToolStarted' : 'AgentToolFinished', ev, c.phase === 'started' ? { callId: c.callId, tool: c.tool, summary: c.summary } : { callId: c.callId, ok: c.ok }); onStuck(detector.feed(c)); },
      onLog: (line) => log(agent.id, line),
      onUsage: (u) => { agent.usage = { ...u, engine: engineId, taskId: t.id }; t.usage = addUsage(baseUsage, u);
        // FT-63: contexto por encima del umbral → pedir las notas en caliente (Claude) o, si el motor no admite mensajes, cortar
        // FT-57 manda sobre FT-63: si el intento ya está cerca de su tope de tokens, se deja que lo corte el tope (va a Revisión) en vez de compactar y relanzar
        const budgetUsd = Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3, capTok = Number(s.settings.maxTaskTokens) > 0 ? Number(s.settings.maxTaskTokens) : 0;
        const nearCap = engineId === 'codex' && (capTok ? (u.total || 0) >= capTok * 0.9 : codexCostUsd(u, model) >= budgetUsd * 0.9); // mismo cálculo que codex.js (Claude lo corta el CLI por US$)
        if (at && !cmp.asked && seg < compact.MAX_COMPACTIONS && !nearCap && compact.reached(u, model, at)) {
          cmp.asked = true;
          const pct = Math.round(compact.contextShare(u, model) * 100);
          if (job.message) { job.message(compact.COMPACT_INSTRUCTION, { raw: true }); log(agent.id, `🗜 Contexto al ${pct} %: pido las notas (${compact.NOTES_FILE}) para relanzar con contexto limpio`); }
          else { cmp.cut = true; log(agent.id, `🗜 Contexto al ${pct} %: corto la sesión y la relanzo desde su rama`); job.stop(); }
          events.emit('AgentProgress', ev, { activity: `Contexto al ${pct} %: compactando`, engine: engineId });
        }
        changed();
        detector.usage(u.total).then(onStuck, () => {}); // FT-62
      }, // FT-26 · FT-62
    });
    const entry = jobs.get(agent.id);
    Object.assign(entry, { stop: job.stop, engine: engineId, pid: job.pid, pause: job.pause, resume: job.resume, message: job.message });
    res = await job.done;
    rec.finish(); // FT-76
    if (!cmp.asked || res.budgetHit || !(res.ok || cmp.cut && res.stopped)) break;
    const notesPath = path.join(cwd, compact.NOTES_FILE);
    const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
    if (!notes && !cmp.cut) break; // pidió las notas y no las escribió: había terminado → resumen final normal
    try { fs.unlinkSync(notesPath); } catch { /* sin fichero */ }
    if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd;
    if (t.branch) { try { await git.commitAll(cwd, `${t.code || t.id}: avance antes de compactar el contexto`, `${agent.name} (${role.label})`); } catch { /* sin cambios */ } }
    t.compactNotes = notes;
    t.compactions = (t.compactions || 0) + 1;
    log(agent.id, `↻ Relanzo ${t.code || '#' + t.id} con ${notes ? 'sus notas' : 'su rama'} (compactación ${t.compactions})`);
    events.emit('AgentResumed', ev, { reason: 'compact', attempt: t.attempts, compactions: t.compactions });
    }
    delete t.compactNotes;
    const entry = jobs.get(agent.id) || {}; // FT-62 tras el bucle de segmentos de FT-63: marca de atasco del último segmento

    if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd;
    if (res.sessionId) Object.assign(t, { sessionId: res.sessionId, sessionAt: Date.now(), sessionEngine: engineId });
    delete t.resumeAfterQuota;
    // FT-62: atascado y cortado tras el aviso: como el tope de gasto, NO es un fallo; lo hecho queda en la rama y va a Revisión.
    if (entry.stuck) {
      res.ok = true; res.stopped = false;
      res.summary = `⚠️ atascado: ${entry.stuck}. ${agent.name} no avanzaba (se le avisó y siguió igual), así que se cortó antes de agotar el tope; lo hecho queda en la rama. Revisa: «Devolver» con otra indicación le da otro intento partiendo de aquí.${res.summary ? '\n\n' + res.summary : ''}`;
      t.stuck = entry.stuck;
      events.emit('AgentBlocked', ev, { reason: 'stuck', signal: entry.stuck, costUsd: t.costUsd });
    }
    // Tope de gasto alcanzado: NO es un fallo. Lo hecho se confirma y la tarea va a Revisión con el aviso; «Devolver» le da
    // otro intento (con su tope) partiendo de su rama, «Aprobar» si ya vale. Así se para y se pregunta, sin seguir gastando.
    if (res.budgetHit && t.kind !== 'plan') {
      const cap = Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3, capText = res.capText || `${cap} $`;
      res.ok = true;
      res.summary = `⚠️ TOPE DE GASTO ALCANZADO (${capText} por intento): ${agent.name} se cortó a medias y lo hecho queda en la rama. Revisa: «Devolver» le da otro intento partiendo de aquí; «Aprobar» solo si ya vale.${res.summary ? '\n\n' + res.summary : ''}`;
      t.budgetHit = true;
      log(agent.id, `⚠️ ${t.code || t.id}: tope de gasto de ${capText} alcanzado → a revisión`);
      events.emit('AgentBlocked', ev, { reason: 'budget', capUsd: cap, costUsd: t.costUsd });
    }
    // FT-66: sin cuota a mitad de tarea → NO es un fallo. Se confirma lo hecho en su rama, la tarea vuelve a «Por hacer»
    // con la hora a la que sigue y `tick()` la relanza sola (mismo agente, misma rama, misma sesión si el motor lo permite).
    if (!res.ok && !res.stopped && t.kind !== 'plan') {
      const q = detectQuotaHit(`${res.error || ''}\n${res.summary || ''}`);
      if (q.hit) {
        for (const x of taskRepos(p, t)) { try { await git.commitAll(x.dir, `${t.code || t.id}: avance antes de quedarse sin cuota`, `${agent.name} (${role.label})`); } catch { /* sin cambios */ } }
        const win = (quota.snapshot()[engineId]?.windows || []).find((w) => w.id === 'session');
        const resetsAt = q.resetsAt || (win?.resetsAt > Date.now() ? win.resetsAt : null) || Date.now() + 15 * 60_000;
        Object.assign(t, { status: 'todo', agentId: null, error: null, quotaPaused: { engine: engineId, since: Date.now(), resetsAt }, preferAgentId: agent.id });
        t.activity = pausedLabel(t);
        log(agent.id, `${t.activity} (${t.code || '#' + t.id}; lo hecho queda en la rama)`);
        events.emit('AgentPaused', ev, { reason: 'quota', engine: engineId, resetsAt });
        return; // finally: agente libre y tick()
      }
    }
    if (!res.ok) { if (!res.stopped) agentError = true; throw new Error(res.error || 'El agente no terminó bien'); }
    t.summary = res.summary || '';
    if (t.kind !== 'plan' && s.settings.agentMemory !== false) { // FT-75: el bloque «LECCIONES:» del resumen pasa a la memoria
      const h = memory.harvest(p.id, agent.id, t.summary, t.code || t.id);
      t.summary = h.summary;
      if (h.added) log(agent.id, `🧠 ${h.added} lección(es) a la memoria`);
    }

    if (t.kind === 'plan') {
      const list = res.tasks || parseTasks(res.summary);
      const ids = [];
      for (const item of list.slice(0, 8)) {
        const r = roles.includes(item.role) ? item.role : (roles[0] || 'back');
        const deps = (item.dependsOn || []).map((i) => ids[i]).filter(Boolean);
        const rk = (p.repos || []).some((x) => x.key === item.repo) ? item.repo : null;
        ids.push(createTask({ projectId: p.id, title: item.title, description: item.description, role: r, repo: rk, dependsOn: deps, sizeChecked: true }).id);
      }
      t.summary = `${ids.length} tareas creadas para el equipo.`;
      t.status = 'done';
      events.emit('AgentCompleted', ev, { status: 'done', summary: t.summary, costUsd: t.costUsd });
      log(agent.id, `✅ Plan listo: ${ids.length} tareas`);
    } else {
      if (t.branch) {
        // FT-44: commit y diffStat por repo; los repos sin cambios se sueltan (worktree y rama fuera) para no fusionar nada vacío
        for (const x of taskRepos(p, t)) {
          const c = await git.commitAll(x.dir, t.code ? `${t.code}: ${t.title}` : `${t.title} (#${t.id})`, `${agent.name} (${role.label})`);
          const stat = await git.diffStat(x.repo, { branch: x.branch });
          const sha = c?.sha || (stat ? await git.git(x.dir, 'rev-parse', '--short', 'HEAD') : null);
          if (!stat && !x.main) { await git.cleanup(p, x.repo, t, x.dir); delete t.repos[x.key]; continue; }
          t.repos[x.key] = { ...t.repos[x.key], branch: x.branch, diffStat: stat, sha };
          if (x.main) t.diffStat = stat;
          for (const f of c?.files || []) events.emit('AgentFileModified', ev, { path: f, repo: x.key });
          events.emit('AgentArtifactCreated', ev, { kind: 'commit', branch: x.branch, repo: x.key, sha: c?.sha || null, files: c?.files || [], diffStat: stat.slice(-500) });
        }
        // Guardarraíl: cambios nuevos sin confirmar en un checkout principal = escribió fuera de su worktree
        const out = [];
        for (const r of Object.keys(outside).length ? p.repos || [] : []) {
          const was = new Set(outside[r.key] || []);
          const files = (await git.statusLines(r.path)).filter((l) => !was.has(l));
          if (files.length) out.push({ repo: r.key, path: r.path, files: files.slice(0, 30) });
        }
        t.outsideWrites = out.length ? out : null;
        if (out.length) { log(agent.id, `⚠ Escribió fuera de su worktree: ${out.map((o) => `${o.repo} (${o.files.length})`).join(', ')}`); events.emit('AgentBlocked', ev, { reason: 'outside-worktree', repos: out.map((o) => o.repo) }); }
        t.diffStat = t.diffStat || '';
      } else {
        t.diffStat = res.diffStat || '';
        events.emit('AgentArtifactCreated', ev, { kind: 'diff', diffStat: t.diffStat.slice(-500) });
      }
      t.status = 'review';
      Object.assign(t, { reviewAt: Date.now(), nudged: false, lastEngine: engineId }); delete t.autoApproved;
      setImmediate(() => autoReview(p, t).catch((e) => log(agent.id, `⚠ Revisión automática de ${t.code || t.id}: ${e.message}`))); // FT-56
      events.emit('AgentCompleted', ev, { status: 'review', summary: (t.summary || '').slice(0, 500), costUsd: t.costUsd });
      log(agent.id, '✋ Terminado: esperando tu revisión');
      reflect(t, `✋ ${agent.name} terminó; pendiente de revisión en AgentOffice.${t.diffStat ? `\n\n\`\`\`\n${t.diffStat.slice(0, 800)}\n\`\`\`` : ''}`);
    }
  } catch (e) {
    if (jobs.get(agent.id)?.requeue) { // FT-5: mensaje en caliente sin soporte del motor → misma tarea, misma rama, con el mensaje
      t.status = 'todo';
      t.error = null;
      t.agentId = null;
      events.emit('AgentProgress', ev, { activity: 'Reencolada con un mensaje del cliente' });
      log(agent.id, '↻ Tarea reencolada con el mensaje del cliente');
      return;
    }
    t.status = 'failed';
    t.error = e.message;
    if (agentError && t.kind !== 'plan') escalate(t, 'error del agente'); // FT-60: el reintento (Reintentar) usa el siguiente modelo
    events.emit('AgentFailed', ev, { error: String(e.message).slice(0, 500) });
    log(agent.id, '❌ ' + e.message);
    reflect(t, `❌ Falló en AgentOffice: ${String(e.message).slice(0, 500)}`);
  } finally {
    questions.cancelForTask(t.id);
    delete t.compactNotes; // FT-63
    if (!jobs.get(agent.id)?.requeue) delete t.stuckWarned; // FT-62: solo sobrevive al reencolado con el aviso
    jobs.delete(agent.id);
    t.updatedAt = Date.now();
    if (engineId && t.kind !== 'plan') recentRuns.set(warmKey(p, t, engineId), Date.now()); // FT-64: su prefijo sigue en caché ~5 min
    Object.assign(agent, { status: 'idle', taskId: null, activity: '', activeEngine: null });
    changed();
    tick();
  }
}

// Estimación de coste de una tarea antes de arrancarla: mediana del coste de las últimas 10 tareas hechas del mismo rol
// (de todos los proyectos). Sin historial suficiente (<3), null. La usa la tarjeta («≈ 0,8 $»).
export function costEstimates() {
  const byRole = {};
  const done = get().tasks.filter((t) => t.status === 'done' && t.costUsd > 0 && t.kind !== 'plan').sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of done) (byRole[t.role] ||= []).push(t);
  const st = get().settings, all = ladder.ladders(st), roles = allRoles();
  const med = (v) => { const x = v.map((t) => t.costUsd).sort((a, b) => a - b); return +x[Math.floor(x.length / 2)].toFixed(2); };
  const out = {};
  for (const [r, list] of Object.entries(byRole)) {
    // FT-60: la tarea empieza por el modelo inicial de la cascada → se estima con las tareas que empezaron por él (si hay ≥3)
    const initial = new Set(['claude', 'codex'].map((e) => ladder.pick(e, all[e], { floor: roles[r]?.minModel || '', all })?.model).filter(Boolean));
    const same = list.filter((t) => initial.has(t.modelHistory?.[0]?.model)).slice(0, 10);
    const v = same.length >= 3 ? same : list.slice(0, 10);
    if (v.length >= 3) out[r] = med(v);
  }
  return out;
}
