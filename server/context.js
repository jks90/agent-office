// Application Context Provider (FT-2): la UI publica lo que el usuario está viendo (POST /api/context) y el Guide Agent
// lo lee enriquecido (GET /api/context). Contexto estructurado, sin visión: nunca capturas de pantalla.
// Un contexto por cliente (id de pestaña, cabecera `x-ao-client`); GET devuelve el del cliente más reciente.
import * as store from './store.js';
import { prefixOf } from './codes.js';
import * as activity from './events.js';

const VIEWS = ['office', 'summary', 'tasks', 'agents', 'guide', 'settings'];
const MAX_CLIENTS = 50;
const clients = new Map(); // clientId → contexto publicado (el último del Map es el más reciente)
const str = (v, n = 200) => (v == null || v === '' ? null : String(v).slice(0, n));

// Valida y recorta lo que manda la UI. `host` (contexto de flow-test, FT-3) se guarda tal cual pero acotado en tamaño.
function clean(b = {}) {
  let host = null;
  if (b.host && typeof b.host === 'object') host = JSON.stringify(b.host).length <= 20_000 ? b.host : { truncated: true };
  return {
    view: VIEWS.includes(b.view) ? b.view : null,
    projectId: str(b.projectId), openTaskId: str(b.openTaskId), selectedAgentId: str(b.selectedAgentId),
    taskFilter: str(b.taskFilter) || '', questionOpen: str(b.questionOpen),
    officeMode: ['building', 'floor'].includes(b.officeMode) ? b.officeMode : null, // la Oficina enseña el edificio o una planta (FT-47)
    officeLevel: ['building', 'floor', 'agent'].includes(b.officeLevel) ? b.officeLevel : null, // FT-71: empresa → planta → agente
    host, at: Number(b.at) || Date.now(),
  };
}

export function publish(clientId, body) {
  const id = str(clientId, 80) || 'default';
  clients.delete(id);
  clients.set(id, { ...clean(body), receivedAt: Date.now() });
  while (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value);
  return { ok: true };
}

// Contexto del cliente más reciente (o del pedido) con proyecto, tarea, agente y eventos resueltos desde el estado.
export function get(clientId) {
  const pick = clientId && clients.has(clientId) ? [clientId, clients.get(clientId)] : [...clients.entries()].at(-1);
  const recentEvents = activity.list({ limit: 20 });
  if (!pick) return { client: null, view: null, projectId: null, openTaskId: null, selectedAgentId: null, taskFilter: '', questionOpen: null, officeMode: null, officeLevel: null, project: null, task: null, agent: null, recentEvents, host: null, at: null };
  const [client, ctx] = pick;
  const st = store.get();
  const p = st.projects.find((x) => x.id === ctx.projectId);
  const t = st.tasks.find((x) => x.id === ctx.openTaskId);
  const a = st.agents.find((x) => x.id === ctx.selectedAgentId);
  const tail = (id) => (store.allLogs()[id] || []).slice(-10).map((l) => l.line);
  const tAgent = t && st.agents.find((x) => x.id === t.agentId);
  const aTask = a && st.tasks.find((x) => x.agentId === a.id && x.status === 'doing');
  return {
    client, ...ctx,
    project: p ? { id: p.id, name: p.name, prefix: prefixOf(p), repos: (p.repos || []).map((r) => ({ key: r.key, path: r.path, roles: r.roles || [] })) } : null,
    task: t ? {
      id: t.id, code: t.code, title: t.title, status: t.status, role: t.role, branch: t.branch || null,
      agent: tAgent ? { id: tAgent.id, name: tAgent.name } : null,
      logTail: t.agentId ? tail(t.agentId) : [], questions: t.questions || [],
    } : null,
    agent: a ? {
      id: a.id, name: a.name, role: a.role, status: a.status, activity: a.activity || '',
      task: aTask ? { id: aTask.id, code: aTask.code, title: aTask.title } : null,
    } : null,
    recentEvents,
  };
}
