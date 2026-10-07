// Tool Registry tipado del Guide Agent (FT-4). El Guide no es un worker: es una capa por encima del orquestador, así que
// cada tool delega en lo que YA existe (team.js, context.js, events.js, git.js). Registro:
//   { name, description, input (JSON Schema), policy: read|navigate|execute|write|irreversible, handler(args, ctx), pending? }
// `pending` = registrada pero aún sin implementación (la traerá otra tarea): responde 501 sin pedir confirmación.
// `run()` es lo único que se expone (POST /api/guide/tool y bin/ao-mcp.mjs): valida → política → handler → auditoría.
import * as store from '../store.js';
import * as team from '../team.js';
import * as git from '../git.js';
import * as context from '../context.js';
import * as activity from '../events.js';
import { prefixOf } from '../codes.js';
import { draftTask } from '../ai-draft.js';
import { cleanContext } from '../task-context.js';
import * as integ from './integrations.js';
import { getProvider } from '../desktop/index.js';
import { resolveApp } from '../desktop/apps.js';
import * as vision from './vision.js';
import { gate, audit, summarize, getPolicy, POLICIES } from './policy.js';
import { parseKeys } from '../desktop/input.js';
import { flowTestUrl } from '../suite.js';
import fs from 'node:fs';
import { getDriver, renderSnapshot } from '../browser/index.js';
import { agentDriver, addHandoff, resolveHandoff, setControl, status as browserStatus } from '../browser/panel.js';
import * as bpolicy from '../browser/policy.js';
import * as questions from '../questions.js';
import { resolveRefs } from '../uploads.js'; // FT-130

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const VIEWS = ['office', 'summary', 'tasks', 'agents', 'guide', 'browser', 'settings'];
const str = (description) => ({ type: 'string', description });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ── Búsquedas sobre el estado ───────────────────────────────────────────────
const findTask = (ref) => {
  const k = String(ref || '').trim();
  const t = k && store.get().tasks.find((x) => x.id === k || (x.code && x.code === k.toUpperCase()));
  if (!t) throw fail(404, `Tarea no encontrada: ${k || '(sin código)'}`);
  return t;
};
const findAgent = (ref) => {
  const k = String(ref || '').trim();
  const a = k && store.get().agents.find((x) => x.id === k || x.name.toLowerCase() === k.toLowerCase());
  if (!a) throw fail(404, `Agente no encontrado: ${k || '(sin id)'}`);
  return a;
};
const findProject = (ref) => {
  const k = String(ref || '').trim();
  const p = k && store.get().projects.find((x) => x.id === k || x.name.toLowerCase() === k.toLowerCase() || prefixOf(x) === k.toUpperCase());
  if (!p) throw fail(404, `Proyecto no encontrado: ${k || '(sin id)'}`);
  return p;
};
const projectOf = (t) => store.get().projects.find((p) => p.id === t.projectId);
// Agente que está ejecutando la tarea (para pausar/reanudar/parar por código de tarea).
const doingAgent = (code) => { const t = findTask(code); if (t.status !== 'doing' || !t.agentId) throw fail(409, `La tarea ${t.code || t.id} no está en curso`); return t.agentId; };
const agentOfTask = (t) => store.get().agents.find((a) => a.id === t.agentId);

const brief = (t) => ({
  id: t.id, code: t.code, title: t.title, status: t.status, kind: t.kind, role: t.role, repo: t.repo, projectId: t.projectId,
  agentId: t.agentId || t.assignedAgentId || null, branch: t.branch || null, dependsOn: t.dependsOn.map((d) => store.get().tasks.find((x) => x.id === d)?.code || d), updatedAt: t.updatedAt,
});
const briefAgent = (a) => ({ id: a.id, name: a.name, role: a.role, engine: a.engine, model: a.model, status: a.status, activity: a.activity || '', taskId: a.taskId || null });

// Tarea a partir de {code} o, si se da {agentId}, la que el agente lleva ahora o la última que hizo.
const taskFrom = ({ code, agentId }) => {
  if (code) return findTask(code);
  const a = findAgent(agentId);
  const mine = store.get().tasks.filter((t) => t.agentId === a.id).sort((x, y) => y.updatedAt - x.updatedAt);
  const t = mine.find((x) => x.status === 'doing') || mine[0];
  if (!t) throw fail(404, `${a.name} no tiene tareas`);
  return t;
};
const lastActions = (agentId, limit = 20) => {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  return (store.allLogs()[agentId] || []).slice(-n).map((l) => ({ ts: l.ts, line: l.line }));
};

// Comandos para la UI (navegar, abrir, enseñar): salen por el bus → SSE `event: ui`. Van al cliente que el usuario
// tiene delante (el del último contexto publicado) o a todos si no hay ninguno. Nunca capturas: son órdenes estructuradas.
function ui(cmd, ctx) {
  const client = ctx?.client || context.get().client || null;
  store.bus.emit('ui', { ...cmd, client, at: Date.now() });
  return { sent: true, client };
}

// FT-44: una tarea puede tener rama en varios repos; `files` son rutas relativas (con `repo:` delante fuera del principal)
// y `repos` el detalle por repo.
const gitFiles = async (t) => {
  const p = projectOf(t);
  const xs = p ? team.taskRepos(p, t) : [];
  if (!t.branch || !xs.length) return { files: [], note: t.branch ? 'La tarea no tiene repo' : 'La tarea no tiene rama (motor demo o sin empezar)' };
  const repos = {}, files = [], notes = [];
  for (const x of xs) {
    if (!(await git.branchExists(x.repo, x.branch))) { notes.push(`La rama ${x.branch} ya se fusionó en ${x.repo.baseBranch} (${x.key}) y se borró (tarea ${t.status}); los ficheros están en el diffStat de la tarea y en git log de ${x.key}`); continue; }
    const out = await git.git(x.repo.path, 'diff', '--name-only', `${x.repo.baseBranch}...${x.branch}`);
    const list = out ? out.split('\n') : [];
    repos[x.key] = { files: list, base: x.repo.baseBranch, branch: x.branch };
    files.push(...list.map((f) => x.main ? f : `${x.key}:${f}`));
  }
  return { files, ...(xs.length > 1 ? { repos } : {}), base: xs[0].repo.baseBranch, branch: t.branch, ...(notes.length ? { note: notes.join(' · ') } : {}) };
};

