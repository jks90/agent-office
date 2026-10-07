// Activity Stream tipado (FT-1): eventos de tareas y agentes con ids correlacionables (projectId/taskId/taskCode/agentId).
// Convive con `store.log` (líneas de texto por agente): esto es la capa estructurada que consume el Guide Agent y la UI.
// Buffer en memoria (últimos 2000) + data/events.jsonl (rota a 5 MB) + bus `activity` → SSE `event: activity`.
import fs from 'node:fs';
import path from 'node:path';
import { bus, DATA_DIR } from './store.js';

export const TYPES = [
  'TaskCreated', 'TaskAssigned', 'AgentStarted', 'AgentProgress', 'AgentToolStarted', 'AgentToolFinished',
  'AgentFileModified', 'AgentArtifactCreated', 'AgentBlocked', 'UserInstructionAdded',
  'AgentPaused', 'AgentResumed', 'AgentFailed', 'AgentCompleted', 'TaskReviewed',
  'TaskUpdatedFromBase', 'TaskConflict', // FT-19
  'TaskSplitRequested', // FT-63: tarea grande enviada al PO para trocearla
  'ReviewPending', // FT-56: tarea esperando revisión más de reviewNudgeMin minutos {taskCode, minutes, blocks[]}
  'TeamAdjusted', // 🧑‍✈️ el coordinador cambió la plantilla o el motor de un agente {type, why, auto}
];

const MAX_BUFFER = 2000;
const MAX_FILE = 5 * 1024 * 1024;
const FILE = path.join(DATA_DIR, 'events.jsonl');
const buffer = load();
let seq = 0;

function load() {
  try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_BUFFER).map((l) => JSON.parse(l)); } catch { return []; }
}

// Ids únicos y ordenables: tiempo en base 36 + contador + sal (no dependen de lo cargado del fichero).
const nextId = () => `ev_${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 4)}`;

function persist(ev) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.statSync(FILE).size > MAX_FILE) fs.renameSync(FILE, FILE + '.1'); } catch { /* aún no existe */ }
    fs.appendFileSync(FILE, JSON.stringify(ev) + '\n');
  } catch { /* el stream nunca debe tumbar al orquestador */ }
}

// ctx: { projectId, taskId, taskCode, agentId } (ver `ctxOf`). Lo específico de cada tipo va en `data`.
export function emit(type, ctx = {}, data = {}) {
  if (!TYPES.includes(type)) throw new Error(`Tipo de evento desconocido: ${type}`);
  const ev = {
    id: nextId(), ts: Date.now(), type,
    projectId: ctx.projectId ?? null, taskId: ctx.taskId ?? null, taskCode: ctx.taskCode ?? null, agentId: ctx.agentId ?? null,
    data,
  };
  buffer.push(ev);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  persist(ev);
  bus.emit('activity', ev);
  return ev;
}

export const ctxOf = (t, agent) => ({ projectId: t?.projectId, taskId: t?.id, taskCode: t?.code, agentId: agent?.id ?? t?.agentId });

// Consulta: filtros por tarea (id o código), agente, proyecto y `since` (id de evento o timestamp ms); los `limit` más recientes, en orden cronológico.
export function list({ taskId, agentId, projectId, since, limit } = {}) {
  const code = taskId ? String(taskId).toUpperCase() : null;
  let out = buffer.filter((e) => (!taskId || e.taskId === taskId || e.taskCode === code) && (!agentId || e.agentId === agentId) && (!projectId || e.projectId === projectId));
  if (since) {
    const i = out.findIndex((e) => e.id === since);
    out = i >= 0 ? out.slice(i + 1) : out.filter((e) => e.ts > (Number(since) || 0));
  }
  const n = Math.max(1, Math.min(MAX_BUFFER, Number(limit) || 200));
  return out.slice(-n);
}
