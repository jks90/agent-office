// El equipo: proyectos (con uno o varios repos), agentes (roles de serie o de fichero .md), tareas y el planificador.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { orderTodo, CACHE_WINDOW_MS } from './affinity.js';
import * as codes from './codes.js';
import * as questions from './questions.js';
import * as events from './events.js';
import { classifyReject, REASONS, forCoordinator } from './scores.js'; // FT-152 · FT-154
import * as git from './git.js';
import { dirtyMap, commitOnMain } from './onmain.js'; // FT-233
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
import * as ponytail from './ponytail.js'; // FT-86
import { briefingFor } from './briefing.js';
import * as identity from './identity.js'; // 🪪 identidad inmutable + bautizos
import { detectQuotaHit } from './quota-pause.js';
import * as memory from './memory.js';
import * as codeindex from './codeindex.js';
import * as compact from './compact.js';
import * as stuck from './stuck.js';
import * as review from './review.js'; // FT-56
import * as toolcat from './toolcatalog.js';
import * as toolkit from './toolkit.js';
import * as proposals from './proposals.js';
import * as releaseTrigger from './release-trigger.js'; // 🚀 «Publicar X.Y.Z»: el pipeline lo ejecuta AgentOffice en nombre del agente de Release // 🧰 notas de negocio por skill y scripts nuevos que proponen los agentes // 🧰 skills + MCP + scripts del agente: prompt «úsalas primero» y rastreo de uso
import * as coord from './coordinator.js';
import * as sup from './supervisor.js'; // FT-122
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

// ── Proyectos ↔ carpetas del workspace de flow-test. Desde «proyectos manuales» los proyectos ya NO se crean solos por
// carpeta: se dan de alta a mano y cada uno se vincula (obligatorio) a UNA carpeta de primer nivel de flows/ — o a la raíz
// (ROOT, la convención histórica «default»: los flows sueltos). Una carpeta, un proyecto. `checkFolders` (al arrancar y cada
// 5 min) solo refresca el nº de flows y marca `orphan` si la carpeta vinculada desaparece, para re-vincularla en Ajustes.
export const ROOT = 'default';
// Copias de flows dentro de los worktrees de los agentes (data/worktrees/… de AgentOffice): aparecen en el workspace de
// flow-test cuando la carpeta de un proyecto enlaza el repo agent-office entero. No son flows del proyecto: se ignoran.
export const isWorktreeCopy = (p) => /(^|\/)data\/worktrees\//.test(String(p || ''));
// assets/ y privado/ son del sistema; las ocultas y las «_» (p. ej. _agentes, el catálogo) tampoco son proyectos.
const isProjectFolder = (name) => !!name && name !== ROOT && !name.startsWith('.') && !name.startsWith('_') && !['assets', 'privado'].includes(name) && !isWorktreeCopy(name);

async function readWorkspace() {
  try {
    const r = await fetch(`${flowTestUrl()}/workspace/flows`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { files: j.files || [], dir: j.dir || null, dirs: j.dirs || [] };
  } catch (e) { throw fail(502, `No pude leer el workspace de flow-test: ${e.message}`); }
}

// Carpetas de primer nivel (también las vacías: flow-test ≥ 5.20 manda `dirs`) con su nº de flows; la raíz cuenta los sueltos.
function folderCounts({ files, dirs }) {
  const counts = new Map([[ROOT, 0]]);
  const top = (rel) => String(rel).split('/')[0];
  for (const d of dirs) if (isProjectFolder(top(d)) && !counts.has(top(d))) counts.set(top(d), 0);
  for (const f of files) {
    const parts = String(f.path).split('/');
    const folder = parts.length > 1 ? parts[0] : ROOT;
    if (folder !== ROOT && !isProjectFolder(folder)) continue;
    if (!counts.has(folder)) counts.set(folder, 0);
    if ((f.type && f.type !== 'flow') || isWorktreeCopy(f.path)) continue;
    counts.set(folder, counts.get(folder) + 1);
  }
  return counts;
}

export async function checkFolders() {
  const ws = await readWorkspace();
  const counts = folderCounts(ws);
  const s = get();
  const orphans = [];
  for (const p of s.projects) {
    if (!p.folder) continue; // sin vincular (proyectos de antes): la UI pide vincularlos
    p.orphan = !counts.has(p.folder);
    if (p.orphan) orphans.push(p.name); else p.flows = counts.get(p.folder);
  }
  s.workspace = { dir: ws.dir, folders: [...counts.keys()], syncedAt: Date.now() };
  changed();
  return { folders: [...counts.keys()], orphans, unlinked: s.projects.filter((p) => !p.folder).map((p) => p.name), dir: ws.dir };
}

// Selector de «Nuevo proyecto» / Ajustes: cada carpeta con sus flows y el proyecto que ya la usa (si lo hay).
export async function workspaceFolders() {
  const ws = await readWorkspace();
  const counts = folderCounts(ws);
  const owner = (f) => { const p = get().projects.find((x) => x.folder === f); return p ? { id: p.id, name: p.name } : null; };
  return { dir: ws.dir, folders: [...counts].map(([name, flows]) => ({ name, root: name === ROOT, flows, project: owner(name) })) };
}

// Normaliza y valida la carpeta de un proyecto: obligatoria, de primer nivel (o la raíz) y libre (salvo el propio proyecto).
function checkFolderName(folder, selfId = null) {
  const f = String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!f) throw fail(400, 'El proyecto necesita una carpeta del workspace de flow-test');
  if (f !== ROOT && (f.includes('/') || !isProjectFolder(f))) throw fail(400, `«${f}» no vale como carpeta de proyecto (una de primer nivel, sin «.» ni «_» al principio)`);
  const other = get().projects.find((p) => p.folder === f && p.id !== selfId);
  if (other) throw fail(409, `La carpeta «${f === ROOT ? 'raíz' : f}» ya es del proyecto «${other.name}»`);
  return f;
}