// ── Escritorio (FT-22) · regla «solo fuera»: si la ventana activa es flow-test/AgentOffice no se devuelve nada del escritorio ──
const INSIDE_RE = () => new RegExp(`flow[-_ ]?test|agentoffice|agent office|(localhost|127\\.0\\.0\\.1):${process.env.AO_PORT || 7420}\\b`, 'i');
const INSIDE = { inside: true, hint: 'usa app.getContext' };
const isInside = (w) => !!w && INSIDE_RE().test(`${w.title || ''} ${w.app || ''}`);
// Se ejecuta antes de la política: si el usuario está dentro de la app no hay nada que confirmar.
const outsideOnly = async () => (isInside(await getProvider().getActive()) ? INSIDE : null);
// FT-29 · ui.*: actuar por semántica sobre otras apps (AT-SPI). Nunca sobre flow-test/AgentOffice (ya tienen API interna).
// Palabras (por prefijo, sin acentos ni mayúsculas) cuyo control hace que ui.act se trate como `irreversible`.
export const DESTRUCTIVE_WORDS = ['eliminar', 'elimina', 'borrar', 'borra', 'delete', 'remove', 'enviar', 'envia', 'send', 'pagar', 'paga', 'pay', 'comprar', 'compra', 'buy', 'purchase', 'confirmar', 'confirma', 'confirm', 'aceptar', 'acepta', 'accept', 'submit', 'publicar', 'publish', 'desinstalar', 'uninstall', 'formatear', 'vaciar', 'empty', 'descartar', 'discard', 'sobrescribir', 'overwrite'];
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const isDestructive = (node) => plain(`${node?.name || ''} ${node?.role || ''}`).split(/[^a-z0-9]+/).some((w) => w && DESTRUCTIVE_WORDS.some((d) => w.startsWith(d)));
// ¿Alguna ventana del pid (o la indicada) es flow-test/AgentOffice? Con pid/windowId vacíos ya vale outsideOnly (ventana activa).
const insideTarget = async ({ pid, windowId }) => {
  if (!pid && !windowId) return null;
  const hit = (await getProvider().list()).filter((w) => (windowId ? w.id === windowId : w.pid === pid));
  return hit.some(isInside) ? INSIDE : null;
};
const uiPrecheck = async (args) => (await outsideOnly()) || insideTarget(args);
const uiTarget = { pid: { type: 'integer', description: 'pid de la app (por defecto, la de la ventana activa)' }, windowId: str('Id de ventana (alternativa a pid)') };
const a11y = () => { const d = getProvider(), av = d.a11yAvailable(); if (!av.ok) throw Object.assign(fail(503, `AT-SPI no disponible: falta ${av.missing.join(', ')}`), { missing: av.missing }); return d; };
const clip = (w) => ({ ...w, title: String(w.title || '').slice(0, 200) });

// FT-30 · Fallback de entrada (ratón/teclado ciegos). Apagado de serie: `settings.guideInputFallback` (Ajustes ▸ Guide Agent).
// Atajos que keyboard.keyPress trata como `irreversible` (confirmación SIEMPRE). «enter» a secas: no se sabe si hay un diálogo delante.
export const IRREVERSIBLE_KEYS = ['enter', 'ctrl+w', 'ctrl+q', 'alt+f4', 'shift+delete', 'delete', 'ctrl+enter'];
export const isIrreversibleKeys = (keys) => { try { return IRREVERSIBLE_KEYS.includes(parseKeys(keys).canon); } catch { return false; } };
// precheck: 403 con el ajuste apagado; después, regla «solo fuera» (ventana activa = flow-test/AgentOffice → {inside:true})
const inputPrecheck = async () => {
  if (!getPolicy().guideInputFallback) throw fail(403, 'fallback de ratón/teclado desactivado en Ajustes');
  return outsideOnly();
};
const inputProvider = () => { const d = getProvider(), av = d.inputAvailable(); if (!av.ok) throw Object.assign(fail(503, `entrada no disponible: falta ${av.missing.join(', ')}`), { missing: av.missing }); return d; };
const LAST = 'ÚLTIMO RECURSO: antes ui.find/ui.act. Entrada «ciega» sin ver el resultado; ';
const OUTSIDE = 'Si la ventana activa es flow-test/AgentOffice responde {inside:true} sin tocar nada. Desactivada de serie (Ajustes ▸ Guide Agent): con el ajuste apagado responde 403.';
const xy = { x: { type: 'integer', description: 'Coordenada X en píxeles de pantalla' }, y: { type: 'integer', description: 'Coordenada Y en píxeles de pantalla' } };


// ── Navegador del agente (FT-115) · regla «solo fuera»: ni se navega ni se actúa sobre la UI de AgentOffice/flow-test ──
const urlInside = (u) => {
  if (INSIDE_RE().test(String(u))) return true;
  try { return new URL(u).host === new URL(flowTestUrl()).host; } catch { return false; }
};
// Si el navegador está abierto y la pestaña activa es nuestra UI → {inside:true} sin tocar nada.
// FT-116: además, la pestaña activa debe pasar la política de dominios (403 si está bloqueada, p. ej. tras una redirección).
async function browserPrecheck() {
  const d = getDriver();
  if (!d.isOpen()) return null;
  const tab = (await d.tabs.list()).find((t) => t.active);
  if (tab && urlInside(tab.url)) return INSIDE;
  if (tab?.url) await bpolicy.guard(tab.url);
  return null;
}
// URL a la que apunta la llamada (navigate/tabs new) o, si no, la de la pestaña activa: inside → INSIDE; si no, política de dominios.
const urlPrecheck = async (a) => {
  if (a.url) { if (urlInside(a.url)) return INSIDE; await bpolicy.guard(a.url); return null; }
  return browserPrecheck();
};
// URL (sin query) de la página sobre la que actúa una tool, para el audit
const pageUrl = async (args) => { try { if (args?.url) return bpolicy.auditUrl(args.url); const d = getDriver(); return d.isOpen() ? bpolicy.auditUrl((await d.tabs.list()).find((t) => t.active)?.url) : null; } catch { return null; } };
// Último snapshot visto por pestaña: permite saber el nombre del control antes de pulsarlo (política dinámica).
const seenNodes = new Map();
const remember = (s) => { for (const k of [...seenNodes.keys()]) if (k.startsWith(`${s.tabId}:`)) seenNodes.delete(k); for (const n of s.nodes) seenNodes.set(`${s.tabId}:${n.ref}`, n); };
const nodeOf = (ref) => { if (!ref) return null; for (const [k, n] of seenNodes) if (k.endsWith(`:${ref}`)) return n; return null; };
const nodeInfo = (ref) => { const n = nodeOf(ref); return n ? `Control: «${n.name}» (${n.role}) [${ref}]` : `Control: ${ref || 'elemento con foco'}`; };
// click: control destructivo → irreversible (confirmación siempre), como ui.act
const refDynamic = async (a) => {
  const n = nodeOf(a.ref);
  const ctx = `Navegador del agente\n${nodeInfo(a.ref)}\nAcción: ${a.action || 'click'}`;
  if (n && isDestructive(n)) return { policy: 'irreversible', context: `⚠ Control potencialmente destructivo\n${ctx}` };
  // FT-116: botón/enlace en una página con campos de contraseña o tarjeta → puede enviar credenciales o un pago
  if (n && n.role === 'button' && pageHasSensitiveField(n)) return { policy: 'irreversible', context: `⚠ Página con campos de contraseña/pago: esto puede enviar el formulario\n${ctx}` };
  return { policy: 'execute', context: ctx };
};
// ¿El último snapshot de la pestaña del nodo tiene un campo de contraseña/tarjeta?
const pageHasSensitiveField = (n) => { const key = [...seenNodes].find(([, v]) => v === n)?.[0]; const tab = key?.slice(0, key.lastIndexOf(':')); for (const [k, x] of seenNodes) if (k.startsWith(`${tab}:`) && ['textbox', 'searchbox'].includes(x.role) && (x.states?.includes('protected') || bpolicy.SENSITIVE_FIELD.test(x.name || ''))) return true; return false; };

