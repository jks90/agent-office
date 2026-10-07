// AgentOffice: servidor HTTP sin dependencias — estáticos, API REST y SSE (/events).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { prefixOf } from './codes.js';
import * as questions from './questions.js';
import * as team from './team.js';
import * as review from './review.js'; // FT-56
import * as toolcat from './toolcatalog.js';
import * as costs from './costs.js'; // FT-76
import * as ponytail from './ponytail.js'; // FT-86
import * as uploads from './uploads.js'; // FT-95
import { allRoles } from './roles.js';
import { checkSuite, suiteInfo } from './suite.js';
import * as auth from './engines/auth.js';
import * as localServer from './engines/local-server.js';
import * as boards from './boards/index.js';
import * as skills from './skills.js';
import { draftTask } from './ai-draft.js';
import crypto2 from 'node:crypto';
import { saveRole, deleteRole } from './roles.js';
import { ladders, normalizeLadder } from './model-ladder.js'; // FT-60
import * as activity from './events.js';
import * as browserPanel from './browser/panel.js'; // FT-117
import * as browser from './browser/index.js'; // FT-118
import * as browserExt from './browser/extension.js';
import * as telegram from './telegram.js'; // avisos al móvil (ReviewPending, bloqueos, fallos)
import * as selfupdate from './selfupdate.js'; // se pone al día solo con GitHub cuando no hay nadie trabajando
import * as context from './context.js';
import * as guideTools from './guide/tools.js';
import * as guidePolicy from './guide/policy.js';
import * as browserPolicy from './browser/policy.js';
import * as guide from './guide/index.js';
import { getProvider as desktopProvider } from './desktop/index.js';
import * as stt from './guide/stt/index.js';
import * as wake from './guide/stt/wake.js';
import * as tts from './guide/tts/index.js'; // FT-52
import * as quota from './quota.js';
import * as memory from './memory.js';
import * as codeindex from './codeindex.js'; // FT-58
import * as claudeEngine from './engines/claude.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const PORT = Number(process.env.AO_PORT || 7420);
const HOST = process.env.AO_HOST || '127.0.0.1'; // lanza procesos con tus permisos: solo local
// Si se expone fuera del loopback (p. ej. para que el flow-test en Docker lo proxee), hace falta un token:
// cabecera `x-ao-token` (flow-test lo manda desde FLOW_AGENTS_TOKEN). Desde 127.0.0.1 no se pide.
const TOKEN = process.env.AO_TOKEN || (HOST !== '127.0.0.1' && HOST !== 'localhost' ? loadOrCreateToken() : null);
function loadOrCreateToken() {
  const f = path.join(store.DATA_DIR, '.token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* se crea */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}
const isLoopback = (req) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress || '');
const PUBLIC = path.join(store.ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json' };

// Comprobación inicial de la suite (y refresco periódico para el planificador).
checkSuite().then((s) => console.log(s.ok ? `🧪 flow-test en ${s.url} · ${s.mode}${s.plan ? ' · ' + s.plan : ''}${s.org ? ' · ' + s.org : ''}` : `⛔ ${s.reason}`)).catch(() => {});
setInterval(() => checkSuite().then(() => store.changed()).catch(() => {}), 5 * 60 * 1000).unref();

// Proyectos = carpetas del workspace de flow-test (al arrancar, cada 5 min y con POST /api/sync).
const sync = () => team.syncWorkspace().then((r) => { if (r.created) console.log(`📁 ${r.created} proyecto(s) nuevo(s) desde flow-test: ${r.folders.join(', ')}`); }).catch((e) => console.log(`📁 sin sincronizar: ${e.message}`));
checkSuite().then(sync);
quota.setOnChange(() => store.changed()); // FT-45: cuota de las suscripciones → snapshot SSE
quota.startPolling();
auth.cachedEnginesStatus(); // precargar las sesiones de los motores para el motor automático
setInterval(sync, 5 * 60 * 1000).unref();
// FT-96: adjuntos subidos que ningún chat ni tarea usa (chips quitados, modales cancelados): fuera pasado 1 día; al arrancar y cada hora.
const sweepUploads = () => { try { const n = uploads.sweep(guide.uploadsInUse()); if (n) console.log(`🧹 ${n} carpeta(s) de adjuntos temporales borradas`); } catch { /* sin uploads */ } };
sweepUploads();
setInterval(sweepUploads, 3600e3).unref();
// Tableros online con autoSync: cada 5 min.
setInterval(() => { for (const p of store.get().projects) if (p.board?.autoSync) team.syncBoard(p.id).catch(() => {}); }, 5 * 60 * 1000).unref();

// Documentos de oficina → texto plano al lado (los agentes solo leen texto): .docx/.odt por su XML, .pdf con pdftotext si existe.
export function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    let txt = null;
    if (ext === '.docx' || ext === '.odt') {
      const xml = execFileSync('unzip', ['-p', file, ext === '.docx' ? 'word/document.xml' : 'content.xml'], { maxBuffer: 50e6 }).toString('utf8');
      txt = xml.replace(/<\/w:p>|<\/text:p>|<\/text:h>/g, '\n').replace(/<w:tab\/>|<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
    } else if (ext === '.pdf') {
      try { txt = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 50e6 }).toString('utf8').trim(); } catch { return null; }
    }
    if (!txt) return null;
    const out = file + '.txt';
    fs.writeFileSync(out, txt);
    return { name: path.basename(out), path: out, size: fs.statSync(out).size, derived: true };
  } catch { return null; }
}

