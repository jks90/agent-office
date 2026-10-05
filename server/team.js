// El equipo: proyectos, agentes, tareas y el planificador que reparte el trabajo.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as git from './git.js';
import { ROLES, ROLE_IDS } from './roles.js';
import { parseTasks } from './engines/describe.js';
import * as demo from './engines/demo.js';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import { suiteOk, mcpUrl } from './suite.js';

const ENGINES = { demo, claude, codex };
export const ENGINE_IDS = Object.keys(ENGINES);

const { get, changed, newId, log } = store;
const jobs = new Map(); // agentId -> { stop, taskId }

const DEFAULT_TEAM = [
  { name: 'Olivia', role: 'po' },
  { name: 'Bruno', role: 'back' },
  { name: 'Frida', role: 'front' },
  { name: 'Quique', role: 'qa' },
];

const fail = (status, message) => Object.assign(new Error(message), { status });
const findOr404 = (list, id, what) => list.find((x) => x.id === id) || (() => { throw fail(404, `${what} no encontrado`); })();

// ── Proyectos ──────────────────────────────────────────────────────────────
export async function createProject({ name, repoPath, engine = 'demo' }) {
  if (!name?.trim()) throw fail(400, 'El proyecto necesita un nombre');
  let repo = { repoPath: null, baseBranch: null };
  if (repoPath?.trim()) {
    const dir = repoPath.trim().replace(/^~(?=\/|$)/, process.env.HOME);
    if (!fs.existsSync(dir)) throw fail(400, `No existe la carpeta ${dir}`);
    try { repo = await git.repoInfo(dir); } catch { throw fail(400, `${dir} no es un repositorio git`); }
  }
  if (!ENGINE_IDS.includes(engine)) engine = 'demo';
  const s = get();
  const project = { id: newId(), name: name.trim(), ...repo, running: false, createdAt: Date.now() };
  s.projects.push(project);
  DEFAULT_TEAM.forEach((m) => s.agents.push(newAgent(project.id, { ...m, engine })));
  changed();
  return project;
}

export function deleteProject(id) {
  const s = get();
  findOr404(s.projects, id, 'Proyecto');
  for (const a of s.agents.filter((a) => a.projectId === id)) jobs.get(a.id)?.stop();
  s.projects = s.projects.filter((p) => p.id !== id);
  s.agents = s.agents.filter((a) => a.projectId !== id);
  s.tasks = s.tasks.filter((t) => t.projectId !== id);
  changed();
}

export function setRunning(id, running) {
  const p = findOr404(get().projects, id, 'Proyecto');
  p.running = !!running;
  changed();
  tick();
}

// ── Agentes ────────────────────────────────────────────────────────────────
function newAgent(projectId, { name, role, engine = 'demo', model = '' }) {
  return { id: newId(), projectId, name, role, engine, model, status: 'idle', activity: '', taskId: null, createdAt: Date.now() };
}

export function hire({ projectId, name, role, engine, model }) {
  const s = get();
  findOr404(s.projects, projectId, 'Proyecto');
  if (!ROLE_IDS.includes(role)) throw fail(400, 'Rol desconocido');
  if (!name?.trim()) throw fail(400, 'El agente necesita un nombre');
  if (s.agents.filter((a) => a.projectId === projectId).length >= 8) throw fail(400, 'La oficina tiene 8 mesas: no caben más agentes');
  const agent = newAgent(projectId, { name: name.trim(), role, engine: ENGINE_IDS.includes(engine) ? engine : 'demo', model: model || '' });
  s.agents.push(agent);
  changed();
  return agent;
}

