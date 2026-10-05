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
import * as vision from './vision.js';
import { gate, audit, summarize, POLICIES } from './policy.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const VIEWS = ['office', 'summary', 'tasks', 'agents', 'guide', 'settings'];
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

const gitFiles = async (t) => {
  const p = projectOf(t);
  const repo = p && team.repoOfTask(p, t);
  if (!t.branch || !repo) return { files: [], note: t.branch ? 'La tarea no tiene repo' : 'La tarea no tiene rama (motor demo o sin empezar)' };
  if (!(await git.branchExists(repo, t.branch))) return { files: [], branch: t.branch, note: `La rama ${t.branch} ya se fusionó en ${repo.baseBranch} y se borró (tarea ${t.status}); los ficheros están en el diffStat de la tarea y en git log de ${repo.key}` };
  const out = await git.git(repo.path, 'diff', '--name-only', `${repo.baseBranch}...${t.branch}`);
  return { files: out ? out.split('\n') : [], base: repo.baseBranch, branch: t.branch };
};

// ── Escritorio (FT-22) · regla «solo fuera»: si la ventana activa es flow-test/AgentOffice no se devuelve nada del escritorio ──
const INSIDE_RE = () => new RegExp(`flowtest|agentoffice|agent office|(localhost|127\\.0\\.0\\.1):${process.env.AO_PORT || 7420}\\b`, 'i');
const INSIDE = { inside: true, hint: 'usa app.getContext' };
const isInside = (w) => !!w && INSIDE_RE().test(`${w.title || ''} ${w.app || ''}`);
// Se ejecuta antes de la política: si el usuario está dentro de la app no hay nada que confirmar.
const outsideOnly = async () => (isInside(await getProvider().getActive()) ? INSIDE : null);
const clip = (w) => ({ ...w, title: String(w.title || '').slice(0, 200) });

// ── Registro ────────────────────────────────────────────────────────────────
const T = (name, description, input, policy, handler, extra = {}) => ({ name, description, input, policy, handler, ...extra });
const later = (name, description, input, policy, who = 'FT-5') =>
  T(name, `${description} (aún no disponible: lo implementa ${who}; responde 501)`, input, policy, () => { throw fail(501, `${name} aún no está implementado (${who})`); }, { pending: true });