// ── Workspace de flow-test (los flows NO están en los repos: viven en flows/ de flow-test, con enlaces a cada repo) ──
async function ftGet(pathAndQuery) {
  let r;
  try { r = await fetch(flowTestUrl() + pathAndQuery, { signal: AbortSignal.timeout(8000) }); } catch (e) { throw fail(502, `flow-test no responde (${flowTestUrl()}): ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, j.error || `flow-test respondió HTTP ${r.status}`);
  return j;
}
const cut = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// Método y URL de un curl, para el resumen de un nodo HTTP.
const curlLine = (c) => { const src = String(c || ''); const m = src.match(/-X\s+([A-Z]+)/); const u = src.match(/["']?((?:https?:\/\/|\{\{)[^\s"']+)/); return cut(`${m ? m[1] : 'GET'} ${u ? u[1] : ''}`, 140); };
export function summarizeFlow(flow, max = 150) {
  const nodes = [
    ...(flow.nodes || []).map((n) => ({ id: n.id, kind: 'http', name: cut(n.name, 90), detail: curlLine(n.curl) })),
    ...(flow.sqlNodes || []).map((n) => ({ id: n.id, kind: 'sql', name: cut(n.name, 90), detail: cut(n.query || n.sql || '', 120) })),
    ...(flow.webNodes || []).map((n) => ({ id: n.id, kind: 'web', name: cut(n.name, 90), detail: cut(n.url || '', 120) })),
    ...(flow.infoNodes || []).map((n) => ({ id: n.id, kind: n.renderMode === 'mermaid' ? 'mermaid' : n.renderMode === 'image' ? 'imagen' : 'nota', name: cut(n.name, 90), detail: cut(n.content || '', 160) })),
  ];
  return { name: flow.name || '', counts: nodes.reduce((m, n) => ((m[n.kind] = (m[n.kind] || 0) + 1), m), {}), connections: (flow.connections || []).length,
    drawings: (flow.drawings || []).length, variables: Object.keys(flow.envVariables || {}).length, nodes: nodes.slice(0, max), truncated: nodes.length > max ? nodes.length - max : 0 };
}

// ── Registro ────────────────────────────────────────────────────────────────
const T = (name, description, input, policy, handler, extra = {}) => ({ name, description, input, policy, handler, ...extra });
const later = (name, description, input, policy, who = 'FT-5') =>
  T(name, `${description} (aún no disponible: lo implementa ${who}; responde 501)`, input, policy, () => { throw fail(501, `${name} aún no está implementado (${who})`); }, { pending: true });

export const tools = [
  // — App / navegación —
  T('app.getContext', 'Qué está viendo el usuario ahora: vista, proyecto, tarea abierta, agente seleccionado, últimos eventos y contexto de flow-test.', obj({ client: str('Id de cliente (opcional; por defecto el más reciente)') }), 'read',
    ({ client }) => context.get(client)),
  T('app.navigate', 'Lleva la UI a una vista (office|summary|tasks|agents|guide|browser|settings) y, si se indica, a un proyecto. Con view=office y projectId la Oficina entra en la planta (sala) de ese proyecto; sin projectId muestra lo que haya (edificio, planta o agente, app.getContext.officeLevel, FT-71).', obj({ view: { type: 'string', enum: VIEWS }, projectId: str('Id o nombre del proyecto (opcional)') }, ['view']), 'navigate',
    ({ view, projectId }, ctx) => ({ ...ui({ type: 'navigate', view, projectId: projectId ? findProject(projectId).id : null }, ctx), view }) ),
  T('app.openTask', 'Abre en la UI el modal de una tarea.', obj({ code: str('Código de la tarea, p. ej. FT-4') }, ['code']), 'navigate',
    ({ code }, ctx) => { const t = findTask(code); return { ...ui({ type: 'openTask', taskId: t.id, projectId: t.projectId }, ctx), task: t.code || t.id }; }),
  T('app.selectAgent', 'Abre en la UI el panel de un agente.', obj({ agentId: str('Id o nombre del agente') }, ['agentId']), 'navigate',
    ({ agentId }, ctx) => { const a = findAgent(agentId); return { ...ui({ type: 'selectAgent', agentId: a.id }, ctx), agent: a.name }; }),
  T('app.openArtifact', 'Abre la tarea en la UI y devuelve su diff (rama base...rama de la tarea).', obj({ code: str('Código de la tarea') }, ['code']), 'navigate',
    async ({ code }, ctx) => { const t = findTask(code); ui({ type: 'openTask', taskId: t.id, projectId: t.projectId }, ctx); return { task: t.code || t.id, diff: (await team.taskDiff(t.id)).slice(0, 20_000) }; }),
  T('flowtest.listFlows', 'Lista los flows del workspace de flow-test (los de cada proyecto están en su carpeta, con enlaces a los repos; NO están solo en el repo, no los busques con ls). Por defecto, la carpeta del proyecto indicado; sin projectId, todos. Filtro opcional por texto en la ruta.', obj({ projectId: str('Id o nombre del proyecto (opcional)'), query: str('Texto a buscar en la ruta (opcional)') }), 'read',
    async ({ projectId, query }) => {
      const p = projectId ? findProject(projectId) : null;
      const folder = p ? (p.folder || (p.name === 'default' ? '' : null)) : null;
      const j = await ftGet('/workspace/flows');
      const q = String(query || '').toLowerCase();
      const all = (j.files || []).filter((f) => f.type === 'flow' && !team.isWorktreeCopy(f.path)) // sin las copias de los worktrees de los agentes
        .filter((f) => folder == null || (folder === '' ? !f.path.includes('/') : f.path.startsWith(folder + '/')))
        .filter((f) => !q || f.path.toLowerCase().includes(q));
      return { folder: folder ?? (p ? null : '(todas)'), total: all.length, flows: all.slice(0, 300).map((f) => ({ path: f.path, name: f.name, mtime: f.mtime })), truncated: Math.max(0, all.length - 300),
        ...(p && folder == null ? { note: `El proyecto «${p.name}» no tiene carpeta en el workspace de flow-test` } : {}) };
    }),
  T('flowtest.readFlow', 'Lee un flow del workspace de flow-test y devuelve su resumen: nombre, nodos (HTTP con método y URL, SQL, web, notas con su texto, diagramas), conexiones y variables. Usa la ruta que da flowtest.listFlows.', obj({ path: str('Ruta del flow dentro de flows/, p. ej. flowtest/agent-office/x.flow.json') }, ['path']), 'read',
    async ({ path: rel }) => { const j = await ftGet(`/workspace/flow?path=${encodeURIComponent(rel)}`); return { path: j.path, mtime: j.mtime, ...summarizeFlow(j.flow || {}) }; }),
  T('flowtest.show', 'Pide a flow-test (host, FT-3) que muestre un flow y, opcionalmente, un nodo. Solo tiene efecto con AgentOffice embebido en flow-test.', obj({ flow: str('Ruta o nombre del flow'), node: str('Id del nodo (opcional)') }, ['flow']), 'navigate',
    ({ flow, node }, ctx) => ({ ...ui({ type: 'flowtest.show', flow, node: node || null }, ctx), flow, node: node || null })),

  // — Proyectos y tareas —
  T('project.list', 'Lista los proyectos (id, nombre, prefijo, repos, si están en marcha, tareas por estado).', obj(), 'read',
    () => store.get().projects.map((p) => ({ id: p.id, name: p.name, prefix: prefixOf(p), running: !!p.running, repos: (p.repos || []).map((r) => r.key), team: p.team,
      tasks: store.get().tasks.filter((t) => t.projectId === p.id).reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {}) }))),
  T('task.list', 'Lista tareas, filtradas por proyecto y/o estado.', obj({ projectId: str('Id o nombre del proyecto'), status: { type: 'string', enum: team.STATUSES } }), 'read',
    ({ projectId, status }) => { const pid = projectId ? findProject(projectId).id : null; return store.get().tasks.filter((t) => (!pid || t.projectId === pid) && (!status || t.status === status)).map(brief); }),
  T('task.get', 'Detalle de una tarea: descripción, resumen del agente, diffStat, error, preguntas y respuestas.', obj({ code: str('Código de la tarea') }, ['code']), 'read',
    ({ code }) => { const t = findTask(code); return { ...brief(t), context: t.context || null, description: t.description, summary: t.summary, diffStat: t.diffStat, repos: t.repos || null, outsideWrites: t.outsideWrites || null, error: t.error, feedback: t.feedback, questions: t.questions || [], costUsd: t.costUsd, attempts: t.attempts, createdAt: t.createdAt }; }),
  // FT-7: borrador de tarea con la IA de «✨ Redactar con IA» + el contexto que el usuario tiene delante. No crea nada.
  T('task.draft', 'Redacta (sin crearlo) el borrador de una tarea a partir de lo que pide el usuario y de lo que está viendo (flow/nodo de flow-test, tarea o agente abiertos): título, descripción con «Hecho cuando», rol, repo y skills. Enséñaselo al usuario y, si lo aprueba, pásalo a task_create. Tarda unos segundos.', obj({
    projectId: str('Id o nombre del proyecto'), text: str('Lo que pide el usuario, tal cual'),
  }, ['projectId', 'text']), 'read',
  async ({ projectId, text }, ctx) => {
    const p = findProject(projectId);
    const c = context.get(ctx?.client);
    const { costUsd, ...draft } = await draftTask({ projectId: p.id, text, context: cleanContext(c), model: store.get().settings.guideModel || '' });
    return { projectId: p.id, ...draft };
  }),
  T('task.create', 'Crea una tarea en un proyecto (entra en la cola del equipo con su código). Guarda en la tarea el contexto que el usuario tenía delante (flow/nodo, tarea o agente abiertos) para que se vea «Nació de…» y el worker lo sepa; para título/descripción/rol usa antes task_draft.', obj({
    projectId: str('Id o nombre del proyecto'), title: str('Título'), description: str('Descripción / criterios de aceptación'), role: str('Rol que la hará (back, front, qa, po…)'),
    repo: str('Clave del repo (opcional)'), dependsOn: { type: 'array', items: { type: 'string' }, description: 'Códigos de tareas de las que depende' }, status: { type: 'string', enum: ['backlog', 'todo'] },
    skills: { type: 'array', items: { type: 'string' }, description: 'Skills sugeridas (de las del rol)' },
  }, ['projectId', 'title', 'role']), 'write',
  ({ projectId, title, description, role, repo, dependsOn = [], status, skills = [] }, ctx) => {
    const t = team.createTask({ projectId: findProject(projectId).id, title, description, role, repo: repo || null, dependsOn: dependsOn.map((c) => findTask(c).id), status: status || 'todo', skills, context: cleanContext(context.get(ctx?.client)) });
    return brief(t);
  }),
  T('task.update', 'Edita una tarea que no esté en curso (título, descripción, rol, repo, estado backlog/todo, dependencias).', obj({
    code: str('Código de la tarea'), title: str('Título'), description: str('Descripción'), role: str('Rol'), repo: str('Clave del repo'),
    status: { type: 'string', enum: ['backlog', 'todo'] }, dependsOn: { type: 'array', items: { type: 'string' }, description: 'Códigos de dependencias' },
  }, ['code']), 'write',
  ({ code, dependsOn, ...patch }) => brief(team.updateTask(findTask(code).id, { ...patch, ...(dependsOn ? { dependsOn: dependsOn.map((c) => findTask(c).id) } : {}) })) ),
  T('task.assign', 'Fija qué agente hará una tarea que aún no ha empezado (debe estar fichado en el proyecto). agentId vacío = volver a elegir por rol.', obj({ code: str('Código de la tarea'), agentId: str('Id o nombre del agente') }, ['code']), 'write',
    ({ code, agentId }) => brief(team.assignTask(findTask(code).id, agentId ? findAgent(agentId).id : null))),
  T('task.getStatus', 'Estado de una tarea con sus últimas acciones (log del agente) y eventos del Activity Stream.', obj({ code: str('Código de la tarea'), limit: { type: 'integer', description: 'Máx. de acciones/eventos (20 por defecto)' } }, ['code']), 'read',
    ({ code, limit }) => { const t = findTask(code); return { ...brief(t), activity: agentOfTask(t)?.activity || '', error: t.error, lastActions: t.agentId ? lastActions(t.agentId, limit) : [], events: activity.list({ taskId: t.id, limit: Number(limit) || 20 }) }; }),
  T('task.pause', 'Pausa al agente que trabaja en la tarea (SIGSTOP al proceso; la tarea sigue en curso).', obj({ code: str('Código de la tarea') }, ['code']), 'execute',
    ({ code }) => briefAgent(team.pauseAgent(doingAgent(code)))),
  T('task.resume', 'Reanuda al agente pausado de la tarea.', obj({ code: str('Código de la tarea') }, ['code']), 'execute',
    ({ code }) => briefAgent(team.resumeAgent(doingAgent(code)))),
  T('task.stop', 'Detiene al agente que trabaja en la tarea (mata su proceso; la tarea queda fallida y se puede reintentar).', obj({ code: str('Código de la tarea') }, ['code']), 'execute',
    ({ code }) => { team.stopAgent(doingAgent(code)); return { stopped: true }; }),
  T('task.updateFromBase', 'Actualiza con la rama base (main) la rama de una tarea en revisión: si entra limpia queda lista para aprobar; si choca, la tarea vuelve al agente con el feedback del conflicto (FT-19).', obj({ code: str('Código de la tarea') }, ['code']), 'execute',
    async ({ code }) => team.updateFromBase(findTask(code).id)),
  T('task.addConstraint', 'Añade una restricción persistente a la tarea: se incluye siempre en el prompt del agente, también tras Devolver.', obj({ code: str('Código de la tarea'), text: str('Restricción, p. ej. «no toques server/index.js»') }, ['code', 'text']), 'write',
    ({ code, text }) => brief(team.addConstraint(findTask(code).id, text, 'guide'))),
  T('agent.message', 'Envía una instrucción a un agente que está trabajando (Claude: en caliente; Codex/demo: reencola la tarea con el mensaje). constraint=true la guarda además como restricción de la tarea.', obj({ agentId: str('Id o nombre del agente'), message: str('Mensaje'), constraint: { type: 'boolean', description: 'Guardarla como restricción persistente de la tarea' } }, ['agentId', 'message']), 'write',
    ({ agentId, message, constraint }) => team.messageAgent(findAgent(agentId).id, { text: message, constraint: !!constraint, origin: 'guide' })),

  // — Agentes —
  T('agent.list', 'Lista los agentes de la empresa (rol, motor, estado, actividad actual).', obj({ projectId: str('Solo la plantilla de este proyecto (opcional)') }), 'read',
    ({ projectId }) => { const ids = projectId ? new Set(findProject(projectId).team) : null; return store.get().agents.filter((a) => !ids || ids.has(a.id)).map(briefAgent); }),
  T('agent.status', 'Estado de un agente y la tarea que lleva.', obj({ agentId: str('Id o nombre del agente') }, ['agentId']), 'read',
    ({ agentId }) => { const a = findAgent(agentId); const t = store.get().tasks.find((x) => x.agentId === a.id && x.status === 'doing'); return { ...briefAgent(a), task: t ? brief(t) : null }; }),
  T('agent.getLastActions', 'Últimas acciones de un agente: líneas de su log y eventos recientes.', obj({ agentId: str('Id o nombre del agente'), limit: { type: 'integer', description: 'Máx. (20 por defecto)' } }, ['agentId']), 'read',
    ({ agentId, limit }) => { const a = findAgent(agentId); return { agent: a.name, log: lastActions(a.id, limit), events: activity.list({ agentId: a.id, limit: Number(limit) || 20 }) }; }),
  T('agent.getModifiedFiles', 'Ficheros que ha modificado una tarea/agente (git diff --name-only base...rama, en cada repo con rama; los de repos secundarios llevan «repo:» delante).', obj({ code: str('Código de la tarea'), agentId: str('Alternativa: agente (su tarea actual o la última)') }), 'read',
    async (a) => { const t = taskFrom(a); return { task: t.code || t.id, ...(await gitFiles(t)) }; }),
  T('agent.getArtifacts', 'Artefactos de una tarea/agente: diffStat, resumen y commits de la rama (por repo si hay varios) y, si los hay, avisos de escritura fuera del worktree.', obj({ code: str('Código de la tarea'), agentId: str('Alternativa: agente (su tarea actual o la última)') }), 'read',
    async (a) => {
      const t = taskFrom(a);
      const p = projectOf(t);
      const commits = [], repos = {};
      for (const x of p ? team.taskRepos(p, t) : []) {
        let list = [];
        if (await git.branchExists(x.repo, x.branch)) { const out = await git.git(x.repo.path, 'log', '--format=%h %s', `${x.repo.baseBranch}..${x.branch}`); list = out ? out.split('\n') : []; }
        else { const out = await git.git(x.repo.path, 'log', '--format=%h %s', '--grep', `Merge branch '${x.branch}'`, '-1'); list = out ? [out + ' (ya fusionada)'] : []; }
        repos[x.key] = { branch: x.branch, diffStat: t.repos?.[x.key]?.diffStat ?? (x.main ? t.diffStat : ''), commits: list };
        commits.push(...list.map((c) => x.main ? c : `${x.key}: ${c}`));
      }
      return { task: t.code || t.id, branch: t.branch || null, summary: t.summary, diffStat: t.diffStat, commits, ...(Object.keys(repos).length > 1 ? { repos } : {}), ...(t.outsideWrites ? { outsideWrites: t.outsideWrites } : {}) };
    }),

  // — Integraciones deterministas (FT-10): IDE, git, filesystem, terminal, navegador. Solo repos/worktrees del proyecto —
  T('ide.openFile', 'Abre un fichero en el IDE del usuario (AO_IDE_CMD, por defecto VS Code) en una línea. Con «task» abre la copia del worktree de la tarea y, si no das «line», la del primer hunk de su diff. «path» es relativo al repo (como lo devuelve agent_getModifiedFiles). Si responde 503 no hay IDE: enseña el diff con app_openArtifact.',
    obj({ path: str('Fichero, relativo al repo/worktree'), line: { type: 'integer', description: 'Línea (opcional)' }, task: str('Código de la tarea a la que pertenece el fichero (recomendado)'), repo: str('Clave del repo (si no das tarea)') }, ['path']), 'navigate',
    (a) => integ.ideOpenFile(a)),
  T('git.status', 'git status del repo (o del worktree de la rama indicada).', obj({ repo: str('Clave del repo'), branch: str('Rama de una tarea (opcional)') }, ['repo']), 'read', (a) => integ.gitStatus(a)),
  T('git.diff', 'git diff de UN repo (clave): con «branch», rama base...rama (en tareas multi-repo, una llamada por repo); sin ella, los cambios sin confirmar frente a HEAD. Recortado a 200 KB.', obj({ repo: str('Clave del repo'), branch: str('Rama de una tarea (opcional)') }, ['repo']), 'read', (a) => integ.gitDiff(a)),
  T('git.log', 'git log del repo (o de una rama): hash, fecha, autor y asunto.', obj({ repo: str('Clave del repo'), branch: str('Rama (opcional)'), limit: { type: 'integer', description: 'Máx. de commits (20 por defecto, 100 como mucho)' } }, ['repo']), 'read', (a) => integ.gitLog(a)),
  T('filesystem.read', 'Lee un fichero de un repo/worktree del proyecto (máx. 200 KB). Nunca .env, .git ni data/; fuera del repo da error.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (lee su worktree)'), path: str('Fichero, relativo al repo') }, ['path']), 'read', (a) => integ.fsRead(a)),
  T('filesystem.write', 'Escribe (crea o sobrescribe) un fichero dentro de un repo/worktree del proyecto (máx. 200 KB). Pide confirmación. Nunca .env, .git ni data/.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (escribe en su worktree)'), path: str('Fichero, relativo al repo'), content: str('Contenido completo') }, ['path', 'content']), 'write', (a) => integ.fsWrite(a)),
  T('terminal.execute', 'Ejecuta un comando en la raíz de un repo/worktree, sin shell (nada de ; & | > $ ni sustituciones). Solo la lista blanca de los workers (npm, node, git status/diff/log/add/commit…, ls, cat, grep…; sin rm, sudo, docker, ssh ni git push). Timeout 60 s y salida recortada.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (corre en su worktree)'), cmd: str('Comando, p. ej. «git status --short»') }, ['cmd']), 'execute', (a) => integ.terminalExecute(a)),
  T('browser.open', 'Abre una URL http(s) en el navegador NORMAL del usuario (xdg-open) para que ÉL la vea; no devuelve nada ni se puede controlar. Para leer o manejar una web tú mismo usa browser.navigate + browser.snapshot (navegador dedicado del agente).', obj({ url: str('URL') }, ['url']), 'navigate', (a) => integ.browserOpen(a)),

  // — Navegador del agente (FT-115, sobre el driver de FT-114): Chromium dedicado por CDP. Flujo: snapshot → actuar por ref → snapshot —
  T('browser.tabs', 'Pestañas del navegador del agente (Chromium dedicado, no el del usuario). action: list (por defecto) | new (url opcional) | select | close (con id). Abre el navegador si hace falta. Nunca sobre flow-test/AgentOffice ({inside:true}).',
    obj({ action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, id: str('Id de pestaña (select/close)'), url: str('URL http(s) (new)') }), 'read',
    async ({ action = 'list', id, url }) => { const b = agentDriver().tabs; return action === 'new' ? b.new({ url }) : action === 'select' ? b.select({ id }) : action === 'close' ? b.close({ id }) : b.list(); },
    { precheck: urlPrecheck }),
  T('browser.navigate', 'Navega la pestaña activa del navegador del agente a una URL http(s), o con action=back|forward|reload. Después haz browser.snapshot. Para mostrar una web al usuario usa browser.open. Nunca flow-test/AgentOffice ({inside:true}).',
    obj({ url: str('URL http(s)'), action: { type: 'string', enum: ['back', 'forward', 'reload'] } }), 'navigate',
    async ({ url, action }) => { const d = agentDriver(); if (action) return d[action](); if (!url) throw fail(400, 'Falta «url» o «action»'); return d.navigate({ url }); },
    { precheck: urlPrecheck }),
  T('browser.snapshot', 'PRIMERO SIEMPRE: árbol de accesibilidad compacto de la pestaña activa, una línea por nodo `[e12] button "Enviar"`. Usa esas refs en click/type/select/scroll. No gasta tokens de imagen: usa browser.screenshot solo si necesitas VER el aspecto (gráficos, maquetación).',
    obj(), 'read', async () => { const s = await agentDriver().snapshot(); remember(s); return bpolicy.untrusted({ tabId: s.tabId, url: s.url, title: s.title, total: s.total, truncated: s.truncated, snapshot: bpolicy.wrapUntrusted(renderSnapshot(s)) }); },
    { precheck: browserPrecheck }),
  T('browser.find', 'Busca nodos de la pestaña activa por rol exacto (button, link, textbox…) y/o texto (subcadena del nombre o valor, sin mayúsculas). Devuelve sus refs; más barato que leer todo el snapshot.',
    obj({ role: str('Rol, p. ej. «button»'), text: str('Texto del nombre o valor') }), 'read',
    async ({ role, text }) => {
      if (!role && !text) throw fail(400, 'Indica «role» y/o «text»');
      const s = await agentDriver().snapshot(); remember(s);
      const q = plain(text);
      const nodes = s.nodes.filter((n) => (!role || n.role === role) && (!q || plain(`${n.name} ${n.value}`).includes(q))).slice(0, 50);
      return bpolicy.untrusted({ tabId: s.tabId, url: s.url, count: nodes.length, truncated: s.truncated, nodes });
    }, { precheck: browserPrecheck }),
  T('browser.click', 'Clic (o dblclick / hover / focus) en un nodo por su ref de browser.snapshot/find. Si el nombre del control parece destructivo (eliminar, enviar, pagar, confirmar…) pide confirmación SIEMPRE. Solo usa x,y si el nodo no tiene ref. Después, snapshot.',
    obj({ ref: str('ref del nodo'), action: { type: 'string', enum: ['click', 'dblclick', 'hover', 'focus'] }, x: { type: 'integer' }, y: { type: 'integer' } }), 'execute',
    async (a) => agentDriver().act({ ...a, action: a.action || 'click' }),
    { precheck: browserPrecheck, dynamic: refDynamic }),
  T('browser.type', 'Escribe texto en un campo por su ref (lo enfoca antes); rellena date/time/datetime-local/range/color/contenteditable según su tipo (formato nativo, p. ej. 2026-10-08, 19:30). El resultado trae {navigated,url,title} y, si un envío no se produjo, validation con el motivo. clear=true lo vacía antes; submit=true pulsa Enter después (irreversible: confirmación SIEMPRE). El texto NUNCA se guarda en el audit.',
    obj({ ref: str('ref del campo'), text: str('Texto'), clear: { type: 'boolean' }, submit: { type: 'boolean' } }, ['text']), 'execute',
    async (a) => agentDriver().type(a),
    { precheck: browserPrecheck, auditArgs: ({ text, ...r }) => ({ ...r, chars: [...String(text ?? '')].length }),
      dynamic: async (a) => (a.submit ? { policy: 'irreversible', context: `⚠ Escribir y pulsar Enter (puede enviar el formulario)\n${nodeInfo(a.ref)}` } : null) }),
  T('browser.select', 'Elige una opción de un <select> por su ref (value o texto visible). En <select multiple> varias separadas por «|» (p. ej. «Bacon|Onion»).',
    obj({ ref: str('ref del select'), value: str('Valor o texto de la opción (varias con «|» si es múltiple)') }, ['ref', 'value']), 'execute',
    async ({ ref, value }) => agentDriver().act({ ref, action: 'select', value }), { precheck: browserPrecheck }),
  T('browser.upload', 'FT-130 · Adjunta ficheros a un <input type=file> por su ref (dispara input/change). «paths»: rutas absolutas dentro de data/uploads (adjuntos del chat o de la tarea). Pide confirmación. Después, snapshot.',
    obj({ ref: str('ref del campo de fichero'), paths: { type: 'array', items: { type: 'string' }, description: 'Rutas absolutas de data/uploads' } }, ['ref', 'paths']), 'execute',
    async ({ ref, paths }) => agentDriver().upload({ ref, files: resolveRefs((Array.isArray(paths) ? paths : [paths]).map((p) => ({ path: p }))).map((f) => f.path) }),
    { precheck: browserPrecheck, auditArgs: ({ paths, ...r }) => ({ ...r, files: [].concat(paths || []).map((p) => String(p).split('/').pop()) }),
      dynamic: async (a) => ({ policy: 'execute', context: `Subir ${[].concat(a.paths || []).length} fichero(s) a la página\n${nodeInfo(a.ref)}` }) }),
  T('browser.scroll', 'Desplaza la rueda sobre un nodo (por ref) o el centro de la página: dy>0 baja, dx>0 a la derecha (píxeles). Devuelve la posición. Después, snapshot si buscas algo más abajo.',
    obj({ ref: str('ref del nodo (opcional)'), dx: { type: 'integer' }, dy: { type: 'integer' } }), 'navigate',
    async (a) => agentDriver().scroll(a), { precheck: browserPrecheck }),
  T('browser.press', 'Pulsa una tecla (p. ej. «Tab», «Escape», «ArrowDown») en el elemento con foco o en el de «ref». Enter y Delete son irreversibles (confirmación SIEMPRE).',
    obj({ key: str('Nombre de tecla de puppeteer, p. ej. «Tab»'), ref: str('ref a enfocar antes (opcional)') }, ['key']), 'execute',
    async ({ key, ref }) => agentDriver().type({ ref, key }),
    { precheck: browserPrecheck, dynamic: async ({ key, ref }) => (/^(enter|delete|numpadenter)$/i.test(key) ? { policy: 'irreversible', context: `⚠ Tecla «${key}»\n${nodeInfo(ref)}` } : null) }),
  T('browser.waitFor', 'Espera a que aparezca un texto, un selector CSS o una URL (subcadena), o simplemente ms. timeout en ms (10 s por defecto); 408 si no ocurre.',
    obj({ text: str('Texto visible'), selector: str('Selector CSS'), url: str('Subcadena de URL'), ms: { type: 'integer' }, timeout: { type: 'integer' } }), 'read',
    async (a) => agentDriver().waitFor(a), { precheck: browserPrecheck }),
  T('browser.screenshot', 'Captura la pestaña activa y DEVUELVE LA IMAGEN (además de la ruta en data/browser/captures; máx. 1280 px de ancho). Cuesta más que browser.snapshot: úsala solo cuando necesites VER el aspecto. Actúa siempre por ref, no por coordenadas de la imagen.',
    obj({ fullPage: { type: 'boolean', description: 'Toda la página, no solo lo visible' }, format: { type: 'string', enum: ['png', 'jpeg'] } }), 'read',
    async (a, ctx) => {
      const r = await agentDriver().screenshot(a);
      // por MCP la imagen viaja en base64 (ao-mcp la convierte en contenido `image`); por la API normal solo la ruta
      return { path: r.path, width: r.width, height: r.height, bytes: r.bytes, format: r.format, ...(ctx?.via === 'mcp' ? { image: { mimeType: r.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: fs.readFileSync(r.path).toString('base64') } } : {}) };
    }, { precheck: browserPrecheck }),
  T('browser.console', 'Mensajes de consola de la pestaña activa (anillo de 200): {ts, level, text}. limit (50 por defecto); clear=true los vacía.',
    obj({ limit: { type: 'integer' }, clear: { type: 'boolean' } }), 'read', async (a) => bpolicy.untrusted(await agentDriver().console(a)), { precheck: browserPrecheck }),
  T('browser.network', 'Peticiones de red de la pestaña activa (anillo de 200): método, URL, estado, tipo; cabeceras sensibles enmascaradas. limit (50 por defecto); clear=true las vacía.',
    obj({ limit: { type: 'integer' }, clear: { type: 'boolean' } }), 'read', async (a) => bpolicy.untrusted(await agentDriver().network(a)), { precheck: browserPrecheck }),
  T('browser.evaluate', 'Ejecuta una expresión JavaScript en la página activa y devuelve el valor (recortado a 20 KB). Puede hacer cualquier cosa en la página: pide confirmación. Prefiere snapshot/click/type.',
    obj({ expression: str('Expresión JS') }, ['expression']), 'execute',
    async ({ expression }) => { const r = await agentDriver().evaluate({ expression }); const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value); return bpolicy.untrusted({ value: String(v ?? '').slice(0, 20_000) }); },
    { precheck: browserPrecheck, auditArgs: ({ expression }) => ({ expression: /pass|contrase|token|secret|card|tarjeta/i.test(expression) ? `(oculta: ${String(expression).length} car.)` : summarize(expression) }),
      dynamic: async ({ expression }) => ({ policy: 'irreversible', context: `⚠ JavaScript arbitrario en la página: SIEMPRE pide confirmación\n\n\`\`\`js\n${String(expression).slice(0, 600)}\n\`\`\`` }) }),
  T('browser.requestHuman', 'Pasa el control al usuario cuando necesitas algo que no debes hacer tú: captcha, login, 2FA, datos personales o de pago. Pausa tu trabajo, avisa al usuario (🛡 con «Listo»/«Cancelar») y vuelve cuando pulse «Listo» (done:true); después haz browser.snapshot. Nunca pidas ni teclees contraseñas por tu cuenta (FT-116).',
    obj({ motivo: str('Qué tiene que hacer el usuario, en una frase') }, ['motivo']), 'navigate',
    async ({ motivo }) => {
      if (!getDriver().isOpen()) throw fail(409, 'El navegador del agente está cerrado: ábrelo con browser.navigate antes');
      await addHandoff({ reason: String(motivo).slice(0, 300) });
      await setControl('user');
      let a = null;
      try { a = await questions.choose({ question: `🤝 El agente del navegador necesita que lo hagas tú: ${String(motivo).slice(0, 300)}`, options: ['Listo', 'Cancelar'], context: 'Tienes el control del navegador (pestaña Navegador). Haz lo que haga falta —captcha, login, 2FA…— y pulsa «Listo» para que el agente continúe. Sus acciones están en pausa.' }); }
      finally { for (const h of browserStatus().handoffs.filter((x) => x.reason === String(motivo).slice(0, 300))) await resolveHandoff(h.id); await setControl('agent').catch(() => {}); }
      return a === 'Listo' ? { done: true } : { done: false, cancelled: a === 'Cancelar', timeout: a == null };
    }, { precheck: browserPrecheck }),

  // — Escritorio (FT-22): delegan en server/desktop/ —
  T('window.getActive', 'Ventana activa del escritorio del usuario (id, título, app, pid). Si es flow-test/AgentOffice responde {inside:true} y hay que usar app.getContext.', obj(), 'read',
    async () => { const w = await getProvider().getActive(); return isInside(w) ? INSIDE : clip(w); }),
  T('window.list', 'Ventanas abiertas del escritorio (id, título recortado a 200 car., app, pid, active). Si la activa es flow-test/AgentOffice responde {inside:true}.', obj(), 'read',
    async () => { const d = getProvider(); if (isInside(await d.getActive())) return INSIDE; return (await d.list()).map(clip); }),
  T('screen.capture', 'Captura el escritorio (o una ventana) a un PNG en data/desktop/captures. Devuelve ruta y metadatos, nunca la imagen. Pide confirmación la primera vez por sesión. Si la activa es flow-test/AgentOffice responde {inside:true}.',
    obj({ target: { type: 'string', enum: ['screen', 'window'], description: 'screen (por defecto) o window' }, windowId: str('Id de ventana (opcional, con target=window)') }), 'read',
    async ({ target, windowId }) => { const r = await getProvider().capture({ target: target || 'screen', windowId }); return { path: r.path, width: r.width, height: r.height, bytes: r.bytes, tool: r.tool, ts: r.ts }; },
    { confirmOnce: true, precheck: outsideOnly }),
  // FT-23: describe la pantalla con el proveedor multimodal del Guide. Último recurso: antes window.getActive / app.getContext.
  T('screen.describe', 'ÚLTIMO RECURSO: describe con el modelo multimodal lo que hay en pantalla (hace una captura o usa «capturePath» de una anterior). Antes usa window.getActive (y app.getContext si el usuario está en flow-test/AgentOffice): solo llama a esto si no basta. Pide confirmación la primera vez por sesión. Si la ventana activa es flow-test/AgentOffice responde {inside:true}. Con claude-cli responde 501 (no admite imágenes); para ver una web usa browser.screenshot (la imagen llega por MCP).',
    obj({ question: str('Qué quieres saber de la pantalla (opcional)'), capturePath: str('Ruta de una captura previa de data/desktop/captures/ (opcional; si no, captura ahora)') }), 'read',
    async ({ question, capturePath }) => {
      const file = capturePath ? vision.resolveCapture(capturePath) : (await getProvider().capture({ target: 'screen' })).path;
      const { description, provider, model } = await vision.describeImage(file, question);
      return { description, capturePath: file, provider, ...(model ? { model } : {}) };
    },
    { confirmOnce: true, precheck: async () => { vision.assertSupported(); return outsideOnly(); } }),

  // — AT-SPI (FT-29): leer y actuar por semántica en apps de fuera —
  T('ui.getTree', 'Árbol de accesibilidad (AT-SPI) de una app de fuera: nodos {ref, role, name, states, actions, bounds}. Prefiérelo a screen.capture/screen.describe. Si el objetivo es flow-test/AgentOffice responde {inside:true}.',
    obj({ ...uiTarget, depth: { type: 'integer', description: 'Profundidad (3 por defecto, máx. 6)' }, maxNodes: { type: 'integer', description: 'Máx. de nodos (200 por defecto, máx. 500)' } }), 'read',
    async (a) => a11y().uiTree(a), { precheck: uiPrecheck }),
  T('ui.find', 'Busca controles por rol exacto y/o nombre (subcadena) en una app de fuera. Devuelve los nodos con su ref para ui.act. Si el objetivo es flow-test/AgentOffice responde {inside:true}.',
    obj({ ...uiTarget, role: str('Rol AT-SPI, p. ej. «push button»'), name: str('Texto del nombre (sin distinguir mayúsculas)') }), 'read',
    async (a) => a11y().uiFind(a), { precheck: uiPrecheck }),
  T('ui.act', 'Actúa sobre un control por su ref (de ui.find/ui.getTree): click, press, focus o setText (con «text»). Si el control parece destructivo (eliminar, enviar, pagar, confirmar…) se trata como irreversible y pide confirmación SIEMPRE. Nunca actúa sobre flow-test/AgentOffice ({inside:true}).',
    obj({ ref: str('ref del nodo'), action: { type: 'string', enum: ['click', 'press', 'focus', 'setText'] }, text: str('Texto (solo setText)') }, ['ref', 'action']), 'execute',
    async ({ ref, action, text }) => { const r = await a11y().uiAct({ ref, action, text }); return { ok: r.ok !== false, ref, action, node: r.node }; },
    {
      // el ref lleva el pid de la app: se comprueba que no sea nuestra propia UI
      precheck: async (a) => (await outsideOnly()) || insideTarget({ pid: Number(String(a.ref).split(':')[0]) || undefined }),
      // política efectiva según el control: destructivo → irreversible (confirmación siempre, con app/control/acción en el modal)
      dynamic: async ({ ref, action, text }) => {
        const n = await a11y().uiNode(ref);
        if (isInside({ title: n.name, app: n.app })) throw fail(403, 'No se actúa sobre la UI de AgentOffice/flow-test');
        const ctx = `App: ${n.app} (pid ${n.pid})\nControl: «${n.name}» (${n.role})\nAcción: ${action}${action === 'setText' ? ` «${String(text || '').slice(0, 80)}»` : ''}`;
        return isDestructive(n) ? { policy: 'irreversible', context: `⚠ Control potencialmente destructivo\n${ctx}` } : { policy: 'execute', context: ctx };
      },
    }),

  // — Aplicaciones (FT-31): listar y lanzar apps instaladas —
  T('application.list', 'Lista las aplicaciones instaladas (.desktop visibles): {id, name, exec}. El id es lo único que acepta application.open.', obj(), 'read',
    async () => getProvider().listApps()),
  T('application.open', 'Abre una aplicación instalada por su «id» de application.list (sin argumentos ni comandos libres). Veta AgentOffice, flow-test y terminales (403); un id que no esté en la lista da 400.',
    obj({ id: str('id de application.list, p. ej. «gedit»') }, ['id']), 'execute',
    async ({ id }) => getProvider().openApp({ id }),
    // se valida antes de pedir confirmación: un id no válido o vetado falla sin molestar al usuario
    {
      precheck: async ({ id }) => { resolveApp(await getProvider().listApps(), id); return null; },
      // FT-32 · el modal muestra qué app se lanzará (el id ya está validado por el precheck)
      dynamic: async ({ id }) => { const a = resolveApp(await getProvider().listApps(), id); return { policy: 'execute', context: `App: ${a.name} (${a.id})\nControl: —\nAcción: abrir la aplicación` }; },
    }),
  // — Fallback de entrada (FT-30): xdotool (X11) / ydotool (Wayland) —
  T('mouse.click', `${LAST}hace clic en unas coordenadas de pantalla (left|right|middle, doble opcional). ${OUTSIDE}`,
    obj({ ...xy, button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'left por defecto' }, double: { type: 'boolean', description: 'Doble clic' } }, ['x', 'y']), 'execute',
    async (a) => { await inputProvider().click(a); return { ok: true, x: a.x, y: a.y, button: a.button || 'left', double: !!a.double }; }, { precheck: inputPrecheck }),
  T('mouse.scroll', `${LAST}desplaza la rueda (dy>0 baja, dx>0 a la derecha; en «clics» de rueda), opcionalmente tras mover el ratón a x,y. ${OUTSIDE}`,
    obj({ ...xy, dx: { type: 'integer', description: 'Horizontal (clics de rueda)' }, dy: { type: 'integer', description: 'Vertical (clics de rueda)' } }), 'execute',
    async (a) => { await inputProvider().scroll(a); return { ok: true, dx: a.dx || 0, dy: a.dy || 0 }; }, { precheck: inputPrecheck }),
  T('keyboard.type', `${LAST}teclea texto en la ventana con foco. El texto NUNCA se guarda en el audit (solo el nº de caracteres). ${OUTSIDE}`,
    obj({ text: str('Texto a teclear') }, ['text']), 'execute',
    async ({ text }) => { await inputProvider().type({ text }); return { ok: true, chars: [...text].length }; },
    { precheck: inputPrecheck, auditArgs: ({ text }) => ({ chars: [...String(text ?? '')].length }) }),
  T('keyboard.keyPress', `${LAST}pulsa un atajo (p. ej. «ctrl+s», «enter»). Enter, ctrl+w, ctrl+q, alt+f4, shift+delete, delete y ctrl+enter se tratan como irreversibles: confirmación SIEMPRE. ${OUTSIDE}`,
    obj({ keys: str('Atajo con «+», p. ej. «ctrl+s»') }, ['keys']), 'execute',
    async ({ keys }) => { await inputProvider().keyPress({ keys }); return { ok: true, keys }; },
    {
      precheck: inputPrecheck,
      // FT-32 · el modal muestra la app con foco, la tecla y la acción
      dynamic: async ({ keys }) => {
        const w = await getProvider().getActive().catch(() => null);
        const irr = isIrreversibleKeys(keys);
        const ctx = `App: ${w?.app || w?.title || 'ventana activa'}\nControl: ventana con foco\nAcción: pulsar «${keys}»`;
        return { policy: irr ? 'irreversible' : 'execute', context: irr ? `⚠ Atajo potencialmente destructivo\n${ctx}` : ctx };
      },
    }),

  // — Ejecución y borrado —
  T('project.run', 'Pone a trabajar (running=true) o pausa (false) al equipo del proyecto.', obj({ projectId: str('Id o nombre del proyecto'), running: { type: 'boolean' } }, ['projectId', 'running']), 'execute',
    ({ projectId, running }) => { const p = findProject(projectId); team.setRunning(p.id, running); return { projectId: p.id, running: !!p.running }; }),
  T('task.delete', 'Borra una tarea y su rama/worktree. No se puede deshacer.', obj({ code: str('Código de la tarea') }, ['code']), 'irreversible',
    async ({ code }) => { const t = findTask(code); await team.deleteTask(t.id); return { deleted: t.code || t.id }; }),
  later('flowtest.deleteFlow', 'Borra un fichero de flow de la carpeta del proyecto en flow-test. No se puede deshacer.', obj({ flow: str('Ruta del flow') }, ['flow']), 'irreversible', 'una tarea posterior: flow-test aún no expone el borrado a AgentOffice'),
];

