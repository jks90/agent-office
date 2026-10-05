// El equipo: proyectos (con uno o varios repos), agentes (roles de serie o de fichero .md), tareas y el planificador.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as codes from './codes.js';
import * as git from './git.js';
import { allRoles, roleOf } from './roles.js';
import { parseTasks } from './engines/describe.js';
import * as demo from './engines/demo.js';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import { suiteOk, mcpUrl, flowTestUrl } from './suite.js';
import { engineEnv, cachedEnginesStatus } from './engines/auth.js';
import * as boards from './boards/index.js';
import { linkSkillsInto } from './skills.js';

const ENGINES = { demo, claude, codex };
export const ENGINE_IDS = ['auto', 'claude', 'codex', 'demo'];

// Motor automático: el que tenga sesión y menos trabajo en curso (empate → Claude). Sin ninguno con sesión → error claro.
const MODEL_OF = { claude: /^(sonnet|opus|haiku|claude-)/i, codex: /^(gpt-|o[0-9]|codex)/i };
function pickEngine(agent) {
  if (agent.engine !== 'auto') return agent.engine;
  const st = cachedEnginesStatus();
  const ok = (e) => st ? !!st[e]?.loggedIn : e === 'claude'; // sin estado aún (arranque): solo Claude
  const load = (e) => [...jobs.values()].filter((j) => j.engine === e).length;
  const candidates = ['claude', 'codex'].filter(ok).sort((a, b) => load(a) - load(b) || (a === 'claude' ? -1 : 1));
  if (!candidates.length) throw new Error('Motor automático: ni Claude ni Codex tienen sesión (Ajustes ▸ Motores de IA)');
  return candidates[0];
}
const modelFor = (engineId, agent, role) => {
  const wanted = agent.model || role.model || '';
  if (wanted && MODEL_OF[engineId]?.test(wanted)) return wanted;
  return engineId === 'claude' ? 'sonnet' : engineId === 'codex' ? 'gpt-5.5' : '';
};
export const STATUSES = ['backlog', 'todo', 'doing', 'review', 'done', 'failed'];

const { get, changed, newId, log } = store;
const jobs = new Map(); // agentId -> { stop, taskId }

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
  job.stop();
}

// ── Tareas ─────────────────────────────────────────────────────────────────
export function createTask({ projectId, title, description = '', role, repo = null, dependsOn = [], kind = 'work', goal = null, images = [], files = [], attachments = [], status = 'todo', source = null }) {
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
    costUsd: null, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  codes.assignCode(s.tasks, p, task);
  task.feedbackImages = copyImages(task, images);
  s.tasks.push(task);
  changed();
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
  if (patch.status && ['backlog', 'todo'].includes(patch.status) && ['backlog', 'todo', 'failed'].includes(t.status)) {
    t.status = patch.status;
    t.error = null;
    reflect(t);
  }
  if (Array.isArray(patch.dependsOn)) t.dependsOn = patch.dependsOn.filter((d) => d !== id && s.tasks.some((x) => x.id === d));
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
  await git.cleanup(p, repoOfTask(p, t), t);
  s.tasks = s.tasks.filter((x) => x.id !== id);
  for (const o of s.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== id);
  changed();
}

export async function approve(id) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  const p = projectOf(t);
  if (t.branch) {
    const repo = repoOfTask(p, t);
    try { await git.merge(repo, t); } catch (e) { throw fail(409, e.message); }
    await git.cleanup(p, repo, t);
  }
  t.status = 'done';
  t.updatedAt = Date.now();
  changed();
  reflect(t, `✅ Aprobada en AgentOffice${t.summary ? `\n\n${t.summary.slice(0, 1500)}` : ''}`);
  tick();
}

export async function reject(id, feedback = '', images = [], attachments = []) {
  const t = findOr404(get().tasks, id, 'Tarea');
  for (const a of attachments) { if (/\.(png|jpe?g|webp)$/i.test(a.path)) images = [...images, a.path]; else t.files = [...(t.files || []), a.path]; }
  if (!['review', 'failed'].includes(t.status)) throw fail(409, 'Solo se devuelven tareas en revisión o fallidas');
  // La rama y el worktree se conservan: el agente corrige sobre su intento anterior.
  if (feedback.trim()) t.feedback = [t.feedback, feedback.trim()].filter(Boolean).join('\n');
  t.feedbackImages = copyImages(t, images);
  Object.assign(t, { status: 'todo', agentId: null, diffStat: '', error: null, updatedAt: Date.now() });
  changed();
  reflect(t, feedback.trim() ? `↩ Devuelta en AgentOffice: ${feedback.trim().slice(0, 1000)}` : undefined);
  tick();
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
  const d = await git.diff(repoOfTask(p, t), t);
  return d.length > 300_000 ? d.slice(0, 300_000) + '\n… (recortado)' : d || '(sin cambios)';
}

