#!/usr/bin/env node
// e2e del Guide Agent (FT-11): flujos A–D de la especificación, Policy Layer, eventos y contexto. Sin dependencias nuevas.
//
//   node scripts/guide-e2e.mjs
//
// Arranca `server/index.js` en un puerto libre con AO_DATA_DIR y HOME temporales, el motor `demo`, un flow-test de pega
// (solo responde a /access) y el proveedor de pruebas del Guide `fake` (AO_GUIDE_FAKE=1), que ejecuta un guion de tool calls
// escrito en el propio mensaje (` ::[{"tool":…}]`). Un `claude` falso (AO_CLAUDE_BIN) escribe ficheros reales en una rama
// para el flujo D. Imprime ✓/✗ por check y sale con 1 si falla alguno.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guide-e2e-'));
const dataDir = path.join(tmp, 'data');
const homeDir = path.join(tmp, 'home'); // HOME vacío: el servidor no importa el workspace real de flow-test
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 40_000, step = 150) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ── Infraestructura: flow-test de pega, repo git con un `claude` falso y el servidor ──────────────
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}'); // sin /workspace/flows: el servidor no sincroniza proyectos del workspace real
}).listen(stubPort, '127.0.0.1');

const repo = path.join(tmp, 'repo');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' } }).trim();
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), '# repo e2e\n');
git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');

const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
// claude falso (stream-json): al recibir el prompt escribe dos ficheros en su cwd y responde; sale cuando se cierra stdin.
const fs = require('node:fs'); const path = require('node:path');
let started = false;
process.stdin.on('data', () => {
  if (started) return; started = true;
  fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'src', 'guide-e2e.txt'), 'hola\\n');
  fs.writeFileSync(path.join(process.cwd(), 'NOTES-e2e.md'), '# notas\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'fake', tools: [], session_id: 's1' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Escribo los ficheros' }] }, session_id: 's1' });
  out({ type: 'result', result: 'Hecho: src/guide-e2e.txt y NOTES-e2e.md', is_error: false, total_cost_usd: 0, session_id: 's1' });
});
process.stdin.on('end', () => process.exit(0));
`);
fs.chmodSync(fakeClaude, 0o755);

// Estado inicial: ya apunta al flow-test de pega, para que el arranque no hable con el flow-test real (puerto 9998).
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_GUIDE_FAKE: '1', AO_CLAUDE_BIN: fakeClaude, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ── Cliente HTTP ──────────────────────────────────────────────────────────
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}
const get = (p, h) => call('GET', p, undefined, h);
const post = (p, b = {}, h) => call('POST', p, b, h);
const state = async () => (await get('/api/state')).body;
const taskByCode = async (code) => (await state()).tasks.find((t) => t.code === code);
const agentOf = async (t) => (await state()).agents.find((a) => a.id === t.agentId);
const CLIENT = { 'x-ao-client': 'e2e-tab' };
const tool = (name, args, h = CLIENT) => post('/api/guide/tool', { name, args }, h);

// Confirmaciones pendientes del Policy Layer (kind:'confirm' en /api/questions).
const pendingConfirms = async () => (await get('/api/questions')).body.filter((q) => q.kind === 'confirm');
// Lanza una tool y, cuando aparece la confirmación, responde `answer` ('Sí'|'No'|null = no debería preguntar).
async function toolWithAnswer(name, args, answer, h = CLIENT) {
  const p = tool(name, args, h);
  let asked = null;
  if (answer) {
    asked = await until(async () => (await pendingConfirms())[0], 8000, 80);
    if (asked) await post(`/api/questions/${asked.id}/answer`, { answer });
  } else {
    await sleep(400);
    asked = (await pendingConfirms())[0] || null;
  }
  return { res: await p, asked };
}

// Chat SSE con el proveedor `fake`: devuelve los eventos recibidos. `answers`: respuestas a las confirmaciones, en orden.
async function chat(text, script, { chatId, answers = [] } = {}) {
  const msg = script ? `${text} ::${JSON.stringify(script)}` : text;
  const r = await fetch(`${base}/api/guide/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...CLIENT }, body: JSON.stringify({ chatId, text: msg }) });
  if (!r.ok) return { status: r.status, events: [], error: (await r.json().catch(() => ({}))).error };
  const events = [];
  let done = false;
  const watcher = (async () => {
    const queue = [...answers];
    while (!done && queue.length) {
      const q = (await pendingConfirms())[0];
      if (q) { await post(`/api/questions/${q.id}/answer`, { answer: queue.shift() }); }
      await sleep(100);
    }
  })();
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  done = true;
  await watcher;
  return { status: r.status, events, chatId: events.find((e) => e.type === 'chat')?.chat.id };
}

