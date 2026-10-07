#!/usr/bin/env node
// FT-131 · e2e de AgentOffice EMBEBIDO en flow-test: un flow-test simulado (página con iframe + proxy /agents/ igual que
// server/agents-proxy.js: sin content-length, sin buffering) delante de AgentOffice. Comprueba que, con una 🛡 del Guía pendiente,
// se ve el modal (en cualquier vista, también 🌐 Navegador), que la barra #questions-bar y la 🔔 la abren, que se contesta y que
// el panel 🌐 muestra textos y fotogramas. Captura pageerror/console y fallos de red del iframe.
// Uso: node scripts/embedded-e2e.mjs [captura.png]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import * as store from '../server/store.js';

process.env.AO_BROWSER = 'fake';
const shot = process.argv[2] ? path.resolve(process.argv[2]) : null;
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-embed-'));
const port = await freePort(), ftPort = await freePort();
Object.assign(process.env, { AO_DATA_DIR: tmp, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_BROWSER_HEADLESS: '1' });
const AO = `http://127.0.0.1:${port}`;

// flow-test simulado: /access, página con el iframe y proxy /agents/* (copia de proxyAgents)
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const ft = http.createServer((req, res) => {
  if (req.url === '/access') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ mode: 'licensed', plan: 'pro' })); }
  if (!req.url.startsWith('/agents/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><body style="margin:0"><iframe id="ao" src="/agents/?view=browser" style="width:100vw;height:100vh;border:0"></iframe>`);
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = `127.0.0.1:${port}`;
  const up = http.request(AO + req.url.slice('/agents'.length), { method: req.method, headers }, (ur) => {
    const h = { ...ur.headers };
    delete h['content-length'];
    if (h['content-type']?.includes('text/event-stream')) { h['cache-control'] = 'no-cache'; h['x-accel-buffering'] = 'no'; }
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => up.destroy());
  req.pipe(up);
}).listen(ftPort, '127.0.0.1');
const FT = `http://127.0.0.1:${ftPort}`;

await import('../server/index.js');
const questions = await import('../server/questions.js');
const call = async (m, p, b) => { const r = await fetch(AO + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };
let browser;
process.on('exit', () => { try { ft.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  for (let i = 0; i < 80; i++) { try { await fetch(AO + '/api/state'); break; } catch { await sleep(100); } }
  await call('POST', '/api/settings', { flowTestUrl: FT });
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [], bad = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && bad.push(`FAIL ${r.url()} ${r.failure()?.errorText}`));

  // 🛡 pendiente ANTES de abrir la UI
  const asked = questions.confirm({ question: 'Pulsar «Submit order» en httpbin.org', context: 'click en button' });
  asked.catch(() => {});
  await page.goto(FT + '/', { waitUntil: 'networkidle2' });
  const frame = async () => { const h = await page.waitForSelector('#ao'); return h.contentFrame(); };
  const f = await frame();
  const vis = (sel) => f.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; }, sel);
  const txt = (sel) => f.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

  console.log('Embebido: vista 🌐 con una 🛡 pendiente');
  check('la vista 🌐 está activa', await until(() => vis('#view-browser')));
  check('el modal 🛡 se abre solo', await until(() => f.evaluate(() => { const d = document.querySelector('#dialog'); return d.open && d.className === 'question' && d.textContent.includes('Submit order'); })), errors.join(' | '));
  check('la barra #questions-bar muestra la 🛡', await until(() => f.evaluate(() => { const b = document.querySelector('#questions-bar'); return !b.hidden && b.textContent.includes('🛡'); })));
  check('los botones del panel 🌐 tienen texto', (await txt('#br-control')).length > 3 && (await txt('#br-open')).length > 3, `control="${await txt('#br-control')}"`);

  console.log('Contestar');
  await f.evaluate(() => document.querySelector('#dialog .q-opt')?.click());
  check('la 🛡 se resuelve con la respuesta', await Promise.race([asked.then(() => true, () => true), sleep(5000).then(() => false)]));
  check('desaparece la barra', await until(() => f.evaluate(() => document.querySelector('#questions-bar').hidden)));

  console.log('Panel 🌐 con fotogramas');
  await f.evaluate(() => document.querySelector('#br-open').click());
  check('abre el navegador y llega un fotograma', await until(() => f.evaluate(() => { const i = document.querySelector('#br-img'); return !i.hidden && i.src.startsWith('data:'); })), bad.join(' | '));
  check('el botón de control dice «Tomar el control»', (await txt('#br-control')).includes('Tomar'));

  console.log('Otra 🛡 estando en la vista 🌐 y la 🔔 / barra la abren');
  const asked2 = questions.confirm({ question: 'Segunda confirmación', context: '' });
  asked2.catch(() => {});
  check('el modal sale también ahora', await until(() => f.evaluate(() => document.querySelector('#dialog').open && document.querySelector('#dialog').textContent.includes('Segunda'))));
  await f.evaluate(() => document.querySelector('#dialog button[value=cancel]').click());
  check('«Más tarde» cierra y deja la barra', await until(() => f.evaluate(() => !document.querySelector('#dialog').open && !document.querySelector('#questions-bar').hidden)));
  await f.evaluate(() => document.querySelector('#review-chip').click());
  check('la 🔔 reabre la 🛡', await until(() => f.evaluate(() => document.querySelector('#dialog').open && document.querySelector('#dialog').textContent.includes('Segunda'))), await f.evaluate(() => document.querySelector('#review-chip').outerHTML));
  store.bus.emit('ui', { type: 'navigate', view: 'browser', at: Date.now() }); // el Guía navega con la 🛡 abierta: el modal sigue
  await sleep(500);
  check('una orden de navegación del Guía no cierra la 🛡', await f.evaluate(() => document.querySelector('#dialog').open && document.querySelector('#dialog').className === 'question'));
  if (shot) await page.screenshot({ path: shot });
  await f.evaluate(() => document.querySelector('#dialog .q-opt')?.click());

  check('sin errores de JS ni de red en el iframe', !errors.length && !bad.length, [...errors, ...bad].join(' | '));
} catch (e) {
  failed++; console.log('  ✗ excepción: ' + (e.stack || e));
} finally {
  await browser?.close();
}
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo OK');
process.exit(failed ? 1 : 0);
