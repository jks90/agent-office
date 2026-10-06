#!/usr/bin/env node
// FT-33 · e2e de «computer use» del Guide: AT-SPI (ui.*), fallback de ratón/teclado (mouse.*, keyboard.*),
// application.list/open, regla «solo fuera» (la propia UI) y audit. Sin dependencias nuevas.
//
//   node scripts/computer-use-e2e.mjs
//
// Arranca `server/index.js` en puertos libres con AO_DATA_DIR y HOME temporales, AO_DESKTOP=fake y el Guide fake.
// Servidores: el normal; otro con AO_DESKTOP_FAKE_ACTIVE=AgentOffice y otro con =flow-test (ventana activa propia).
// Imprime ✓/✗ por check, «N/N checks» y sale con 1 si falla alguno.
// Nota: el fake guarda sus acciones solo en memoria (no hay API que las exponga). «Sin acción en el fake» se comprueba
// por lo observable: ni pregunta de confirmación ni paso por la puerta (audit con mode null) y respuesta {inside:true}.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cu-e2e-'));
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
async function startServer(name, env = {}) {
  const dataDir = path.join(tmp, 'data-' + name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const procEnv = { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_GUIDE_FAKE: '1' };
  delete procEnv.AO_DESKTOP_FAKE_ACTIVE;
  Object.assign(procEnv, { AO_DESKTOP: 'fake' }, env);
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
  await c.post('/api/settings', { guideProvider: 'fake' });
  c.tool = (n, args = {}, client = 'cu-e2e') => c.post('/api/guide/tool', { name: n, args }, { 'x-ao-client': client });
  c.pending = async () => (await c.get('/api/questions')).body.filter((q) => q.kind === 'confirm');
  // Lanza la tool y responde la confirmación con `answer` ('Sí'|'No'); sin answer comprueba que NO pregunta.
  c.toolAnswer = async (n, args, answer) => {
    const p = c.tool(n, args);
    let asked = null;
    if (answer) {
      asked = await until(async () => (await c.pending())[0], 8000, 80);
      if (asked) await c.post(`/api/questions/${asked.id}/answer`, { answer });
    } else { await sleep(400); asked = (await c.pending())[0] || null; }
    return { res: await p, asked };
  };
  c.auditRaw = () => { try { return fs.readFileSync(path.join(dataDir, 'guide-audit.jsonl'), 'utf8'); } catch { return ''; } };
  c.audit = () => c.auditRaw().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  c.last = (tool) => c.audit().filter((a) => a.tool === tool).at(-1);
  return c;
}
const cleanup = () => { for (const s of servers) { try { s.kill('SIGTERM'); } catch { /* parado */ } } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const NEW_TOOLS = { 'ui.getTree': 'read', 'ui.find': 'read', 'ui.act': 'execute', 'application.list': 'read', 'application.open': 'execute', 'mouse.click': 'execute', 'mouse.scroll': 'execute', 'keyboard.type': 'execute', 'keyboard.keyPress': 'execute' };
const SECRET = 'contraseña-ultra-secreta-FT33';

try {
  const A = await startServer('normal');

  section('h · GET /api/guide/tools lista las 9 tools nuevas con su política');
  const list = (await A.get('/api/guide/tools')).body;
  for (const [n, p] of Object.entries(NEW_TOOLS)) check(`${n} registrada con política «${p}»`, list.find((t) => t.name === n)?.policy === p, `política ${list.find((t) => t.name === n)?.policy}`);
  check('las 9 tools aparecen exactamente una vez', Object.keys(NEW_TOOLS).every((n) => list.filter((t) => t.name === n).length === 1));

  section('a · ui.getTree / ui.find / ui.act sobre «Guardar»');
  const tree = await A.tool('ui.getTree');
  check('ui.getTree devuelve nodos con ref y role (incluye «Guardar»)', tree.ok && tree.body.length > 0 && tree.body.every((n) => n.ref && n.role) && tree.body.some((n) => n.name === 'Guardar'), JSON.stringify(tree.body).slice(0, 200));
  const find = await A.tool('ui.find', { name: 'Guardar' });
  const saveRef = find.body?.[0]?.ref;
  check('ui.find «Guardar» devuelve el botón con su ref', find.ok && find.body.length === 1 && find.body[0].role === 'push button' && !!saveRef, JSON.stringify(find.body));
  const act = await A.toolAnswer('ui.act', { ref: saveRef, action: 'click' }, null);
  check('ui.act click en «Guardar» → 200 OK sin pedir confirmación', act.res.ok && act.res.body.ok === true && !act.asked, `status ${act.res.status} ${JSON.stringify(act.res.body)}`);
  const aud = A.last('ui.act');
  check('audit: ui.act con policy «execute», result «ok»', aud?.policy === 'execute' && aud.result === 'ok', JSON.stringify(aud));
  check('rechazo: ui.act con ref inexistente → 404', (await A.tool('ui.act', { ref: '1111:9.9', action: 'click' })).status === 404);
  check('rechazo: ui.act con acción no válida → 400', (await A.tool('ui.act', { ref: saveRef, action: 'explotar' })).status === 400);

  section('b · ui.act sobre «Eliminar» → confirmación irreversible');
  const delRef = (await A.tool('ui.find', { name: 'Eliminar' })).body?.[0]?.ref;
  const no = await A.toolAnswer('ui.act', { ref: delRef, action: 'click' }, 'No');
  check('pregunta kind «confirm» con Sí/No y app/control/acción en el contexto', no.asked?.kind === 'confirm' && no.asked.options.join() === 'Sí,No' && /App:/.test(no.asked.context) && /Eliminar/.test(no.asked.context) && /Acción: click/.test(no.asked.context), JSON.stringify(no.asked));
  check('responder «No» → 403 (no se ejecuta)', no.res.status === 403, `status ${no.res.status}`);
  const aNo = A.last('ui.act');
  check('audit: policy «irreversible», confirmed false, result «denied»', aNo.policy === 'irreversible' && aNo.confirmed === false && aNo.result === 'denied', JSON.stringify(aNo));
  const yes = await A.toolAnswer('ui.act', { ref: delRef, action: 'click' }, 'Sí');
  check('responder «Sí» → se ejecuta (200)', !!yes.asked && yes.res.ok && yes.res.body.ok === true, `status ${yes.res.status}`);
  const aYes = A.last('ui.act');
  check('audit: confirmed true, result «ok», policy «irreversible»', aYes.confirmed === true && aYes.result === 'ok' && aYes.policy === 'irreversible', JSON.stringify(aYes));
  await A.post('/api/settings', { guidePolicy: { execute: 'confirm' } });
  const g2 = await A.toolAnswer('ui.act', { ref: saveRef, action: 'click' }, 'Sí');
  check('con guidePolicy.execute=confirm, «Guardar» también pregunta', !!g2.asked && g2.res.ok);
  await A.post('/api/settings', { guidePolicy: { execute: 'auto' } });

  section('c · mouse.click: 403 con el ajuste apagado, OK al activarlo');
  const snap0 = (await A.get('/api/state')).body;
  check('el ajuste guideInputFallback arranca apagado', snap0.guidePolicy?.guideInputFallback === false, JSON.stringify(snap0.guidePolicy));
  const off = await A.tool('mouse.click', { x: 10, y: 20 });
  check('mouse.click con el ajuste apagado → 403', off.status === 403 && /desactivado/.test(off.body.error || ''), `status ${off.status} ${off.body.error}`);
  check('rechazo: mouse.click sin «y» → 400', (await A.tool('mouse.click', { x: 1 })).status === 400);
  await A.post('/api/settings', { guideInputFallback: true });
  const snap1 = (await A.get('/api/state')).body;
  check('POST /api/settings {guideInputFallback:true} lo activa en el snapshot', snap1.guidePolicy?.guideInputFallback === true);
  const on = await A.tool('mouse.click', { x: 10, y: 20 });
  check('mouse.click con el ajuste activo → 200 OK', on.ok && on.body.ok === true && on.body.x === 10 && on.body.y === 20, JSON.stringify(on.body));
  check('audit: mouse.click con policy «execute», result «ok»', A.last('mouse.click')?.result === 'ok' && A.last('mouse.click')?.policy === 'execute');
  check('mouse.scroll con el ajuste activo → 200 OK', (await A.tool('mouse.scroll', { dy: 3 })).ok);

  section('d · keyboard.keyPress alt+f4 → confirmación');
  const k1 = await A.toolAnswer('keyboard.keyPress', { keys: 'alt+f4' }, 'No');
  check('alt+f4 pregunta (confirm) con app y acción en el contexto', k1.asked?.kind === 'confirm' && /Acción: pulsar «alt\+f4»/.test(k1.asked.context) && /App:/.test(k1.asked.context), JSON.stringify(k1.asked));
  check('responder «No» → 403 y audit irreversible/confirmed:false', k1.res.status === 403 && A.last('keyboard.keyPress').policy === 'irreversible' && A.last('keyboard.keyPress').confirmed === false);
  const k2 = await A.toolAnswer('keyboard.keyPress', { keys: 'Alt+F4' }, 'Sí');
  check('con «Sí» (y otra capitalización) se ejecuta', !!k2.asked && k2.res.ok && k2.res.body.ok === true);
  const k3 = await A.toolAnswer('keyboard.keyPress', { keys: 'ctrl+s' }, null);
  check('contraste: ctrl+s no pregunta y se ejecuta', !k3.asked && k3.res.ok);

  section('e · keyboard.type: el texto no llega al audit');
  const ty = await A.toolAnswer('keyboard.type', { text: SECRET }, null);
  check('keyboard.type → 200 con el nº de caracteres', ty.res.ok && ty.res.body.chars === [...SECRET].length, JSON.stringify(ty.res.body));
  check('el texto NO aparece en guide-audit.jsonl', !A.auditRaw().includes(SECRET) && !A.auditRaw().includes('ultra-secreta'));
  check('el audit guarda solo {chars:n}', JSON.stringify(A.last('keyboard.type').args) === JSON.stringify({ chars: [...SECRET].length }), JSON.stringify(A.last('keyboard.type')?.args));

  section('g · application.open: id válido, inexistente, de AgentOffice y vetados');
  const apps = await A.tool('application.list');
  check('application.list devuelve {id,name,exec}', apps.ok && apps.body.length > 0 && apps.body.every((a) => a.id && a.name) && apps.body.some((a) => a.id === 'gedit'));
  const o1 = await A.toolAnswer('application.open', { id: 'gedit' }, null);
  check('id válido «gedit» → ok (launcher fake)', o1.res.ok && o1.res.body.ok === true && o1.res.body.id === 'gedit', JSON.stringify(o1.res.body));
  check('audit: application.open «execute»/«ok»', A.last('application.open').policy === 'execute' && A.last('application.open').result === 'ok');
  const o2 = await A.toolAnswer('application.open', { id: 'no-existe' }, null);
  check('id inexistente → 400 sin molestar al usuario', o2.res.status === 400 && !o2.asked, `status ${o2.res.status} ${o2.res.body.error}`);
  const o3 = await A.toolAnswer('application.open', { id: 'agentoffice' }, null);
  check('id de AgentOffice → 403 sin preguntar', o3.res.status === 403 && !o3.asked, `status ${o3.res.status} ${o3.res.body.error}`);
  check('id de flow-test → 403', (await A.tool('application.open', { id: 'flowtest' })).status === 403);
  check('terminal → 403', (await A.tool('application.open', { id: 'gnome-terminal' })).status === 403);
  check('id con inyección «x; rm» → 400', (await A.tool('application.open', { id: 'x; rm' })).status === 400);
  check('argumento extra «exec» → 400', (await A.tool('application.open', { id: 'gedit', exec: 'rm -rf /' })).status === 400);
  check('audit: las llamadas rechazadas quedan registradas (result «error»)', A.audit().filter((a) => a.tool === 'application.open' && a.result === 'error').length >= 4);

  section('f · ventana activa propia (AgentOffice / flow-test) → {inside:true} sin actuar');
  for (const own of ['AgentOffice', 'flow-test']) {
    const B = await startServer('inside-' + own.toLowerCase(), { AO_DESKTOP_FAKE_ACTIVE: own });
    await B.post('/api/settings', { guideInputFallback: true }); // sin el ajuste las de entrada darían 403 antes
    const calls = [
      ['ui.getTree', {}], ['ui.find', { name: 'Guardar' }], ['ui.act', { ref: '1111:0.1', action: 'click' }],
      ['mouse.click', { x: 1, y: 1 }], ['mouse.scroll', { dy: 1 }], ['keyboard.type', { text: 'hola' }], ['keyboard.keyPress', { keys: 'alt+f4' }],
    ];
    for (const [n, args] of calls) {
      const r = await B.toolAnswer(n, args, null);
      check(`[${own}] ${n} → {inside:true} y no pregunta`, r.res.ok && r.res.body.inside === true && !r.asked, `status ${r.res.status} ${JSON.stringify(r.res.body)} asked:${!!r.asked}`);
    }
    check(`[${own}] ninguna pasó por la puerta ni ejecutó (audit mode null, confirmed null)`, B.audit().length === calls.length && B.audit().every((a) => a.mode === null && a.confirmed === null && a.result === 'ok'), JSON.stringify(B.audit().map((a) => [a.tool, a.mode, a.result])));
    check(`[${own}] no queda ninguna confirmación pendiente (alt+f4 y «Eliminar» serían irreversibles)`, (await B.pending()).length === 0);
  }

  section('r · aislamiento entre servidores');
  const C = await startServer('aislado');
  check('un servidor nuevo vuelve a tener el fallback apagado (403)', (await C.tool('mouse.click', { x: 1, y: 1 })).status === 403);
} catch (e) {
  failed++;
  console.log(`  ✗ excepción inesperada: ${e.stack || e}\n${serverLog.slice(-1500)}`);
}

console.log(`\n${passed}/${passed + failed} checks${failed ? ` — ${failed} FALLAN` : ' ✓'}`);
process.exit(failed ? 1 : 0);
