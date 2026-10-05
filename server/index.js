// AgentOffice: servidor HTTP sin dependencias — estáticos, API REST y SSE (/events).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as team from './team.js';
import { ROLES } from './roles.js';

const PORT = Number(process.env.AO_PORT || 7420);
const HOST = process.env.AO_HOST || '127.0.0.1'; // lanza procesos con tus permisos: solo local
const PUBLIC = path.join(store.ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Primer arranque: un proyecto de demostración para ver la oficina sin configurar nada.
if (!store.get().projects.length) await team.createProject({ name: 'Demo — Tienda online' });

const snapshot = () => ({ ...store.get(), roles: ROLES, engines: team.ENGINE_IDS });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}

const routes = [
  ['GET', /^\/api\/state$/, () => snapshot()],
  ['POST', /^\/api\/projects$/, (_, b) => team.createProject(b)],
  ['DELETE', /^\/api\/projects\/(\w+)$/, ([id]) => team.deleteProject(id)],
  ['POST', /^\/api\/projects\/(\w+)\/run$/, ([id], b) => team.setRunning(id, b.running)],
  ['POST', /^\/api\/projects\/(\w+)\/goal$/, ([id], b) => team.planGoal(id, b.goal)],
  ['POST', /^\/api\/tasks$/, (_, b) => team.createTask(b)],
  ['DELETE', /^\/api\/tasks\/(\w+)$/, ([id]) => team.deleteTask(id)],
  ['POST', /^\/api\/tasks\/(\w+)\/approve$/, ([id]) => team.approve(id)],
  ['POST', /^\/api\/tasks\/(\w+)\/reject$/, ([id], b) => team.reject(id, b.feedback)],
  ['GET', /^\/api\/tasks\/(\w+)\/diff$/, async ([id]) => ({ diff: await team.taskDiff(id) })],
  ['POST', /^\/api\/agents$/, (_, b) => team.hire(b)],
  ['PATCH', /^\/api\/agents\/(\w+)$/, ([id], b) => team.updateAgent(id, b)],
  ['DELETE', /^\/api\/agents\/(\w+)$/, ([id]) => team.fire(id)],
  ['POST', /^\/api\/agents\/(\w+)\/stop$/, ([id]) => team.stopAgent(id)],
  ['POST', /^\/api\/settings$/, (_, b) => {
    const st = store.get().settings;
    if (typeof b.flowTestMcpUrl === 'string') st.flowTestMcpUrl = b.flowTestMcpUrl.trim();
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
  if (pathname === '/events') return events(req, res);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  const route = routes.find(([m, re]) => m === req.method && re.test(pathname));
  if (!route) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Ruta desconocida"}');
  try {
    const out = await route[2](pathname.match(route[1]).slice(1), req.method === 'GET' ? {} : await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`🏢 AgentOffice en http://${HOST}:${PORT}`));