// FT-32 · estado de las herramientas de entrada (xdotool/ydotool) para la ayuda de Ajustes; en caché 30 s (hace `which`)
let inputCache = { t: 0, v: null };
const inputStatus = () => {
  if (Date.now() - inputCache.t > 30_000) { let v; try { const a = desktopProvider().inputAvailable(); v = { ok: !!a.ok, missing: a.missing || [] }; } catch (e) { v = { ok: false, missing: [] }; } inputCache = { t: Date.now(), v }; }
  return inputCache.v;
};
// FT-50: cada tarea sin empezar lleva `plannedAgentId`/`plannedReason` (calculados en cada snapshot, no persistidos).
const snapshot = () => { const st = store.get(); return { ...st, projects: st.projects.map((p) => ({ ...p, prefixDefault: prefixOf(p) })), tasks: review.decorate(team.withPlannedAgents(st)), modelLadders: ladders(st.settings), roles: allRoles(), engines: team.ENGINE_IDS, suite: suiteInfo(), costEstimates: team.costEstimates(), rtk: claudeEngine.rtkAvailable(), codeIndexInstalled: codeindex.available(), questions: questions.list(), guidePolicy: { ...guidePolicy.getPolicy(), input: inputStatus() }, guideProviders: guide.providerInfo(), quota: quota.snapshot(), browser: { ...browserPanel.status(), mode: browser.getMode(), modes: browser.MODES, ext: browserExt.status() } }; };

async function readBody(req) {
  const limit = req.url.startsWith('/api/upload') ? 40e6 : req.url.startsWith('/api/guide/stt') ? 12e6 : 1e6; // adjuntos y audio del Guide (FT-9) en base64
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}

// Acciones que ponen a trabajar al equipo: solo con un flow-test vigente.
const gated = (fn) => async (m, b) => {
  const suite = await checkSuite();
  if (!suite.ok) throw Object.assign(new Error(suite.reason), { status: 402, gated: 'suite', suite });
  return fn(m, b);
};

// Proyecto y ruta de uno de sus repos (por clave; sin clave, el primero) — para la memoria de Claude Code.
const findProject = (id) => store.get().projects.find((p) => p.id === id) || (() => { throw Object.assign(new Error('Proyecto no encontrado'), { status: 404 }); })();
const repoPath = (id, key) => { const rs = findProject(id).repos || []; const r = rs.find((x) => x.key === key) || (!key && rs[0]); if (!r) throw Object.assign(new Error('Repo no encontrado'), { status: 404 }); return r.path; };