const projectOf = (t) => get().projects.find((p) => p.id === t.projectId);
const depsDone = (t) => t.dependsOn.every((d) => get().tasks.find((x) => x.id === d)?.status === 'done');

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
export function tick() {
  const s = get();
  if (!suiteOk()) return; // sin flow-test vigente, el equipo no arranca nada
  for (const p of s.projects) {
    if (!p.running) continue;
    const team = teamOf(p);
    let slots = (s.settings.maxParallel || 4) - team.filter((a) => jobs.has(a.id)).length;
    const todo = s.tasks.filter((t) => t.projectId === p.id && t.status === 'todo').sort((a, b) => a.createdAt - b.createdAt);
    for (const t of todo) {
      if (slots <= 0) break;
      if (!depsDone(t)) continue;
      const agent = team.find((a) => !jobs.has(a.id) && (a.role === t.role || (roleOf(a.role)?.handles || []).includes(t.role)));
      if (!agent) continue;
      slots--;
      runTask(p, agent, t);
    }
  }
}
setInterval(tick, 1500).unref();

const teamRoles = (p) => [...new Set(teamOf(p).filter((a) => roleOf(a.role)?.kind !== 'planner').map((a) => a.role))];

function buildPrompt(p, agent, t) {
  if (t.kind === 'plan') {
    const roles = teamRoles(p);
    const repos = p.repos || [];
    return [
      `Objetivo del equipo: ${t.goal}`,
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
      'Responde SOLO con un bloque JSON (máximo 6 tareas):',
      '```json',
      `[{"title": "…", "description": "qué hacer y cómo saber que está bien", "role": "${roles.join('|')}", ${repos.length > 1 ? `"repo": "${repos.map((r) => r.key).join('|')}", ` : ''}"dependsOn": [índices de tareas anteriores de esta lista]}]`,
      '```',
    ].join('\n');
  }
  const done = get().tasks.filter((x) => t.dependsOn.includes(x.id));
  return [
    `Tarea ${t.code || '#' + t.id}: ${t.title}`,
    '',
    t.description,
    done.length ? `\nTrabajo previo del equipo (ya fusionado):\n${done.map((d) => `- ${d.title}: ${d.summary}`).join('\n')}` : '',
    t.feedback ? `\nComentarios de la revisión anterior (corrígelos):\n${t.feedback}` : '',
    t.feedbackImages?.length ? `\nImágenes adjuntas (míralas con atención antes de cambiar nada; también están en ${t.feedbackImages.join(', ')}).` : '',
    t.files?.length ? `\nFicheros adjuntos (léelos antes de empezar): ${t.files.join(', ')}` : '',
    '',
    p.folder ? `Carpeta del proyecto en el workspace de flow-test: «${p.folder}/» (ahí viven sus flows y su documentación; guarda ahí lo que generes con flow-test).` : '',
    `Trabajas en una copia aislada del repo (git worktree) en la rama ${t.branch}. No cambies de rama ni hagas push.`,
    t.reused ? 'En esta rama ya está tu intento anterior (mira `git log` y `git diff` contra la rama base): parte de él y corrige lo que pide la revisión, sin rehacer lo que ya estaba bien.' : '',
    'Lo que dejes sin confirmar se confirmará solo al terminar.',
    t.code ? `Cita el código ${t.code} en lo que documentes (changelog, README, flows, tablero) para que la tarea se pueda rastrear.` : '',
    'Al acabar, responde con un resumen breve: qué cambiaste y cómo lo probaste.',
  ].join('\n');
}