export function updateAgent(id, patch) {
  const a = findOr404(get().agents, id, 'Agente');
  if (patch.name?.trim()) a.name = patch.name.trim();
  if (ENGINE_IDS.includes(patch.engine)) a.engine = patch.engine;
  if (typeof patch.model === 'string') a.model = patch.model.trim();
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
export function createTask({ projectId, title, description = '', role, dependsOn = [], kind = 'work', goal = null, images = [] }) {
  const s = get();
  findOr404(s.projects, projectId, 'Proyecto');
  if (!title?.trim()) throw fail(400, 'La tarea necesita un título');
  if (!ROLE_IDS.includes(role)) throw fail(400, 'Rol desconocido');
  const task = {
    id: newId(), projectId, kind, goal, title: title.trim(), description: String(description || '').trim(), role,
    dependsOn: dependsOn.filter((d) => s.tasks.some((t) => t.id === d)),
    status: 'todo', agentId: null, branch: null, summary: '', diffStat: '', error: null, feedback: '',
    costUsd: null, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  task.feedbackImages = copyImages(task, images);
  s.tasks.push(task);
  changed();
  tick();
  return task;
}

export function planGoal(projectId, goal) {
  if (!goal?.trim()) throw fail(400, 'Escribe un objetivo');
  const s = get();
  if (!s.agents.some((a) => a.projectId === projectId && a.role === 'po')) throw fail(400, 'El equipo no tiene PO: contrata uno para planificar');
  return createTask({ projectId, kind: 'plan', goal: goal.trim(), role: 'po', title: `Planificar: ${goal.trim().slice(0, 80)}`, description: goal.trim() });
}

export async function deleteTask(id) {
  const s = get();
  const t = findOr404(s.tasks, id, 'Tarea');
  if (t.status === 'doing') throw fail(409, 'Para al agente antes de borrar la tarea');
  await git.cleanup(projectOf(t), t);
  s.tasks = s.tasks.filter((x) => x.id !== id);
  for (const o of s.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== id);
  changed();
}

export async function approve(id) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (t.status !== 'review') throw fail(409, 'La tarea no está en revisión');
  const p = projectOf(t);
  if (t.branch) {
    try { await git.merge(p, t); } catch (e) { throw fail(409, e.message); }
    await git.cleanup(p, t);
  }
  t.status = 'done';
  t.updatedAt = Date.now();
  changed();
  tick();
}

export async function reject(id, feedback = '', images = []) {
  const t = findOr404(get().tasks, id, 'Tarea');
  if (!['review', 'failed'].includes(t.status)) throw fail(409, 'Solo se devuelven tareas en revisión o fallidas');
  // La rama y el worktree se conservan: el agente corrige sobre su intento anterior.
  if (feedback.trim()) t.feedback = [t.feedback, feedback.trim()].filter(Boolean).join('\n');
  t.feedbackImages = copyImages(t, images);
  Object.assign(t, { status: 'todo', agentId: null, diffStat: '', error: null, updatedAt: Date.now() });
  changed();
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
  const d = await git.diff(projectOf(t), t);
  return d.length > 300_000 ? d.slice(0, 300_000) + '\n… (recortado)' : d || '(sin cambios)';
}

const projectOf = (t) => get().projects.find((p) => p.id === t.projectId);
const depsDone = (t) => t.dependsOn.every((d) => get().tasks.find((x) => x.id === d)?.status === 'done');

// ── Planificador ───────────────────────────────────────────────────────────
export function tick() {
  const s = get();
  if (!suiteOk()) return; // sin flow-test vigente, el equipo no arranca nada
  for (const p of s.projects) {
    if (!p.running) continue;
    const team = s.agents.filter((a) => a.projectId === p.id);
    let slots = (s.settings.maxParallel || 4) - team.filter((a) => jobs.has(a.id)).length;
    const todo = s.tasks.filter((t) => t.projectId === p.id && t.status === 'todo').sort((a, b) => a.createdAt - b.createdAt);
    for (const t of todo) {
      if (slots <= 0) break;
      if (!depsDone(t)) continue;
      const agent = team.find((a) => a.role === t.role && !jobs.has(a.id));
      if (!agent) continue;
      slots--;
      runTask(p, agent, t);
    }
  }
}
setInterval(tick, 1500).unref();

function buildPrompt(p, agent, t) {
  if (t.kind === 'plan') {
    const roles = [...new Set(get().agents.filter((a) => a.projectId === p.id && a.role !== 'po').map((a) => a.role))];
    return [
      `Objetivo del equipo: ${t.goal}`,
      '',
      p.repoPath ? 'Lee la documentación y el código del repositorio (estás en su raíz) para entender el contexto.' : 'No hay repositorio: planifica solo a partir del objetivo.',
      `Divide el objetivo en tareas pequeñas para estos roles: ${roles.join(', ')}.`,
      'Cada tarea debe poder hacerla un agente solo, en una rama aparte, y ser verificable.',
      'Las tareas de QA van al final y dependen de lo que verifican.',
      '',
      'Responde SOLO con un bloque JSON (máximo 6 tareas):',
      '```json',
      '[{"title": "…", "description": "qué hacer y cómo saber que está bien", "role": "' + roles.join('|') + '", "dependsOn": [índices de tareas anteriores de esta lista]}]',
      '```',
    ].join('\n');
  }
  const done = get().tasks.filter((x) => t.dependsOn.includes(x.id));
  return [
    `Tarea #${t.id}: ${t.title}`,
    '',
    t.description,
    done.length ? `\nTrabajo previo del equipo (ya fusionado):\n${done.map((d) => `- ${d.title}: ${d.summary}`).join('\n')}` : '',
    t.feedback ? `\nComentarios de la revisión anterior (corrígelos):\n${t.feedback}` : '',
    t.feedbackImages?.length ? `\nImágenes adjuntas (míralas con atención antes de cambiar nada; también están en ${t.feedbackImages.join(', ')}).` : '',
    '',
    `Trabajas en una copia aislada del repo (git worktree) en la rama ${t.branch}. No cambies de rama ni hagas push.`,
    t.reused ? 'En esta rama ya está tu intento anterior (mira `git log` y `git diff` contra la rama base): parte de él y corrige lo que pide la revisión, sin rehacer lo que ya estaba bien.' : '',
    'Lo que dejes sin confirmar se confirmará solo al terminar.',
    'Al acabar, responde con un resumen breve: qué cambiaste y cómo lo probaste.',
  ].join('\n');
}

async function runTask(p, agent, t) {
  const s = get();
  jobs.set(agent.id, { stop() {}, taskId: t.id }); // ocupado DESDE YA (antes de cualquier await), o el mismo tick le daría dos tareas
  Object.assign(t, { status: 'doing', agentId: agent.id, error: null, attempts: t.attempts + 1, updatedAt: Date.now() });
  Object.assign(agent, { status: 'working', taskId: t.id, activity: t.kind === 'plan' ? 'Leyendo el objetivo' : 'Preparando su copia del repo' });
  changed();
  log(agent.id, `▶ #${t.id} ${t.title}`);

  const engine = ENGINES[agent.engine] || demo;
  const real = agent.engine !== 'demo';
  const roles = [...new Set(s.agents.filter((a) => a.projectId === p.id && a.role !== 'po').map((a) => a.role))];
  let cwd = p.repoPath || store.DATA_DIR;

  try {
    if (real && t.kind !== 'plan') {
      if (!p.repoPath) throw new Error('Los motores claude/codex necesitan que el proyecto tenga un repositorio git');
      const wt = await git.createWorktree(p, t);
      cwd = wt.path;
      t.branch = wt.branch;
      t.reused = !!wt.reused;
      if (wt.reused) log(agent.id, `↺ Sigue sobre su intento anterior en ${wt.branch}`);
    }
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    const job = engine.start({
      agent, task: t, project: p, cwd, mode: t.kind === 'plan' ? 'plan' : 'work', goal: t.goal, roles,
      prompt: buildPrompt(p, agent, t),
      images: t.kind === 'plan' ? [] : (t.feedbackImages || []).filter((f) => fs.existsSync(f)),
      system: ROLES[agent.role].system,
      model: agent.model,
      mcpUrl: agent.role === 'qa' ? mcpUrl() : null,
      onActivity: (text) => { agent.activity = text; changed(); },
      onLog: (line) => log(agent.id, line),
    });
    jobs.set(agent.id, { stop: job.stop, taskId: t.id });
    const res = await job.done;

    if (res.costUsd != null) t.costUsd = (t.costUsd || 0) + res.costUsd;
    if (!res.ok) throw new Error(res.error || 'El agente no terminó bien');
    t.summary = res.summary || '';

    if (t.kind === 'plan') {
      const list = res.tasks || parseTasks(res.summary);
      const ids = [];
      for (const item of list.slice(0, 8)) {
        const role = ROLE_IDS.includes(item.role) && item.role !== 'po' ? item.role : (roles[0] || 'back');
        const deps = (item.dependsOn || []).map((i) => ids[i]).filter(Boolean);
        ids.push(createTask({ projectId: p.id, title: item.title, description: item.description, role, dependsOn: deps }).id);
      }
      t.summary = `${ids.length} tareas creadas para el equipo.`;
      t.status = 'done';
      log(agent.id, `✅ Plan listo: ${ids.length} tareas`);
    } else {
      if (t.branch) {
        await git.commitAll(cwd, `${t.title} (#${t.id})`, `${agent.name} (${ROLES[agent.role].label})`);
        t.diffStat = await git.diffStat(p, t);
      } else {
        t.diffStat = res.diffStat || '';
      }
      t.status = 'review';
      log(agent.id, '✋ Terminado: esperando tu revisión');
    }
  } catch (e) {
    t.status = 'failed';
    t.error = e.message;
    log(agent.id, '❌ ' + e.message);
  } finally {
    jobs.delete(agent.id);
    t.updatedAt = Date.now();
    Object.assign(agent, { status: 'idle', taskId: null, activity: '' });
    changed();
    tick();
  }
}