browser.setMode(store.get().settings.browserMode); // FT-118
browserExt.onChange(() => store.changed());
const routes = [
  ['POST', /^\/api\/browser\/pair$/, () => browserExt.newPairingCode()], // FT-118: código de un solo uso para la extensión
  ['POST', /^\/api\/browser\/forget$/, () => browserExt.forget()],
  ['GET', /^\/api\/state$/, () => snapshot()],
  // Cuota restante de las suscripciones de Claude y Codex (FT-45); ?force=1 se salta la caché de 60 s
  ['GET', /^\/api\/quota$/, (_, __, q) => quota.readAll({ force: q.force === '1' })],
  // Panel del navegador del agente (FT-117): estado, abrir/cerrar, control agente↔usuario, navegación, pestañas y entrada (el vídeo va por /api/browser/stream)
  ['GET', /^\/api\/browser$/, () => browserPanel.refresh()],
  ['POST', /^\/api\/browser\/open$/, () => browserPanel.open()],
  ['POST', /^\/api\/browser\/close$/, () => browserPanel.close()],
  ['POST', /^\/api\/browser\/control$/, (_, b) => browserPanel.setControl(b.mode)],
  ['POST', /^\/api\/browser\/nav$/, (_, b) => browserPanel.nav(b)],
  ['POST', /^\/api\/browser\/tab$/, (_, b) => browserPanel.tab(b)],
  ['POST', /^\/api\/browser\/input$/, (_, b) => browserPanel.input(b)],
  // Activity Stream tipado (FT-1)
  ['GET', /^\/api\/events$/, (_, __, q) => activity.list(q)],
  // Contexto de la UI (FT-2): lo que el usuario está viendo, por cliente (cabecera `x-ao-client`)
  ['GET', /^\/api\/context$/, (_, __, q, req) => context.get(q.client || req.headers['x-ao-client'])],
  ['POST', /^\/api\/context$/, (_, b, __, req) => context.publish(req.headers['x-ao-client'], b)],
  // Tool Registry + Policy Layer del Guide Agent (FT-4): lo usan la UI, las pruebas y bin/ao-mcp.mjs
  ['GET', /^\/api\/guide\/tools$/, () => guideTools.describe()],
  ['POST', /^\/api\/guide\/tool$/, (_, b, __, req) => guideTools.run(String(b.name || ''), b.args ?? {}, { client: req.headers['x-ao-client'] || null, chatId: req.headers['x-ao-chat'] || null, via: req.headers['x-ao-via'] || 'api' })],
  // Guide Agent (FT-6): chats persistentes; la conversación (POST /api/guide/chat, SSE) se atiende en `guideChat`
  ['GET', /^\/api\/guide\/chats$/, () => guide.listChats()],
  ['GET', /^\/api\/guide\/chats\/([\w-]+)$/, ([id]) => guide.getChat(id)],
  ['DELETE', /^\/api\/guide\/chats\/([\w-]+)$/, ([id]) => guide.deleteChat(id)],
  // Voz (FT-9): GET = proveedores STT y su estado; POST {audio: base64, mime, lang?} → {text, lang, ms}. El texto lo manda el cliente a /api/guide/chat
  ['GET', /^\/api\/guide\/stt$/, async () => ({ ...(await stt.status()), wake: await wake.status() })], // wake (FT-35): ¿puede la UI ofrecer escucha continua?
  ['POST', /^\/api\/guide\/stt$/, (_, b) => {
    if (typeof b.audio !== 'string' || !b.audio) throw fail(400, 'Falta el audio (base64)');
    return stt.transcribe(Buffer.from(b.audio, 'base64'), b.mime, b.lang);
  }],
  // Voz de salida (FT-52): GET = proveedor TTS, voz y estado; POST {text, voice?} → audio (se atiende en `guideTts`, respuesta binaria)
  ['GET', /^\/api\/guide\/tts$/, (_, __, q) => tts.status(q.provider)],
  // Palabra de activación (FT-35): {audio: base64, mime, durationMs?} → {wake, rest, ms}. Solo STT local (nunca OpenAI); audio ≤200 KB / 3 s
  ['POST', /^\/api\/guide\/wake$/, (_, b) => {
    if (typeof b.audio !== 'string' || !b.audio) throw fail(400, 'Falta el audio (base64)');
    return wake.wake(Buffer.from(b.audio, 'base64'), b.mime, b.durationMs);
  }],
  ['POST', /^\/api\/guide\/stop$/, (_, b) => guide.stop(String(b.chatId || ''))],
  // Cuentas de los motores de IA (login OAuth/clave API, logout)
  ['GET', /^\/api\/engines$/, () => auth.enginesStatus()],
  ['GET', /^\/api\/engines\/models$/, () => auth.enginesModels()],
  ['POST', /^\/api\/engines\/(claude|codex)\/login$/, async ([e], b) => (b.apiKey ? (await auth.loginWithApiKey(e, b.apiKey), { ok: true }) : auth.startLogin(e, { mode: b.mode }))],
  ['POST', /^\/api\/engines\/(claude|codex)\/code$/, ([e], b) => auth.submitCode(e, b.code)],
  ['POST', /^\/api\/engines\/(claude|codex)\/cancel$/, ([e]) => auth.cancelLogin(e)],
  ['POST', /^\/api\/engines\/(claude|codex)\/logout$/, ([e]) => auth.logout(e)],
  // FT-54 · IA local: «Probar» (lista modelos y guarda URL/clave/modelo) y ajustes sueltos (modelo por defecto, allowAuto)
  ['POST', /^\/api\/engines\/local\/probe$/, async (_, b) => {
    if (typeof b.apiKey === 'string') auth.setLocalKey(b.apiKey.trim());
    const p = await localServer.probe(b.baseUrl, auth.localKey());
    if (p.ok) localServer.save({ baseUrl: p.baseUrl, models: p.models });
    return { ...p, local: (await auth.enginesStatus()).local };
  }],
  ['POST', /^\/api\/engines\/local\/settings$/, async (_, b) => {
    if (typeof b.apiKey === 'string') auth.setLocalKey(b.apiKey.trim());
    localServer.save({ model: typeof b.model === 'string' ? b.model : undefined, allowAuto: typeof b.allowAuto === 'boolean' ? b.allowAuto : undefined });
    return (await auth.enginesStatus()).local;
  }],
  ['GET', /^\/api\/suite$/, () => checkSuite(true).then((suite) => { store.changed(); return suite; })],
  ['POST', /^\/api\/projects$/, (_, b) => team.createProject(b)],
  ['DELETE', /^\/api\/projects\/(\w+)$/, ([id]) => team.deleteProject(id)],
  ['PATCH', /^\/api\/projects\/(\w+)$/, ([id], b) => team.updateProject(id, b)],
  ['GET', /^\/api\/version$/, () => selfupdate.state],
  ['POST', /^\/api\/version\/check$/, () => selfupdate.check()],
  ['POST', /^\/api\/telegram\/test$/, async () => { const c = telegram.config(); return { enabled: c.enabled, chats: c.chats.length, sent: await telegram.send('✅ AgentOffice: los avisos por Telegram funcionan') }; }],
  // Costes de los agentes (FT-76): KPI, desglose y línea base interactiva. Para seguirlo desde flows de flow-test.
  ['GET', /^\/api\/costs$/, (_, __, q) => costs.overview(store.get(), Date.now(), { variant: q.variant })],
  ['GET', /^\/api\/costs\/export$/, (_, __, q) => { const rows = costs.exportRows(store.get()); return q.format === 'csv' ? { csv: costs.toCsv(rows) } : rows; }],
  ['GET', /^\/api\/costs\/baseline$/, () => costs.readBaseline()],
  ['POST', /^\/api\/costs\/baseline$/, (_, b) => costs.addBaseline(b, fail)],
  ['GET', /^\/api\/costs\/(\w+)\/([\w-]+)$/, ([pid, tid]) => { const t = store.get().tasks.find((x) => x.projectId === pid && (x.id === tid || x.code === tid)); if (!t) throw fail(404, 'Tarea no encontrada'); return costs.taskDetail(t); }],
  // Resumen compacto de las tareas de un proyecto (para seguimiento desde flows de flow-test)
  ['GET', /^\/api\/projects\/(\w+)\/tasks$/, ([id]) => { const s = store.get(); return s.tasks.filter((t) => t.projectId === id).map((t) => ({ id: t.id, code: t.code, status: t.status, kind: t.kind, role: t.role, repo: t.repo, agent: s.agents.find((a) => a.id === t.agentId)?.name || null, title: t.title, dependsOn: t.dependsOn, costUsd: t.costUsd, summary: (t.summary || '').slice(0, 300), updatedAt: t.updatedAt })); }],
  ['POST', /^\/api\/projects\/(\w+)\/import-flow$/, ([id], b) => team.importFlow(id, b.path)],
  ['GET', /^\/api\/flows$/, () => team.listFlows()],
  ['POST', /^\/api\/sync$/, () => team.syncWorkspace()],
  // Catálogo central de skills y roles
  ['GET', /^\/api\/skills$/, () => ({ catalogDir: skills.catalogDir(), catalog: skills.listCatalog(), inventory: skills.inventory() })],
  ['POST', /^\/api\/skills\/centralize$/, (_, b) => skills.centralize(b.dir, b.name)],
  ['POST', /^\/api\/skills\/read$/, (_, b) => skills.readSkillFile(b.dir)],
  ['POST', /^\/api\/skills\/write$/, (_, b) => skills.writeSkillFile(b.dir, b.content)],
  ['POST', /^\/api\/skills\/new$/, (_, b) => skills.createSkill(b)],
  // Catálogos de MCP y scripts para los agentes (server/toolcatalog.js)
  ['GET', /^\/api\/tools$/, () => ({ mcp: { catalog: toolcat.mcpCatalog(), inventory: toolcat.mcpInventory() }, scripts: { catalog: toolcat.scriptCatalog(), inventory: toolcat.scriptInventory() } })],
  ['POST', /^\/api\/tools\/mcp$/, (_, b) => toolcat.addMcp(b)],
  ['DELETE', /^\/api\/tools\/mcp\/([\w.-]+)$/, ([n]) => toolcat.removeMcp(n)],
  ['POST', /^\/api\/tools\/scripts$/, (_, b) => toolcat.addScript(b)],
  ['DELETE', /^\/api\/tools\/scripts\/([\w.-]+)$/, ([n]) => toolcat.removeScript(n)],
  ['DELETE', /^\/api\/skills\/([\w-]+)$/, ([name]) => skills.uncentralize(name)],
  ['POST', /^\/api\/roles$/, (_, b) => { const r = saveRole(b); store.changed(); return r; }],
  ['DELETE', /^\/api\/roles\/([\w-]+)$/, ([id]) => { deleteRole(id); store.changed(); }],
  // Tableros online por proyecto
  ['GET', /^\/api\/boards\/kinds$/, () => boards.describe()],
  ['GET', /^\/api\/projects\/(\w+)\/board$/, ([id]) => boards.publicBoard(store.get().projects.find((p) => p.id === id) || {})],
  ['POST', /^\/api\/projects\/(\w+)\/board$/, ([id], b) => boards.saveBoard(store.get().projects.find((p) => p.id === id), b)],
  ['POST', /^\/api\/projects\/(\w+)\/board\/create$/, ([id], b) => boards.createBoard(store.get().projects.find((p) => p.id === id), b)],
  ['POST', /^\/api\/projects\/(\w+)\/board\/align$/, gated(([id]) => boards.alignColumns(store.get().projects.find((p) => p.id === id)))],
  ['POST', /^\/api\/projects\/(\w+)\/board\/export\/cancel$/, ([id]) => boards.cancelExport(store.get().projects.find((p) => p.id === id))],
  ['POST', /^\/api\/projects\/(\w+)\/board\/export$/, gated(([id]) => boards.exportAll(store.get().projects.find((p) => p.id === id)))],
  ['POST', /^\/api\/projects\/(\w+)\/board\/test$/, ([id]) => boards.testBoard(store.get().projects.find((p) => p.id === id))],
  ['POST', /^\/api\/projects\/(\w+)\/board\/sync$/, gated(([id]) => team.syncBoard(id))],
  ['POST', /^\/api\/projects\/(\w+)\/board\/sync-all$/, gated(([id]) => team.syncAll(id))],
  ['PATCH', /^\/api\/tasks\/([\w-]+)$/, ([id], b) => team.updateTask(id, b)],
  // Preguntas de los agentes al usuario (bin/ao-ask.mjs ↔ modal de la UI)
  ['GET', /^\/api\/questions$/, () => questions.list()],
  ['POST', /^\/api\/questions$/, (_, b) => questions.ask(b)],
  ['POST', /^\/api\/questions\/(\w+)\/wait$/, ([id], b) => questions.wait(id, Math.min(55_000, Number(b.ms) || 50_000))],
  ['POST', /^\/api\/questions\/(\w+)\/answer$/, ([id], b) => questions.answer(id, b.answer)],
  ['POST', /^\/api\/projects\/(\w+)\/run$/, gated(([id], b) => team.setRunning(id, b.running))],
  ['POST', /^\/api\/projects\/(\w+)\/goal$/, gated(([id], b) => team.planGoal(id, b.goal, { attachments: b.attachments, title: b.title }))],
  ['POST', /^\/api\/tasks$/, gated((_, b) => team.createTask(b))],
  // FT-75 · memoria de los agentes: GET/PUT /api/memory/:projectId[?agent=<id>] {text}
  ['GET', /^\/api\/memory\/(\w+)$/, ([pid], _, q) => ({ text: memory.read(pid, q.agent || null), max: memory.MAX_CHARS })],
  ['PUT', /^\/api\/memory\/(\w+)$/, ([pid], b, q) => ({ text: memory.write(pid, q.agent || null, b.text) })],
  // Memoria de Claude Code de los repos del proyecto: GET lista · GET/PUT/DELETE …/file?repo=<clave>&name=<x.md>
  ['GET', /^\/api\/projects\/(\w+)\/claude-memory$/, ([id]) => (findProject(id).repos || []).map((r) => ({ repo: r.key, path: r.path, ...memory.claudeList(r.path) }))],
  ['GET', /^\/api\/projects\/(\w+)\/claude-memory\/file$/, ([id], _, q) => memory.claudeRead(repoPath(id, q.repo), q.name)],
  ['PUT', /^\/api\/projects\/(\w+)\/claude-memory\/file$/, ([id], b, q) => memory.claudeWrite(repoPath(id, q.repo), q.name, b.text)],
  ['DELETE', /^\/api\/projects\/(\w+)\/claude-memory\/file$/, ([id], _, q) => memory.claudeDelete(repoPath(id, q.repo), q.name)],
  // ⏰ tareas programadas y 🪝 webhook entrante
  ['GET', /^\/api\/projects\/(\w+)\/schedules$/, ([id]) => team.listSchedules(id)],
  ['POST', /^\/api\/projects\/(\w+)\/schedules$/, ([id], b) => team.saveSchedule(id, b)],
  ['PATCH', /^\/api\/projects\/(\w+)\/schedules\/(\w+)$/, ([id, sid], b) => team.saveSchedule(id, b, sid)],
  ['DELETE', /^\/api\/projects\/(\w+)\/schedules\/(\w+)$/, ([id, sid]) => team.deleteSchedule(id, sid)],
  ['POST', /^\/api\/projects\/(\w+)\/schedules\/(\w+)\/run$/, ([id, sid]) => team.runScheduleNow(id, sid)],
  ['POST', /^\/api\/hooks\/([\w-]{16,})$/, ([token], b) => team.fireHook(token, b)],
  ['POST', /^\/api\/projects\/(\w+)\/supervisor$/, ([id]) => team.addSupervisorTo(id)], // FT-122
  ['POST', /^\/api\/tasks\/(\w+)\/dep-proposal$/, ([id], b) => team.resolveDepProposal(id, b)], // FT-122
  ['POST', /^\/api\/projects\/(\w+)\/coordinate$/, ([id]) => team.coordinateNow(id)], // 🧑‍✈️ aplicar la sugerencia / pasada ahora
  ['POST', /^\/api\/tasks\/([\w-]+)\/review-again$/, ([id]) => team.reReview(id)], // relanzar la revisión automática
  ['POST', /^\/api\/tasks\/(\w+)\/resume-now$/, ([id]) => team.resumeNow(id)], // FT-66: «Reanudar ya» una tarea pausada por cuota
  ['POST', /^\/api\/upload$/, (_, b) => uploads.save(b.files, extractText)], // FT-95: saneado y con límites
  ['POST', /^\/api\/tasks\/draft$/, gated((_, b) => draftTask(b))],
  ['DELETE', /^\/api\/tasks\/([\w-]+)$/, ([id]) => team.deleteTask(id)],
  ['POST', /^\/api\/tasks\/([\w-]+)\/approve$/, ([id]) => team.approve(id)],
  ['POST', /^\/api\/tasks\/([\w-]+)\/update-from-base$/, ([id]) => team.updateFromBase(id)], // FT-19
  ['POST', /^\/api\/tasks\/([\w-]+)\/assign$/, ([id], b) => team.assignTask(id, b.agentId || null)], // FT-50: «Asignar a…» desde la tarjeta (agentId vacío = volver a elegir por rol)
  ['POST', /^\/api\/tasks\/([\w-]+)\/reject$/, gated(([id], b) => team.reject(id, b.feedback, b.images, b.attachments))],
  ['GET', /^\/api\/tasks\/([\w-]+)\/diff$/, async ([id]) => ({ diff: await team.taskDiff(id) })],
  ['POST', /^\/api\/agents$/, (_, b) => team.hire(b)],
  ['PATCH', /^\/api\/projects\/(\w+)\/team$/, ([id], b) => team.setTeam(id, b)],
  ['PATCH', /^\/api\/agents\/(\w+)$/, ([id], b) => team.updateAgent(id, b)],
  ['DELETE', /^\/api\/agents\/(\w+)$/, ([id]) => team.fire(id)],
  ['POST', /^\/api\/agents\/(\w+)\/stop$/, ([id]) => team.stopAgent(id)],
  ['POST', /^\/api\/agents\/(\w+)\/pause$/, ([id]) => team.pauseAgent(id)],
  ['POST', /^\/api\/agents\/(\w+)\/resume$/, ([id]) => team.resumeAgent(id)],
  ['POST', /^\/api\/agents\/(\w+)\/message$/, ([id], b) => team.messageAgent(id, { text: b.text, constraint: !!b.constraint })],
  ['POST', /^\/api\/tasks\/([\w-]+)\/constraints$/, ([id], b) => team.addConstraint(id, b.text)],
  ['POST', /^\/api\/settings$/, (_, b) => {
    const st = store.get().settings;
    if (typeof b.flowTestUrl === 'string' && b.flowTestUrl.trim()) st.flowTestUrl = b.flowTestUrl.trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
    if (typeof b.workspaceHostDir === 'string') st.workspaceHostDir = b.workspaceHostDir.trim();
    if (['todas', 'al pasar'].includes(b.officeBubbles)) st.officeBubbles = b.officeBubbles; // FT-123
    if (typeof b.quotaGuard === 'boolean') st.quotaGuard = b.quotaGuard; // FT-45
    if (review.POLICIES.includes(b.reviewPolicy) && b.reviewPolicy !== st.reviewPolicy) { st.reviewPolicy = b.reviewPolicy; for (const p of store.get().projects) if (!p.reviewPolicy) team.reviewPending(p); } // FT-56: manual | auto-qa | auto
    if (b.reviewNudgeMin !== undefined && Number(b.reviewNudgeMin) >= 0) st.reviewNudgeMin = Math.min(1440, Math.round(Number(b.reviewNudgeMin)));
    if (Array.isArray(b.reviewSensitive)) st.reviewSensitive = b.reviewSensitive.map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
    if (typeof b.reviewEngine === 'string' && ['', 'claude', 'codex', 'demo'].includes(b.reviewEngine)) st.reviewEngine = b.reviewEngine;
    if (typeof b.agentMemory === 'boolean') st.agentMemory = b.agentMemory; // FT-75
    if (b.ponytailRoles && typeof b.ponytailRoles === 'object') st.ponytailRoles = ponytail.cleanRoles(b.ponytailRoles); // FT-86
    if (typeof b.claudeMemory === 'boolean') st.claudeMemory = b.claudeMemory;
    if (Array.isArray(b.hiddenProjects)) st.hiddenProjects = b.hiddenProjects.map(String).filter((id) => /^\w+$/.test(id)).slice(0, 500); // proyectos ocultos en la UI (siguen funcionando)
    if (typeof b.codeIndex === 'boolean') st.codeIndex = b.codeIndex; // FT-58
    if (browser.MODES.includes(b.browserMode)) { st.browserMode = b.browserMode; browser.setMode(b.browserMode); } // FT-118
    if (typeof b.cacheAffinity === 'boolean') st.cacheAffinity = b.cacheAffinity; // FT-64
    if (b.maxTaskUsd !== undefined) st.maxTaskUsd = Math.max(0.5, Math.min(50, Number(b.maxTaskUsd) || 3)); // tope de gasto por intento de tarea
    if (b.compactAt !== undefined) st.compactAt = Number(b.compactAt) > 0 ? Math.min(90, Math.max(30, Number(b.compactAt))) / 100 : 0; // FT-63: % de contexto que dispara la compactación (0 = apagada)
    if (['plan', 'suggest', 'off'].includes(b.bigTasks)) st.bigTasks = b.bigTasks; // FT-63: qué hacer con las tareas grandes
    if (typeof b.stuckGuard === 'boolean') st.stuckGuard = b.stuckGuard; // FT-62: umbrales del detector de atascos
    for (const [k, lo, hi] of [['stuckRepeat', 2, 20], ['stuckErrors', 2, 30], ['stuckNoEdit', 5, 200], ['stuckTokens', 5000, 5_000_000]]) if (b[k] !== undefined && Number(b[k]) > 0) st[k] = Math.max(lo, Math.min(hi, Math.round(Number(b[k]))));
    if (b.maxTaskTokens !== undefined) st.maxTaskTokens = Math.max(0, Math.min(50_000_000, Math.round(Number(b.maxTaskTokens) || 0))); // FT-57: tope en tokens por intento (0 = el equivalente al de US$)
    if (['low', 'medium', 'high'].includes(b.agentEffort)) st.agentEffort = b.agentEffort;
    if (b.modelLadder && typeof b.modelLadder === 'object') { // FT-60: escalera de modelos por motor (vacía = la de serie)
      st.modelLadder = { ...st.modelLadder };
      for (const e of ['claude', 'codex']) if (b.modelLadder[e] !== undefined) { const l = normalizeLadder(b.modelLadder[e], e).slice(0, 4); if (l.length) st.modelLadder[e] = l; else delete st.modelLadder[e]; }
    }
    if (b.costTargetPct !== undefined) st.costTargetPct = Math.max(10, Math.min(500, Number(b.costTargetPct) || 100)); // FT-76: objetivo «coste por tarea aprobada ≤ X % del interactivo»
    if (b.maxParallel) st.maxParallel = Math.max(1, Math.min(8, Number(b.maxParallel) || 4));
    if (typeof b.guideModel === 'string') st.guideModel = b.guideModel.trim();
    if (guide.providerNames().includes(b.guideProvider)) st.guideProvider = b.guideProvider;
    if (stt.providerNames().includes(b.sttProvider)) st.sttProvider = b.sttProvider; // FT-9
    if (tts.providerNames().includes(b.ttsProvider)) st.ttsProvider = b.ttsProvider; // FT-52
    if (typeof b.ttsVoice === 'string' && b.ttsVoice.length < 80) st.ttsVoice = b.ttsVoice;
    if (typeof b.sttLang === 'string' && /^(auto|[a-z]{2})$/.test(b.sttLang.trim())) st.sttLang = b.sttLang.trim();
    if (b.guideModels && typeof b.guideModels === 'object') { // modelo por proveedor del Guide (FT-8)
      st.guideModels = { ...st.guideModels };
      for (const n of guide.providerNames()) if (typeof b.guideModels[n] === 'string') { const v = b.guideModels[n].trim(); if (v) st.guideModels[n] = v; else delete st.guideModels[n]; }
    }
    if (b.guidePolicy && typeof b.guidePolicy === 'object') guidePolicy.setPolicy(b.guidePolicy);
    if (typeof b.guideInputFallback === 'boolean') guidePolicy.setPolicy({ guideInputFallback: b.guideInputFallback }); // FT-30
    if (b.browserPolicy && typeof b.browserPolicy === 'object') browserPolicy.setBrowserPolicy(b.browserPolicy); // FT-116
    store.changed();
    return st;
  }],
];

