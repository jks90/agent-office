// FT-67: motor puro de layout para la oficina 3D.
// Sin dependencias de three.js ni del DOM para poder probarlo en Node.

export const VISUAL_STATUSES = ['working', 'waiting', 'reviewing', 'blocked', 'failed', 'idle'];
export const ZONES = ['development', 'qa', 'docs', 'review', 'meeting', 'idle', 'board'];

const ROLE_ZONE = [
  [/qa|test|quality/i, 'qa'],
  [/doc|writer|content/i, 'docs'],
  [/review|merge/i, 'review'],
  [/manager|lead|guide|pm|po|product/i, 'meeting'],
];

const DONE = new Set(['done', 'merged', 'approved']);
const QUEUED = new Set(['todo', 'backlog', 'queued', 'pending']);
const RUNNING = new Set(['doing', 'working', 'running']);

const BASE_MODULES = {
  development: [
    { x: 1.15, z: 2.0, rot: Math.PI },
    { x: 2.65, z: 2.0, rot: Math.PI },
    { x: 1.15, z: 3.55, rot: Math.PI },
    { x: 2.65, z: 3.55, rot: Math.PI },
  ],
  qa: [
    { x: 5.1, z: 2.0, rot: Math.PI },
    { x: 6.55, z: 2.0, rot: Math.PI },
    { x: 5.1, z: 3.55, rot: Math.PI },
    { x: 6.55, z: 3.55, rot: Math.PI },
  ],
  docs: [
    { x: 1.35, z: 5.9, rot: Math.PI * 0.75 },
    { x: 2.85, z: 5.9, rot: Math.PI * 0.75 },
    { x: 4.35, z: 5.9, rot: Math.PI * 0.75 },
  ],
  review: [
    { x: 7.85, z: 4.85, rot: -Math.PI / 2 },
    { x: 9.15, z: 4.85, rot: -Math.PI / 2 },
    { x: 10.45, z: 4.85, rot: -Math.PI / 2 },
  ],
  meeting: [
    { x: 7.95, z: 7.0, rot: 0 },
    { x: 8.95, z: 7.55, rot: -Math.PI / 2 },
    { x: 6.95, z: 7.55, rot: Math.PI / 2 },
  ],
  idle: [
    { x: 10.55, z: 7.1, rot: Math.PI },
    { x: 11.45, z: 7.1, rot: Math.PI },
    { x: 10.55, z: 6.25, rot: 0 },
  ],
  board: [
    { x: 4.9, z: 0.95, rot: 0 },
    { x: 5.95, z: 0.95, rot: 0 },
  ],
};

const MODULE_SHIFT = {
  development: { x: 0, z: 3.1 },
  qa: { x: 0, z: 3.1 },
  docs: { x: 4.5, z: 0 },
  review: { x: 0, z: 1.45 },
  meeting: { x: 2.9, z: 0 },
  idle: { x: 0, z: -1.35 },
  board: { x: 2.35, z: 0 },
};

export function toVisualState(agent, tasks = [], questions = []) {
  const ownTasks = tasks.filter((t) => ownsTask(agent, t));
  const task = activeTask(agent, ownTasks);
  const pendingQuestion = questions.some((q) => ownsQuestion(agent, task, q));
  const projectId = agent.projectId || task?.projectId || '';

  /*
   * FT-67 tabla de reglas, usando solo snapshot SSE:
   * blocked   -> agente/tarea con quotaBlocked, quotaPaused, status paused/blocked,
   *              o tarea propia no terminada con dependsOn sin cumplir.
   * failed    -> ultima tarea propia en failed.
   * reviewing -> ultima tarea propia en review.
   * working   -> agente trabajando o tarea propia en doing/working/running.
   * waiting   -> pregunta pendiente o tarea propia en cola/backlog/todo sin bloqueo.
   * idle      -> sin tarea visualmente activa.
   * El primer match gana para que los bloqueos y fallos sean visibles.
   */
  let status = 'idle';
  if (isBlocked(agent, task, tasks)) status = 'blocked';
  else if (task?.status === 'failed') status = 'failed';
  else if (task?.status === 'review') status = 'reviewing';
  else if (agent.status === 'working' || RUNNING.has(task?.status)) status = 'working';
  else if (pendingQuestion || QUEUED.has(task?.status)) status = 'waiting';

  return {
    id: String(agent.id),
    name: agent.name || agent.id || '',
    role: normalizeRole(agent.role),
    status,
    taskId: task?.id,
    taskTitle: task?.title,
    projectId,
    tool: agent.activeEngine || agent.engine || task?.tool,
    activity: agent.activity || task?.activity || '',
  };
}