export const tools = [
  // — App / navegación —
  T('app.getContext', 'Qué está viendo el usuario ahora: vista, proyecto, tarea abierta, agente seleccionado, últimos eventos y contexto de flow-test.', obj({ client: str('Id de cliente (opcional; por defecto el más reciente)') }), 'read',
    ({ client }) => context.get(client)),
  T('app.navigate', 'Lleva la UI a una vista (office|summary|tasks|agents|guide|settings) y, si se indica, a un proyecto.', obj({ view: { type: 'string', enum: VIEWS }, projectId: str('Id o nombre del proyecto (opcional)') }, ['view']), 'navigate',
    ({ view, projectId }, ctx) => ({ ...ui({ type: 'navigate', view, projectId: projectId ? findProject(projectId).id : null }, ctx), view }) ),
  T('app.openTask', 'Abre en la UI el modal de una tarea.', obj({ code: str('Código de la tarea, p. ej. FT-4') }, ['code']), 'navigate',
    ({ code }, ctx) => { const t = findTask(code); return { ...ui({ type: 'openTask', taskId: t.id, projectId: t.projectId }, ctx), task: t.code || t.id }; }),
  T('app.selectAgent', 'Abre en la UI el panel de un agente.', obj({ agentId: str('Id o nombre del agente') }, ['agentId']), 'navigate',
    ({ agentId }, ctx) => { const a = findAgent(agentId); return { ...ui({ type: 'selectAgent', agentId: a.id }, ctx), agent: a.name }; }),
  T('app.openArtifact', 'Abre la tarea en la UI y devuelve su diff (rama base...rama de la tarea).', obj({ code: str('Código de la tarea') }, ['code']), 'navigate',
    async ({ code }, ctx) => { const t = findTask(code); ui({ type: 'openTask', taskId: t.id, projectId: t.projectId }, ctx); return { task: t.code || t.id, diff: (await team.taskDiff(t.id)).slice(0, 20_000) }; }),
  T('flowtest.show', 'Pide a flow-test (host, FT-3) que muestre un flow y, opcionalmente, un nodo. Solo tiene efecto con AgentOffice embebido en flow-test.', obj({ flow: str('Ruta o nombre del flow'), node: str('Id del nodo (opcional)') }, ['flow']), 'navigate',
    ({ flow, node }, ctx) => ({ ...ui({ type: 'flowtest.show', flow, node: node || null }, ctx), flow, node: node || null })),

  // — Proyectos y tareas —
  T('project.list', 'Lista los proyectos (id, nombre, prefijo, repos, si están en marcha, tareas por estado).', obj(), 'read',
    () => store.get().projects.map((p) => ({ id: p.id, name: p.name, prefix: prefixOf(p), running: !!p.running, repos: (p.repos || []).map((r) => r.key), team: p.team,
      tasks: store.get().tasks.filter((t) => t.projectId === p.id).reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {}) }))),
  T('task.list', 'Lista tareas, filtradas por proyecto y/o estado.', obj({ projectId: str('Id o nombre del proyecto'), status: { type: 'string', enum: team.STATUSES } }), 'read',
    ({ projectId, status }) => { const pid = projectId ? findProject(projectId).id : null; return store.get().tasks.filter((t) => (!pid || t.projectId === pid) && (!status || t.status === status)).map(brief); }),
  T('task.get', 'Detalle de una tarea: descripción, resumen del agente, diffStat, error, preguntas y respuestas.', obj({ code: str('Código de la tarea') }, ['code']), 'read',
    ({ code }) => { const t = findTask(code); return { ...brief(t), context: t.context || null, description: t.description, summary: t.summary, diffStat: t.diffStat, error: t.error, feedback: t.feedback, questions: t.questions || [], costUsd: t.costUsd, attempts: t.attempts, createdAt: t.createdAt }; }),
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
  T('agent.getModifiedFiles', 'Ficheros que ha modificado una tarea/agente (git diff --name-only base...rama).', obj({ code: str('Código de la tarea'), agentId: str('Alternativa: agente (su tarea actual o la última)') }), 'read',
    async (a) => { const t = taskFrom(a); return { task: t.code || t.id, ...(await gitFiles(t)) }; }),
  T('agent.getArtifacts', 'Artefactos de una tarea/agente: diffStat, resumen y commits de la rama.', obj({ code: str('Código de la tarea'), agentId: str('Alternativa: agente (su tarea actual o la última)') }), 'read',
    async (a) => {
      const t = taskFrom(a);
      const p = projectOf(t), repo = p && team.repoOfTask(p, t);
      let commits = [];
      if (t.branch && repo && await git.branchExists(repo, t.branch)) { const out = await git.git(repo.path, 'log', '--format=%h %s', `${repo.baseBranch}..${t.branch}`); commits = out ? out.split('\n') : []; }
      else if (t.branch && repo) { const out = await git.git(repo.path, 'log', '--format=%h %s', '--grep', `Merge branch '${t.branch}'`, '-1'); commits = out ? [out + ' (ya fusionada)'] : []; }
      return { task: t.code || t.id, branch: t.branch || null, summary: t.summary, diffStat: t.diffStat, commits };
    }),

  // — Integraciones deterministas (FT-10): IDE, git, filesystem, terminal, navegador. Solo repos/worktrees del proyecto —
  T('ide.openFile', 'Abre un fichero en el IDE del usuario (AO_IDE_CMD, por defecto VS Code) en una línea. Con «task» abre la copia del worktree de la tarea y, si no das «line», la del primer hunk de su diff. «path» es relativo al repo (como lo devuelve agent_getModifiedFiles). Si responde 503 no hay IDE: enseña el diff con app_openArtifact.',
    obj({ path: str('Fichero, relativo al repo/worktree'), line: { type: 'integer', description: 'Línea (opcional)' }, task: str('Código de la tarea a la que pertenece el fichero (recomendado)'), repo: str('Clave del repo (si no das tarea)') }, ['path']), 'navigate',
    (a) => integ.ideOpenFile(a)),
  T('git.status', 'git status del repo (o del worktree de la rama indicada).', obj({ repo: str('Clave del repo'), branch: str('Rama de una tarea (opcional)') }, ['repo']), 'read', (a) => integ.gitStatus(a)),
  T('git.diff', 'git diff del repo: con «branch», rama base...rama; sin ella, los cambios sin confirmar frente a HEAD. Recortado a 200 KB.', obj({ repo: str('Clave del repo'), branch: str('Rama de una tarea (opcional)') }, ['repo']), 'read', (a) => integ.gitDiff(a)),
  T('git.log', 'git log del repo (o de una rama): hash, fecha, autor y asunto.', obj({ repo: str('Clave del repo'), branch: str('Rama (opcional)'), limit: { type: 'integer', description: 'Máx. de commits (20 por defecto, 100 como mucho)' } }, ['repo']), 'read', (a) => integ.gitLog(a)),
  T('filesystem.read', 'Lee un fichero de un repo/worktree del proyecto (máx. 200 KB). Nunca .env, .git ni data/; fuera del repo da error.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (lee su worktree)'), path: str('Fichero, relativo al repo') }, ['path']), 'read', (a) => integ.fsRead(a)),
  T('filesystem.write', 'Escribe (crea o sobrescribe) un fichero dentro de un repo/worktree del proyecto (máx. 200 KB). Pide confirmación. Nunca .env, .git ni data/.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (escribe en su worktree)'), path: str('Fichero, relativo al repo'), content: str('Contenido completo') }, ['path', 'content']), 'write', (a) => integ.fsWrite(a)),
  T('terminal.execute', 'Ejecuta un comando en la raíz de un repo/worktree, sin shell (nada de ; & | > $ ni sustituciones). Solo la lista blanca de los workers (npm, node, git status/diff/log/add/commit…, ls, cat, grep…; sin rm, sudo, docker, ssh ni git push). Timeout 60 s y salida recortada.', obj({ repo: str('Clave del repo'), task: str('Código de la tarea (corre en su worktree)'), cmd: str('Comando, p. ej. «git status --short»') }, ['cmd']), 'execute', (a) => integ.terminalExecute(a)),
  T('browser.open', 'Abre una URL http(s) en el navegador del usuario (xdg-open).', obj({ url: str('URL') }, ['url']), 'navigate', (a) => integ.browserOpen(a)),

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
  T('screen.describe', 'ÚLTIMO RECURSO: describe con el modelo multimodal lo que hay en pantalla (hace una captura o usa «capturePath» de una anterior). Antes usa window.getActive (y app.getContext si el usuario está en flow-test/AgentOffice): solo llama a esto si no basta. Pide confirmación la primera vez por sesión. Si la ventana activa es flow-test/AgentOffice responde {inside:true}. Con claude-cli responde 501 (no admite imágenes).',
    obj({ question: str('Qué quieres saber de la pantalla (opcional)'), capturePath: str('Ruta de una captura previa de data/desktop/captures/ (opcional; si no, captura ahora)') }), 'read',
    async ({ question, capturePath }) => {
      const file = capturePath ? vision.resolveCapture(capturePath) : (await getProvider().capture({ target: 'screen' })).path;
      const { description, provider, model } = await vision.describeImage(file, question);
      return { description, capturePath: file, provider, ...(model ? { model } : {}) };
    },
    { confirmOnce: true, precheck: async () => { vision.assertSupported(); return outsideOnly(); } }),

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
  const entry = { ts: t0, tool: name, args: summarize(args), policy: tool.policy, mode: null, confirmed: null, via: ctx.via || 'api', client: ctx.client || null, ...(ctx.chatId ? { chatId: ctx.chatId } : {}) };
  const done = (result, extra = {}) => audit({ ...entry, result, ms: Date.now() - t0, ...extra });
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail(400, 'args debe ser un objeto');
    validate(tool.input, args);
    if (tool.pending) return tool.handler(args, ctx);
    if (tool.precheck) { const early = await tool.precheck(args, ctx); if (early) { done('ok'); return early; } }
    const g = await gate(tool, args, ctx);
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