function events(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('state', snapshot());
  send('logs', store.allLogs());
  const onState = () => send('state', snapshot());
  const onLog = (entry) => send('log', entry);
  const onActivity = (ev) => send('activity', ev); // FT-1
  store.bus.on('state', onState);
  store.bus.on('log', onLog);
  const onUi = (cmd) => send('ui', cmd); // FT-4: órdenes del Guide a la UI (navegar, abrir tarea…)
  store.bus.on('activity', onActivity);
  store.bus.on('ui', onUi);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); store.bus.off('state', onState); store.bus.off('log', onLog); store.bus.off('activity', onActivity); store.bus.off('ui', onUi); });
}

// Adjuntos subidos (data/uploads) e imágenes de feedback (data/feedback, FT-28) para verlos desde la tarjeta.
// searchParams ya viene decodificado; no se vuelve a decodificar.
function serveUpload(req, res) {
  const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
  const abs = path.resolve(p);
  const allowed = ['uploads', 'feedback'].some((d) => abs.startsWith(path.join(store.DATA_DIR, d) + path.sep));
  if (!allowed || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404).end('No encontrado'); return; }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || (ext === '.txt' || ext === '.md' ? 'text/plain; charset=utf-8' : 'application/octet-stream'), 'content-disposition': `inline; filename="${path.basename(abs)}"` });
  fs.createReadStream(abs).pipe(res);
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// POST /api/guide/chat {chatId?, text} → SSE con los eventos del proveedor (chat|text|tool_call|tool_result|done|error).
// El turno sigue aunque el navegador se desconecte (el resultado queda en el chat guardado).
async function guideChat(req, res) {
  let b;
  try { b = await readBody(req); } catch (e) { return res.writeHead(e.status || 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
  const it = guide.chat({ chatId: b.chatId, text: b.text, attachments: b.attachments, client: req.headers['x-ao-client'] || null });
  let first;
  try { first = await it.next(); } catch (e) { return res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (ev) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
  try {
    for (let r = first; !r.done; r = await it.next()) send(r.value);
  } catch (e) { send({ type: 'error', error: e.message }); }
  res.end();
}

// POST /api/guide/tts {text, voice?} → audio/wav (o audio/mpeg). 503 si el proveedor no está disponible.
async function guideTts(req, res) {
  try {
    const b = await readBody(req);
    const { audio, mime } = await tts.synthesize(b.text, typeof b.voice === 'string' ? b.voice : undefined, typeof b.provider === 'string' ? b.provider : undefined);
    res.writeHead(200, { 'content-type': mime, 'content-length': audio.length, 'cache-control': 'no-store' }).end(audio);
  } catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (TOKEN && !isLoopback(req) && req.headers['x-ao-token'] !== TOKEN && !/^\/api\/hooks\/[\w-]{16,}$/.test(pathname)) { // 🪝 el webhook se autentica con el token de su URL
    return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"AgentOffice: falta el token (x-ao-token)"}');
  }
  if (pathname === '/events') return events(req, res);
  if (pathname === '/api/file') return serveUpload(req, res);
  if (pathname === '/api/browser/stream') return browserPanel.subscribe(req, res); // FT-117
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  if (pathname === '/api/guide/chat' && req.method === 'POST') return guideChat(req, res);
  if (pathname === '/api/guide/tts' && req.method === 'POST') return guideTts(req, res);
  const route = routes.find(([m, re]) => m === req.method && re.test(pathname));
  if (!route) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Ruta desconocida"}');
  try {
    const out = await route[2](pathname.match(route[1]).slice(1), req.method === 'GET' ? {} : await readBody(req), Object.fromEntries(new URL(req.url, 'http://x').searchParams), req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message, gated: e.gated, suite: e.suite, missing: e.missing }));
  }
});
server.on('upgrade', (req, socket) => { // FT-118: WebSocket de la extensión (solo loopback; se autentica con código/clave)
  if (new URL(req.url, 'http://x').pathname === '/api/browser/ext') browserExt.handleUpgrade(req, socket); else socket.destroy();
});
server.listen(PORT, HOST, () => {
  console.log(`🏢 AgentOffice en http://${HOST}:${PORT}`);
  if (TOKEN) console.log(`🔑 Token para el proxy de flow-test (FLOW_AGENTS_TOKEN): ${TOKEN}`);
});
