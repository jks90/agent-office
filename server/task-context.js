// Contexto del que nace una tarea (FT-7): lo que el usuario tenía delante cuando la pidió al Guide.
//   {view, projectId, taskCode?, agentId?, host:{flow, filePath, node, consoleTail}}  (recortado; sin capturas)
// Funciones puras: las usan team.js (persistir y prompt), ai-draft.js (borrador) y guide/tools.js (task.create).
const str = (v, n = 300) => (v == null || v === '' ? null : String(v).slice(0, n));

// Recorta el contexto de flow-test (host, FT-3) a lo útil: flow, fichero, nodo y cola de consola.
function cleanHost(h) {
  if (!h || typeof h !== 'object') return null;
  const fn = h.focusedNode;
  const node = h.node ?? (fn && typeof fn === 'object' ? fn.id ?? fn.name : fn) ?? null;
  const tab = h.activeTab;
  const out = {
    flow: str(h.flow ?? (tab && typeof tab === 'object' ? tab.name ?? tab.flow : tab)),
    filePath: str(h.filePath ?? (tab && typeof tab === 'object' ? tab.filePath ?? tab.path : null)),
    node: str(node),
    nodeLabel: str(h.nodeLabel ?? (fn && typeof fn === 'object' ? fn.label ?? fn.name : null)),
    consoleTail: (Array.isArray(h.consoleTail) ? h.consoleTail : []).slice(-10).map((l) => str(typeof l === 'string' ? l : l?.text ?? l?.line ?? JSON.stringify(l), 300)),
  };
  return out.flow || out.filePath || out.node || out.consoleTail.length ? out : null;
}

// Normaliza lo que llega (context.get(): contexto publicado y resuelto) al formato persistido en la tarea.
export function cleanContext(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {
    view: str(c.view, 20), projectId: str(c.projectId, 80),
    taskCode: str(c.taskCode ?? c.task?.code, 40), agentId: str(c.agentId ?? c.selectedAgentId ?? c.agent?.id, 80),
    host: cleanHost(c.host),
  };
  return out.host || out.taskCode || out.agentId || out.view ? out : null;
}

// Texto para el prompt: «el cliente estaba viendo … cuando pidió esto».
export function describeContext(c, worker = false) {
  if (!c) return '';
  const h = c.host;
  const bits = [];
  if (h?.flow || h?.filePath) bits.push(`el flow «${h.flow || h.filePath}»${h.filePath && h.flow ? ` (${h.filePath})` : ''} de flow-test${h.node ? `, con el nodo «${h.nodeLabel || h.node}» (id ${h.node}) seleccionado` : ''}`);
  if (c.taskCode) bits.push(`la tarea ${c.taskCode} de AgentOffice`);
  if (c.agentId) bits.push(`el panel de un agente (${c.agentId})`);
  if (!bits.length && c.view) bits.push(`la vista «${c.view}» de AgentOffice`);
  let t = `El cliente estaba viendo ${bits.join(' y ') || 'AgentOffice'} cuando pidió esto`;
  if (worker && h?.consoleTail?.length) t += `. Últimas líneas de su consola:\n${h.consoleTail.map((l) => `  ${l}`).join('\n')}`;
  return t;
}