// Comprueba que la carpeta existe en flow-test; con `create` la crea (POST /workspace/folder: vale con flow-test en Docker).
async function ensureFolder(f, create) {
  if (f === ROOT) return 0;
  const counts = folderCounts(await readWorkspace());
  if (counts.has(f)) return counts.get(f);
  if (!create) throw fail(400, `No existe la carpeta «${f}» en el workspace de flow-test`);
  // Con el workspace en este disco se crea aquí, con el usuario de AgentOffice: flow-test en Docker la crearía como root y los
  // agentes de un proyecto sin repo (que trabajan en la carpeta) no podrían escribir. Si no se ve el disco, se le pide a flow-test.
  const hostDir = expand(get().settings.workspaceHostDir);
  if (hostDir && fs.existsSync(hostDir)) { fs.mkdirSync(path.join(hostDir, f), { recursive: true }); return 0; }
  let r;
  try { r = await fetch(`${flowTestUrl()}/workspace/folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: f }), signal: AbortSignal.timeout(8000) }); } catch (e) { throw fail(502, `flow-test no responde: ${e.message}`); }
  if (!r.ok && r.status !== 409) throw fail(502, `flow-test no creó la carpeta «${f}»: ${(await r.json().catch(() => ({}))).error || 'HTTP ' + r.status}`);
  return 0;
}

// Repos sugeridos para una carpeta: sus enlaces simbólicos que apuntan dentro de un repo git (clave = nombre del enlace),
// p. ej. unityhouse/servidor → …/servidor/flows. Solo se sugieren en el diálogo; nada se añade solo.
export async function suggestRepos(folder) {
  const hostDir = expand(get().settings.workspaceHostDir);
  if (!hostDir || !folder || folder === ROOT) return [];
  let entries;
  try { entries = fs.readdirSync(path.join(hostDir, folder), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isSymbolicLink() || e.name === 'docs') continue;
    let real;
    try { real = fs.realpathSync(path.join(hostDir, folder, e.name)); } catch { continue; }
    let info;
    try { info = await git.repoInfo(real); } catch { continue; }
    const key = e.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (out.some((r) => r.path === info.path || r.key === key)) continue;
    out.push({ key, path: info.path });
  }
  return out;
}

export async function createProject({ name, repoPath, repos, engine = 'demo', folder, createFolder = false, coordinator = true, defaultTeam = true }) {
  if (!name?.trim()) throw fail(400, 'El proyecto necesita un nombre');
  // Solo para los e2e (arrancan su servidor con un flow-test falso sin /workspace): altas sin carpeta. Nadie la pone en producción.
  const unlinked = !String(folder ?? '').trim() && process.env.AO_TEST_ALLOW_UNLINKED === '1';
  const f = unlinked ? null : checkFolderName(folder);
  const list = await resolveRepos({ repos, repoPath });
  const flows = unlinked ? null : await ensureFolder(f, createFolder);
  if (!ENGINE_IDS.includes(engine)) engine = 'auto';
  const s = get();
  if (f) checkFolderName(f); // otra alta pudo coger la carpeta mientras se esperaba a flow-test
  const project = { id: newId(), name: name.trim(), folder: f, flows, orphan: false, repos: list, repoPath: list[0]?.path || null, baseBranch: list[0]?.baseBranch || null, running: false, team: [], coordinator: 'auto', createdAt: Date.now() };
  s.projects.push(project);
  if (!s.agents.length && defaultTeam !== false) DEFAULT_TEAM.forEach((m) => { const a = newAgent({ ...m, engine }); s.agents.push(a); project.team.push(a.id); }); // con plantilla de equipo, no
  if (coordinator !== false) addSupervisor(project); // FT-122: el coordinador viene de serie (casilla del alta; ocupa mesa; se puede quitar)
  changed();
  return project;
}

// 👔 Managers del proyecto: { managerId: [miembros] }. El manager es un agente del equipo que revisa (auto-qa) las tareas de
// SUS miembros en vez del revisor del proyecto, y el organigrama los cuelga de él. Un miembro, un manager; nadie se gestiona a sí mismo.
export function normalizeManagers(p, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const team = new Set(p.team || []);
  const out = {}, taken = new Set();
  for (const [mid, list] of Object.entries(raw)) {
    if (!team.has(mid)) throw fail(400, 'El manager tiene que estar fichado en el proyecto');
    const ms = [...new Set(Array.isArray(list) ? list : [])];
    for (const id of ms) {
      if (!team.has(id)) throw fail(400, 'Los miembros de un manager tienen que estar fichados en el proyecto');
      if (id === mid || raw[id]) throw fail(400, 'Un manager no puede estar en el equipo de otro manager');
      if (taken.has(id)) throw fail(400, 'Cada miembro va con un solo manager');
      taken.add(id);
    }
    out[mid] = ms;
  }
  return out;
}
// Manager de un agente en el proyecto (los dos fichados), o null.
export function managerOf(p, agentId) {
  const team = new Set(p?.team || []);
  if (!team.has(agentId)) return null;
  return Object.entries(p?.managers || {}).find(([mid, ms]) => team.has(mid) && ms.includes(agentId))?.[0] || null;
}

export async function updateProject(id, patch) {
  const p = findOr404(get().projects, id, 'Proyecto');
  if (patch.name?.trim()) p.name = patch.name.trim();
  if (patch.folder !== undefined) { // re-vincular: a una carpeta que exista y esté libre (la vinculación es obligatoria)
    const f = checkFolderName(patch.folder, p.id);
    if (f !== p.folder) { p.flows = await ensureFolder(f, !!patch.createFolder); p.folder = f; p.orphan = false; }
  }
  if (patch.prefix !== undefined) p.prefix = codes.normalizePrefix(patch.prefix) || null; // las tareas ya numeradas conservan su código
  if (patch.coordinator !== undefined) p.coordinator = ['suggest', 'auto'].includes(patch.coordinator) ? patch.coordinator : null; // 🧑‍✈️ apagado | sugerir | automático
  if (patch.supervisorApproves !== undefined) p.supervisorApproves = !!patch.supervisorApproves; // FT-122: delega aprobar y recortar dependencias
  if (patch.reviewerAgentId !== undefined) { // 🔎 revisor del proyecto: un agente del equipo hace la revisión auto-qa (vacío = la de siempre)
    if (patch.reviewerAgentId && !(p.team || []).includes(patch.reviewerAgentId)) throw fail(400, 'El revisor tiene que estar fichado en el proyecto');
    p.reviewerAgentId = patch.reviewerAgentId || null;
  }
  if (patch.managers !== undefined) p.managers = normalizeManagers(p, patch.managers); // 👔 managers: cada uno revisa a su equipo
  if (patch.reviewPolicy !== undefined) { // '' = la de la empresa · manual | auto-qa | auto
    p.reviewPolicy = review.POLICIES.includes(patch.reviewPolicy) ? patch.reviewPolicy : null;
    reviewPending(p);
  }
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

// Proyecto SIN repo (solo documentación y flows, p. ej. «empresa»): sus agentes trabajan directamente en la carpeta del
// proyecto en el workspace de flow-test (sin worktree ni rama; de una en una para no pisarse; aprobar = hecha).
export function projectDir(p) {
  if (!p?.folder) return null;
  const base = String(get().settings.workspaceHostDir || path.join(os.homedir(), 'JksDocs', 'workspace')).replace(/^~(?=\/|$)/, os.homedir());
  const dir = p.folder === ROOT ? base : path.join(base, p.folder);
  return fs.existsSync(dir) ? dir : null;
}

// El repo de una tarea: el que diga la tarea; si no, el que declare su rol; si no, el primero.
export function repoOfTask(p, t) {
  const repos = p.repos || [];
  return repos.find((r) => r.key === t.repo) || repos.find((r) => (r.roles || []).includes(t.role)) || repos[0] || null;
}

// ── Agentes ────────────────────────────────────────────────────────────────
// 🪪 Nace con su identidad (uid, nombre de nacimiento, físico); si viene de fuera (paquete, copia) se respeta tal cual.
function newAgent({ name, role, engine = 'auto', model = '', identity: given = null, baptisms = [] }) {
  const a = { id: newId(), name, role, engine, model: model || roleOf(role)?.model || '', status: 'idle', activity: '', taskId: null, createdAt: Date.now() };
  // Si ya hay aquí un agente con ese uid (clon, plantilla 🔒), manda su identidad local (puede seguir sin sellar).
  a.identity = (given && store.get().agents.find((x) => x.identity?.uid === given.uid)?.identity) || given || identity.newIdentity(name, { bornIn: String(store.get().settings?.authorName || os.userInfo().username || '').slice(0, 80) });
  a.baptisms = identity.cleanBaptisms(baptisms);
  if (given && name !== (a.baptisms.at(-1)?.to ?? given.birthName)) a.baptisms.push({ from: a.baptisms.at(-1)?.to ?? given.birthName, to: name, at: Date.now() });
  return a;
}

// Contratar = alta en la empresa (y, si se indica proyecto, fichaje directo en su plantilla).
export function hire({ projectId = null, name, role, engine, model, identity: given = null, baptisms = [] }) {
  const s = get();
  const p = projectId ? findOr404(s.projects, projectId, 'Proyecto') : null;
  if (!roleOf(role)) throw fail(400, 'Rol desconocido');
  if (!name?.trim()) throw fail(400, 'El agente necesita un nombre');
  if (p && p.team.length >= coord.MAX_DESKS) throw fail(400, `La oficina tiene ${coord.MAX_DESKS} mesas: no caben más agentes en este proyecto`);
  const agent = newAgent({ name: name.trim(), role, engine: ENGINE_IDS.includes(engine) ? engine : 'auto', model: model || '', identity: given, baptisms });
  s.agents.push(agent);
  if (p) p.team.push(agent.id);
  changed();
  return agent;
}

// Fichar / mandar al banquillo (no borra al agente).
export function setTeam(projectId, { add = [], remove = [] }) {
  const s = get();
  const p = findOr404(s.projects, projectId, 'Proyecto');
  for (const id of add) { findOr404(s.agents, id, 'Agente'); if (!p.team.includes(id)) { if (p.team.length >= coord.MAX_DESKS) throw fail(400, `La oficina tiene ${coord.MAX_DESKS} mesas`); p.team.push(id); } }
  p.team = p.team.filter((id) => !remove.includes(id));
  changed();
  tick();
  return p.team;
}

export function updateAgent(id, patch) {
  const a = findOr404(get().agents, id, 'Agente');
  const sameIdentity = (x) => x && typeof x === 'object' && x.fingerprint === a.identity?.fingerprint && identity.fingerprintOf(x) === a.identity?.fingerprint;
  if (patch.identity !== undefined && !sameIdentity(patch.identity)) throw fail(409, 'La identidad de un agente no cambia nunca: renómbralo (bautizo) si quieres otro nombre');
  if (patch.name?.trim()) identity.baptize(a, patch.name); // 🪪 bautizo: queda el original en identity.birthName
  if (ENGINE_IDS.includes(patch.engine)) a.engine = patch.engine;
  if (typeof patch.model === 'string') a.model = patch.model.trim();
  if (patch.role && roleOf(patch.role)) a.role = patch.role;
  if (typeof patch.ponytail === 'boolean') a.ponytail = patch.ponytail; // FT-86
  if (Array.isArray(patch.mcps)) a.mcps = [...new Set(patch.mcps.map(String).filter(Boolean))].slice(0, 30); // MCP del catálogo (toolcatalog.js)
  if (Array.isArray(patch.scripts)) a.scripts = [...new Set(patch.scripts.map(String).filter(Boolean))].slice(0, 50);
  if (Array.isArray(patch.skills)) a.skills = [...new Set(patch.skills.map(String).filter(Boolean))].slice(0, 30); // 🧰 skills del catálogo además de las del rol
  changed();
  return a;
}

// 🎨 Retocar el físico mientras no se haya publicado; los clones (mismo uid) son el mismo agente y cambian a la vez.
export function setAvatar(id, input) {
  const s = get();
  const a = findOr404(s.agents, id, 'Agente');
  const next = identity.withAvatar(a.identity, input);
  for (const x of s.agents) if (x.identity?.uid === next.uid) x.identity = next;
  changed();
  return a;
}
// 🔒 Publicado en el marketplace: su identidad (y la de sus clones) queda sellada.
export function sealIdentities(uids) {
  const set = new Set(uids.filter(Boolean));
  let n = 0;
  for (const x of get().agents) if (set.has(x.identity?.uid) && !x.identity.sealedAt) { x.identity = identity.sealed(x.identity); n++; }
  if (n) changed();
  return n;
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
export function createTask({ assignedAgentId = null, projectId, title, description = '', role, repo = null, dependsOn = [], kind = 'work', goal = null, images = [], files = [], attachments = [], status = 'todo', source = null, context = null, skills = [], priority = 0, sizeChecked = false, minModel = '', checks = [], reviewRequired = false, autoApprove = false, fromPlan = null, extra = null }) {
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
  if (fromPlan) task.fromPlan = fromPlan; // parte de una épica (la creó ese plan)
  if (reviewRequired) task.reviewRequired = true; // FT-56: nunca se aprueba sola
  else if (autoApprove) task.autoApprove = true; // programada rutinaria: se aprueba sola al terminar
  if (assignedAgentId === HUMAN) task.assignedAgentId = HUMAN; // FT-189
  else if (assignedAgentId && assignedAgentId !== '__auto') {
    const a = findOr404(s.agents, assignedAgentId, 'Agente');
    if (!(p.team || []).includes(a.id)) throw fail(400, `${a.name} no está fichado en el proyecto de la tarea`);
    task.assignedAgentId = a.id;
  }
  if (cleanMinModel(minModel)) task.minModel = cleanMinModel(minModel); // FT-60: esta tarea no empieza por el peldaño barato
  if (sizeChecked) task.sizeChecked = true; // FT-63: ya troceada por el PO, no se vuelve a evaluar
  // 🚀 Campos de quien la crea (p. ej. el disparador de release: onMain, releaseVersion…) ANTES de tick(): la tarea puede arrancar ya
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (v !== undefined && !(k in task)) task[k] = v;
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
  const human = t.assignedAgentId === HUMAN || patch.assignedAgentId === HUMAN;
  if (t.status === 'doing' && !(human && !t.agentId)) throw fail(409, 'Para al agente antes de editar la tarea');
  if (patch.assignedAgentId !== undefined) { // FT-189: «human» sin buscar agente; «__auto»/id de agente reasigna (borra «human»)
    if (patch.assignedAgentId === HUMAN) t.assignedAgentId = HUMAN;
    else if (!patch.assignedAgentId || patch.assignedAgentId === '__auto') delete t.assignedAgentId;
    else {
      const a = findOr404(s.agents, patch.assignedAgentId, 'Agente');
      if (!(p?.team || []).includes(a.id)) throw fail(400, `${a.name} no está fichado en el proyecto de la tarea`);
      t.assignedAgentId = a.id;
    }
  }
  const before = `${t.title}\n${t.description}`;
  if (patch.title?.trim()) t.title = patch.title.trim();
  if (typeof patch.description === 'string') t.description = patch.description.trim();
  if (`${t.title}\n${t.description}` !== before && p?.board && t.source?.kind === p.board.kind) boards.pushContentSoon(p, t);
  if (patch.role && roleOf(patch.role)) t.role = patch.role;
  if (patch.repo !== undefined) {
    if (patch.repo && !(p.repos || []).some((r) => r.key === patch.repo)) throw fail(400, `El proyecto no tiene el repo «${patch.repo}»`);
    t.repo = patch.repo || null;
  }
  if (patch.status && patch.status !== t.status && t.assignedAgentId === HUMAN) { // FT-189: el usuario la mueve a mano por todas las columnas
    if (!['backlog', 'todo', 'doing', 'review', 'done', 'discarded'].includes(patch.status)) throw fail(400, 'Columna desconocida');
    t.status = patch.status; t.error = null;
    if (patch.status === 'review') t.reviewAt = Date.now();
    reflect(t);
  } else if (patch.status && patch.status !== t.status) {
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

// Archivar: oculta tareas Hechas o Descartadas del tablero sin borrarlas (siguen en el estado, en la búsqueda y en «Ver archivadas»).
// { ids } o { projectId, status } (todas las de esa columna); archived:false las devuelve. No toca updatedAt (el orden de «Hecho»).
export function archiveTasks({ ids = null, projectId = null, status = null, archived = true }) {
  const s = get();
  const pool = Array.isArray(ids) ? s.tasks.filter((t) => ids.includes(t.id)) : s.tasks.filter((t) => t.projectId === projectId && t.status === status);
  if (!Array.isArray(ids) && !['done', 'discarded'].includes(status)) throw fail(400, 'Solo se archivan las columnas Hecho y Descartada');
  let n = 0;
  for (const t of pool) {
    if (!['done', 'discarded'].includes(t.status)) continue;
    if (archived && !t.archived) { t.archived = Date.now(); n++; } else if (!archived && t.archived) { delete t.archived; n++; }
  }
  if (n) changed();
  return { changed: n };
}

// FT-189 · Valor reservado de `assignedAgentId`: la tarea es del usuario; ningún agente la coge, arranca ni reanuda.
export const HUMAN = 'human';
// Fija qué agente hará la tarea (FT-4); null = vuelve a elegirse por rol. Solo antes de empezar.
export function assignTask(id, agentId) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (agentId === '__auto') agentId = null; // FT-189
  const human = t.assignedAgentId === HUMAN || agentId === HUMAN;
  if (!['backlog', 'todo', 'failed'].includes(t.status) && !(human && !t.agentId)) throw fail(409, 'Solo se puede asignar una tarea que no ha empezado');
  if (agentId === HUMAN) t.assignedAgentId = HUMAN; // FT-189: reservado, sin buscar agente
  else if (agentId) {
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
  if (t.status === 'doing' && t.assignedAgentId !== HUMAN) throw fail(409, 'Para al agente antes de borrar la tarea');
  const p = projectOf(t);
  for (const x of taskRepos(p, t)) await git.cleanup(p, x.repo, t, x.dir); // FT-44: todos los worktrees/ramas de la tarea
  s.tasks = s.tasks.filter((x) => x.id !== id);
  for (const o of s.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== id);
  changed();
}

// FT-153: valoración opcional del revisor ({rating:1-5, reasons:[...]}) de la entrega n (0 = primera). Valida y la guarda en t.ratings.
function rate(t, n, { rating, reasons } = {}, by) {
  const r = Math.round(Number(rating)), ok = r >= 1 && r <= 5;
  if (rating != null && rating !== '' && !ok) throw fail(400, 'rating debe ser un entero de 1 a 5');
  if (Array.isArray(reasons) && reasons.some((x) => !REASONS.includes(x))) throw fail(400, `reasons admite: ${REASONS.join(', ')}`);
  const rs = Array.isArray(reasons) ? reasons : [];
  if (ok || rs.length) (t.ratings ||= []).push({ n, rating: ok ? r : null, reasons: rs, by: by || 'human', at: Date.now() });
  return rs;
}

export async function approve(id, { by = null, verdict = null, rating, reasons } = {}) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  rate(t, t.returns || 0, { rating, reasons }, by); // FT-153: se valida antes de fusionar nada
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
  // 🚀 Se fusionó en el propio repo de AgentOffice: se publica solo (push + reinicio cuando nadie trabaje)
  if (t.branch && taskRepos(p, t).some((x) => path.resolve(x.repo.path) === path.resolve(store.ROOT))) import('./selfupdate.js').then((u) => u.publishSelf(t.code || t.id)).catch(() => {});
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

export async function reject(id, feedback = '', images = [], attachments = [], by = null, { rating, reasons } = {}) {
  const t = findOr404(get().tasks, id, 'Tarea');
  for (const a of attachments) { if (/\.(png|jpe?g|webp)$/i.test(a.path)) images = [...images, a.path]; else t.files = [...(t.files || []), a.path]; }
  if (!['review', 'failed'].includes(t.status)) throw fail(409, 'Solo se devuelven tareas en revisión o fallidas');
  const given = rate(t, t.returns || 0, { rating, reasons }, by); // FT-153: valoración del revisor y etiquetas elegidas (valida antes de tocar nada)
  // La rama y el worktree se conservan: el agente corrige sobre su intento anterior.
  t.returns = (t.returns || 0) + 1; // FT-76: devoluciones (KPI «aprobadas a la primera»)
  if (feedback.trim()) t.feedback = [t.feedback, feedback.trim()].filter(Boolean).join('\n');
  (t.rejectAt ||= []).push(Date.now()); // FT-152: cuándo, para atribuir la devolución al intento (modelo) que la provocó
  (t.rejectReasons ||= []).push(given[0] || classifyReject(feedback)); // FT-152: motivo de cada devolución (puntuación de agentes); FT-153: manda la etiqueta elegida
  if (t.budgetHit || t.stuck) t.cuts = (t.cuts || 0) + 1; // FT-152: se cortó por tope o atasco (budgetHit se borra más abajo)
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

// ✕ Rechazar: «no, y no la rehagas». De Revisión (o Fallida) a Descartada con el motivo en su historial; sus cambios se tiran
// (rama ao/<código> y worktree de cada repo). En proyectos sin repo lo que escribió en la carpeta se queda (no hay rama que borrar).
// Lo que dependía de ella se desbloquea: una descartada cuenta como resuelta. «↩ Recuperar» la devuelve al Backlog y empieza de cero.
export async function discardTask(id, reason = '') {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (!['review', 'failed'].includes(t.status)) throw fail(409, 'Solo se rechazan tareas en revisión o fallidas (las demás se mueven a «Descartada» a mano)');
  const p = projectOf(t);
  const why = String(reason || '').trim().slice(0, 1000);
  for (const x of taskRepos(p, t)) { try { await git.cleanup(p, x.repo, t, x.dir); } catch { /* ya no estaba: da igual */ } }
  reviewNote(t, 'human', 'discarded', why);
  events.emit('TaskReviewed', events.ctxOf(t), { decision: 'discarded', feedback: why.slice(0, 500) });
  if (why) t.discardReason = why;
  for (const e of Object.values(t.repos || {})) e.diffStat = '';
  delete t.reviewNote; delete t.reviewing; delete t.autoApproved; delete t.reviewAt; delete t.nudged; delete t.budgetHit;
  Object.assign(t, { status: 'discarded', agentId: null, branch: null, diffStat: '', error: null, behind: 0, conflicts: [], mergeKey: null, discardedAt: Date.now(), updatedAt: Date.now() });
  changed();
  reflect(t, why ? `✕ Rechazada en AgentOffice: ${why}` : '✕ Rechazada en AgentOffice');
  tick();
  return { ok: true, status: t.status };
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
async function runChecks(cwd, checks, t = null, logId = null) {
  for (const [i, c] of checks.entries()) {
    if (t) { t.reviewStep = `verificación ${i + 1}/${checks.length}: ${c}`; changed(); }
    if (logId) log(logId, `🔎 ▶ ${c}`);
    const ok = await new Promise((r) => { const ch = spawn('sh', ['-c', c], { cwd, stdio: 'ignore', timeout: 300_000 }); ch.on('error', () => r(false)); ch.on('close', (code) => r(code === 0)); });
    if (logId) log(logId, `🔎 ${ok ? '✓' : '✗'} ${c}`);
    if (!ok) return { ok: false, failed: c };
  }
  return { ok: true };
}
async function runReviewer(p, t, repo, cwd, checks) {
  const s = get();
  let engineId = ENGINES[s.settings.reviewEngine] && s.settings.reviewEngine !== 'auto' ? s.settings.reviewEngine : (ENGINES[t.lastEngine] ? t.lastEngine : 'demo');
  // Sin cuota en ese motor, el revisor no contesta y la tarea se aparcaba: se usa el otro (el de más margen) y, si ninguno
  // tiene, se espera al reinicio de la ventana (autoReview lo reintenta solo; ver reviewWaitQuota en refreshReviews).
  const g = engineId !== 'demo' ? quota.gate(engineId) : { block: false };
  if (g.block) {
    const alt = ['claude', 'codex'].filter((e) => e !== engineId && ENGINES[e] && !quota.gate(e).block && !quota.gate(e).wait)
      .sort((a, b) => (quota.margin(b) ?? 0) - (quota.margin(a) ?? 0))[0];
    if (!alt) throw Object.assign(new Error(g.message || 'sin cuota para revisar'), { quotaWait: g.resetsAt || Date.now() + 10 * 60_000 });
    engineId = alt;
  }
  // 🔎 Revisor del proyecto (p.reviewerAgentId): un agente APARTE del equipo, con su rol, su modelo y sus MCP, que no sea el autor
  // 👔 Con managers, revisa el manager del autor; si no tiene, el revisor del proyecto
  const revId = managerOf(p, t.agentId) || p.reviewerAgentId;
  const own = revId && revId !== t.agentId && (p.team || []).includes(revId) ? s.agents.find((a) => a.id === revId) : null;
  if (own && ENGINES[own.engine] && own.engine !== 'auto' && own.engine !== engineId && !quota.gate(own.engine).block) engineId = own.engine;
  // Sin autor ni equipo (tarea creada ya en revisión, proyecto sin plantilla) revisa un «Revisor» genérico en vez de fallar
  const agent = own || s.agents.find((a) => a.id === t.agentId) || teamOf(p)[0] || { id: 'revisor', name: 'Revisor', role: 'qa', engine: engineId, model: '' };
  const role = (own && roleOf(own.role)) || Object.values(allRoles()).find((r) => r.kind === 'qa') || roleOf(agent.role) || roleOf('back');
  const extraMcp = own ? toolcat.resolveMcps(toolcat.assignedMcps(own, role)).claude : {};
  if (own) { own.status = 'working'; own.activity = `🔎 Revisando ${t.code || t.id}`; own.taskId = null; changed(); }
  // Visible en la tarjeta: quién revisa (motor/modelo), en qué paso va y en qué registro escribe (el del autor, líneas 🔎)
  Object.assign(t, { reviewBy: `${engineId}${modelFor(engineId, agent, role).model ? ' · ' + modelFor(engineId, agent, role).model : ''}`, reviewStep: 'el revisor lee el diff y ejecuta comprobaciones', reviewLogAgent: agent.id }); changed();
  const job = await ENGINES[engineId].start({
    agent, task: t, project: p, cwd, mode: engineId === 'demo' ? 'review' : 'work', goal: null, roles: teamRoles(p),
    prompt: own && !t.branch ? review.verifyPrompt(t) : review.reviewPrompt(t, repo?.baseBranch || 'main', checks), system: role.system, model: modelFor(engineId, agent, role).model, // FT-60: modelFor devuelve {model, level, why}
    kind: own ? role.kind || 'qa' : 'dev', roleTools: own ? role.tools : null, roleId: own ? own.role : undefined, extraMcp, hasSkills: false, images: [], budgetUsd: Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3,
    effort: ['low', 'medium', 'high'].includes(s.settings.agentEffort) ? s.settings.agentEffort : 'medium',
    env: { ...engineEnv(engineId), AO_URL: `http://127.0.0.1:${process.env.AO_PORT || 7420}`, AO_TASK: t.id, AO_AGENT: 'revisor' },
    onActivity: () => {}, onLog: (line) => log(agent.id, `🔎 ${line}`), onTool: () => {}, onUsage: () => {},
  });
  const timer = setTimeout(() => job.stop?.(), 15 * 60_000);
  try { const res = await job.done; if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd; return review.parseVerdict(res.summary); } finally { clearTimeout(timer); if (own) { own.status = 'idle'; own.activity = ''; changed(); } }
}
// Al llegar a «Revisión» (reviewPolicy auto-qa | auto). Nunca toca tareas reviewRequired, con tope/atasco, ni con ficheros sensibles.
export async function autoReview(p, t) {
  // Programadas rutinarias marcadas «aprobar sola» (p. ej. el informe contable diario): se cierran al terminar si no hay nada raro
  if (t.autoApprove && t.status === 'review' && !t.reviewRequired && !t.budgetHit && !t.stuck && !reviewing.has(t.id)) {
    return approve(t.id, { by: 'programada', verdict: { approve: true, text: 'tarea programada rutinaria: se aprueba sola al terminar' } });
  }
  const s = get(), policy = review.policyOf(s.settings, p);
  if (policy === 'manual' || t.status !== 'review' || t.kind === 'plan' || reviewing.has(t.id)) return;
  const hold = (why) => { t.reviewNote = why; reviewNote(t, 'auto', 'skipped', why); changed(); };
  reviewing.add(t.id);
  try {
    if (t.reviewRequired) return hold('✋ marcada «revisión obligatoria»: la revisa una persona');
    if (t.budgetHit || t.stuck) return hold('✋ terminó cortada (tope de gasto o atasco): la revisa una persona');
    if ((t.autoReviews || 0) >= review.MAX_AUTO_CYCLES) return hold(`⚠️ ${review.MAX_AUTO_CYCLES} revisiones automáticas fallidas: la revisa una persona`);
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
    const logId = s.agents.find((a) => a.id === t.agentId)?.id || teamOf(p)[0]?.id || 'revisor';
    Object.assign(t, { reviewing: policy, reviewStartedAt: Date.now(), reviewStep: 'preparando la revisión', reviewLogAgent: logId }); changed();
    log(logId, `🔎 Revisión automática (${policy === 'auto' ? 'tests' : 'QA'}) de ${t.code || t.id} · ${checks.length ? 'verificaciones: ' + checks.join('; ') : 'sin verificaciones declaradas'}`);
    if (policy === 'auto') {
      const r = await runChecks(cwd, checks, t, logId);
      if (t.status !== 'review') return;
      if (!r.ok) return hold(`✋ la verificación «${r.failed}» falló: no se aprueba sola`);
      await approve(t.id, { by: 'auto', verdict: { approve: true, text: `pasan las verificaciones declaradas (${checks.join('; ')})` } });
      return;
    }
    // La rama se pone al día con la base ANTES de revisar (el revisor ve el código real y no devuelve por desfase). Choques solo en
    // historiales (CHANGELOG…) se combinan solos; un choque de verdad vuelve al agente sin gastar intento de revisión.
    t.reviewStep = `poniendo la rama al día con ${repo?.baseBranch || 'main'}`; changed();
    for (const x of taskRepos(p, t)) {
      try { await syncWithBase(p, x, t); } catch (e) { if (e.conflicts) return; throw e; }
    }
    if (t.status !== 'review') return;
    const v = await runReviewer(p, t, repo, cwd, checks); // auto-qa
    if (v) log(t.reviewLogAgent || logId, `🔎 Veredicto: ${v.approve ? '✅ aprueba' : '↩ devuelve'}${v.reasons.length ? ' · ' + v.reasons.join('; ').slice(0, 300) : ''}`);
    if (t.status !== 'review') return; // un humano decidió mientras tanto
    if (!v) return hold('✋ el revisor no devolvió un veredicto válido: la revisa una persona');
    if (v.approve) {
      // Lo que el revisor ve mejorable pero no bloquea se APUNTA en el veredicto (historial de la tarea), sin crear tareas:
      // creándolas, cada aprobación añadía 1–4 tarjetas al backlog y el proyecto «nunca se acababa» (22 en una tarde).
      const sug = (v.followups || []).map((f) => f.title).filter(Boolean);
      const extra = [v.pending?.length ? `pendiente de comprobar fuera: ${v.pending.join('; ')}` : '', sug.length ? `sugerencias (no se han creado tareas): ${sug.join('; ')}` : ''].filter(Boolean).join(' · ');
      await approve(t.id, { by: 'auto-qa', verdict: { approve: true, text: [v.reasons.join('; ') || 'sin objeciones', extra].filter(Boolean).join(' · ') } });
    }
    else if (v.human) return hold(`✋ necesita al usuario: ${(v.feedback || v.reasons.join('; ') || 'lo que falta solo lo puedes hacer tú').slice(0, 400)}`); // devolverla no lo arregla
    else await reject(t.id, v.feedback || v.reasons.join('\n') || 'El revisor automático pide cambios.', [], [], 'auto-qa');
  } catch (e) {
    if (e.quotaWait) { t.reviewWaitQuota = e.quotaWait; reviewNote(t, 'auto', 'skipped', `⏸ revisión en espera de cuota (${e.message})`); return; } // se reintenta sola
    hold(`✋ la revisión automática falló (${e.message}): la revisa una persona`);
  }
  finally { reviewing.delete(t.id); for (const k of ['reviewing', 'reviewStartedAt', 'reviewStep', 'reviewBy']) delete t[k]; changed(); } // reviewLogAgent se queda: el registro sigue consultable
}