// SSE global (/events): activity y ui.
const sse = { activity: [], ui: [] };
const sseAbort = new AbortController();
async function listenSse() {
  const r = await fetch(`${base}/events`, { signal: sseAbort.signal });
  let buf = '';
  const dec = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
        const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
        if (data && (ev === 'activity' || ev === 'ui')) sse[ev].push(JSON.parse(data));
      }
    }
  } catch { /* cerrado al terminar */ }
}

try {
  if (!(await until(async () => { try { return (await get('/api/state')).ok; } catch { return false; } }, 10_000, 100))) throw new Error('El servidor no arrancó:\n' + serverLog);
  listenSse();
  await post('/api/settings', { guideProvider: 'fake' });
  check('el proveedor de pruebas «fake» se acepta en ajustes (AO_GUIDE_FAKE=1)', (await state()).settings.guideProvider === 'fake');

  // Proyecto A (demo, sin repo) con el equipo base; proyecto B con repo git y un agente Claude (falso) para el flujo D.
  const A = (await post('/api/projects', { name: 'e2e-demo', engine: 'demo' })).body;
  const B = (await post('/api/projects', { name: 'e2e-git', repoPath: repo, engine: 'demo' })).body;
  await post('/api/agents', { projectId: B.id, name: 'Fran', role: 'back', engine: 'claude' });
  const PA = (await state()).projects.find((p) => p.id === A.id).prefixDefault;
  const PB = (await state()).projects.find((p) => p.id === B.id).prefixDefault;
  check('hay dos proyectos con prefijos de código distintos', !!PA && !!PB && PA !== PB, `${PA} / ${PB}`);

  // ── 1. Application Context (FT-2) ─────────────────────────────────────────
  section('Contexto de la aplicación: POST /api/context → GET /api/context');
  const empty = (await get('/api/context')).body;
  check('sin nadie conectado el contexto viene vacío (client null, view null)', empty.client === null && empty.view === null);
  const host = { flow: 'flows/login.flow.json', filePath: '/ws/flows/login.flow.json', node: 'n7', nodeLabel: 'POST /login', consoleTail: ['401 Unauthorized'] };
  const pub = await post('/api/context', { view: 'tasks', projectId: A.id, host }, CLIENT);
  check('POST /api/context devuelve ok', pub.ok && pub.body.ok === true);
  const ctx = (await get('/api/context', CLIENT)).body;
  check('GET /api/context devuelve el cliente, la vista y el proyecto resuelto', ctx.client === 'e2e-tab' && ctx.view === 'tasks' && ctx.project?.name === 'e2e-demo' && ctx.project.prefix === PA, JSON.stringify({ c: ctx.client, v: ctx.view, p: ctx.project?.name }));
  check('el contexto de flow-test (host) llega tal cual', ctx.host?.flow === host.flow && ctx.host?.node === 'n7' && ctx.host?.consoleTail?.[0] === '401 Unauthorized');
  await post('/api/context', { view: 'inventada', projectId: A.id }, { 'x-ao-client': 'otra-pestana' });
  check('rechazo: una vista no válida se publica como null', (await get('/api/context', { 'x-ao-client': 'otra-pestana' })).body.view === null);
  check('GET sin cliente devuelve el más reciente; con cliente, el pedido', (await get('/api/context')).body.client === 'otra-pestana' && (await get('/api/context?client=e2e-tab')).body.client === 'e2e-tab');
  await post('/api/context', { view: 'tasks', projectId: A.id, host }, CLIENT); // el de la pestaña de pruebas vuelve a ser el más reciente
  check('app.getContext (tool read) devuelve lo mismo y no pregunta', (await tool('app.getContext', { client: 'e2e-tab' })).body.host?.flow === host.flow && (await pendingConfirms()).length === 0);

  // ── 2. Eventos en orden para una tarea demo (FT-1) ────────────────────────
  section('Activity Stream: eventos en orden de una tarea demo');
  const mk = async (project, title, role) => (await post('/api/tasks', { projectId: project.id, title, role, description: 'e2e' })).body;
  const tEv = await mk(A, 'Tarea de eventos', 'back');
  const tPause = await mk(A, 'Tarea para pausar', 'front');
  check('las tareas nacen con código legible', [tEv, tPause].every((t) => new RegExp(`^${PA}-\\d+$`).test(t.code || '')), [tEv.code, tPause.code].join(','));
  check('POST /api/tasks sin título se rechaza (400)', (await post('/api/tasks', { projectId: A.id, role: 'back' })).status === 400);
  await post(`/api/projects/${A.id}/run`, { running: true });

  // Pausar/reanudar mientras la de front trabaja (flujo C, parte pausa).
  section('Flujo C · «Páralo»: pausa, reanudación y constraint');
  const working = await until(async () => { const t = await taskByCode(tPause.code); const a = t?.status === 'doing' && await agentOf(t); return a?.status === 'working' ? a : null; });
  check('la tarea pasa a «doing» y su agente a «working»', !!working);
  const paused = await tool('task.pause', { code: tPause.code });
  check('task.pause (execute, auto) no pide confirmación y devuelve el agente', paused.ok && (await pendingConfirms()).length === 0 && paused.body.status === 'paused', JSON.stringify(paused.body));
  const stPaused = await state();
  check('el agente queda en «paused» y la tarea sigue «doing»', stPaused.agents.find((a) => a.id === working.id).status === 'paused' && stPaused.tasks.find((t) => t.code === tPause.code).status === 'doing');
  const act1 = stPaused.agents.find((a) => a.id === working.id).activity;
  await sleep(1500);
  check('en pausa el demo no avanza (la actividad no cambia)', (await state()).agents.find((a) => a.id === working.id).activity === act1);
  check('rechazo: pausar dos veces → 409', (await tool('task.pause', { code: tPause.code })).status === 409);
  const tIdle = (await post('/api/tasks', { projectId: A.id, title: 'En el backlog', role: 'back', status: 'backlog' })).body;
  check('rechazo: pausar una tarea que no está en curso → 409', (await tool('task.pause', { code: tIdle.code })).status === 409);
  const resumed = await tool('task.resume', { code: tPause.code });
  check('task.resume devuelve al agente a «working»', resumed.ok && resumed.body.status === 'working', JSON.stringify(resumed.body));
  check('rechazo: reanudar un agente que no está en pausa → 409', (await tool('task.resume', { code: tPause.code })).status === 409);
  const stillDoing = await until(async () => { const t = await taskByCode(tPause.code); return t.status === 'review' ? t : null; });
  check('tras reanudar la tarea avanza y termina en «review»', !!stillDoing);

  // agent.message con constraint: el demo no admite entrada en caliente → reencola la MISMA tarea.
  section('Flujo C · agent.message con constraint (demo reencola)');
  // La tarea se crea AQUÍ (no al principio): el demo tarda un tiempo aleatorio y si ya hubiera terminado no estaría «doing».
  const tMsg = await mk(A, 'Tarea para mensaje', 'qa');
  const msgTask = await until(async () => { const t = await taskByCode(tMsg.code); return t?.status === 'doing' ? t : null; });
  const msgAgent = msgTask && await agentOf(msgTask);
  await post('/api/settings', { guidePolicy: { write: 'auto' } });
  const msg = await tool('agent.message', { agentId: msgAgent?.id || 'x', message: 'no toques server/index.js', constraint: true });
  check('agent.message (write, auto) responde «requeued» para el motor demo', msg.ok && msg.body.delivered === 'requeued', JSON.stringify(msg.body));
  const reTask = await until(async () => { const t = await taskByCode(tMsg.code); return t && t.attempts >= 2 && t.status === 'doing' ? t : null; }, 30_000);
  check('la tarea se reencola y vuelve a ejecutarse (intento 2, misma tarea)', !!reTask && reTask.id === tMsg.id, reTask ? '' : 'no llegó a un 2.º intento');
  check('la restricción queda en task.constraints con origen «guide»', (reTask?.constraints || []).some((c) => c.text === 'no toques server/index.js' && c.origin === 'guide'));
  check('rechazo: agent.message a un agente que no trabaja → 409', (await tool('agent.message', { agentId: msgAgent?.name || 'x', message: 'hola' })).status === 409 || (await agentOf(reTask || msgTask))?.status === 'working');
  check('rechazo: agent.message sin texto → 400', (await tool('agent.message', { agentId: 'x' })).status === 400);
  const cons = await tool('task.addConstraint', { code: tEv.code, text: 'solo ficheros de server/' });
  check('task.addConstraint añade la restricción a la tarea', cons.ok && (await taskByCode(tEv.code)).constraints.some((c) => c.text === 'solo ficheros de server/'));
  await post('/api/settings', { guidePolicy: { write: 'confirm' } });

  // Esperar a que la tarea de eventos termine y comprobar el orden.
  const evTask = await until(async () => { const t = await taskByCode(tEv.code); return t?.status === 'review' ? t : null; });
  check('la tarea de eventos llega a «review»', !!evTask);
  // El AgentCompleted se emite justo tras poner la tarea en «review»: se espera (hasta 3 s) a que sea el último evento.
  const evs = (await until(async () => { const l = (await get(`/api/events?taskId=${tEv.code}&limit=500`)).body; return l.at(-1)?.type === 'AgentCompleted' ? l : null; }, 3000)) || (await get(`/api/events?taskId=${tEv.code}&limit=500`)).body;
  const types = evs.map((e) => e.type);
  const firstAt = (t) => types.indexOf(t);
  const order = ['TaskCreated', 'TaskAssigned', 'AgentStarted', 'AgentToolStarted', 'AgentToolFinished', 'AgentArtifactCreated', 'AgentCompleted'];
  check('aparecen en orden: ' + order.join(' → '), order.every((t) => firstAt(t) >= 0) && order.every((t, i) => i === 0 || firstAt(order[i - 1]) <= firstAt(t)), types.join(','));
  // El constraint de la prueba anterior puede quedar registrado (UserInstructionAdded) justo después de que el worker demo termine: no es un evento del agente.
  const lastAgentEv = evs.filter((e) => e.type !== 'UserInstructionAdded').at(-1);
  check('el último evento del agente es AgentCompleted (status review)', lastAgentEv?.type === 'AgentCompleted' && lastAgentEv.data.status === 'review', types.slice(-4).join(' → '));
  check('los eventos van en orden cronológico y con ids únicos y ordenables', evs.every((e, i) => i === 0 || e.ts >= evs[i - 1].ts) && new Set(evs.map((e) => e.id)).size === evs.length && evs.every((e, i) => i === 0 || e.id > evs[i - 1].id));
  check('todos traen taskId, taskCode, projectId y agentId correlacionables', evs.every((e) => e.taskId === tEv.id && e.taskCode === tEv.code && e.projectId === A.id) && evs.filter((e) => e.type !== 'TaskCreated' && e.type !== 'UserInstructionAdded').every((e) => e.agentId));
  const started = evs.filter((e) => e.type === 'AgentToolStarted'), finished = new Set(evs.filter((e) => e.type === 'AgentToolFinished').map((e) => e.data.callId));
  check('cada AgentToolStarted tiene su AgentToolFinished (mismo callId)', started.length > 0 && started.every((e) => finished.has(e.data.callId)));
  const half = evs[Math.floor(evs.length / 2)];
  check('GET /api/events?since=<id> devuelve solo lo posterior', (await get(`/api/events?taskId=${tEv.code}&since=${half.id}`)).body.every((e) => e.id > half.id));
  check('GET /api/events por código en minúsculas y con límite', (await get(`/api/events?taskId=${tEv.code.toLowerCase()}&limit=2`)).body.length === 2);
  check('GET /api/events de una tarea inexistente devuelve lista vacía', (await get('/api/events?taskId=ZZ-999')).body.length === 0);
  const viaSse = sse.activity.filter((e) => e.taskId === tEv.id).map((e) => e.id);
  check('el SSE (/events) emitió los mismos eventos de la tarea', evs.every((e) => viaSse.includes(e.id)));
  const pauseEvs = (await get(`/api/events?taskId=${tPause.code}&limit=500`)).body.map((e) => e.type);
  check('pausa/reanudación dejaron AgentPaused → AgentResumed', pauseEvs.indexOf('AgentPaused') >= 0 && pauseEvs.indexOf('AgentResumed') > pauseEvs.indexOf('AgentPaused'), pauseEvs.join(','));
  const msgEvs = (await get(`/api/events?taskId=${tMsg.code}&limit=500`)).body;
  const ui = msgEvs.find((e) => e.type === 'UserInstructionAdded');
  check('el constraint dejó UserInstructionAdded (kind constraint, origin guide) y la tarea se volvió a asignar', ui?.data.kind === 'constraint' && ui.data.origin === 'guide' && msgEvs.filter((e) => e.type === 'TaskAssigned').length >= 2);
  await post(`/api/tasks/${tEv.id}/reject`, { feedback: 'e2e: otra vuelta' });
  check('devolver la tarea deja TaskReviewed (rejected) y UserInstructionAdded (feedback)', (await get(`/api/events?taskId=${tEv.code}`)).body.some((e) => e.type === 'TaskReviewed' && e.data.decision === 'rejected') && (await get(`/api/events?taskId=${tEv.code}`)).body.some((e) => e.type === 'UserInstructionAdded' && e.data.kind === 'feedback'));
  await post(`/api/projects/${A.id}/run`, { running: false });

  // ── 3. Policy Layer (FT-4) ────────────────────────────────────────────────
  section('Policy Layer: irreversible, write confirm/auto');
  const draftCount = async () => (await state()).tasks.filter((t) => t.projectId === A.id).length;
  const n0 = await draftCount();
  check('por defecto write=confirm', (await state()).guidePolicy.write === 'confirm');
  const tc1 = await toolWithAnswer('task.create', { projectId: A.id, title: 'Rechazada por el usuario', role: 'back' }, 'No');
  check('write con confirm: pregunta (kind confirm, opciones Sí/No) y responder «No» aborta con 403', tc1.asked?.kind === 'confirm' && tc1.asked.options.join() === 'Sí,No' && tc1.res.status === 403, `status ${tc1.res.status}`);
  check('…y no se creó la tarea', (await draftCount()) === n0);
  const tc2 = await toolWithAnswer('task.create', { projectId: A.id, title: 'Aceptada por el usuario', role: 'back' }, 'Sí');
  check('write con confirm: responder «Sí» ejecuta la tool y crea la tarea con código', tc2.res.ok && /^[A-Z]+-\d+$/.test(tc2.res.body.code || '') && (await draftCount()) === n0 + 1, JSON.stringify(tc2.res.body));
  await post('/api/settings', { guidePolicy: { write: 'auto' } });
  check('ajustes: guidePolicy.write=auto se refleja en el snapshot', (await state()).guidePolicy.write === 'auto');
  const tc3 = await toolWithAnswer('task.create', { projectId: A.id, title: 'Sin preguntar', role: 'back' }, null);
  check('write con auto: no pregunta y crea la tarea', tc3.res.ok && !tc3.asked && (await draftCount()) === n0 + 2, tc3.asked ? 'preguntó' : JSON.stringify(tc3.res.body));
  const delT = tc3.res.body.code;
  const d1 = await toolWithAnswer('task.delete', { code: delT }, 'No');
  check('irreversible: pregunta aunque write=auto; «No» aborta (403) y la tarea sigue', !!d1.asked && d1.res.status === 403 && !!(await taskByCode(delT)));
  const d2 = await toolWithAnswer('task.delete', { code: delT }, 'Sí');
  check('irreversible: «Sí» borra la tarea', !!d2.asked && d2.res.ok && !(await taskByCode(delT)));
  check('read (task.list) y navigate (app.navigate) no preguntan', (await tool('task.list', {})).ok && (await tool('app.navigate', { view: 'agents' })).ok && (await pendingConfirms()).length === 0);
  const pend = await tool('flowtest.deleteFlow', { flow: 'x.flow.json' });
  check('tool pendiente (flowtest.deleteFlow) responde 501 sin pedir confirmación', pend.status === 501 && (await pendingConfirms()).length === 0);
  check('rechazo: tool desconocida → 404', (await tool('no.existe', {})).status === 404);
  check('rechazo: argumento obligatorio ausente → 400', (await tool('task.create', { projectId: A.id, role: 'back' })).status === 400);
  check('rechazo: argumento desconocido → 400', (await tool('task.list', { cosa: 1 })).status === 400);
  check('rechazo: tarea inexistente → 404', (await tool('task.getStatus', { code: 'ZZ-999' })).status === 404);
  await post('/api/settings', { guidePolicy: { write: 'confirm', execute: 'confirm' } });
  const ex = await toolWithAnswer('task.pause', { code: tPause.code }, 'No');
  check('execute=confirm: también pregunta (y «No» aborta con 403 antes de tocar al agente)', !!ex.asked && ex.res.status === 403);
  await post('/api/settings', { guidePolicy: { write: 'confirm', execute: 'auto' } });
  const audit = fs.readFileSync(path.join(dataDir, 'guide-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('auditoría (guide-audit.jsonl): registra confirmadas, denegadas y automáticas', audit.some((a) => a.tool === 'task.create' && a.confirmed === true && a.result === 'ok') && audit.some((a) => a.tool === 'task.create' && a.result === 'denied') && audit.some((a) => a.tool === 'task.list' && a.mode === 'auto') && audit.some((a) => a.tool === 'task.delete' && a.policy === 'irreversible'));

  // ── 4. Flujo A: crear una tarea desde lo que estoy viendo (FT-7) ─────────
  section('Flujo A · «Créame una tarea para solucionar esto»');
  await post('/api/context', { view: 'tasks', projectId: A.id, host }, CLIENT);
  const fa = await chat('Créame una tarea para solucionar esto', [
    { say: 'Miro dónde estás' }, { tool: 'app.getContext', args: {} },
    { tool: 'task.create', args: { projectId: A.id, title: 'Arreglar el 401 de POST /login', description: 'Hecho cuando: login devuelve 200', role: 'back', skills: ['x'] } },
  ], { answers: ['Sí'] });
  const ta = (await state()).tasks.find((t) => t.title === 'Arreglar el 401 de POST /login');
  check('el chat SSE emite chat → text → tool_call → tool_result → done', ['chat', 'text', 'tool_call', 'tool_result', 'done'].every((t) => fa.events.some((e) => e.type === t)) && fa.events.at(-1).type === 'done', fa.events.map((e) => e.type).join(','));
  check('cada tool_call tiene su tool_result (mismo id) y ok', fa.events.filter((e) => e.type === 'tool_call').every((c) => fa.events.some((r) => r.type === 'tool_result' && r.id === c.id && r.ok)));
  check('la tarea creada tiene código y proyecto', !!ta && /^[A-Z]+-\d+$/.test(ta.code) && ta.projectId === A.id, JSON.stringify(ta?.code));
  check('la tarea guarda el `context` publicado (flow, nodo, consola) tomado del servidor', ta?.context?.host?.flow === host.flow && ta.context.host.node === 'n7' && ta.context.host.consoleTail?.[0] === '401 Unauthorized' && ta.context.view === 'tasks', JSON.stringify(ta?.context));
  check('task.get devuelve el context y la tarea consta en task.list', (await tool('task.get', { code: ta.code })).body.context?.host?.flow === host.flow && (await tool('task.list', { projectId: A.id })).body.some((t) => t.code === ta.code));
  const saved = (await get(`/api/guide/chats/${fa.chatId}`)).body;
  check('el chat guardado conserva usuario, texto y tool calls con resultado', saved.messages.some((m) => m.role === 'user') && saved.messages.some((m) => m.role === 'assistant') && saved.messages.filter((m) => m.role === 'tool' && m.ok === true).length === 2, saved.messages.map((m) => m.role).join(','));
  const faDeny = await chat('Créala', [{ tool: 'task.create', args: { projectId: A.id, title: 'No debería existir', role: 'back' } }], { chatId: fa.chatId, answers: ['No'] });
  const denied = faDeny.events.find((e) => e.type === 'tool_result');
  check('seguir en el mismo chat: si el usuario dice «No» a la confirmación el tool_result es error y no se crea', denied?.ok === false && /rechaz/i.test(denied.result) && !(await state()).tasks.some((t) => t.title === 'No debería existir'));
  check('rechazo: chat sin texto → 400', (await post('/api/guide/chat', { text: '  ' })).status === 400);
  check('rechazo: chat inexistente → 404', (await post('/api/guide/chat', { chatId: 'g_nada', text: 'hola' })).status === 404);
  check('un mensaje sin guion devuelve eco y done', (await chat('hola guía')).events.some((e) => e.type === 'text' && e.text.includes('hola guía')));
  const badScript = await chat('x', null);
  check('GET /api/guide/chats lista los chats', (await get('/api/guide/chats')).body.length >= 3 && badScript.events.length > 0);

  // ── 5. Flujo B: «¿Cómo va?» ───────────────────────────────────────────────
  section('Flujo B · «¿Cómo va?»');
  await post(`/api/projects/${A.id}/run`, { running: true });
  const fb = await chat('¿Cómo va?', [{ tool: 'task.list', args: { projectId: A.id } }, { tool: 'task.getStatus', args: { code: tMsg.code } }, { tool: 'agent.list', args: {} }]);
  const res = (n) => { const c = fb.events.find((e) => e.type === 'tool_call' && e.name === n); const r = fb.events.find((e) => e.type === 'tool_result' && e.id === c?.id); return r?.ok ? JSON.parse(r.result) : null; };
  check('task.list devuelve las tareas del proyecto con código y estado', res('task.list')?.some((t) => t.code === tEv.code && t.status) === true);
  const gs = res('task.getStatus');
  check('task.getStatus trae estado, últimas acciones y eventos del Activity Stream', gs?.code === tMsg.code && Array.isArray(gs.lastActions) && gs.events.length > 0 && gs.events.every((e) => e.taskCode === tMsg.code), JSON.stringify(gs && Object.keys(gs)));
  check('agent.list devuelve los agentes con estado', res('agent.list')?.every((a) => a.name && a.status) === true);
  check('el resumen no preguntó nada (todo es lectura)', (await pendingConfirms()).length === 0);

  // ── 6. Flujo D: «Enséñame lo que ha cambiado» ─────────────────────────────
  section('Flujo D · «Enséñame lo que ha cambiado»');
  const tD = await mk(B, 'Tarea con cambios reales', 'back');
  await post(`/api/projects/${B.id}/run`, { running: true });
  const doneD = await until(async () => { const t = await taskByCode(tD.code); return t?.status === 'review' || t?.status === 'failed' ? t : null; }, 40_000);
  check('el agente (claude falso) termina la tarea en «review» con rama propia', doneD?.status === 'review' && doneD.branch === `ao/${tD.code}`, JSON.stringify({ s: doneD?.status, b: doneD?.branch, e: doneD?.error }));
  const fd = await chat('Enséñame lo que ha cambiado', [
    { tool: 'agent.getModifiedFiles', args: { code: tD.code } },
    { tool: 'app.openArtifact', args: { code: tD.code } },
  ]);
  const mf = fd.events.find((e) => e.type === 'tool_result');
  const files = mf?.ok ? JSON.parse(mf.result).files : [];
  check('agent.getModifiedFiles devuelve los ficheros del diff (base...rama)', files.includes('NOTES-e2e.md') && files.includes('src/guide-e2e.txt') && files.length === 2, JSON.stringify(files));
  const oa = fd.events.filter((e) => e.type === 'tool_result')[1];
  check('app.openArtifact devuelve el diff con esos ficheros', oa?.ok && JSON.parse(oa.result).diff.includes('src/guide-e2e.txt'));
  const openUi = await until(async () => sse.ui.find((u) => u.type === 'openTask' && u.taskId === tD.id), 3000);
  check('la UI recibe la orden estructurada `ui` openTask por SSE (sin capturas)', !!openUi && openUi.client === 'e2e-tab', JSON.stringify(openUi));
  check('por agente (sin código) también: devuelve la última tarea del agente', (await tool('agent.getModifiedFiles', { agentId: 'Fran' })).body.files?.length === 2);
  const arts = (await tool('agent.getArtifacts', { code: tD.code })).body;
  check('agent.getArtifacts da diffStat y el commit de la rama', /guide-e2e\.txt/.test(arts.diffStat || '') && arts.commits?.length === 1 && arts.commits[0].includes(tD.code), JSON.stringify(arts));
  check('el diff del demo sin rama lo dice (no inventa ficheros)', Array.isArray((await tool('agent.getModifiedFiles', { code: tEv.code })).body.files) && (await tool('agent.getModifiedFiles', { code: tEv.code })).body.files.length === 0);
  check('rechazo: agent.getModifiedFiles sin tarea ni agente → 404', (await tool('agent.getModifiedFiles', {})).status === 404);
  await post(`/api/tasks/${tD.id}/approve`);
  check('aprobar fusiona la rama y deja TaskReviewed (approved, merged)', (await get(`/api/events?taskId=${tD.code}`)).body.some((e) => e.type === 'TaskReviewed' && e.data.decision === 'approved' && e.data.merged === true));
  check('tras fusionar, getModifiedFiles no falla (rama borrada) y avisa', (await tool('agent.getModifiedFiles', { code: tD.code })).body.note?.includes('ya se fusionó') === true);
  await post(`/api/projects/${B.id}/run`, { running: false });
  await post(`/api/projects/${A.id}/run`, { running: false });

  // ── 7. Parada y límites del chat ───────────────────────────────────────────
  section('Chat: parar');
  check('POST /api/guide/stop sin turno en curso responde ok (stopped=false)', (await post('/api/guide/stop', { chatId: fa.chatId })).body.stopped === false);
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}`);
  if (serverLog) console.log('--- log del servidor ---\n' + serverLog.slice(-2000));
} finally {
  sseAbort.abort();
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} checks correctos, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
