#!/usr/bin/env node
// FT-115 · e2e de las tools browser.* del Guía y de los agentes (ao-mcp), sobre el driver FAKE (AO_BROWSER=fake).
// Opcional: AO_E2E_REAL_BROWSER=1 repite lo esencial con Chromium real y una web local (headless).
//
//   node scripts/browser-tools-e2e.mjs
//
// Arranca `server/index.js` con AO_DATA_DIR/HOME temporales. Imprime ✓/✗ y sale con 1 si falla algo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { claudeScope } from '../server/engines/toolscope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-btools-e2e-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// flow-test de pega (solo /access) y una web local para el navegador real
const stubPort = await freePort(), webPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
const web = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/dos') ? '<title>Dos</title><h1>Página dos</h1>' : '<title>Inicio</title><h1>Hola mundo</h1><a href="/dos">Ir a dos</a><input aria-label="Nombre"><button>Guardar</button>');
}).listen(webPort, '127.0.0.1');

const servers = [];
let serverLog = '';
async function startServer(name, env = {}) {
  const dataDir = path.join(tmp, 'data-' + name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, browserPolicy: { default: 'ask', domains: { 'example.test': 'allow' } }, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_GUIDE_FAKE: '1', AO_DESKTOP: 'fake', ...env } });
  proc.stdout.on('data', (d) => { serverLog += `[${name}] ${d}`; });
  proc.stderr.on('data', (d) => { serverLog += `[${name}] ${d}`; });
  servers.push(proc);
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
  };
  const c = { dataDir, base, port, get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h) };
  if (!(await until(async () => { try { return (await c.get('/api/state')).ok; } catch { return false; } }, 10_000))) throw new Error(`El servidor «${name}» no arrancó:\n${serverLog}`);
  await c.post('/api/settings', { guideProvider: 'fake' });
  c.tool = (n, args = {}) => c.post('/api/guide/tool', { name: n, args }, { 'x-ao-client': 'bt-e2e' });
  c.pending = async () => (await c.get('/api/questions')).body.filter((q) => q.kind === 'confirm');
  c.toolAnswer = async (n, args, answer) => { // responde la confirmación; sin answer comprueba que NO pregunta
    const p = c.tool(n, args);
    let asked = null;
    if (answer) { asked = await until(async () => (await c.pending())[0], 8000, 80); if (asked) await c.post(`/api/questions/${asked.id}/answer`, { answer }); }
    else { await sleep(300); asked = (await c.pending())[0] || null; }
    return { res: await p, asked };
  };
  c.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'guide-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return c;
}
// Cliente MCP mínimo contra bin/ao-mcp.mjs
function mcpClient(url, env = {}) {
  const p = spawn(process.execPath, ['bin/ao-mcp.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, AO_URL: url, ...env } });
  const waits = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); waits.get(m.id)?.(m); });
  let n = 0;
  const rpc = (method, params) => new Promise((res) => { const id = ++n; waits.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { rpc, close: () => p.kill() };
}
const cleanup = () => { for (const s of servers) { try { s.kill('SIGTERM'); } catch { /* parado */ } } try { stub.close(); web.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const POLICIES = { 'browser.tabs': 'read', 'browser.navigate': 'navigate', 'browser.snapshot': 'read', 'browser.find': 'read', 'browser.click': 'execute', 'browser.type': 'execute', 'browser.select': 'execute', 'browser.scroll': 'navigate', 'browser.press': 'execute', 'browser.waitFor': 'read', 'browser.screenshot': 'read', 'browser.console': 'read', 'browser.network': 'read', 'browser.evaluate': 'execute', 'browser.requestHuman': 'navigate' };

try {
  section('capacidad «browser» por rol (unidad)');
  check('qa-suite y office-flowtest la tienen; back no', claudeScope({ kind: 'qa', roleId: 'qa-suite' }).browser && claudeScope({ kind: 'docs', roleId: 'office-flowtest' }).browser && !claudeScope({ kind: 'dev', roleId: 'back' }).browser);
  check('mode=plan nunca la lleva', !claudeScope({ kind: 'qa', roleId: 'qa-suite', mode: 'plan' }).browser);
  check('`tools: …, browser` la activa y no cuenta como herramienta integrada', (() => { const s = claudeScope({ kind: 'dev', roleId: 'x', roleTools: ['Read', 'browser'] }); return s.browser && s.builtin.join() === 'Read'; })());

  const A = await startServer('fake', { AO_BROWSER: 'fake', AO_BROWSER_WAIT_CONTROL_MS: '1500' });

  section('registro y política');
  const list = (await A.get('/api/guide/tools')).body;
  for (const [n, p] of Object.entries(POLICIES)) check(`${n} → ${p}`, list.find((t) => t.name === n)?.policy === p, String(list.find((t) => t.name === n)?.policy));
  check('browser.open se mantiene y aclara que es el navegador del usuario', /NORMAL del usuario/.test(list.find((t) => t.name === 'browser.open')?.description || ''));
  check('browser.snapshot orienta: «PRIMERO»; screenshot: «solo cuando necesites VER»', /PRIMERO/.test(list.find((t) => t.name === 'browser.snapshot').description) && /solo cuando necesites VER/.test(list.find((t) => t.name === 'browser.screenshot').description));

  section('flujo snapshot → actuar por ref');
  const nav = await A.tool('browser.navigate', { url: 'http://example.test/uno' });
  check('navigate → 200 con url', nav.ok && /example\.test\/uno/.test(nav.body.url), JSON.stringify(nav.body));
  check('navigate con esquema no http → 403 (política FT-116)', (await A.tool('browser.navigate', { url: 'file:///etc/passwd' })).status === 403);
  const snap = await A.tool('browser.snapshot');
  check('snapshot devuelve texto con refs [e1]', snap.ok && /\[e3\] button "Enviar"/.test(snap.body.snapshot), JSON.stringify(snap.body).slice(0, 200));
  const f = await A.tool('browser.find', { role: 'link', text: 'MÁS' });
  check('find por rol+texto (sin mayúsculas/acentos) → e4', f.ok && f.body.count === 1 && f.body.nodes[0].ref === 'e4', JSON.stringify(f.body));
  check('find sin criterios → 400', (await A.tool('browser.find')).status === 400);
  const c1 = await A.toolAnswer('browser.click', { ref: 'e4' }, null);
  check('click en «Más info» → sin confirmación', c1.res.ok && !c1.asked, JSON.stringify(c1.res.body));
  const c2 = await A.toolAnswer('browser.click', { ref: 'e3' }, 'No');
  check('click en «Enviar» (destructivo) → confirmación irreversible; «No» → 403', c2.asked?.kind === 'confirm' && /Enviar/.test(c2.asked.context) && c2.res.status === 403, JSON.stringify(c2.asked));
  check('audit: policy irreversible + denied', (() => { const a = A.audit().filter((x) => x.tool === 'browser.click').at(-1); return a.policy === 'irreversible' && a.result === 'denied'; })());
  const SECRET = 'clave-secreta-FT115';
  const ty = await A.toolAnswer('browser.type', { ref: 'e2', text: SECRET }, null);
  check('type → sin confirmación', ty.res.ok && !ty.asked);
  check('el texto tecleado NO está en el audit (solo nº de caracteres)', (() => { const raw = fs.readFileSync(path.join(A.dataDir, 'guide-audit.jsonl'), 'utf8'); return !raw.includes(SECRET) && /"chars":\d+/.test(raw); })());
  const ts = await A.toolAnswer('browser.type', { ref: 'e2', text: 'x', submit: true }, 'No');
  check('type con submit → irreversible', ts.asked && ts.res.status === 403);
  const pe = await A.toolAnswer('browser.press', { key: 'Enter' }, 'No');
  check('press Enter → irreversible', pe.asked && pe.res.status === 403);
  check('press Tab → sin confirmación', (await A.toolAnswer('browser.press', { key: 'Tab' }, null)).res.ok);
  const ev = await A.toolAnswer('browser.evaluate', { expression: 'document.title' }, 'Sí');
  check('evaluate → pide confirmación SIEMPRE (FT-116) y devuelve valor', ev.asked && ev.res.ok && /document\.title/.test(ev.res.body.value), JSON.stringify(ev.res.body));
  for (const [n, a] of [['browser.scroll', { dy: 300 }], ['browser.waitFor', { ms: 10 }], ['browser.console', {}], ['browser.network', {}], ['browser.tabs', {}], ['browser.select', { ref: 'e2', value: 'x' }]]) {
    const r = await A.tool(n, a);
    check(`${n} → 200`, r.ok, JSON.stringify(r.body));
  }
  const tn = await A.tool('browser.tabs', { action: 'new', url: 'http://example.test/dos' });
  check('tabs new → pestaña activa con la url', tn.ok && tn.body.active && /dos/.test(tn.body.url), JSON.stringify(tn.body));

  section('control compartido (FT-117): con «user» al mando el agente espera');
  await A.post('/api/browser/control', { mode: 'user' });
  const waited = A.tool('browser.click', { ref: 'e4' }); // FT-135: espera y se completa al devolver el control
  await new Promise((r) => setTimeout(r, 400));
  await A.post('/api/browser/control', { mode: 'agent' });
  check('FT-135: browser.click espera a que el usuario devuelva el control y se completa', (await waited).ok);
  await A.post('/api/browser/control', { mode: 'user' });
  check('browser.click con el control en «user» → 409 al vencer la espera', (await A.tool('browser.click', { ref: 'e4' })).status === 409);
  check('browser.navigate con el control en «user» → 409', (await A.tool('browser.navigate', { url: 'http://example.test/x' })).status === 409);
  check('browser.snapshot (lectura) sigue funcionando', (await A.tool('browser.snapshot')).ok);
  await A.post('/api/browser/control', { mode: 'agent' });
  check('devuelto el control, browser.click vuelve a actuar', (await A.tool('browser.click', { ref: 'e4' })).ok);

  section('solo fuera: nunca flow-test/AgentOffice');
  for (const u of [`http://127.0.0.1:${A.port}/`, `http://localhost:${A.port}/x`, `http://127.0.0.1:${stubPort}/`]) {
    const r = await A.tool('browser.navigate', { url: u });
    check(`navigate a ${u.replace('http://', '')} → {inside:true}`, r.ok && r.body.inside === true, JSON.stringify(r.body));
  }
  check('tabs new a la propia UI → {inside:true}', (await A.tool('browser.tabs', { action: 'new', url: `http://127.0.0.1:${A.port}/` })).body.inside === true);

  section('screenshot: imagen por MCP, ruta por API');
  const sa = await A.tool('browser.screenshot');
  check('API: devuelve ruta y NO base64', sa.ok && sa.body.path && fs.existsSync(sa.body.path) && !sa.body.image, JSON.stringify(sa.body).slice(0, 150));
  const m = mcpClient(A.base);
  const sm = (await m.rpc('tools/call', { name: 'browser_screenshot', arguments: {} })).result;
  const img = sm.content.find((x) => x.type === 'image');
  check('MCP: contenido type:image base64 PNG + texto con la ruta', !!img && img.mimeType === 'image/png' && Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG' && /path/.test(sm.content.find((x) => x.type === 'text').text) && !/"data"/.test(sm.content.find((x) => x.type === 'text').text));
  check('MCP: browser_snapshot sigue siendo texto', (await m.rpc('tools/call', { name: 'browser_snapshot', arguments: {} })).result.content.every((x) => x.type === 'text'));
  m.close();

  section('ao-mcp para agentes worker (AO_MCP_ONLY=browser)');
  const w = mcpClient(A.base, { AO_MCP_ONLY: 'browser' });
  const names = (await w.rpc('tools/list')).result.tools.map((t) => t.name);
  check('lista solo browser_* (17), sin browser_open ni task_* ni terminal_*', names.length === 17 && names.every((n) => n.startsWith('browser_')) && !names.includes('browser_open'), names.join());
  check('una tool fuera de la lista → error', !!(await w.rpc('tools/call', { name: 'task_list', arguments: {} })).error);
  w.close();

  if (process.env.AO_E2E_REAL_BROWSER === '1') {
    section('Chromium real (AO_E2E_REAL_BROWSER=1)');
    const R = await startServer('real', { AO_BROWSER_HEADLESS: '1', AO_BROWSER_NO_SANDBOX: process.env.AO_BROWSER_NO_SANDBOX || '' });
    const n1 = await R.tool('browser.navigate', { url: `http://127.0.0.1:${webPort}/` });
    check('navigate real', n1.ok && /Inicio/.test(n1.body.title || ''), JSON.stringify(n1.body));
    const s = await R.tool('browser.snapshot');
    check('snapshot real con «Hola mundo» y refs', s.ok && /Hola mundo/.test(s.body.snapshot) && /\[e\d+\]/.test(s.body.snapshot), JSON.stringify(s.body).slice(0, 200));
    const lk = (await R.tool('browser.find', { role: 'link', text: 'Ir a dos' })).body.nodes?.[0];
    const ck = await R.tool('browser.click', { ref: lk?.ref });
    await R.tool('browser.waitFor', { text: 'Página dos', timeout: 5000 });
    check('click por ref lleva a /dos', ck.ok && /Dos/.test((await R.tool('browser.snapshot')).body.title || ''));
    const sr = await R.tool('browser.screenshot');
    check('screenshot real: PNG en disco', sr.ok && fs.statSync(sr.body.path).size > 500);
    await R.tool('browser.tabs', { action: 'close' });
  }
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}\n${serverLog.slice(-1500)}`);
}
console.log(`\n${passed}/${passed + failed} checks${failed ? ` · ${failed} FALLAN` : ''}`);
process.exit(failed ? 1 : 0);
