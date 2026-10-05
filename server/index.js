// AgentOffice: servidor HTTP sin dependencias — estáticos, API REST y SSE (/events).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as team from './team.js';
import { allRoles } from './roles.js';
import { checkSuite, suiteInfo } from './suite.js';
import * as auth from './engines/auth.js';
import * as boards from './boards/index.js';
import * as skills from './skills.js';
import { saveRole, deleteRole } from './roles.js';

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
setInterval(sync, 5 * 60 * 1000).unref();
// Tableros online con autoSync: cada 5 min.
setInterval(() => { for (const p of store.get().projects) if (p.board?.autoSync) team.syncBoard(p.id).catch(() => {}); }, 5 * 60 * 1000).unref();

const snapshot = () => ({ ...store.get(), roles: allRoles(), engines: team.ENGINE_IDS, suite: suiteInfo() });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}

// Acciones que ponen a trabajar al equipo: solo con un flow-test vigente.
const gated = (fn) => async (m, b) => {
  const suite = await checkSuite();
  if (!suite.ok) throw Object.assign(new Error(suite.reason), { status: 402, gated: 'suite', suite });
  return fn(m, b);
};

const routes = [
  ['GET', /^\/api\/state$/, () => snapshot()],
  // Cuentas de los motores de IA (login OAuth/clave API, logout)
  ['GET', /^\/api\/engines$/, () => auth.enginesStatus()],
  ['POST', /^\/api\/engines\/(claude|codex)\/login$/, async ([e], b) => (b.apiKey ? (await auth.loginWithApiKey(e, b.apiKey), { ok: true }) : auth.startLogin(e, { mode: b.mode }))],
  ['POST', /^\/api\/engines\/(claude|codex)\/code$/, ([e], b) => auth.submitCode(e, b.code)],
  ['POST', /^\/api\/engines\/(claude|codex)\/cancel$/, ([e]) => auth.cancelLogin(e)],
  ['POST', /^\/api\/engines\/(claude|codex)\/logout$/, ([e]) => auth.logout(e)],
  ['GET', /^\/api\/suite$/, () => checkSuite(true).then((suite) => { store.changed(); return suite; })],
  ['POST', /^\/api\/projects$/, (_, b) => team.createProject(b)],
  ['DELETE', /^\/api\/projects\/(\w+)$/, ([id]) => team.deleteProject(id)],
  ['PATCH', /^\/api\/projects\/(\w+)$/, ([id], b) => team.updateProject(id, b)],
  ['POST', /^\/api\/projects\/(\w+)\/import-flow$/, ([id], b) => team.importFlow(id, b.path)],
  ['GET', /^\/api\/flows$/, () => team.listFlows()],
  ['POST', /^\/api\/sync$/, () => team.syncWorkspace()],
  // Catálogo central de skills y roles
  ['GET', /^\/api\/skills$/, () => ({ catalogDir: skills.catalogDir(), catalog: skills.listCatalog(), inventory: skills.inventory() })],
  ['POST', /^\/api\/skills\/centralize$/, (_, b) => skills.centralize(b.dir, b.name)],
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
  ['PATCH', /^\/api\/tasks\/(\w+)$/, ([id], b) => team.updateTask(id, b)],
  ['POST', /^\/api\/projects\/(\w+)\/run$/, gated(([id], b) => team.setRunning(id, b.running))],
  ['POST', /^\/api\/projects\/(\w+)\/goal$/, gated(([id], b) => team.planGoal(id, b.goal))],
  ['POST', /^\/api\/tasks$/, gated((_, b) => team.createTask(b))],
  ['DELETE', /^\/api\/tasks\/(\w+)$/, ([id]) => team.deleteTask(id)],
  ['POST', /^\/api\/tasks\/(\w+)\/approve$/, ([id]) => team.approve(id)],
  ['POST', /^\/api\/tasks\/(\w+)\/reject$/, gated(([id], b) => team.reject(id, b.feedback, b.images))],
  ['GET', /^\/api\/tasks\/(\w+)\/diff$/, async ([id]) => ({ diff: await team.taskDiff(id) })],
  ['POST', /^\/api\/agents$/, (_, b) => team.hire(b)],
  ['PATCH', /^\/api\/agents\/(\w+)$/, ([id], b) => team.updateAgent(id, b)],
  ['DELETE', /^\/api\/agents\/(\w+)$/, ([id]) => team.fire(id)],
  ['POST', /^\/api\/agents\/(\w+)\/stop$/, ([id]) => team.stopAgent(id)],
  ['POST', /^\/api\/settings$/, (_, b) => {
    const st = store.get().settings;
    if (typeof b.flowTestUrl === 'string' && b.flowTestUrl.trim()) st.flowTestUrl = b.flowTestUrl.trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
    if (typeof b.workspaceHostDir === 'string') st.workspaceHostDir = b.workspaceHostDir.trim();
    if (b.maxParallel) st.maxParallel = Math.max(1, Math.min(8, Number(b.maxParallel) || 4));
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
  store.bus.on('state', onState);
  store.bus.on('log', onLog);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); store.bus.off('state', onState); store.bus.off('log', onLog); });
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

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (TOKEN && !isLoopback(req) && req.headers['x-ao-token'] !== TOKEN) {
    return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"AgentOffice: falta el token (x-ao-token)"}');
  }
  if (pathname === '/events') return events(req, res);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  const route = routes.find(([m, re]) => m === req.method && re.test(pathname));
  if (!route) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Ruta desconocida"}');
  try {
    const out = await route[2](pathname.match(route[1]).slice(1), req.method === 'GET' ? {} : await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message, gated: e.gated, suite: e.suite }));
  }
}).listen(PORT, HOST, () => {
  console.log(`🏢 AgentOffice en http://${HOST}:${PORT}`);
  if (TOKEN) console.log(`🔑 Token para el proxy de flow-test (FLOW_AGENTS_TOKEN): ${TOKEN}`);
});