export function layoutFloor(agents, opts = {}, prev = null) {
  const visualAgents = agents.map((a) => VISUAL_STATUSES.includes(a.status) ? { ...a, role: normalizeRole(a.role) } : toVisualState(a, opts.tasks, opts.questions));
  const capacity = normalizeCapacity(opts.capacity, visualAgents.length);
  const modules = new Map();
  const used = new Set();
  const slots = {};
  const prevSlots = prev?.slots || {};

  for (const agent of [...visualAgents].sort(byStableId)) {
    const zone = zoneFor(agent);
    const condition = conditionOf(agent, zone);
    const kept = prevSlots[agent.id];
    if (kept?.condition === condition && !used.has(slotKey(kept))) {
      used.add(slotKey(kept));
      slots[agent.id] = { ...kept, agentId: agent.id };
      touchModule(modules, kept.zone, kept.module, capacity[kept.zone]);
      continue;
    }
    const placed = firstFreeSlot(zone, used, capacity[zone]);
    used.add(slotKey(placed));
    slots[agent.id] = { ...placed, agentId: agent.id, condition, status: agent.status, role: agent.role };
    touchModule(modules, placed.zone, placed.module, capacity[placed.zone]);
  }

  return {
    size: recommendedFloorSize(visualAgents.length),
    slots,
    modules: [...modules.values()].sort((a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone) || a.index - b.index),
  };
}

export function recommendedFloorSize(count) {
  if (count <= 6) return { kind: 'compact', rx: 8.2, rz: 5.7 };
  if (count <= 12) return { kind: 'medium', rx: 10.2, rz: 7.2 };
  return { kind: 'modular', rx: 11.4, rz: 8.0 };
}

function ownsTask(agent, task) {
  return task && (task.id === agent.taskId || task.agentId === agent.id || task.assignedAgentId === agent.id);
}

function ownsQuestion(agent, task, q) {
  if (!q) return false;
  return q.agentId === agent.id || q.taskId === task?.id || q.agentName === agent.name;
}

function activeTask(agent, ownTasks) {
  if (agent.taskId) {
    const current = ownTasks.find((t) => t.id === agent.taskId);
    if (current) return current;
  }
  return [...ownTasks].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

function isBlocked(agent, task, allTasks) {
  if (['paused', 'blocked'].includes(agent.status) || agent.quotaPaused || agent.quotaBlocked) return true;
  if (!task) return false;
  if (task.quotaBlocked || task.quotaPaused || task.blocked) return true;
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  return deps.some((id) => !DONE.has(allTasks.find((t) => t.id === id)?.status));
}

function normalizeRole(role = '') {
  const r = String(role || '').toLowerCase();
  if (/qa|test|quality/.test(r)) return 'qa';
  if (/doc|writer|content/.test(r)) return 'docs';
  if (/review|merge/.test(r)) return 'reviewer';
  if (/manager|lead|guide|pm|po|product/.test(r)) return 'manager';
  return r || 'developer';
}

function zoneFor(agent) {
  if (agent.status === 'reviewing' || agent.status === 'failed') return 'review';
  if (agent.status === 'waiting') return 'board';
  if (agent.status === 'idle') return agent.role === 'manager' ? 'meeting' : 'idle';
  return roleZone(agent.role);
}

function roleZone(role) {
  for (const [re, zone] of ROLE_ZONE) if (re.test(role)) return zone;
  return 'development';
}

function conditionOf(agent, zone) {
  return [zone, agent.status, agent.role, agent.taskId || ''].join(':');
}

function normalizeCapacity(capacity = {}, count = 0) {
  const base = count <= 6 ? { development: 3, qa: 2, docs: 2, review: 2, meeting: 2, idle: 2, board: 2 }
    : count <= 12 ? { development: 4, qa: 3, docs: 3, review: 3, meeting: 3, idle: 3, board: 2 }
      : { development: 4, qa: 4, docs: 3, review: 3, meeting: 3, idle: 3, board: 2 };
  return Object.fromEntries(ZONES.map((z) => [z, Math.max(1, Math.min(BASE_MODULES[z].length, Number(capacity[z] || base[z])))]));
}

function firstFreeSlot(zone, used, capacity) {
  for (let moduleIndex = 0; ; moduleIndex++) {
    for (let index = 0; index < capacity; index++) {
      const key = `${zone}:${moduleIndex}:${index}`;
      if (!used.has(key)) {
        const base = BASE_MODULES[zone][index];
        const shift = MODULE_SHIFT[zone];
        return {
          zone,
          module: moduleIndex,
          index,
          x: round(base.x + shift.x * moduleIndex),
          z: round(base.z + shift.z * moduleIndex),
          rot: base.rot,
        };
      }
    }
  }
}

function touchModule(modules, zone, index, capacity) {
  const key = `${zone}:${index}`;
  if (!modules.has(key)) modules.set(key, { id: key, zone, index, capacity });
}

function slotKey(slot) {
  return `${slot.zone}:${slot.module}:${slot.index}`;
}

function byStableId(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