// «🔎 Revisar otra vez»: relanza la revisión automática de una tarea que se quedó esperando por un fallo técnico.
export async function reReview(id) {
  const t = get().tasks.find((x) => x.id === id || x.code === String(id).toUpperCase());
  if (!t) throw fail(404, 'Tarea no encontrada');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  const p = get().projects.find((x) => x.id === t.projectId);
  if (review.policyOf(get().settings, p) === 'manual') throw fail(409, 'La revisión de este proyecto es manual');
  delete t.reviewNote; delete t.autoReviews; delete t.conflictRejects; changed(); // lo pide una persona: nuevos intentos de revisión automática
  setImmediate(() => autoReview(p, t).catch(() => {}));
  return { ok: true };
}

// MCP y scripts del catálogo que lleva el agente (los suyos + los de su rol), para la parte estable del prompt.
function toolsPromptBlock(agent, kit) {
  return toolkit.promptBlock(kit || toolkit.kitOf(agent, roleOf(agent.role)));
}

// Al pasar a revisión automática, lo que ya esperaba revisión no se queda atascado: se revisa ahora (de una en una).
export function reviewPending(p) {
  if (review.policyOf(get().settings, p) === 'manual') return;
  const queue = get().tasks.filter((t) => t.projectId === p.id && t.status === 'review' && !t.reviewNote);
  (async () => { for (const t of queue) { try { await autoReview(p, t); } catch { /* queda para la persona */ } } })();
}

// Aviso proactivo: pasados reviewNudgeMin minutos en revisión, evento ReviewPending (una vez por entrada en revisión).
export function reviewNudge(now = Date.now()) {
  const s = get(), min = review.nudgeMin(s.settings);
  let any = false;
  for (const t of s.tasks.filter((x) => x.status === 'review' && x.assignedAgentId !== 'human' && !x.nudged && !x.reviewing)) { // FT-190: lo del humano no es un aviso
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
    // Revisiones que esperaban cuota: al pasar la hora de reinicio se reintentan (si sigue sin cuota, vuelve a esperar)
    for (const t of get().tasks.filter((x) => x.status === 'review' && x.reviewWaitQuota && Date.now() >= x.reviewWaitQuota && !x.reviewing)) {
      delete t.reviewWaitQuota; any = true;
      const p = projectOf(t); if (p) setImmediate(() => autoReview(p, t).catch(() => {}));
    }
    if (any) changed();
  } finally { refreshing = false; }
}
setInterval(refreshReviews, 10_000).unref();

