#!/usr/bin/env node
// FT-117 · e2e del panel «🌐 Navegador»: el servidor corre en este mismo proceso (así se usa agentDriver() como lo hará A2).
// Comprueba: vista y botón, apertura, screencast (≤10 fps), quién controla, «Tomar el control» (agente en pausa 409 y clics/teclas
// reenviados), marca de 1 s sobre el ref, «Devolver al agente», hueco de handoff, vista Guía (app.navigate view=browser) y móvil.
// Por defecto driver fake (AO_BROWSER=fake); con --real (o AO_BROWSER=cdp) usa el Chromium real (headless) y una página local.
// Uso: node scripts/browser-panel-e2e.mjs [--real] [captura-dir]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const real = process.env.AO_BROWSER === 'cdp' || args.includes('--real');
if (!real) process.env.AO_BROWSER = 'fake';
else delete process.env.AO_BROWSER;
const shots = args.find((a) => !a.startsWith('--')) ? path.resolve(args.find((a) => !a.startsWith('--'))) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-brpanel-'));
const port = await freePort(), webPort = await freePort();
Object.assign(process.env, { AO_DATA_DIR: tmp, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_BROWSER_HEADLESS: '1' });
const hits = [];
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/hit')) { hits.push(decodeURIComponent(req.url.slice(5))); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Pagina de prueba</title><body style="margin:0;font:20px sans-serif">
    <h1>Panel FT-117</h1><input id=i style="width:300px;height:40px" oninput="fetch('/hit?v='+this.value)">
    <button id=b style="margin:20px;padding:20px" onclick="fetch('/hit?click')">Pulsar</button></body>`);
}).listen(webPort, '127.0.0.1');
const WEB = `http://127.0.0.1:${webPort}/`;

