#!/usr/bin/env node
// FT-118 · e2e del driver de la extensión: un cliente WebSocket simula la extensión MV3.
//  1) En proceso: emparejamiento (código de un solo uso, clave), ops del contrato, errores, desconexión.
//  2) Con el servidor real (AO_DATA_DIR temporal): /api/browser/pair, Ajustes ▸ Navegador, snapshot SSE, upgrade.
// Uso: node scripts/extension-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ext-'));
process.env.AO_DATA_DIR = dir;
const ext = await import('../server/browser/extension.js');
const browser = await import('../server/browser/index.js');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const rejects = async (p, status, m) => { try { await p; ok(false, m); } catch (e) { ok(e.status === status, `${m} (${e.status})`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = fs.readFileSync(new URL('../server/desktop/fake.png', import.meta.url)).toString('base64');

// ── extensión simulada ──
const calls = [];
function fakeExtension(url, hello) {
  const ws = new WebSocket(url);
  const x = { ws, key: null, denied: null, ready: false, ceded: [{ id: '7', url: 'https://example.com/', title: 'Ejemplo', active: true }] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...hello }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ready') { x.ready = true; x.key = m.key || null; ws.send(JSON.stringify({ type: 'tabs', tabs: x.ceded })); return; }
    if (m.type === 'denied') { x.denied = m.error; return; }
    calls.push(m);
    const reply = (r) => ws.send(JSON.stringify({ id: m.id, ...r }));
    const P = m.params;
    if (m.op === 'tabs.list') return reply({ ok: true, result: x.ceded });
    if (m.op === 'navigate') return reply({ ok: true, result: { url: P.url, title: 'Nav' } });
    if (m.op === 'snapshot') return reply({ ok: true, result: { tabId: '7', url: 'https://example.com/', title: 'Ejemplo', nodes: [{ ref: 'e1', role: 'button', name: 'Enviar', value: '', states: [] }], total: 1, truncated: false, omitted: 0 } });
    if (m.op === 'screenshot') return reply({ ok: true, result: { data: PNG, format: 'png', width: 1, height: 1, tabId: '7' } });
    if (m.op === 'network') return reply({ ok: true, result: { tabId: '7', entries: [{ url: 'https://example.com/', requestHeaders: { Authorization: 'Bearer secreto', Accept: '*/*' } }] } });
    if (m.op === 'act' && P.ref === 'e99') return reply({ ok: false, status: 404, error: 'ref e99 desconocida' });
    if (m.op === 'evaluate') return reply({ ok: false, status: 422, error: 'boom' });
    if (m.op === 'hang') return;
    reply({ ok: true, result: { ok: true, op: m.op, params: P } });
  };
  return x;
}
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(25); } return false; };

// ── 1) en proceso ──
const srv = http.createServer((_, r) => r.writeHead(404).end());
srv.on('upgrade', (req, sock) => ext.handleUpgrade(req, sock));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const wsUrl = `ws://127.0.0.1:${srv.address().port}/api/browser/ext`;

browser.setMode('extension');
const d = browser.getDriver();
ok(d.id === 'extension' && !d.available().ok, 'sin extensión: available() = false');
await rejects(d.snapshot(), 503, 'sin extensión: snapshot da 503');

const bd = fakeExtension(wsUrl, { code: 'MALO1234' });
await waitFor(() => bd.denied);
ok(!!bd.denied && !ext.status().connected, 'código inventado: denegado');

const { code } = ext.newPairingCode();
ok(/^[A-Z2-9]{8}$/.test(code) && ext.status().pairing?.code === code, 'código de 8 caracteres visible en el estado');
const x = fakeExtension(wsUrl, { code });
ok(await waitFor(() => x.ready && ext.status().connected), 'la extensión se empareja con el código');
ok(!!x.key && x.key.length >= 32, 'recibe una clave de sesión');
ok(ext.status().pairing === null, 'el código es de un solo uso');
const keysRaw = fs.readFileSync(path.join(dir, 'browser', 'ext.json'), 'utf8');
ok(!keysRaw.includes(x.key) && keysRaw.includes('"keys"'), 'en disco solo queda el hash de la clave');
const again = fakeExtension(wsUrl, { code });
await waitFor(() => again.denied);
ok(!!again.denied, 'reusar el código falla');
await waitFor(() => ext.status().tabs.length === 1);
ok(ext.status().tabs[0].url === 'https://example.com/', 'el estado lista las pestañas cedidas');

