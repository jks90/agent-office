// Estado persistente (data/state.json) + bus de eventos para el SSE.
import fs from 'node:fs';
import path from 'node:path';
import { codexCostUsd } from './usage.js';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { migrate as migrateCodes } from './codes.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.AO_DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'state.json');

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const empty = () => ({
  projects: [],
  agents: [],
  tasks: [],
  settings: { flowTestUrl: 'http://localhost:9998', maxParallel: 4, workspaceHostDir: `${process.env.HOME}/JksDocs/workspace` },
});

let state = load();

function load() {
  try {
    const s = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    // Ajuste antiguo (URL del MCP) → URL base de flow-test.
    if (s.settings.flowTestMcpUrl && !s.settings.flowTestUrl) s.settings.flowTestUrl = s.settings.flowTestMcpUrl.replace(/\/mcp\/?$/, '');
    delete s.settings.flowTestMcpUrl;
    // Proyectos antiguos de un solo repo → lista de repos.
    for (const p of s.projects) if (!Array.isArray(p.repos)) p.repos = p.repoPath ? [{ key: 'main', path: p.repoPath, baseBranch: p.baseBranch, roles: [] }] : [];
    // Los procesos no sobreviven a un reinicio: lo que estaba en curso vuelve a la cola.
    for (const t of s.tasks) if (t.status === 'doing') { t.status = 'todo'; t.agentId = null; }
    for (const a of s.agents) { a.status = 'idle'; a.taskId = null; a.activity = ''; }
    // Tareas de Codex de antes de estimar su coste: tokens sin $ → coste ≈ con la tabla de precios (una vez; queda marcado).
    for (const t of s.tasks) {
      const eng = t.sessionEngine || t.modelHistory?.at(-1)?.engine || (/^codex/.test(t.usage?.source || '') ? 'codex' : '');
      if (t.costUsd == null && eng === 'codex' && t.usage?.total > 0) { t.costUsd = codexCostUsd(t.usage, t.modelHistory?.at(-1)?.model); t.costEstimated = true; }
    }
    // Esquema 2: los agentes son de la empresa (globales); cada proyecto ficha a los suyos en project.team y el resto
    // espera en el banquillo. Los equipos por defecto que se crearon por carpeta (duplicados sin tareas) se eliminan.
    if (!s.schema || s.schema < 2) {
      const keep = new Set(s.projects.filter((p) => s.tasks.some((t) => t.projectId === p.id)).map((p) => p.id));
      s.agents = s.agents.filter((a) => !a.projectId || keep.has(a.projectId));
      for (const p of s.projects) p.team = s.agents.filter((a) => a.projectId === p.id).map((a) => a.id);
      for (const a of s.agents) { a.projects = undefined; delete a.projectId; }
      s.schema = 2;
    }
    for (const p of s.projects) if (!Array.isArray(p.team)) p.team = [];
    // Esquema 3: código legible por tarea (GL-7) — también para las tareas antiguas, por orden de creación.
    if (!s.schema || s.schema < 3) { migrateCodes(s); s.schema = 3; }
    for (const p of s.projects) if (p.board?.job?.running) { p.board.job.running = false; p.board.job.lastError = 'Exportación interrumpida (reinicio)'; }
    return s;
  } catch {
    return empty();
  }
}

export const get = () => state;

let saveTimer = null;
let emitTimer = null;
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}
export function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 300);
  if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; bus.emit('state', state); }, 80);
}
// Al apagar (systemctl stop/restart, Ctrl+C) se vuelca lo pendiente: con el debounce, un reinicio justo tras
// aprobar/devolver perdía ese cambio y la tarea «volvía» a su estado anterior aunque el merge ya estuviera hecho.
const shutdownHooks = [];
export const onShutdown = (fn) => shutdownHooks.push(fn);
export function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; try { save(); } catch { /* disco */ } } }
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { for (const h of shutdownHooks) { try { h(); } catch { /* no bloquear el apagado */ } } flush(); process.exit(0); });
process.on('beforeExit', flush);

export const newId = () => Math.random().toString(36).slice(2, 8);

// Logs por agente: solo en memoria (los últimos 400).
const logs = new Map();
export function log(agentId, line) {
  const entry = { agentId, line: String(line).slice(0, 2000), ts: Date.now() };
  const arr = logs.get(agentId) || [];
  arr.push(entry);
  if (arr.length > 400) arr.splice(0, arr.length - 400);
  logs.set(agentId, arr);
  bus.emit('log', entry);
}
export const allLogs = () => Object.fromEntries(logs);