const CONFLICT_MARK = 'Tu rama choca con';
const CONFLICT_MAX = 3; // devoluciones seguidas por el mismo choque antes de dejarla para una persona
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
  if (!r.conflicts.length) delete t.conflictRejects; // al día: el freno anti-bucle vuelve a cero
  if (r.conflicts.length && onConflict === 'reject') {
    // Freno anti-bucle: si el agente ya ha recibido el mismo choque CONFLICT_MAX veces y no lo resuelve (sin permisos, sin
    // saber…), deja de devolverse y espera a una persona (avisa por ReviewPending/Telegram) en vez de girar cada pocos segundos.
    t.conflictRejects = (t.conflictRejects || 0) + 1;
    if (t.conflictRejects > CONFLICT_MAX) {
      t.reviewNote = `✋ no consigue resolver el choque con ${x.repo.baseBranch}${where} en ${r.conflicts.slice(0, 3).join(', ')} (${CONFLICT_MAX} intentos): la revisa una persona`;
      reviewNote(t, 'auto', 'skipped', t.reviewNote); changed();
      throw Object.assign(fail(409, t.reviewNote), { conflicts: r.conflicts, held: true });
    }
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
    return (j.files || []).filter((f) => f.type === 'flow' && !isWorktreeCopy(f.path)).map((f) => ({ path: f.path, name: f.name || f.path }));
  } catch (e) { throw fail(502, `No pude listar los flows de flow-test: ${e.message}`); }
}