ok(d.available().ok && d.isOpen(), 'available() = true con la extensión conectada');
ok((await d.launch()).ok, 'launch() responde');
const tabs = await d.tabs.list();
ok(tabs.length === 1 && tabs[0].id === '7', 'tabs.list devuelve solo las cedidas');
const nv = await d.navigate({ url: 'https://example.org/x' });
ok(nv.url === 'https://example.org/x', 'navigate llega a la extensión');
await rejects(d.navigate({ url: 'file:///etc/passwd' }), 400, 'navigate file: rechazado en el servidor');
await rejects(d.navigate({ url: 'javascript:alert(1)' }), 400, 'navigate javascript: rechazado');
await rejects(d.tabs.new({ url: 'chrome://settings' }), 400, 'tabs.new chrome: rechazado');
ok(!calls.some((c) => /file:|javascript:|chrome:/.test(JSON.stringify(c.params))), 'las URL prohibidas no salieron hacia la extensión');
const sn = await d.snapshot();
ok(sn.nodes[0].ref === 'e1' && browser.renderSnapshot(sn).includes('[e1] button "Enviar"'), 'snapshot con refs y renderizable');
const sh = await d.screenshot();
ok(fs.existsSync(sh.path) && sh.bytes > 0 && sh.tabId === '7', 'screenshot se guarda en data/browser/captures');
const net = await d.network();
ok(net.entries[0].requestHeaders.Authorization === '***' && net.entries[0].requestHeaders.Accept === '*/*', 'network enmascara cabeceras sensibles');
await rejects(d.act({ ref: 'e99' }), 404, 'error 404 de la extensión se propaga');
await rejects(d.evaluate({ expression: 'x' }), 422, 'error 422 de evaluate se propaga');
const act = await d.act({ ref: 'e1', action: 'click' });
ok(act.op === 'act' && act.params.ref === 'e1', 'act reenvía ref y acción');

// FT-117 en modo extensión: el panel en vivo degrada a capturas periódicas
const frames = [];
const stopCast = await d.screencast((f) => frames.push(f), { fps: 2 });
ok(await waitFor(() => frames.length >= 1), 'screencast degradado: llegan fotogramas JPEG por capturas');
ok(frames[0].mime === 'image/jpeg' && frames[0].tabId === '7' && frames[0].url === 'https://example.com/', 'el fotograma lleva mime, pestaña y URL');
stopCast();
const panel = await import('../server/browser/panel.js');
const ps = await panel.refresh();
ok(ps.driver === 'extension' && ps.open && ps.tabs.length === 1, 'panel.status() usa el driver de la extensión');
ok(typeof panel.agentDriver().box === 'function', 'agentDriver() envuelve el driver de la extensión');
const rel = await d.close();
ok(rel.ok, 'close() pide soltar las pestañas');
x.ws.close();
ok(await waitFor(() => !ext.status().connected), 'al cerrar el socket, el estado pasa a desconectado');
await rejects(d.snapshot(), 503, 'tras desconectar: 503');

// reconexión con la clave (sin código)
const key = x.key;
const y = fakeExtension(wsUrl, { key });
ok(await waitFor(() => y.ready && ext.status().connected), 'reconecta con la clave guardada');
const z = fakeExtension(wsUrl, { key: 'x'.repeat(48) });
await waitFor(() => z.denied);
ok(!!z.denied, 'clave inválida: denegado');
ext.forget();
ok(await waitFor(() => !ext.status().connected) && !ext.status().paired, 'forget(): corta y olvida las claves');
const w = fakeExtension(wsUrl, { key });
await waitFor(() => w.denied);
ok(!!w.denied, 'la clave olvidada ya no sirve');

// Origin de una web: rechazado
const body = await new Promise((r) => {
  const q = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/api/browser/ext', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } });
  q.on('upgrade', () => r('101')); q.on('response', (res) => r(String(res.statusCode))); q.on('error', () => r('error')); q.end();
});
ok(body !== '101', `un Origin web no puede abrir el WebSocket (${body})`);
srv.close(); srv.closeAllConnections?.();

// ── 2) servidor real ──
const port = 7600 + Math.floor(Math.random() * 300);
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ext-srv-'));
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dir2, AO_BROWSER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
const api = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
try {
  ok(await waitFor(() => /AgentOffice en/.test(log), 8000), 'el servidor arranca');
  let st = await api('GET', '/api/state');
  ok(st.browser?.mode === 'dedicated' && st.browser.ext.connected === false, 'snapshot: modo «dedicated» por defecto y extensión sin conectar');
  await api('POST', '/api/settings', { browserMode: 'extension' });
  st = await api('GET', '/api/state');
  ok(st.browser.mode === 'extension' && st.settings.browserMode === 'extension', 'Ajustes ▸ Navegador guarda «Mi navegador (extensión)»');
  await api('POST', '/api/settings', { browserMode: 'otro' });
  st = await api('GET', '/api/state');
  ok(st.browser.mode === 'extension', 'un modo desconocido se ignora');
  const p = await api('POST', '/api/browser/pair');
  st = await api('GET', '/api/state');
  ok(/^[A-Z2-9]{8}$/.test(p.code) && st.browser.ext.pairing.code === p.code, 'POST /api/browser/pair: el código llega al snapshot');
  const e = fakeExtension(`ws://127.0.0.1:${port}/api/browser/ext`, { code: p.code });
  ok(await waitFor(() => e.ready), 'el WebSocket /api/browser/ext del servidor real empareja');
  await sleep(200);
  st = await api('GET', '/api/state');
  ok(st.browser.ext.connected && st.browser.ext.paired && st.browser.ext.tabs.length === 1, 'snapshot: extensión conectada con 1 pestaña cedida');
  await api('POST', '/api/browser/forget');
  ok(await waitFor(() => e.ws.readyState > 1), 'forget corta la conexión');
} finally { child.kill(); }

console.log(fails ? `\n${fails} fallo(s)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
