// Estado persistente (data/state.json) + bus de eventos para el SSE.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.AO_DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'state.json');

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const empty = () => ({
  projects: [],
  agents: [],
  tasks: [],
  settings: { flowTestUrl: 'http://localhost:9998', maxParallel: 4 },
});

let state = load();

function load() {
  try {
    const s = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    // Ajuste antiguo (URL del MCP) → URL base de flow-test.
    if (s.settings.flowTestMcpUrl && !s.settings.flowTestUrl) s.settings.flowTestUrl = s.settings.flowTestMcpUrl.replace(/\/mcp\/?$/, '');
    delete s.settings.flowTestMcpUrl;
    // Los procesos no sobreviven a un reinicio: lo que estaba en curso vuelve a la cola.
    for (const t of s.tasks) if (t.status === 'doing') { t.status = 'todo'; t.agentId = null; }
    for (const a of s.agents) { a.status = 'idle'; a.taskId = null; a.activity = ''; }
    return s;
  } catch {
    return empty();
  }
}

export const get = () => state;

let saveTimer = null;
let emitTimer = null;
export function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }, 300);
  if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; bus.emit('state', state); }, 80);
}

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