// ── Planificador ───────────────────────────────────────────────────────────
// FT-50 · Quién hará una tarea (regla única del planificador y de la tarjeta): el agente fijado con «Asignar a…»
// (`assignedAgentId`), o los del equipo del proyecto cuyo rol es el de la tarea o lo atiende (`handles`); libre antes que
// ocupado. Función pura: `agents` son los agentes de la empresa (se filtran por `project.team`), `roles` el catálogo ya
// cargado (evita releer los .md por tarea) y `isBusy` cómo saber si un agente está ocupado (el planificador mira sus jobs).
export function plannedAgentFor(project, task, agents, { roles = allRoles(), isBusy = (a) => a.status !== 'idle' } = {}) {
  const ids = new Set(project?.team || []);
  if (task.assignedAgentId === HUMAN) return null; // FT-189: asignada al humano, ningún agente la coge
  const fits = (a) => task.assignedAgentId ? a.id === task.assignedAgentId : (a.role === task.role || (roles[a.role]?.handles || []).includes(task.role));
  const candidates = (agents || []).filter((a) => ids.has(a.id) && fits(a));
  return candidates.find((a) => !isBusy(a)) || candidates[0] || null;
}
// Campos calculados para el snapshot (no se persisten): `plannedAgentId` y, si nadie puede hacerla, `plannedReason`.
export function withPlannedAgents(s) {
  const roles = allRoles();
  return s.tasks.map((t) => {
    if (!['backlog', 'todo', 'failed'].includes(t.status)) return t;
    if (t.assignedAgentId === HUMAN) return { ...t, plannedAgentId: null, plannedReason: null }; // FT-189: no es «sin agente»
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

// Épicas: una tarea grande que se mandó al PO para trocear (splitInto = su plan) conoce sus partes (epicParts) y pasa a Hecho
// cuando todas están Hechas o Descartadas. Para planes anteriores sin planChildren, sus partes son las que creó el PO al terminar.
export function syncEpics() {
  const s = get();
  let dirty = false;
  for (const t of s.tasks.filter((x) => x.splitInto && ['backlog', 'todo', 'failed'].includes(x.status))) {
    const plan = s.tasks.find((x) => x.id === t.splitInto);
    if (!plan || plan.status !== 'done') continue;
    if (!plan.planChildren) {
      const from = plan.startedAt || plan.createdAt, to = (plan.updatedAt || from) + 3000;
      plan.planChildren = s.tasks.filter((x) => x.projectId === plan.projectId && x.id !== t.id && x.kind !== 'plan' && x.createdAt >= from && x.createdAt <= to).map((x) => x.id);
      dirty = true;
    }
    if (JSON.stringify(t.epicParts) !== JSON.stringify(plan.planChildren)) { t.epicParts = plan.planChildren; dirty = true; }
    const parts = plan.planChildren.map((id) => s.tasks.find((x) => x.id === id)).filter(Boolean);
    if (parts.length && parts.every((x) => ['done', 'discarded'].includes(x.status))) {
      const codes = parts.map((x) => x.code || x.id).join(', ');
      Object.assign(t, { status: 'done', epicDone: Date.now(), summary: t.summary || `🧩 Épica hecha por partes (${plan.code || plan.id}): ${codes}.`, error: null });
      log(null, `🧩 ${t.code || t.id} (épica) pasa a Hecho: terminadas sus ${parts.length} partes (${codes})`);
      reflect(t); dirty = true;
    }
  }
  if (dirty) changed();
}

export function tick() {
  try { syncEpics(); } catch (e) { log(null, `⚠ épicas: ${e.message}`); }
  const s = get();
  if (!suiteOk()) return; // sin flow-test vigente, el equipo no arranca nada
  const roles = allRoles();
  for (const p of s.projects) {
    if (!p.running) continue;
    const team = teamOf(p);
    let slots = (s.settings.maxParallel || 4) - team.filter((a) => jobs.has(a.id)).length;
    if (!(p.repos || []).length && team.some((a) => jobs.has(a.id))) slots = 0; // sin repo: una tarea a la vez sobre la misma carpeta
    const todoAll = s.tasks.filter((t) => t.projectId === p.id && t.status === 'todo' && t.assignedAgentId !== HUMAN); // FT-189
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
      let agent = pref || plannedAgentFor(p, t, team, { roles, isBusy: (a) => jobs.has(a.id) });
      if (!pref && p.coordinator && !t.assignedAgentId) { // FT-154: con coordinador, entre los libres va el de mejor nota en el rol (y las críticas no van a < 50)
        const fits = team.filter((a) => !jobs.has(a.id) && (a.role === t.role || (roles[a.role]?.handles || []).includes(t.role)));
        const pick = coord.pickByScore(t, fits, coordScores());
        if (pick.why && t.scoreNote !== pick.why) { t.scoreNote = pick.why; coordNote(p, { type: 'dispatch', why: pick.why, auto: true }); }
        if (fits.length) agent = pick.agent;
      }
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
    coordinate(p);
    supervise(p).catch(() => {}); // FT-122
  }
  runSchedules();
}
setInterval(tick, 1500).unref();

// ── ⏰ Tareas programadas y 🪝 webhook entrante ─────────────────────────────────────────────────────────────────────
// p.schedules = [{ id, title, description, role, every (min) | at ('HH:MM', cada día) | null (solo webhook), hookToken?,
//                  reviewRequired, enabled, lastRunAt, lastTaskId }]. Solo se crean en proyectos en marcha (las de webhook,
// siempre). Sin acumular: si la tarea anterior de esa programación sigue pendiente, esta vuelta se salta.
const SCHED_EVERY = 30_000;
let schedAt = 0;
const pendingStatus = ['backlog', 'todo', 'doing', 'review'];
function scheduleDue(sch, now) {
  if (!sch.enabled) return false;
  if (sch.every > 0) return now - (sch.lastRunAt || 0) >= sch.every * 60_000;
  if (/^\d{1,2}:\d{2}$/.test(sch.at || '')) {
    const [h, m] = sch.at.split(':').map(Number);
    const today = new Date(now); today.setHours(h, m, 0, 0);
    return now >= today.getTime() && (sch.lastRunAt || 0) < today.getTime();
  }
  return false;
}
const fmtFecha = (ms) => new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function fireSchedule(p, sch, { origin = 'programada', extra = '' } = {}) {
  const prev = sch.lastTaskId && get().tasks.find((t) => t.id === sch.lastTaskId);
  if (prev && pendingStatus.includes(prev.status)) { sch.lastRunAt = Date.now(); return { skipped: `${prev.code || prev.id} sigue pendiente` }; }
  const t = createTask({ projectId: p.id, title: `${sch.title} · ${fmtFecha(Date.now())}`, role: sch.role, reviewRequired: !!sch.reviewRequired, autoApprove: !!sch.autoApprove && !sch.reviewRequired, sizeChecked: true,
    description: `${sch.description || ''}\n\n_(Tarea ${origin} «${sch.title}»${sch.every ? `, cada ${sch.every} min` : sch.at ? `, cada día a las ${sch.at}` : ''}.)_${extra ? `\n\nDatos del aviso que la lanzó:\n\`\`\`\n${extra}\n\`\`\`` : ''}` });
  Object.assign(sch, { lastRunAt: Date.now(), lastTaskId: t.id });
  log(null, `⏰ ${p.name}: ${origin} «${sch.title}» → ${t.code || t.id}`);
  changed();
  return { task: t.code || t.id };
}
function runSchedules() {
  const now = Date.now();
  if (now - schedAt < SCHED_EVERY) return;
  schedAt = now;
  for (const p of get().projects) if (p.running) for (const sch of p.schedules || []) if (scheduleDue(sch, now)) {
    if (sch.check) { runCheck(p, sch); continue; }
    try { fireSchedule(p, sch); } catch (e) { log(null, `⚠ Programada «${sch.title}»: ${e.message}`); }
  }
}
// Script de comprobación (sin IA): se ejecuta en la carpeta del proyecto (o su repo). Código 0 = sin novedad (solo se apunta);
// 2 = hay que actuar → se crea la tarea con su salida como datos del aviso; otro = error (se apunta y se reintenta en la siguiente).
const checking = new Set();
function runCheck(p, sch) {
  if (checking.has(sch.id)) return;
  checking.add(sch.id);
  sch.lastRunAt = Date.now();
  const cwd = projectDir(p) || p.repos?.[0]?.path || os.homedir();
  const ch = spawn('sh', ['-c', sch.check], { cwd, env: { ...process.env, AO_PROJECT: p.name }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let out = '';
  ch.stdout.on('data', (d) => { out += d; if (out.length > 20_000) out = out.slice(-20_000); });
  ch.stderr.on('data', (d) => { out += d; if (out.length > 20_000) out = out.slice(-20_000); });
  ch.on('close', (code) => {
    checking.delete(sch.id);
    sch.lastCheck = { at: Date.now(), code, out: out.slice(-1500) };
    if (code === 2) { try { fireSchedule(p, sch, { origin: 'lanzada por su comprobación', extra: out.slice(-4000) }); } catch (e) { log(null, `⚠ Programada «${sch.title}»: ${e.message}`); } }
    else if (code !== 0) log(null, `⚠ Comprobación de «${sch.title}» falló (código ${code}): ${out.split('\n').filter(Boolean).slice(-1)[0] || ''}`);
    changed();
  });
  ch.on('error', (e) => { checking.delete(sch.id); sch.lastCheck = { at: Date.now(), code: -1, out: e.message }; changed(); });
}
const cleanSchedule = (b, prev = {}) => {
  const every = Number(b.every) > 0 ? Math.max(5, Math.min(60 * 24 * 31, Math.round(Number(b.every)))) : null;
  const at = /^\d{1,2}:\d{2}$/.test(String(b.at || '')) ? String(b.at) : null;
  return { ...prev, title: String(b.title ?? prev.title ?? '').trim().slice(0, 120), description: String(b.description ?? prev.description ?? '').slice(0, 8000),
    role: b.role ?? prev.role, every: b.every !== undefined || b.at !== undefined ? every : prev.every ?? null, at: b.every !== undefined || b.at !== undefined ? (every ? null : at) : prev.at ?? null,
    reviewRequired: b.reviewRequired !== undefined ? !!b.reviewRequired : !!prev.reviewRequired, enabled: b.enabled !== undefined ? !!b.enabled : prev.enabled ?? true,
    check: b.check !== undefined ? (String(b.check || '').trim().slice(0, 500) || null) : prev.check ?? null,
    autoApprove: b.autoApprove !== undefined ? !!b.autoApprove : !!prev.autoApprove };
};
export function listSchedules(projectId) { return findOr404(get().projects, projectId, 'Proyecto').schedules || []; }
export function saveSchedule(projectId, b, sid = null) {
  const p = findOr404(get().projects, projectId, 'Proyecto');
  p.schedules ||= [];
  const prev = sid ? p.schedules.find((x) => x.id === sid) : null;
  if (sid && !prev) throw fail(404, 'Programación no encontrada');
  const sch = cleanSchedule(b, prev || { id: newId(), createdAt: Date.now() });
  if (!sch.title) throw fail(400, 'Falta el título');
  if (!roleOf(sch.role)) throw fail(400, 'Rol desconocido');
  if (b.webhook === true && !sch.hookToken) sch.hookToken = crypto.randomBytes(18).toString('base64url');
  if (b.webhook === false) delete sch.hookToken;
  if (!sch.every && !sch.at && !sch.hookToken) throw fail(400, 'Elige una frecuencia (cada N minutos o a una hora) o activa el webhook');
  if (prev) Object.assign(prev, sch); else p.schedules.push(sch);
  changed();
  return prev || sch;
}
export function deleteSchedule(projectId, sid) { const p = findOr404(get().projects, projectId, 'Proyecto'); p.schedules = (p.schedules || []).filter((x) => x.id !== sid); changed(); return { ok: true }; }
export function runScheduleNow(projectId, sid) {
  const p = findOr404(get().projects, projectId, 'Proyecto');
  const sch = (p.schedules || []).find((x) => x.id === sid);
  if (!sch) throw fail(404, 'Programación no encontrada');
  if (sch.check) { runCheck(p, sch); return { checking: true }; }
  const r = fireSchedule(p, sch, { origin: 'lanzada a mano' }); tick(); return r;
}
// ── ⇄ Mover / copiar entre proyectos ───────────────────────────────────────────────────────────────────────────────────
// Tareas: solo las que no han empezado (Backlog, Por hacer, Descartada): las demás tienen rama/worktree en los repos de su
// proyecto. Código nuevo con el prefijo del destino; se sueltan dependencias, repo, asignación y enlace al tablero que no
// existan allí. Programadas y agentes: mover o copiar.
const otherProject = (fromId, toId) => {
  const s = get();
  const to = findOr404(s.projects, toId, 'Proyecto de destino');
  if (fromId === to.id) throw fail(400, 'Ya está en ese proyecto');
  return to;
};
export function moveTask(id, toProjectId) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (!['backlog', 'todo', 'discarded'].includes(t.status) || t.agentId || t.branch) throw fail(409, 'Solo se mueven tareas que no han empezado (Backlog, Por hacer o Descartada)');
  const from = projectOf(t), to = otherProject(t.projectId, toProjectId);
  const notes = [];
  const oldCode = t.code;
  if (t.repo && !(to.repos || []).some((r) => r.key === t.repo)) { notes.push(`repo «${t.repo}» (no está en ${to.name})`); t.repo = null; }
  if (t.assignedAgentId && t.assignedAgentId !== HUMAN && !(to.team || []).includes(t.assignedAgentId)) { notes.push('asignación (el agente no está fichado allí)'); delete t.assignedAgentId; }
  const deps = (t.dependsOn || []).filter((d) => s.tasks.find((x) => x.id === d)?.projectId === to.id);
  if (deps.length !== (t.dependsOn || []).length) notes.push(`${(t.dependsOn || []).length - deps.length} dependencia(s)`);
  t.dependsOn = deps;
  for (const o of s.tasks) if (o !== t && o.projectId === t.projectId && o.dependsOn?.includes(t.id)) { o.dependsOn = o.dependsOn.filter((d) => d !== t.id); notes.push(`dependencia de ${o.code || o.id}`); }
  if (t.source?.kind && from?.board?.kind === t.source.kind) { notes.push('enlace al tablero online'); delete t.source; }
  if (t.fromPlan && s.tasks.find((x) => x.id === t.fromPlan)?.projectId !== to.id) delete t.fromPlan;
  t.title = codes.stripCode(t.title, oldCode) || t.title;
  t.projectId = to.id;
  t.code = null;
  codes.assignCode(s.tasks, to, t);
  t.movedFrom = { projectId: from?.id || null, code: oldCode, at: Date.now() };
  t.updatedAt = Date.now();
  log(null, `⇄ ${oldCode || t.id} → ${to.name} como ${t.code}${notes.length ? ` (sin ${notes.join(', ')})` : ''}`);
  changed(); tick();
  return { task: t, dropped: notes };
}

export function moveSchedule(projectId, sid, toProjectId, { copy = false } = {}) {
  const from = findOr404(get().projects, projectId, 'Proyecto');
  const sch = (from.schedules || []).find((x) => x.id === sid);
  if (!sch) throw fail(404, 'Programación no encontrada');
  const to = otherProject(from.id, toProjectId);
  to.schedules ||= [];
  let out;
  if (copy) { // copia desactivada (que no se lance dos veces) y sin el webhook (su token es la credencial de la original)
    out = { ...structuredClone(sch), id: newId(), createdAt: Date.now(), enabled: false, lastRun: undefined, lastTaskId: undefined, lastCheck: undefined };
    delete out.hookToken;
    to.schedules.push(out);
  } else {
    from.schedules = from.schedules.filter((x) => x.id !== sid);
    to.schedules.push(sch);
    out = sch;
  }
  log(null, `⇄ Programada «${sch.title}» ${copy ? 'copiada' : 'movida'} a ${to.name}${copy ? ' (desactivada)' : ''}`);
  changed();
  return out;
}

export function moveAgent(id, fromProjectId, toProjectId, { copy = false, name = '' } = {}) {
  const s = get();
  const a = findOr404(s.agents, id, 'Agente');
  const from = fromProjectId ? findOr404(s.projects, fromProjectId, 'Proyecto') : null;
  const to = otherProject(from?.id, toProjectId);
  if (!copy && (to.team || []).includes(a.id)) throw fail(409, `${a.name} ya está fichado en ${to.name}`);
  if ((to.team || []).length >= coord.MAX_DESKS) throw fail(400, `${to.name} no tiene mesas libres (${coord.MAX_DESKS})`);
  if (copy) { // agente nuevo con la misma configuración (rol, motor, modelo, MCP, skills, scripts…), sin su estado ni historial;
    // 🪪 es un clon: misma identidad (uid, nombre de nacimiento y muñeco) y mismos bautizos
    const clone = { ...newAgent({ name: (name || `${a.name} (copia)`).trim(), role: a.role, engine: a.engine, model: a.model, identity: a.identity, baptisms: a.baptisms }) };
    for (const k of ['ponytail', 'mcps', 'scripts', 'skills']) if (a[k] !== undefined) clone[k] = structuredClone(a[k]);
    s.agents.push(clone);
    to.team.push(clone.id);
    log(clone.id, `⇄ Copia de ${a.name} fichada en ${to.name}`);
    changed(); tick();
    return clone;
  }
  if (a.status && a.status !== 'idle') throw fail(409, `${a.name} está trabajando: espera a que acabe o páralo`);
  if (from) from.team = from.team.filter((x) => x !== a.id);
  to.team.push(a.id);
  for (const t of s.tasks) if (from && t.projectId === from.id && t.assignedAgentId === a.id && !['done', 'discarded'].includes(t.status) && !t.agentId) delete t.assignedAgentId; // sus tareas fijas de allí vuelven a la regla del rol
  log(a.id, `⇄ ${a.name} pasa de ${from?.name || 'el banquillo'} a ${to.name}`);
  changed(); tick();
  return a;
}

// POST /api/hooks/<token> (sin x-ao-token: el token de la URL es la credencial). El cuerpo (p. ej. el aviso de un monitor de
// flow-test con sus reglas y variables) va en la descripción de la tarea.
export function fireHook(token, body) {
  if (!token || token.length < 16) throw fail(404, 'Webhook desconocido');
  for (const p of get().projects) for (const sch of p.schedules || []) {
    if (!sch.hookToken || sch.hookToken.length !== token.length || !crypto.timingSafeEqual(Buffer.from(sch.hookToken), Buffer.from(token))) continue;
    if (!sch.enabled) return { skipped: 'programación desactivada' };
    const extra = typeof body === 'string' ? body : JSON.stringify(body ?? {}, null, 2);
    const r = fireSchedule(p, sch, { origin: 'lanzada por webhook', extra: extra.slice(0, 4000) }); tick(); return r;
  }
  throw fail(404, 'Webhook desconocido');
}

// ── 🧑‍✈️ Coordinador del equipo (server/coordinator.js decide; aquí se aplica o se sugiere) ──────────────────────────────
const COORD_EVERY = 2 * 60_000, COORD_COOLDOWN = 10 * 60_000;
const busySeen = new Map(); // agente → última vez visto trabajando (o la primera vez visto, tras arrancar)
const FREE_NAMES = ['Alba', 'Bruno', 'Celia', 'Dani', 'Eva', 'Fran', 'Gala', 'Hugo', 'Inés', 'Jon', 'Lara', 'Marco', 'Nerea', 'Omar', 'Pau', 'Rita', 'Saúl', 'Tea', 'Unai', 'Vega', 'Yago', 'Zoe'];
const freeName = () => FREE_NAMES.find((n) => !get().agents.some((a) => a.name === n)) || `Agente ${get().agents.length + 1}`;
function coordSnapshot(p) {
  const s = get(), team = teamOf(p), now = Date.now();
  for (const a of team) if (jobs.has(a.id) || !busySeen.has(a.id)) busySeen.set(a.id, now);
  const st = cachedEnginesStatus();
  const engineOk = Object.fromEntries(['claude', 'codex'].map((e) => [e, (st ? !!st[e]?.loggedIn : e === 'claude') && !quota.gate(e).block]));
  const onTeam = new Set(s.projects.flatMap((x) => x.team || []));
  return { team, bench: s.agents.filter((a) => !onTeam.has(a.id)), tasks: s.tasks.filter((t) => t.projectId === p.id), roles: allRoles(), engineOk, repos: p.repos || [],
    reviewPolicy: review.policyOf(s.settings, p), reviewNudgeMin: review.nudgeMin(s.settings),
    busy: new Set(team.filter((a) => jobs.has(a.id)).map((a) => a.id)), idleSince: Object.fromEntries(team.map((a) => [a.id, busySeen.get(a.id)])), now,
    margin: { claude: quota.margin('claude'), codex: quota.margin('codex') }, scores: coordScores() };
}
const coordActions = (snap) => [...coord.plan(snap), ...coord.reviewPlan(snap), ...coord.scorePlan(snap)];
// FT-154 · notas de los agentes para el coordinador, en caché 60 s (el cálculo recorre todo el histórico)
let scoreMemo = { at: 0, v: null };
function coordScores() {
  if (Date.now() - scoreMemo.at > 60_000) {
    try { scoreMemo = { at: Date.now(), v: forCoordinator(get(), { estimates: costEstimates(), events: events.list({}) }) }; } catch { scoreMemo = { at: Date.now(), v: null }; }
  }
  return scoreMemo.v;
}
export const resetCoordScores = () => { scoreMemo = { at: 0, v: null }; };
function coordNote(p, entry) {
  (p.coordLog ||= []).push({ at: Date.now(), ...entry });
  p.coordLog = p.coordLog.slice(-30);
  log(null, `🧑‍✈️ ${p.name}: ${entry.why}`);
  events.emit('TeamAdjusted', { projectId: p.id }, entry);
}
// Aplica las acciones del plan (sin pasar por setTeam/hire, que llamarían a tick() desde dentro de tick()).
export function applyCoordination(p, actions) {
  const s = get();
  for (const x of actions) {
    const a = x.agentId && s.agents.find((y) => y.id === x.agentId);
    const rt = x.taskId && s.tasks.find((y) => y.id === x.taskId);
    if (x.type === 'engine' && a) a.engine = 'auto';
    else if (x.type === 'retarget' && a) { a.homeRole ||= a.role; a.role = x.role; } // FT-121: prestado a otro rol del mismo kind
    else if (x.type === 'restore' && a) { a.role = a.homeRole; delete a.homeRole; }
    else if (x.type === 'review-now' && rt?.status === 'review') { rt.blockKicked = true; setImmediate(() => autoReview(p, rt).catch(() => {})); }
    else if (x.type === 'review-alert' && rt?.status === 'review') {
      rt.blockAlerted = true;
      events.emit('ReviewBlocking', events.ctxOf(rt), { taskCode: rt.code || rt.id, minutes: x.minutes, blocks: x.blocks, required: !!x.required });
    }
    else if (x.type === 'model') { // FT-154: cambia el modelo de los agentes del rol
      const ags = s.agents.filter((y) => (x.agentIds || []).includes(y.id));
      if (!ags.length) continue;
      for (const y of ags) y.model = x.model;
    }
    else if (x.type === 'reviewer' && a) a.autoReviewer = true; // FT-154: revisor automático propuesto de su rol
    else if (x.type === 'bench' && a) p.team = p.team.filter((id) => id !== a.id);
    else if (x.type === 'sign' && a && p.team.length < coord.MAX_DESKS && !p.team.includes(a.id)) p.team.push(a.id);
    else if (x.type === 'hire' && p.team.length < coord.MAX_DESKS) {
      const rm = roleOf(x.role)?.model || '';
      const fits = rm && (x.engine === 'claude' ? MODEL_OF.claude.test(rm) : !MODEL_OF.claude.test(rm)); // el modelo del rol solo si es de ese motor
      const agent = newAgent({ name: freeName(), role: x.role, engine: x.engine, model: fits ? rm : (x.engine === 'claude' ? 'sonnet' : '') });
      s.agents.push(agent); p.team.push(agent.id);
      x.why += ` (${agent.name})`;
    } else continue;
    coordNote(p, { type: x.type, why: x.why, auto: true });
  }
  delete p.coordSuggest;
  changed();
}
function coordinate(p) {
  if (!['suggest', 'auto'].includes(p.coordinator)) return;
  const now = Date.now();
  if (now - (p.coordCheckAt || 0) < COORD_EVERY) return;
  p.coordCheckAt = now;
  const snap = coordSnapshot(p);
  const actions = coordActions(snap);
  const staffing = actions.some((x) => ['sign', 'hire', 'bench'].includes(x.type));
  if (staffing && now - (p.coordAt || 0) < COORD_COOLDOWN) return; // un cambio de plantilla cada 10 min como mucho
  if (!actions.length) { if (p.coordSuggest) { delete p.coordSuggest; changed(); } return; }
  if (p.coordinator === 'suggest') {
    const alerts = actions.filter((x) => x.type === 'review-alert'); // los avisos de bloqueo no son una propuesta: salen siempre
    if (alerts.length) applyCoordination(p, alerts);
    actions.splice(0, actions.length, ...actions.filter((x) => x.type !== 'review-alert'));
    if (!actions.length) return;
    const sig = actions.map((x) => x.why).join('|');
    if ((p.coordSuggest || []).map((x) => x.why).join('|') !== sig) { p.coordSuggest = actions.map((x) => ({ ...x, at: now })); log(null, `🧑‍✈️ ${p.name} (sugerencia): ${actions.map((x) => x.why).join(' · ')}`); changed(); }
    return;
  }
  // FT-154: lo que cambia la plantilla por nota (advisory) solo se sugiere, salvo delegación (p.supervisorApproves)
  const hold = p.supervisorApproves ? [] : actions.filter((x) => x.advisory);
  const run = actions.filter((x) => !hold.includes(x));
  if (run.some((x) => ['sign', 'hire', 'bench'].includes(x.type))) p.coordAt = now;
  if (run.length) applyCoordination(p, run);
  const sig = hold.map((x) => x.why).join('|');
  if (!hold.length) { if (p.coordSuggest && run.length) { delete p.coordSuggest; changed(); } return; }
  if ((p.coordSuggest || []).map((x) => x.why).join('|') !== sig) { p.coordSuggest = hold.map((x) => ({ ...x, at: now })); log(null, `🧑‍✈️ ${p.name} (sugerencia): ${hold.map((x) => x.why).join(' · ')}`); changed(); }
}
// «Aplicar» una sugerencia (Para ti) o forzar una pasada ahora.
export function coordinateNow(projectId) {
  const p = findOr404(get().projects, projectId, 'Proyecto');
  const snap = p.coordSuggest?.length ? null : coordSnapshot(p);
  const actions = p.coordSuggest?.length ? p.coordSuggest : coordActions(snap);
  if (actions.length) { p.coordAt = Date.now(); applyCoordination(p, actions); tick(); }
  return { applied: actions.map((x) => x.why) };
}

// ── 🧑‍⚖️ Coordinador / Supervisor de serie (FT-122): rol 'coordinador' (kind 'supervisor') en el equipo de cada proyecto nuevo ──────
// Con él en la mesa, cada ~30 s (AO_SUPERVISOR_MS): pone al día las ramas en revisión, ejecuta sus checks y decide (supervisor.decide);
// recorta dependencias que sobran (supervisor.trimDeps) y aplica los retarget/restore del coordinador. Aprobar y recortar solo con
// p.supervisorApproves (delegación); sin ella deja la recomendación en t.supervisor y avisa. Nunca edita código.
const SUP_EVERY = Number(process.env.AO_SUPERVISOR_MS) || sup.SUPERVISE_EVERY_MS;
const supervising = new Set();
export const supervisorOf = (p) => teamOf(p).find((a) => roleOf(a.role)?.kind === 'supervisor') || null;
function addSupervisor(p, { strict = false } = {}) {
  const s = get();
  if (supervisorOf(p)) return supervisorOf(p); // FT-127: nunca más de uno por proyecto
  if (p.team.length >= coord.MAX_DESKS) { if (strict) throw fail(409, 'sin mesa libre: manda a alguien al banquillo'); return; }
  // FT-127: antes de crear otro, se reutiliza un Coordi libre del banquillo (en ningún equipo, sin tarea y sin historial)
  const inTeam = new Set(s.projects.flatMap((x) => x.team || []));
  const free = s.agents.find((x) => roleOf(x.role)?.kind === 'supervisor' && !inTeam.has(x.id) && !x.taskId && !s.tasks.some((t) => t.agentId === x.id));
  if (free) { p.team.push(free.id); return free; }
  const a = newAgent({ name: s.agents.some((x) => x.name === 'Coordi') ? freeName() : 'Coordi', role: 'coordinador', engine: 'auto' });
  s.agents.push(a); p.team.push(a.id);
  return a;
}
// FT-122 · «Añadir coordinador» en proyectos que ya existían (POST /api/projects/:id/supervisor)
export function addSupervisorTo(projectId) {
  const p = findOr404(get().projects, projectId, 'Proyecto');
  if (supervisorOf(p)) throw fail(409, 'El proyecto ya tiene coordinador');
  const a = addSupervisor(p, { strict: true });
  changed();
  return { ok: true, agentId: a.id };
}
function supNote(p, t, entry) {
  t.supervisor = { at: Date.now(), sig: t.updatedAt, deleg: !!p.supervisorApproves, ...entry };
  reviewNote(t, 'coordinador', entry.action === 'approve' ? 'approved' : entry.action === 'reject' ? 'rejected' : 'skipped', entry.text);
  log(null, `🧑‍⚖️ ${t.code || t.id}: ${entry.text}`);
  events.emit('SupervisorDecision', events.ctxOf(t), { taskCode: t.code || t.id, action: entry.action, text: entry.text });
}
async function superviseTask(p, t) {
  const s = get(), repo = repoOfTask(p, t), delegated = !!p.supervisorApproves;
  for (const x of taskRepos(p, t)) { // rama al día con la base; un choque de verdad vuelve al agente (FT-19)
    try { await syncWithBase(p, x, t, { onConflict: 'reject' }); } catch (e) { if (e.conflicts) return; throw e; }
  }
  if (t.status !== 'review') return;
  const checks = review.declaredChecks(t);
  const dirOk = t.branch && fs.existsSync(git.worktreeDir(p, t));
  const cwd = dirOk ? git.worktreeDir(p, t) : (repo?.path || store.DATA_DIR);
  let patch = '';
  if (t.branch && repo) { try { patch = (await git.diff(repo, t)).slice(0, 200_000); } catch { /* sin diff */ } } // diff acotado
  const files = patch ? [...patch.matchAll(BASE_FILES)].map((m) => m[1]) : [...String(t.diffStat || '').matchAll(/^\s*(\S+)\s+\|/gm)].map((m) => m[1]);
  const sensitive = review.sensitiveHits(files, patch, review.sensitiveList(s.settings));
  const res = checks.length ? await runChecks(cwd, checks) : null;
  const big = sup.changedLines(patch) > sup.BIG_DIFF_LINES;
  const underCap = (p.supervisorUsd || 0) < (Number(s.settings.supervisorMaxUsd) > 0 ? Number(s.settings.supervisorMaxUsd) : 1);
  const ask = async () => { // revisor de modelo barato sobre el diff acotado, con tope de gasto propio por proyecto
    const before = t.costUsd || 0;
    const v = await runReviewer(p, t, repo, cwd, checks).catch(() => null);
    p.supervisorUsd = (p.supervisorUsd || 0) + Math.max(0, (t.costUsd || 0) - before);
    return v;
  };
  let d = res ? sup.decide({ checks: res, sensitive, delegated, reviewRequired: t.reviewRequired }) : { action: 'skip', text: 'sin verificaciones declaradas' };
  // Con checks verdes y delegación, un diff grande no se aprueba solo por los checks: el revisor también tiene que aprobar
  const needReviewer = res ? (d.action === 'approve' && big) : true;
  if (needReviewer && d.action !== 'reject') {
    if (!underCap) d = { action: 'skip', text: 'tope de gasto del supervisor alcanzado: la revisa una persona' };
    else {
      const v = await ask();
      if (!v) d = { action: 'skip', text: 'el revisor no devolvió veredicto' };
      else if (!v.approve) d = { action: 'reject', text: v.feedback || v.reasons.join('\n') || 'El supervisor pide cambios.' };
      else if (!res) d = sup.decide({ checks: { ok: true }, sensitive, delegated, reviewRequired: t.reviewRequired });
    }
  }
  if (t.status !== 'review') return; // una persona decidió mientras tanto
  if (d.action === 'skip') { t.supervisor = { at: Date.now(), sig: t.updatedAt, deleg: delegated, action: 'skip', text: d.text }; return; }
  supNote(p, t, d);
  if (d.action === 'approve') await approve(t.id, { by: 'coordinador', verdict: { approve: true, text: d.text }, rating: d.rating, reasons: d.reasons });
  else if (d.action === 'reject') await reject(t.id, d.text, [], [], 'coordinador', { rating: d.rating, reasons: d.reasons });
}
async function superviseDeps(p) {
  const tasks = get().tasks.filter((t) => t.projectId === p.id), roles = allRoles();
  const kindOf = (t) => roles[t.role]?.kind || 'dev';
  for (const pr of sup.trimDeps(tasks, kindOf)) {
    const t = tasks.find((x) => x.id === pr.taskId);
    if (p.supervisorApproves && pr.auto) { // solo si la bloqueante falló; en revisión nunca se auto-aplica
      updateTask(t.id, { dependsOn: t.dependsOn.filter((d) => !pr.drop.includes(d)) });
      t.depsKept = true;
      delete t.depProposal;
      coordNote(p, { type: 'deps', why: `🧑‍⚖️ ${pr.why}: dependencia quitada`, auto: true });
    } else if (t.depProposal?.why !== pr.why) {
      t.depProposal = { ...pr, at: Date.now() };
      coordNote(p, { type: 'deps-proposal', why: `🧑‍⚖️ propuesta: ${pr.why} (decide tú en Ajustes del proyecto: Quitar / Mantener)`, auto: false });
    }
  }
}
// Una persona resuelve la propuesta: quitar la dependencia o mantenerla (t.depsKept: el supervisor no vuelve a proponerla)
export function resolveDepProposal(id, { accept = false } = {}) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (!t.depProposal) throw fail(409, 'La tarea no tiene propuesta de dependencias');
  if (accept) updateTask(t.id, { dependsOn: t.dependsOn.filter((d) => !t.depProposal.drop.includes(d)) });
  t.depsKept = true; delete t.depProposal;
  changed(); tick();
  return { ok: true };
}
export async function supervise(p, { force = false } = {}) {
  if (!supervisorOf(p) || supervising.has(p.id)) return;
  const now = Date.now();
  if (!force && now - (p.supAt || 0) < SUP_EVERY) return;
  p.supAt = now; supervising.add(p.id);
  try {
    const rt = coord.plan(coordSnapshot(p)).filter((x) => ['retarget', 'restore'].includes(x.type)); // reglas de reasignación (FT-121)
    if (rt.length) applyCoordination(p, rt);
    await superviseDeps(p); // antes de revisar: una dependencia que sobra se quita mientras la bloqueante aún está en revisión
    for (const t of get().tasks.filter((x) => x.projectId === p.id && x.status === 'review' && x.kind !== 'plan' && !x.budgetHit && !x.stuck && !x.reviewing && !reviewing.has(x.id))) {
      const last = t.supervisor;
      if (last && last.sig === t.updatedAt && last.deleg === !!p.supervisorApproves) continue; // ya decidida y nada ha cambiado
      try { await superviseTask(p, t); } catch (e) { log(null, `🧑‍⚖️ ${t.code || t.id}: el supervisor no pudo revisarla (${e.message})`); }
    }
    changed();
  } finally { supervising.delete(p.id); }
}

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

// FT-134: ¿el resumen final promete un aviso futuro / segundo plano? ¿y hay algo entregado (diff en algún repo)?
// Solo si PROMETE un aviso o una espera futura («cuando termine» a secas es corriente y no cuenta).
export const waitsForNotice = (txt) => /\b(me|te|os) avis(ar[aáeé]\w*|o)\b|(sigue|siguen|corre|queda|lanc[eé]|lo dej[eé])[^.\n]{0,60}en segundo plano|will notify|notify me|running in the background/i.test(String(txt || ''));
// Entregable: diff en algún repo, o una ruta absoluta citada en el resumen (informes fuera del repo) modificada durante este intento.
const hasDeliverable = (t) => {
  if (t.diffStat || Object.values(t.repos || {}).some((r) => r?.diffStat)) return true;
  for (const m of String(t.summary || '').matchAll(/(?:^|[\s`'"(])((?:~|\/)[\w.\-\/~ñáéíóúÑ]*\w\.\w+)/g)) {
    try { if (fs.statSync(m[1].replace(/^~/, os.homedir())).mtimeMs > (t.startedAt || 0)) return true; } catch { /* no existe */ }
  }
  return false;
};

// Cómo preguntar al cliente desde la tarea (bin/ao-ask.mjs espera la respuesta y la imprime) + lo ya respondido.
const askRules = () => [
    '',
    'PREGUNTAR AL CLIENTE: si una decisión es suya (no se resuelve leyendo el código ni el documento: reglas de negocio, nombres que verá el usuario, qué opción prefiere), pregunta ANTES de implementar con:',
    `  node ${path.join(store.ROOT, 'bin', 'ao-ask.mjs')} "¿Pregunta cerrada?" --opt "Opción A" --opt "Opción B" [--context "qué cambia con cada opción"]`,
    'El comando se queda esperando (puede tardar minutos) e imprime la respuesta elegida o escrita; úsala y sigue. Una pregunta cada vez, máximo 3 por tarea, con opciones concretas. Si imprime «SIN RESPUESTA», decide tú con el criterio más conservador y déjalo bien visible en el resumen final.',
    'SEGUNDO PLANO (FT-134): no lances procesos en segundo plano ni esperes avisos (nadie te avisará: al terminar tu turno la sesión se cierra y el proceso muere). Los comandos largos van en primer plano con timeout (hasta 10 min).',
  ].join('\n');
const askAnswers = (t) => { const prev = (t.questions || []).filter((q) => q.answer != null); return prev.length ? `Respuestas del cliente ya dadas en esta tarea (no vuelvas a preguntarlas):\n${prev.map((q) => `- ${q.question} → ${q.answer}`).join('\n')}` : ''; };
const askBlock = (t) => [askRules(), askAnswers(t)].join('\n');

// FT-5: restricciones del cliente (siempre) y mensajes recibidos en la ejecución anterior (si se reencoló).
const clientBlock = (t) => [
  (t.constraints || []).length ? `\nRestricciones del cliente (obligatorias, aplican a todo el trabajo):\n${t.constraints.map((c) => `- ${c.text}`).join('\n')}` : '',
  (t.pendingMessages || []).length ? `\nIndicaciones que el cliente añadió mientras trabajabas (aplícalas):\n${t.pendingMessages.map((m) => `- ${m.text}`).join('\n')}` : '',
].join('');

// 🌿 Rama en vivo de cada repo (checkout principal = donde trabaja el usuario). Las tareas SIEMPRE salen de la base configurada
// (main, develop…); esto solo sirve para que se vea —en la UI y en el prompt— que el usuario está en otra rama.
const repoLive = new Map(); // ruta del repo → { branch, dirty, at }
export const repoLiveOf = (repoPath) => repoLive.get(repoPath) || null;
async function refreshRepoLive() {
  let diff = false;
  for (const r of new Map(get().projects.flatMap((p) => p.repos || []).map((r) => [r.path, r])).values()) {
    try {
      const x = await git.repoLive(r.path), prev = repoLive.get(r.path);
      if (!prev || prev.branch !== x.branch || prev.dirty !== x.dirty) diff = true;
      repoLive.set(r.path, { ...x, at: Date.now() });
    } catch { if (repoLive.delete(r.path)) diff = true; }
  }
  if (diff) changed();
}
setTimeout(() => refreshRepoLive().catch(() => {}), 500).unref?.();
setInterval(() => refreshRepoLive().catch(() => {}), 15_000).unref();
const repoOf = (projectId, key) => { const p = findOr404(get().projects, projectId, 'Proyecto'); const r = (p.repos || []).find((x) => x.key === key); if (!r) throw fail(404, `El proyecto no tiene el repo «${key}»`); return { p, r }; };
export async function repoBranches(projectId, key) { const { r } = repoOf(projectId, key); return { base: r.baseBranch, live: repoLiveOf(r.path), branches: await git.localBranches(r.path) }; }
// Cambiar la base de un repo (a mano): las tareas NUEVAS saldrán de ella y se fusionarán en ella; las empezadas siguen con la suya.
export async function setBaseBranch(projectId, key, branch) {
  const { p, r } = repoOf(projectId, key);
  const b = String(branch || '').trim();
  if (!b || b.startsWith('ao/')) throw fail(400, 'Rama base no válida');
  try { await git.git(r.path, 'rev-parse', '--verify', `refs/heads/${b}`); } catch { throw fail(404, `No existe la rama local «${b}» en ${r.key}`); }
  const prev = r.baseBranch;
  r.baseBranch = b;
  if ((p.repos || [])[0] === r) p.baseBranch = b;
  log(null, `🌿 ${p.name} · ${r.key}: la base de las tareas nuevas pasa de «${prev}» a «${b}»`);
  changed();
  return r;
}
// Línea del prompt: de dónde sale y adónde vuelve la rama del agente, y aviso si el usuario está en otra rama.
export function baseLine(repo, branch, label = '') {
  const lv = repoLiveOf(repo.path);
  const own = `${label}tu rama ${branch} sale de «${repo.baseBranch}» y se fusionará en «${repo.baseBranch}».`;
  return lv && lv.branch !== repo.baseBranch
    ? `${own} OJO: el usuario tiene ahora el checkout principal (${repo.path}) en la rama «${lv.branch}», que NO es tu base: lo que veas allí no es la base; no copies de ahí ni lo tomes como referencia.`
    : own;
}

// FT-44: rutas de trabajo del agente. Una copia aislada (git worktree, rama ao/<código>) por CADA repo del proyecto; escribir en
// los checkouts principales se prohíbe (no tienen rama ni revisión y AgentOffice puede servirlos en caliente).
function worktreesBlock(p, t) {
  if (!t.branch && !repoOfTask(p, t)) return ''; // proyecto sin repo: lo explica la parte estable del prompt
  const xs = taskRepos(p, t);
  if (xs.length < 2) { const r = xs[0]?.repo || repoOfTask(p, t); return `Trabajas en una copia aislada del repo (git worktree) en la rama ${t.branch}. No cambies de rama ni hagas push.${r ? ' ' + baseLine(r, t.branch) : ''}`; }
  return [
    `Trabajas en copias aisladas (git worktree) de los repos del proyecto, todas en la rama ${t.branch}. No cambies de rama ni hagas push.`,
    ...xs.map((x) => `- «${x.key}»${x.main ? ' (tu directorio de trabajo)' : ''}: escribe SOLO en ${x.dir} (checkout principal: ${x.repo.path}, solo para consultar). ${baseLine(x.repo, x.branch || t.branch)}`),
    'PROHIBIDO escribir en los checkouts principales: lo escrito fuera de estos worktrees no se revisa, no se confirma ni se fusiona. Si el trabajo toca otro repo, hazlo en SU worktree de arriba.',
  ].join('\n');
}

function buildPrompt(p, agent, t, kit = null) {
  if (t.kind === 'plan') {
    const roles = teamRoles(p);
    const repos = p.repos || [];
    return [
      // Parte estable primero (briefing y memoria del repo): se lee de caché entre planificaciones del mismo proyecto
      repos[0]?.path ? '\n' + briefingFor(repos[0].path) + '\n' : '',
      repos[0]?.path && get().settings.claudeMemory !== false ? memory.claudePromptBlock(repos[0].path) : '',
      `Objetivo del equipo: ${t.goal}`,
      clientBlock(t),
      '',
      repos.length ? `Repositorios del proyecto (estás en ${repos[0].path}): ${repos.map((r) => `«${r.key}» = ${r.path} (base de las tareas: «${r.baseBranch}»${repoLiveOf(r.path) && repoLiveOf(r.path).branch !== r.baseBranch ? `; el usuario está ahora en «${repoLiveOf(r.path).branch}»` : ''})`).join(' · ')}. Arriba tienes su briefing (estructura, ficheros y documentación): parte de él y lee del código solo lo que necesites para decidir, agrupando las lecturas en pocas órdenes (cada paso reenvía todo el contexto).` : 'No hay repositorio: planifica solo a partir del objetivo.',
      `Divide el objetivo en tareas pequeñas para estos roles: ${roles.join(', ')}.`,
      'Cada tarea debe poder hacerla un agente solo, en una rama aparte, y ser verificable.',
      'Las tareas de QA van al final y dependen de lo que verifican.',
      roles.some((r) => roleOf(r)?.kind === 'docs') ? `Si el objetivo cambia cómo funciona algo o añade una pieza nueva, incluye al final una tarea para el rol de documentación (${roles.filter((r) => roleOf(r)?.kind === 'docs').join('/')}) que lo documente en flow-test (${p.folder && p.folder !== ROOT ? `carpeta «${p.folder}/»` : 'raíz del workspace'}), dependiente de las tareas que documenta.` : '',
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
    p.folder ? `Carpeta del proyecto en el workspace de flow-test: ${p.folder === ROOT ? 'la raíz' : `«${p.folder}/»`} (ahí viven sus flows y su documentación; guarda ahí lo que generes con flow-test).` : '',
    repoOfTask(p, t) ? 'Trabajas en una copia aislada del repo (git worktree), en tu propia rama. No cambies de rama ni hagas push.' : `Este proyecto no tiene repo: trabajas DIRECTAMENTE en su carpeta (${projectDir(p) || p.folder}). Escribe solo dentro de ella, no borres nada que no hayas creado tú y deja todo en un estado coherente al terminar.`,
    'Lo que dejes sin confirmar se confirmará solo al terminar.',
    (() => { const r = repoOfTask(p, t); return r?.path ? '\n' + briefingFor(r.path) + (t.codeIndexOn ? '\n' + codeindex.BRIEFING_LINE : '') + '\n' : ''; })(), // FT-58: aviso del índice de código
    get().settings.claudeMemory !== false ? memory.claudePromptBlock(repoOfTask(p, t)?.path) : '', // índice de la memoria de Claude Code del repo
    toolsPromptBlock(agent, kit), // 🧰 skills, MCP y scripts del catálogo (agente + rol), «úsalas primero»
    get().settings.agentMemory !== false ? memory.promptBlock(p.id, agent.id) : '', // FT-75: lecciones de tareas anteriores
    askRules(),
    economyBlock(t.codeIndexOn),
    ...(ponytail.enabled(get().settings, agent, t.role) ? [ponytail.BLOCK] : []), // FT-86: solo con la opción activa (apagada = prompt idéntico)
    get().settings.agentMemory !== false ? memory.PROMPT_ASK : '',
    t.kind !== 'plan' ? proposals.PROMPT_ASK : '', // 🧰 notas de negocio y scripts nuevos (los apruebas en Herramientas)
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
// Codex SÍ puede verse: bajo el servicio corre sin sandbox (bwrap no arranca en systemd), así que puede levantar servidores y
// capturar (scripts/preview.mjs, Chrome headless); y su herramienta view_image está activa en los roles de desarrollo. Lo que no
// sabe es que en Codex una imagen se mira con view_image (leer el fichero no la muestra): se le dice al final del prompt.
const CODEX_VISION = '\n\nPara MIRAR una imagen o captura (PNG/JPG) usa tu herramienta view_image con la ruta del fichero: leerlo con cat/sed no te la enseña. En trabajo visual: genera la captura (p. ej. `node scripts/preview.mjs /tmp/captura.png`), mírala con view_image, corrige y repite (2-3 vueltas como mucho).';

function economyBlock(codeIndexOn) {
  return [
    '',
    'Gasta pocos tokens (cada fichero que lees se reenvía en todos los pasos siguientes):',
    codeIndexOn ? codeindex.ECONOMY_RULE : '', // FT-58
    '- Ficheros grandes (más de ~400 líneas, p. ej. public/app.js, public/office3d.js, server/team.js, README.md): NUNCA los leas enteros. Localiza con Grep (-n) y lee solo el tramo con Read offset/limit.',
    '- No vuelvas a leer lo que ya leíste; no hagas `cat` de ficheros largos ni de salidas largas: recorta con `| tail -30`, `| head`, `grep`.',
    '- Pruebas: ejecuta el e2e/verificación UNA vez cuando creas que está bien; repite solo si falló. Capturas de pantalla: como mucho 1 (otra solo si la primera muestra un fallo), y solo si la tarea es visual.',
    '- Ve al grano: el briefing del repo ya te da la estructura; no lo explores con ls -R/find/wc.',
    '- Agrupa: cada paso (cada orden o lectura) reenvía TODO el contexto. Junta en UNA orden las lecturas y búsquedas que ya sabes que necesitas (p. ej. `rg -n -C3 "patrón" src/ && sed -n \'40,120p\' a.java && sed -n \'1,60p\' b.ts`) en vez de una por paso, y lee tramos de ~150 líneas, no de 20 en 20.',
    '- Para explorar más de 3 ficheros (entender un módulo, buscar todos los usos de algo), delega en el subagente «explorador» (herramienta Task/Agent, si tu motor la tiene) y trabaja con su resumen; lee tú solo los tramos que vayas a editar.',
    '- Si te acercas al tope de gasto de la tarea, deja el trabajo en un estado coherente y resume qué falta.',
  ].join('\n');
}

// 🚀 «Publicar X.Y.Z»: AgentOffice ejecuta scripts/release/run-all.sh en nombre del agente de Release (sin IA ni tope de
// tiempo de un comando), con cada paso en su registro. Aprobado = publicado; si un paso falla, la tarea queda «Fallida» con su log.
async function runReleasePipeline(p, agent, t, ev) {
  const v = t.releaseVersion, dir = releaseTrigger.flowTestDir(get());
  const sp = releaseTrigger.runAllSpec(v, { releaseDryRun: get().settings.releaseDryRun === true });
  let tail = '';
  try {
    if (!dir) throw new Error('No encuentro flow-test (settings.flowTestDir o un repo llamado flow-test)');
    agent.activity = `🚀 Publicando ${v}${sp.dry ? ' (en seco)' : ''}`; changed();
    log(agent.id, `🚀 scripts/release/run-all.sh ${sp.dry ? '--dry-run ' : ''}${v} en ${dir}`);
    const code = await new Promise((resolve) => {
      const child = spawn('bash', sp.args, { cwd: dir, env: sp.env, stdio: sp.stdio });
      Object.assign(jobs.get(agent.id), { stop: () => child.kill('SIGTERM'), pid: child.pid });
      let buf = '';
      const onData = (d) => {
        tail = (tail + d).slice(-6000); buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (/^\[run-all\]/.test(line) || /❌|✅/.test(line)) { log(agent.id, line); agent.activity = line.replace(/^\[run-all\]\s*/, '').slice(0, 120); events.emit('AgentProgress', ev, { activity: agent.activity }); changed(); }
        }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', (e) => { tail += `\n${e.message}`; resolve(1); });
      child.on('close', (c) => resolve(c ?? 1));
    });
    const last = tail.trim().split('\n').slice(-12).join('\n');
    if (code !== 0) throw new Error(`El pipeline se paró (código ${code}):\n${last}`);
    Object.assign(t, { status: 'done', summary: `🚀 ${v} publicada${sp.dry ? ' (EN SECO: no se publicó nada)' : ''}.\n\n${last}`, doneAt: Date.now() });
    events.emit('AgentCompleted', ev, { status: 'done', summary: t.summary.slice(0, 500) });
    log(agent.id, `✅ ${v} publicada`);
    reflect(t, `🚀 ${v} publicada en todas partes`);
  } catch (e) {
    Object.assign(t, { status: 'failed', error: e.message });
    events.emit('AgentFailed', ev, { error: String(e.message).slice(0, 500) });
    log(agent.id, '❌ ' + String(e.message).split('\n')[0]);
    reflect(t, `❌ La publicación ${v} se paró: ${String(e.message).slice(0, 500)}`);
  } finally {
    jobs.delete(agent.id);
    t.updatedAt = Date.now();
    Object.assign(agent, { status: 'idle', taskId: null, activity: '', activeEngine: null });
    changed();
    tick();
  }
}

async function runTask(p, agent, t) {
  if (t.assignedAgentId === HUMAN) return; // FT-189: red de seguridad
  const s = get();
  jobs.set(agent.id, { stop() {}, taskId: t.id, engine: agent.engine === 'auto' ? null : agent.engine }); // ocupado DESDE YA (antes de cualquier await), o el mismo tick le daría dos tareas
  Object.assign(t, { status: 'doing', agentId: agent.id, error: null, attempts: t.attempts + 1, startedAt: Date.now(), updatedAt: Date.now(), agentName: agent.name }); // FT-152: el nombre sobrevive al agente retirado
  Object.assign(agent, { status: 'working', taskId: t.id, activity: t.kind === 'plan' ? 'Leyendo el objetivo' : 'Preparando su copia del repo' });
  changed();
  log(agent.id, `▶ ${t.code || '#' + t.id} ${t.title}`);
  const ev = events.ctxOf(t, agent);
  events.emit('TaskAssigned', ev, { agentName: agent.name, role: agent.role, attempt: t.attempts });
  events.emit('AgentStarted', ev, { engine: agent.engine, attempt: t.attempts });
  if (t.attempts > 1) events.emit('AgentResumed', ev, { reason: 'retry', attempt: t.attempts });
  reflect(t, `▶ ${agent.name} (${roleOf(agent.role)?.label || agent.role}) empieza a trabajar en AgentOffice`);
  if (t.releaseVersion && roleOf(agent.role)?.kind === 'release') return runReleasePipeline(p, agent, t, ev); // 🚀 sin IA

  let engineId;
  let nativeSkills = []; // 🧰 skills enlazadas en el worktree (Claude con repo); las demás van por ruta
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
  let cwd = repo?.path || projectDir(p) || store.DATA_DIR;
  const outside = {}; // FT-44: `git status` de cada checkout principal antes de empezar (guardarraíl)
  let addDirs = [];

  try {
    if (real && t.kind !== 'plan' && (!repo || t.onMain)) {
      const dir = t.onMain && repo ? repo.path : projectDir(p);
      if (!dir) throw new Error('El proyecto no tiene repositorio git ni carpeta en el workspace de flow-test');
      Object.assign(t, { repo: t.onMain && repo ? repo.key : null, branch: null, folderMode: true });
      cwd = dir;
      if (t.onMain) { // 🚀 documentación de una release: sobre main y los repos de docs; al terminar se commitea solo lo suyo
        addDirs = (t.onMainDirs || []).map((d) => String(d).replace(/^~(?=\/|$)/, os.homedir())).filter((d) => fs.existsSync(d));
        t.onMainBefore = await dirtyMap([cwd, ...addDirs]);
        log(agent.id, `📝 Trabaja sobre main en ${dir}${addDirs.length ? ` (+ ${addDirs.join(', ')})` : ''}`);
      } else log(agent.id, `📁 Sin repo: trabaja directamente en ${dir}`);
    } else if (real && t.kind !== 'plan') {
      t.repo = repo.key;
      const wt = await git.createWorktree(p, repo, t);
      cwd = wt.path;
      try { const lv = await git.repoLive(repo.path); repoLive.set(repo.path, { ...lv, at: Date.now() }); if (lv.branch !== repo.baseBranch) log(agent.id, `🌿 ${repo.key}: tú estás en «${lv.branch}»; ${t.code || t.id} trabaja en ${wt.branch}, que sale de la base «${repo.baseBranch}» (no se mezclan)`); } catch { /* repo sin leer */ }
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
      const memDir = get().settings.claudeMemory !== false && memory.claudePromptBlock(repo.path) ? memory.claudeDir(repo.path) : null;
      if (memDir) addDirs.push(memDir); // el agente puede leer el detalle de la memoria de Claude del repo
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
      if (engineId === 'claude' && t.kind !== 'plan') { const names = toolkit.skillsOf(agent, role).map((x) => x.name); if (names.length) { nativeSkills = linkSkillsInto(cwd, names); if (nativeSkills.length) log(agent.id, `🧩 Skills: ${nativeSkills.join(', ')}`); } }
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
    const kit = toolkit.kitOf(agent, role, { nativeNames: nativeSkills }); // 🧰 lo que lleva en este intento
    kit.business = proposals.notesOf(projectDir(p), kit.skills.map((x) => x.name)); // «cómo se aplica aquí» (<carpeta>/_skills/<skill>.md)
    const kitUse = toolkit.tracker(kit);
    if (kit.skills.some((x) => !x.native)) log(agent.id, `🧩 Skills por ruta: ${kit.skills.filter((x) => !x.native).map((x) => x.name).join(', ')}`);
    const prompt = buildPrompt(p, agent, t, kit) + (engineId === 'codex' && t.kind !== 'plan' && role.kind !== 'docs' ? CODEX_VISION : '');
    t.pendingMessages = []; // ya van en el prompt
    const baseUsage = t.usage || null; // FT-26: consumo de intentos anteriores; t.usage es acumulado y se actualiza en vivo
    agent.usage = null; // sesión nueva
    t.variant = ponytail.variantOf(s.settings, agent, t.role); // FT-86
    const rec = costRecorder({ projectId: t.projectId, taskId: t.id, attempt: t.attempts, engine: engineId, model: model || '', role: t.role, variant: t.variant }); // FT-76
    const cmp = { asked: false, cut: false };
    delete t.stuck;
    // FT-62: detector de atascos. 1.ª señal → aviso en caliente (Claude: stdin; Codex/demo: se reencola la tarea con el aviso);
    // si tras el aviso vuelve a saltar → se corta y va a Revisión. t.stuckWarned sobrevive al reencolado.
    const stuckLimits = { ...stuck.limits(s.settings, engineId), enabled: stuck.limits(s.settings).enabled && t.kind !== 'plan' };
    const probe = t.branch ? async () => `${await git.git(cwd, 'status', '--porcelain')}\n${await git.git(cwd, 'diff', '--stat')}` : null;
    // Roles que trabajan en el navegador (capacidad browser/playwright: conciliar bancos, demos…) no editan ficheros: «sin editar» no es atasco
    const browsing = ['browser', 'playwright'].some((c) => role.tools?.includes(c)) || ['navegante', 'qa-suite', 'office-flowtest'].includes(agent.role);
    const newDetector = () => stuck.createDetector({ limits: stuckLimits, isCode: role.kind === 'dev' && !browsing, probe });
    let detector = newDetector();
    if (pickedModel.model) { // FT-60: historial de modelos de la tarea (la tarjeta enseña «haiku → sonnet»)
      (t.modelHistory ||= []).push({ model: pickedModel.model, engine: engineId, attempt: t.attempts, why: pickedModel.why, at: Date.now() });
      (t.attemptsLog ||= []).push({ attempt: t.attempts, agentId: agent.id, agentName: agent.name, engine: engineId, model: pickedModel.model, startedAt: Date.now() }); // FT-152: quién y con qué modelo hizo CADA intento (la puntuación lo atribuye por entrega)
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
    // MCP y scripts del catálogo asignados (agente + rol): definiciones leídas de la config del usuario en este momento
    const mcpRes = toolcat.resolveMcps(toolcat.assignedMcps(agent, role));
    if (mcpRes.missing.length) log(agent.id, `⚠ MCP asignados que ya no existen en tu config: ${mcpRes.missing.join(', ')}`);
    const scriptList = toolcat.resolveScripts(toolcat.assignedScripts(agent, role));
    const scriptDirs = toolkit.kitDirs(kit, cwd).filter((d) => !addDirs.includes(d)); // carpetas de scripts y de skills no enlazadas
    if (Object.keys(mcpRes.claude).length || mcpRes.codexKeep.length || scriptList.length) log(agent.id, `🔌 ${[...Object.keys(mcpRes.claude), ...mcpRes.codexKeep.filter((n) => !mcpRes.claude[n])].join(', ') || 'sin MCP extra'}${scriptList.length ? ` · 📜 ${scriptList.map((x) => x.name).join(', ')}` : ''}`);
    const job = await engine.start({ // FT-54: el motor local prueba el servidor antes de lanzar
      extraMcp: mcpRes.claude, codexMcp: mcpRes, extraBash: scriptList.flatMap((x) => [toolcat.runnerOf(x.path), x.path]),
      onEvent: (e) => { rec.feed(e); kitUse.feed(e, engineId); },
      agent, task: t, project: p, cwd, mode: t.kind === 'plan' ? 'plan' : 'work', goal: t.goal, roles,
      prompt, addDirs: [...addDirs, ...scriptDirs],
      images: (t.feedbackImages || []).filter((f) => fs.existsSync(f)),
      system: role.system,
      model,
      kind: role.kind, roleId: agent.role, roleTools: role.tools, hasSkills: nativeSkills.length > 0, // FT-59: herramientas acotadas por rol
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
      onUsage: (u) => {
        if (engineId === 'codex' && u.costUsd == null) u = { ...u, costUsd: codexCostUsd(u, model), costEstimated: true }; // Codex no informa el coste: estimación con la tabla de precios (con suscripción es cuota, no factura)
        agent.usage = { ...u, engine: engineId, taskId: t.id }; t.usage = addUsage(baseUsage, u);
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
    toolkit.record(t, kit, kitUse.used); // 🧰 qué se le dio y qué usó (acumulado entre intentos)
    if (res.costUsd == null && agent.usage?.costEstimated) { res.costUsd = agent.usage.costUsd; t.costEstimated = true; } // coste ≈ de este segmento (Codex)
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
      t.stuckCount = (t.stuckCount || 0) + 1; // FT-152: acumulado (t.stuck se limpia al reintentar)
      if (t.attemptsLog?.length) t.attemptsLog[t.attemptsLog.length - 1].cut = 'stuck';
      events.emit('AgentBlocked', ev, { reason: 'stuck', signal: entry.stuck, costUsd: t.costUsd });
    }
    // Tope de gasto alcanzado: NO es un fallo. Lo hecho se confirma y la tarea va a Revisión con el aviso; «Devolver» le da
    // otro intento (con su tope) partiendo de su rama, «Aprobar» si ya vale. Así se para y se pregunta, sin seguir gastando.
    if (res.budgetHit && t.kind !== 'plan') {
      const cap = Number(s.settings.maxTaskUsd) > 0 ? Number(s.settings.maxTaskUsd) : 3, capText = res.capText || `${cap} $`;
      res.ok = true;
      res.summary = `⚠️ TOPE DE GASTO ALCANZADO (${capText} por intento): ${agent.name} se cortó a medias y lo hecho queda en la rama. Revisa: «Devolver» le da otro intento partiendo de aquí; «Aprobar» solo si ya vale.${res.summary ? '\n\n' + res.summary : ''}`;
      t.budgetHit = true;
      t.budgetHitCount = (t.budgetHitCount || 0) + 1; // FT-152
      if (t.attemptsLog?.length) t.attemptsLog[t.attemptsLog.length - 1].cut = 'budget';
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
    if (t.onMain && t.onMainBefore) { // 🚀 commitea en cada repo SOLO lo que cambió el agente (no lo que ya estaba sin commitear)
      const co = await commitOnMain(t, agent); // FT-233: el resultado queda en la tarea (sobrevive a un reinicio)
      for (const line of co.lines) log(agent.id, line);
      t.commits = co.commits;
      delete t.onMainBefore;
      const left = Object.entries(co.left);
      if (t.releaseOf && left.length) { // red de seguridad: Publicar chocaría con el preflight «repo limpio»
        const det = left.map(([r, f]) => `${r} (${f.slice(0, 3).join(', ')}${f.length > 3 ? '…' : ''})`).join('; ');
        throw new Error(`FT-233: tras documentar quedan cambios sin commitear: ${det}. ${co.commits.filter((c) => !c.ok).map((c) => `${c.repo}: ${c.error}`).join('; ')}`.trim());
      }
    }
    if (t.kind !== 'plan' && s.settings.agentMemory !== false) { // FT-75: el bloque «LECCIONES:» del resumen pasa a la memoria
      const h = memory.harvest(p.id, agent.id, t.summary, t.code || t.id);
      t.summary = h.summary;
      if (h.added) log(agent.id, `🧠 ${h.added} lección(es) a la memoria`);
    }
    if (t.kind !== 'plan') { // 🧰 «NEGOCIO <skill>:» y «SCRIPT NUEVO:» → propuestas para aprobar en Herramientas
      const pr = proposals.harvest({ project: p, task: t, agent, summary: t.summary, skillNames: toolkit.skillsOf(agent, role).map((x) => x.name), repoKey: repo?.key || null });
      t.summary = pr.summary;
      if (pr.added.length) log(agent.id, `📥 ${pr.added.length} propuesta(s) para 🧰 Herramientas`);
    }

    if (t.kind === 'plan') {
      const list = res.tasks || parseTasks(res.summary);
      const ids = [];
      for (const item of list.slice(0, 8)) {
        const r = roles.includes(item.role) ? item.role : (roles[0] || 'back');
        const deps = (item.dependsOn || []).map((i) => ids[i]).filter(Boolean);
        const rk = (p.repos || []).some((x) => x.key === item.repo) ? item.repo : null;
        ids.push(createTask({ projectId: p.id, title: item.title, description: item.description, role: r, repo: rk, dependsOn: deps, sizeChecked: true, fromPlan: t.id }).id);
      }
      t.planChildren = ids; // épica: la tarea grande original (splitInto = este plan) se cierra sola cuando estén todas (syncEpics)
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
      if (t.kind === 'work' && !t.nobgRequeued && waitsForNotice(t.summary) && !hasDeliverable(t)) { // FT-134: terminó esperando un aviso y sin entregable → otro intento, sin pasar por Revisión
        t.status = 'todo'; t.error = null; t.agentId = null; t.nobgRequeued = true; // una sola vez por tarea
        t.pendingMessages = [...(t.pendingMessages || []), { text: 'En tu intento anterior terminaste esperando un aviso («me avisará», «en segundo plano») y no entregaste nada: nadie te avisa. Ejecuta los comandos largos en primer plano con timeout (hasta 10 min) y entrega el resultado.', at: Date.now() }];
        events.emit('AgentProgress', ev, { activity: 'Reencolada: terminó esperando un aviso que no llega' });
        log(agent.id, '↻ Terminó esperando un aviso en segundo plano y sin entregable: vuelve a Por hacer (FT-134)');
        return;
      }
      if (t.nobgRequeued && waitsForNotice(t.summary) && !hasDeliverable(t)) t.summary = `⚠️ terminó esperando un aviso dos veces (FT-134): sin entregable.\n\n${t.summary}`;
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
