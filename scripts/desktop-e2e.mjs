#!/usr/bin/env node
// e2e de las tools de escritorio del Guide (FT-24): window.getActive, window.list, screen.capture y screen.describe (FT-21..23).
// Sin dependencias nuevas.
//
//   node scripts/desktop-e2e.mjs          # contra el provider fake (AO_DESKTOP=fake), determinista
//   node scripts/desktop-e2e.mjs --real   # además llama a getActive/list/capture contra el escritorio de verdad (solo informa)
//
// Arranca `server/index.js` en un puerto libre con AO_DATA_DIR y HOME temporales y el proveedor `fake` del Guide.
// Hasta cuatro servidores: el normal; otro con AO_DESKTOP_FAKE_ACTIVE=AgentOffice (regla «solo fuera»); otro con
// AO_DESKTOP_PLATFORM=darwin (plataforma no Linux simulada); y el de --real. Imprime ✓/✗ por check y sale con 1 si falla alguno.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.argv.includes('--real');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-desktop-e2e-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// flow-test de pega: solo responde a /access
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

const servers = [];
let serverLog = '';
// Arranca un servidor con su propio DATA_DIR; devuelve un cliente con get/post/tool/toolAnswer/audit.
async function startServer(name, env, guideProvider = 'fake') {
  const dataDir = path.join(tmp, 'data-' + name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const procEnv = { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_GUIDE_FAKE: '1', ...env };
  for (const k of Object.keys(procEnv)) if (procEnv[k] === '') delete procEnv[k]; // '' = quitar la variable
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: procEnv });
  proc.stdout.on('data', (d) => { serverLog += `[${name}] ${d}`; });
  proc.stderr.on('data', (d) => { serverLog += `[${name}] ${d}`; });
  servers.push(proc);
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
  };
  const c = { dataDir, base, call, get: (p, h) => call('GET', p, undefined, h), post: (p, b = {}, h) => call('POST', p, b, h) };
  if (!(await until(async () => { try { return (await c.get('/api/state')).ok; } catch { return false; } }, 10_000))) throw new Error(`El servidor «${name}» no arrancó:\n${serverLog}`);
  await c.post('/api/settings', { guideProvider });
  c.tool = (n, args = {}, client = 'e2e-a') => c.post('/api/guide/tool', { name: n, args }, { 'x-ao-client': client });
  c.pending = async () => (await c.get('/api/questions')).body.filter((q) => q.kind === 'confirm');
  // Lanza la tool y responde la confirmación con `answer` ('Sí'|'No'); sin answer comprueba que NO pregunta.
  c.toolAnswer = async (n, args, answer, client = 'e2e-a') => {
    const p = c.tool(n, args, client);
    let asked = null;
    if (answer) {
      asked = await until(async () => (await c.pending())[0], 8000, 80);
      if (asked) await c.post(`/api/questions/${asked.id}/answer`, { answer });
    } else { await sleep(400); asked = (await c.pending())[0] || null; }
    return { res: await p, asked };
  };
  c.audit = () => { try { return fs.readFileSync(path.join(dataDir, 'guide-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return c;
}
const cleanup = () => { for (const s of servers) { try { s.kill('SIGTERM'); } catch { /* parado */ } } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const TOOLS = ['window.getActive', 'window.list', 'screen.capture', 'screen.describe'];
try {
  // ── Servidor normal (fake) ─────────────────────────────────────────────────
  const A = await startServer('fake', { AO_DESKTOP: 'fake' });
  const capDir = path.join(A.dataDir, 'desktop', 'captures');

  section('1 · /api/guide/tools lista las 4 tools con política read');
  const list = (await A.get('/api/guide/tools')).body;
  for (const n of TOOLS) check(`${n} está registrada con política «read»`, list.find((t) => t.name === n)?.policy === 'read');
  const has = (n) => list.find((t) => t.name === n)?.confirmOnce === true;
  check('screen.capture y screen.describe llevan confirmOnce; window.* no', has('screen.capture') && has('screen.describe') && !has('window.getActive') && !has('window.list'));

  section('2 · window.getActive / window.list: datos fijos, sin confirmación');
  const ga = await A.tool('window.getActive');
  check('window.getActive devuelve la ventana activa fija (VS Code, pid 1111)', ga.ok && /Visual Studio Code/.test(ga.body.title) && ga.body.app === 'code' && ga.body.pid === 1111 && !ga.body.inside, JSON.stringify(ga.body));
  const wl = await A.tool('window.list');
  check('window.list devuelve las 3 ventanas con exactamente una activa', wl.ok && wl.body.length === 3 && wl.body.filter((w) => w.active).length === 1, JSON.stringify(wl.body));
  check('ninguna de las dos preguntó nada', (await A.pending()).length === 0);
  check('rechazo: argumento desconocido en window.getActive → 400', (await A.tool('window.getActive', { x: 1 })).status === 400);

  section('4 · screen.capture: confirmación solo la primera vez por cliente');
  const c1 = await A.toolAnswer('screen.capture', {}, 'Sí', 'e2e-a');
  check('1.ª captura del cliente A: pregunta (kind confirm, Sí/No) y con «Sí» responde con ruta y metadatos', c1.asked?.kind === 'confirm' && c1.asked.options.join() === 'Sí,No' && c1.res.ok && c1.res.body.path && c1.res.body.width > 0 && c1.res.body.bytes > 0, JSON.stringify(c1.res.body));
  check('la respuesta no incluye la imagen (solo ruta y metadatos)', Object.keys(c1.res.body).sort().join() === 'bytes,height,path,tool,ts,width', Object.keys(c1.res.body).join());
  const c2 = await A.toolAnswer('screen.capture', {}, null, 'e2e-a');
  check('2.ª captura del mismo cliente: no pregunta y funciona', !c2.asked && c2.res.ok, JSON.stringify(c2.res.body));
  const c3 = await A.toolAnswer('screen.capture', {}, 'Sí', 'e2e-b');
  check('otro cliente (B) vuelve a preguntar', !!c3.asked && c3.res.ok);
  const c4 = await A.toolAnswer('screen.capture', {}, null, 'e2e-a');
  check('…y el cliente A sigue sin preguntar', !c4.asked && c4.res.ok);

  section('5 · rechazar → 403 y línea «denied» en guide-audit.jsonl');
  const c5 = await A.toolAnswer('screen.capture', {}, 'No', 'e2e-c');
  check('responder «No» → 403', !!c5.asked && c5.res.status === 403, `status ${c5.res.status}`);
  const c5b = await A.toolAnswer('screen.capture', {}, 'No', 'e2e-c');
  check('un «No» no se recuerda: el mismo cliente vuelve a preguntar', !!c5b.asked && c5b.res.status === 403);
  const au = A.audit();
  check('guide-audit.jsonl tiene screen.capture con result «denied», confirmed false y status 403', au.some((a) => a.tool === 'screen.capture' && a.result === 'denied' && a.confirmed === false && a.status === 403), JSON.stringify(au.filter((a) => a.tool === 'screen.capture').at(-1)));
  check('…y las confirmadas con result «ok», confirmed true y mode «confirmOnce»', au.some((a) => a.tool === 'screen.capture' && a.result === 'ok' && a.confirmed === true && a.mode === 'confirmOnce'));
  check('rechazo: screen.capture con target inválido → 400', (await A.tool('screen.capture', { target: 'nada' }, 'e2e-a')).status === 400);

  section('6 · el PNG existe y el tope de 20 se respeta');
  const png = c1.res.body.path;
  const head = fs.existsSync(png) ? fs.readFileSync(png).subarray(0, 4) : Buffer.alloc(0);
  check('el fichero existe, está en data/desktop/captures/, es un PNG y pesa lo que dice `bytes`', path.dirname(png) === capDir && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) && fs.statSync(png).size === c1.res.body.bytes);
  for (let i = 0; i < 24; i++) await A.tool('screen.capture', {}, 'e2e-a');
  const files = fs.readdirSync(capDir).filter((f) => f.endsWith('.png'));
  check('tras 29 capturas quedan exactamente 20 PNG', files.length === 20, `quedan ${files.length}`);
  check('FIFO: la primera captura fue borrada', !fs.existsSync(png));

  section('7 · screen.describe: fake → descripción; proveedor sin imágenes → 501');
  const d1 = await A.toolAnswer('screen.describe', { question: '¿qué hay?' }, null, 'e2e-a'); // el cliente A ya confirmó (clave compartida con capture)
  check('con fake devuelve descripción, ruta de captura y proveedor; no vuelve a preguntar (clave compartida)', d1.res.ok && /VS Code/.test(d1.res.body.description) && d1.res.body.provider === 'fake' && fs.existsSync(d1.res.body.capturePath) && !d1.asked, JSON.stringify(d1.res.body));
  const dNew = await A.toolAnswer('screen.describe', {}, 'Sí', 'e2e-d');
  check('un cliente nuevo sí pregunta antes de describir', !!dNew.asked && dNew.res.ok);
  check('rechazo: capturePath fuera de data/desktop/captures → 400', (await A.tool('screen.describe', { capturePath: '/etc/passwd' }, 'e2e-a')).status === 400);
  check('rechazo: capturePath inexistente → 404', (await A.tool('screen.describe', { capturePath: path.join(capDir, 'no-existe.png') }, 'e2e-a')).status === 404);
  const last = path.join(capDir, fs.readdirSync(capDir).filter((f) => f.endsWith('.png')).sort().at(-1));
  const nPrev = fs.readdirSync(capDir).length;
  const dOk = await A.tool('screen.describe', { capturePath: last }, 'e2e-a');
  check('capturePath válido (captura previa) se describe sin capturar de nuevo', dOk.ok && dOk.body.capturePath === last && fs.readdirSync(capDir).length === nPrev, JSON.stringify(dOk.body));
  await A.post('/api/settings', { guideProvider: 'claude-cli' });
  const nBefore = fs.readdirSync(capDir).length;
  const d501 = await A.toolAnswer('screen.describe', {}, null, 'e2e-new');
  check('con claude-cli (sin imágenes) → 501 «no admite imágenes»', d501.res.status === 501 && /no admite im/.test(d501.res.body.error || ''), JSON.stringify(d501.res));
  check('…el 501 sale antes de pedir confirmación y de capturar', !d501.asked && fs.readdirSync(capDir).length === nBefore);
  await A.post('/api/settings', { guideProvider: 'fake' });

  // ── 3 · ventana activa = AgentOffice ───────────────────────────────────────
  section('3 · ventana activa «AgentOffice» → inside:true y screen.describe no llama al modelo');
  const I = await startServer('inside', { AO_DESKTOP: 'fake', AO_DESKTOP_FAKE_ACTIVE: 'AgentOffice' });
  const ig = await I.tool('window.getActive'), il = await I.tool('window.list');
  check('window.getActive → {inside:true, hint:"usa app.getContext"} sin datos del escritorio', ig.ok && ig.body.inside === true && ig.body.hint === 'usa app.getContext' && !ig.body.title, JSON.stringify(ig.body));
  check('window.list → inside:true', il.ok && il.body.inside === true && !Array.isArray(il.body), JSON.stringify(il.body));
  const insideCaps = () => fs.existsSync(path.join(I.dataDir, 'desktop', 'captures'));
  const ic = await I.toolAnswer('screen.capture', {}, null);
  check('screen.capture → inside:true, sin preguntar y sin crear PNG', ic.res.ok && ic.res.body.inside === true && !ic.asked && !insideCaps());
  const id = await I.toolAnswer('screen.describe', {}, null);
  check('screen.describe → inside:true, sin preguntar, sin captura ni descripción (no llama al modelo)', id.res.ok && id.res.body.inside === true && !id.res.body.description && !id.asked && !insideCaps(), JSON.stringify(id.res.body));

  // ── 8 · plataforma no Linux ────────────────────────────────────────────────
  section('8 · plataforma no Linux simulada (darwin) → 501 legible');
  const U = await startServer('darwin', { AO_DESKTOP: '', AO_DESKTOP_PLATFORM: 'darwin' }, 'anthropic-api');
  for (const n of TOOLS) {
    const r = await U.toolAnswer(n, {}, null);
    check(`${n} → 501 «aún no disponible en darwin», sin preguntar`, r.res.status === 501 && /aún no disponible en darwin/.test(r.res.body.error || '') && !r.asked, JSON.stringify(r.res));
  }

  // ── --real: solo informa ───────────────────────────────────────────────────
  if (REAL) {
    section('--real · escritorio de verdad (solo informa, no cuenta como check)');
    const R = await startServer('real', { AO_DESKTOP: '', AO_DESKTOP_PLATFORM: '', AO_DESKTOP_FAKE_ACTIVE: '' });
    const show = (n, r) => console.log(`  ℹ ${n} → ${r.status}${r.ok ? '' : ' ' + (r.body.error || '')}`);
    const g = await R.tool('window.getActive'); show('window.getActive', g); if (g.ok) console.log('    ' + JSON.stringify(g.body).slice(0, 300));
    const l = await R.tool('window.list'); show('window.list', l); if (l.ok) console.log('    ' + (Array.isArray(l.body) ? `${l.body.length} ventanas` : JSON.stringify(l.body)));
    const cp = await R.toolAnswer('screen.capture', {}, 'Sí'); show('screen.capture', cp.res);
    if (cp.res.ok) console.log('    ' + (cp.res.body.inside ? 'inside (la ventana activa es AgentOffice/flow-test)' : `${cp.res.body.width}x${cp.res.body.height}, ${cp.res.body.bytes} bytes, herramienta ${cp.res.body.tool}`));
  }
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}`);
  if (serverLog) console.log('--- log del servidor ---\n' + serverLog.slice(-2000));
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} checks correctos, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