async function runTask(p, agent, t) {
  const s = get();
  jobs.set(agent.id, { stop() {}, taskId: t.id, engine: agent.engine === 'auto' ? null : agent.engine }); // ocupado DESDE YA (antes de cualquier await), o el mismo tick le daría dos tareas
  Object.assign(t, { status: 'doing', agentId: agent.id, error: null, attempts: t.attempts + 1, updatedAt: Date.now() });
  Object.assign(agent, { status: 'working', taskId: t.id, activity: t.kind === 'plan' ? 'Leyendo el objetivo' : 'Preparando su copia del repo' });
  changed();
  log(agent.id, `▶ ${t.code || '#' + t.id} ${t.title}`);
  reflect(t, `▶ ${agent.name} (${roleOf(agent.role)?.label || agent.role}) empieza a trabajar en AgentOffice`);

  let engineId;
  try { engineId = pickEngine(agent); } catch (e) { Object.assign(t, { status: 'failed', error: e.message, agentId: null }); Object.assign(agent, { status: 'idle', taskId: null, activity: '' }); jobs.delete(agent.id); log(agent.id, '❌ ' + e.message); changed(); return; }
  const engine = ENGINES[engineId] || demo;
  const real = engineId !== 'demo';
  agent.activeEngine = engineId;
  if (agent.engine === 'auto') log(agent.id, `🤖 Motor automático → ${engineId}`);
  const role = roleOf(agent.role) || roleOf('back');
  const roles = teamRoles(p);
  const repo = repoOfTask(p, t);
  let cwd = repo?.path || store.DATA_DIR;

  try {
    if (real && t.kind !== 'plan') {
      if (!repo) throw new Error('Los motores claude/codex necesitan que el proyecto tenga un repositorio git');
      t.repo = repo.key;
      const wt = await git.createWorktree(p, repo, t);
      cwd = wt.path;
      t.branch = wt.branch;
      t.reused = !!wt.reused;
      if (wt.reused) log(agent.id, `↺ Sigue sobre su intento anterior en ${wt.branch}`);
      else log(agent.id, `🌿 Rama ${wt.branch} en el repo ${repo.key}`);
      if (engineId === 'claude' && role.skills?.length) { const linked = linkSkillsInto(cwd, role.skills); if (linked.length) log(agent.id, `🧩 Skills: ${linked.join(', ')}`); }
    }
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    const job = engine.start({
      agent, task: t, project: p, cwd, mode: t.kind === 'plan' ? 'plan' : 'work', goal: t.goal, roles,
      prompt: buildPrompt(p, agent, t),
      images: (t.feedbackImages || []).filter((f) => fs.existsSync(f)),
      system: role.system,
      model: modelFor(engineId, agent, role),
      mcpUrl: ['qa', 'docs'].includes(role.kind) ? mcpUrl() : null, // QA y documentalista hablan con flow-test por MCP
      env: engineEnv(engineId),
      onActivity: (text) => { agent.activity = text; changed(); },
      onLog: (line) => log(agent.id, line),
    });
    jobs.set(agent.id, { stop: job.stop, taskId: t.id, engine: engineId });
    const res = await job.done;

    if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd;
    if (!res.ok) throw new Error(res.error || 'El agente no terminó bien');
    t.summary = res.summary || '';

    if (t.kind === 'plan') {
      const list = res.tasks || parseTasks(res.summary);
      const ids = [];
      for (const item of list.slice(0, 8)) {
        const r = roles.includes(item.role) ? item.role : (roles[0] || 'back');
        const deps = (item.dependsOn || []).map((i) => ids[i]).filter(Boolean);
        const rk = (p.repos || []).some((x) => x.key === item.repo) ? item.repo : null;
        ids.push(createTask({ projectId: p.id, title: item.title, description: item.description, role: r, repo: rk, dependsOn: deps }).id);
      }
      t.summary = `${ids.length} tareas creadas para el equipo.`;
      t.status = 'done';
      log(agent.id, `✅ Plan listo: ${ids.length} tareas`);
    } else {
      if (t.branch) {
        await git.commitAll(cwd, t.code ? `${t.code}: ${t.title}` : `${t.title} (#${t.id})`, `${agent.name} (${role.label})`);
        t.diffStat = await git.diffStat(repo, t);
      } else {
        t.diffStat = res.diffStat || '';
      }
      t.status = 'review';
      log(agent.id, '✋ Terminado: esperando tu revisión');
      reflect(t, `✋ ${agent.name} terminó; pendiente de revisión en AgentOffice.${t.diffStat ? `\n\n\`\`\`\n${t.diffStat.slice(0, 800)}\n\`\`\`` : ''}`);
    }
  } catch (e) {
    t.status = 'failed';
    t.error = e.message;
    log(agent.id, '❌ ' + e.message);
    reflect(t, `❌ Falló en AgentOffice: ${String(e.message).slice(0, 500)}`);
  } finally {
    jobs.delete(agent.id);
    t.updatedAt = Date.now();
    Object.assign(agent, { status: 'idle', taskId: null, activity: '', activeEngine: null });
    changed();
    tick();
  }
}