await import('../server/index.js');
const { getDriver } = await import('../server/browser/index.js');
const panel = await import('../server/browser/panel.js');
const base = `http://127.0.0.1:${port}`;
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };
let browser;
process.on('exit', () => { try { web.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  console.log(`Driver: ${real ? 'Chromium real' : 'fake'}`);
  const st0 = (await call('GET', '/api/state')).body;
  check('el snapshot trae browser (cerrado, controla el agente)', st0.browser && st0.browser.open === false && st0.browser.control === 'agent' && Array.isArray(st0.browser.handoffs));

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/?view=browser', { waitUntil: 'networkidle2' });
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; }, sel);
  const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

  console.log('Vista y apertura');
  check('?view=browser muestra la vista 🌐', await vis('#view-browser') && await vis('#br-bar, .br-bar'));
  check('cerrado: aviso y control deshabilitado', (await txt('#br-empty')).includes('cerrado') && await page.$eval('#br-control', (b) => b.disabled));
  await page.click('#br-open');
  check('abre el navegador (snapshot open=true)', await until(async () => (await call('GET', '/api/state')).body.browser.open));
  check('llega el primer fotograma', await until(() => page.evaluate(() => { const i = document.querySelector('#br-img'); return !i.hidden && i.src.startsWith('data:'); })));

  console.log('Agente al mando');
  check('muestra «Controla el agente»', (await txt('#br-who')).includes('agente'));
  check('URL y atrás/recargar deshabilitados', await page.$eval('#br-url', (i) => i.disabled) && await page.$eval('#br-reload', (b) => b.disabled));
  check('la entrada del usuario sin control → 409', (await call('POST', '/api/browser/input', { type: 'click', x: 1, y: 1 })).status === 409);
  const ag = panel.agentDriver();
  await ag.navigate({ url: WEB });
  check('la URL del agente aparece en la barra y las pestañas', await until(() => page.evaluate((w) => document.querySelector('#br-url').value === w && document.querySelectorAll('.br-tab').length >= 1, WEB)));

  // fps: cuenta los fotogramas de 1 s con un EventSource en el propio Node
  const frames = await new Promise((resolve) => {
    let n = 0; const r = http.get(`${base}/api/browser/stream`, (res) => { res.on('data', (d) => { n += (String(d).match(/event: frame/g) || []).length; }); setTimeout(() => { r.destroy(); resolve(n); }, 1500); });
    r.on('error', () => resolve(n));
  });
  check('screencast ≤ 10 fps (1,5 s → ≤ 17 fotogramas)', frames <= 17, `fotogramas: ${frames}`);
  if (!real) check('el driver fake emite fotogramas (≥ 5 en 1,5 s)', frames >= 5, `fotogramas: ${frames}`);

  console.log('Marca del elemento');
  const snap = await ag.snapshot();
  const btn = snap.nodes.find((n) => n.role === 'button' && /Pulsar|Enviar/.test(n.name)), box = snap.nodes.find((n) => n.role === 'textbox');
  check('snapshot con botón y caja de texto', !!btn && !!box, JSON.stringify(snap.nodes.slice(0, 5)));
  const markSeen = page.waitForFunction(() => !document.querySelector('#br-mark').hidden, { timeout: 3000 }).then(() => Date.now(), () => 0);
  await ag.act({ ref: btn.ref, action: 'click' });
  const t0 = await markSeen;
  check('rectángulo sobre el ref (visible con tamaño)', !!t0 && (await page.$eval('#br-mark', (m) => m.getBoundingClientRect().width > 8)));
  if (shots) await page.screenshot({ path: path.join(shots, '1-agente-marca.png') });
  await page.waitForFunction(() => document.querySelector('#br-mark').hidden, { timeout: 3000 });
  const lasted = Date.now() - t0;
  check('la marca dura ≈ 1 s', lasted >= 700 && lasted <= 1800, `${lasted} ms`);
  if (real) check('el clic del agente llegó a la página', await until(() => hits.includes('click')));

  console.log('Tomar el control');
  await page.click('#br-control');
  check('el usuario controla', await until(async () => (await call('GET', '/api/state')).body.browser.control === 'user') && await until(async () => (await txt('#br-who')).includes('Controlas tú')));
  check('botón pasa a «Devolver al agente» y la URL se habilita', await until(async () => (await txt('#br-control')).includes('Devolver')) && await until(() => page.$eval('#br-url', (i) => !i.disabled)));
  let paused = 0;
  process.env.AO_BROWSER_WAIT_CONTROL_MS = '300'; // FT-135: espera corta para el caso de vencimiento
  const tw = Date.now();
  try { await ag.act({ ref: btn.ref }); } catch (e) { paused = e.status; check('FT-135: 409 con retryAfterMs al vencer', e.retryAfterMs > 0); }
  check('el agente queda en pausa (409) tras esperar', paused === 409 && Date.now() - tw >= 250);
  process.env.AO_BROWSER_WAIT_CONTROL_MS = '20000';
  const pend = ag.act({ ref: btn.ref }).then(() => 'ok', (e) => 'err ' + e.status);
  check('FT-135: el estado dice que el agente espera', await until(async () => (await call('GET', '/api/state')).body.browser.waiting === 1) && await until(async () => (await txt('#br-who')).includes('espera')));
  const early = await Promise.race([pend, new Promise((r) => setTimeout(() => r('pendiente'), 1500))]);
  check('FT-135: sigue pendiente mientras el usuario controla (5 s simulados)', early === 'pendiente');
  await call('POST', '/api/browser/control', { mode: 'agent' });
  check('FT-135: al devolver el control la acción se completa', await pend === 'ok');
  await call('POST', '/api/browser/control', { mode: 'user' });
  process.env.AO_BROWSER_WAIT_CONTROL_MS = '300';
  try { await ag.navigate({ url: WEB }); paused = 0; } catch (e) { paused = e.status; }
  check('navegar tampoco (409)', paused === 409);
  check('leer (snapshot) sigue permitido', (await ag.snapshot()).nodes.length > 0);

  // clic y teclas del usuario sobre el fotograma
  const imgBox = await page.$eval('#br-img', (i) => { const r = i.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, fw: Number(i.dataset.fw), fh: Number(i.dataset.fh) }; });
  const tb = await getDriver().box({ ref: box.ref });
  const cx = imgBox.l + ((tb.x + tb.w / 2) / imgBox.fw) * imgBox.w, cy = imgBox.t + ((tb.y + tb.h / 2) / imgBox.fh) * imgBox.h;
  const before = getDriver().log?.length || 0;
  await page.mouse.click(cx, cy);
  await page.keyboard.type('hola');
  await page.keyboard.press('Enter');
  if (real) check('el texto tecleado llegó al input de la página', await until(() => hits.includes('v=hola')), JSON.stringify(hits));
  else check('el driver recibió clic, texto y tecla', await until(() => { const l = getDriver().log.slice(before); return l.some((e) => e.op === 'act' && e.action === 'click') && l.some((e) => e.op === 'type' && e.text === 'h') && l.some((e) => e.op === 'type' && e.key === 'Enter'); }), JSON.stringify(getDriver().log.slice(before)));
  check('entrada con coordenadas inválidas → 400', (await call('POST', '/api/browser/input', { type: 'click', x: 'a', y: 1 })).status === 400);
  await call('POST', '/api/browser/input', { type: 'wheel', x: 10, y: 10, dy: 100 });
  check('rueda aceptada', true);
  await call('POST', '/api/browser/nav', { op: 'go', url: WEB + '?dos' });
  check('el usuario navega desde la barra (API)', await until(() => page.evaluate(() => document.querySelector('#br-url').value.endsWith('?dos'))));
  await page.click('[data-brnew]');
  check('el usuario abre otra pestaña', await until(() => page.evaluate(() => document.querySelectorAll('.br-tab').length === 2)));
  if (shots) await page.screenshot({ path: path.join(shots, '2-usuario-control.png') });

  console.log('Devolver al agente');
  await page.click('#br-control');
  check('vuelve a controlar el agente', await until(async () => (await call('GET', '/api/state')).body.browser.control === 'agent') && await until(async () => (await txt('#br-who')).includes('agente')));
  let resumed = 0;
  try { await ag.snapshot(); await ag.tabs.select({ id: (await ag.tabs.list())[0].id }); resumed = 200; } catch (e) { resumed = e.status; }
  check('el agente reanuda', resumed === 200);
  check('la entrada del usuario vuelve a ser 409', (await call('POST', '/api/browser/input', { type: 'click', x: 1, y: 1 })).status === 409);

  console.log('Handoff (hueco de A3)');
  check('sin peticiones: texto de vacío', (await txt('#br-side')).includes('Sin peticiones'));
  await panel.addHandoff({ reason: 'Inicia sesión en la web' });
  check('una petición de handoff aparece en el panel', await until(() => txt('#br-side').then((t) => t.includes('Inicia sesión'))));
  await page.click('[data-brhand]');
  check('«Tomar el control» desde la petición', await until(async () => (await call('GET', '/api/state')).body.browser.control === 'user'));
  await panel.resolveHandoff((await call('GET', '/api/state')).body.browser.handoffs[0].id);
  await call('POST', '/api/browser/control', { mode: 'agent' });

  console.log('Guía y responsive');
  check('el Guía navega a view=browser (herramienta app.navigate)', (await call('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'browser' } })).status === 200);
  await page.click('[data-tab="office"]');
  check('al salir de la vista se cierra el stream y se oculta', !(await vis('#view-browser')));
  await page.click('[data-tab="browser"]');
  check('el botón lateral 🌐 vuelve a la vista', await vis('#br-stage'));
  await page.setViewport({ width: 390, height: 780 });
  await sleep(300);
  const mob = await page.evaluate(() => { const s = document.querySelector('#br-stage').getBoundingClientRect(), side = document.querySelector('#br-side').getBoundingClientRect(); return { w: document.documentElement.scrollWidth, vw: innerWidth, stageW: s.width, below: side.top >= s.bottom - 1 }; });
  check('móvil: sin scroll horizontal y panel lateral bajo la imagen', mob.w <= mob.vw + 1 && mob.below, JSON.stringify(mob));
  if (shots) await page.screenshot({ path: path.join(shots, '3-movil.png') });
  await page.setViewport({ width: 1280, height: 800 });

  await call('POST', '/api/browser/close');
  check('cerrar el navegador lo refleja en la vista', await until(() => txt('#br-empty').then((t) => t.includes('cerrado'))));
  check('consola del cliente limpia', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed++;
  console.error('✗ excepción:', e.stack || e);
} finally {
  await browser?.close().catch(() => {});
  await getDriver().close().catch(() => {});
}
console.log(failed ? `\n✗ ${failed} fallo(s)` : '\n✓ todo en verde');
process.exit(failed ? 1 : 0);