const byName = new Map(tools.map((t) => [t.name, t]));
for (const t of tools) if (!POLICIES.includes(t.policy)) throw new Error(`Política inválida en ${t.name}`);

export const describe = () => tools.map(({ name, description, input, policy, pending, confirmOnce }) => ({ name, description, input, policy, ...(pending ? { pending: true } : {}), ...(confirmOnce ? { confirmOnce: true } : {}) }));

// Validación mínima de JSON Schema (object/required/type/enum/additionalProperties) para no depender de nada.
function validate(schema, args, where = 'args') {
  const typeOk = (t, v) => (t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === t);
  if (schema.type && !typeOk(schema.type, args)) throw fail(400, `${where}: se esperaba ${schema.type}`);
  if (schema.enum && !schema.enum.includes(args)) throw fail(400, `${where}: debe ser uno de ${schema.enum.join(', ')}`);
  if (schema.type === 'array' && schema.items) args.forEach((v, i) => validate(schema.items, v, `${where}[${i}]`));
  if (schema.type === 'object' && schema.properties) {
    for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') throw fail(400, `Falta «${k}»`);
    for (const [k, v] of Object.entries(args)) {
      if (!schema.properties[k]) { if (schema.additionalProperties === false) throw fail(400, `Argumento desconocido: «${k}»`); continue; }
      if (v !== undefined && v !== null) validate(schema.properties[k], v, k);
    }
  }
}

// Ejecuta una tool con política y auditoría. ctx: { client, via }.
export async function run(name, args = {}, ctx = {}) {
  const tool = byName.get(name);
  if (!tool) throw fail(404, `Tool desconocida: ${name}`);
  const t0 = Date.now();
  const entry = { ts: t0, tool: name, args: tool.auditArgs && args && typeof args === 'object' ? tool.auditArgs(args) : summarize(args), policy: tool.policy, mode: null, confirmed: null, via: ctx.via || 'api', client: ctx.client || null, ...(ctx.chatId ? { chatId: ctx.chatId } : {}) };
  const done = (result, extra = {}) => audit({ ...entry, result, ms: Date.now() - t0, ...extra });
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail(400, 'args debe ser un objeto');
    if (name.startsWith('browser.') && name !== 'browser.open') entry.page = await pageUrl(args); // FT-116
    validate(tool.input, args);
    if (tool.pending) return tool.handler(args, ctx);
    if (tool.precheck) { const early = await tool.precheck(args, ctx); if (early) { done('ok'); return early; } }
    // FT-29 · política dinámica por llamada (ui.act: destructivo → irreversible)
    const dyn = tool.dynamic ? await tool.dynamic(args, ctx) : null;
    if (dyn) entry.policy = dyn.policy;
    const g = await gate(dyn ? { ...tool, policy: dyn.policy } : tool, args, dyn ? { ...ctx, modalContext: dyn.context } : ctx);
    Object.assign(entry, g);
    if (g.confirmed === false) throw fail(403, `El usuario rechazó «${name}»`);
    const out = await tool.handler(args, ctx);
    done('ok');
    return out ?? { ok: true };
  } catch (e) {
    done(entry.confirmed === false ? 'denied' : 'error', { status: e.status || 500, error: String(e.message).slice(0, 300) });
    throw e;
  }
}
