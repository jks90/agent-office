#!/usr/bin/env node
// FT-114 · e2e del BrowserDriver: web local (formulario, enlaces, iframe, popup) con Chromium headless real
// y un perfil temporal; después el driver fake. Uso: node scripts/browser-driver-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-browser-'));
process.env.AO_DATA_DIR = dir;
process.env.AO_BROWSER_HEADLESS = '1';
const { createCdpDriver, findBrowser } = await import('../server/browser/cdp.js');
const { createFakeDriver } = await import('../server/browser/fake.js');
const { maskHeaders, checkUrl, renderSnapshot } = await import('../server/browser/util.js');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const rejects = async (p, status, m) => { try { await p; ok(false, m); } catch (e) { ok(e.status === status, `${m} (${e.status})`); } };

const PAGES = {
  '/': `<!doctype html><title>Inicio</title><h1>Hola</h1>
    <form id=f onsubmit="document.getElementById('out').textContent='enviado:'+document.getElementById('n').value+':'+document.getElementById('c').value;return false">
      <label>Nombre <input id=n name=n></label>
      <label>Color <select id=c><option value=rojo>Rojo</option><option value=azul>Azul</option></select></label>
      <button type=submit>Enviar</button></form><p id=out></p>
    <a href="/dos">Ir a dos</a>
    <button id=pop onclick="window.open('/popup')">Abrir popup</button>
    <button onclick="console.log('hola consola');fetch('/api',{headers:{Authorization:'Bearer secreto'}})">Log</button>
    <iframe src="/frame" title=marco></iframe>
    <div style="height:3000px"></div><p id=fin>Final</p>`,
  '/dos': '<!doctype html><title>Dos</title><h1>Página dos</h1>',
  '/popup': '<!doctype html><title>Popup</title><h1>Soy el popup</h1>',
  '/frame': '<!doctype html><title>Marco</title><button id=fb onclick="document.title=\'clic-frame\'">Botón del marco</button>',
};
const srv = http.createServer((req, res) => {
  if (req.url === '/api') { res.setHeader('set-cookie', 'a=1'); return res.end('{}'); }
  if (req.url === '/setc') { res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', 'persist=si; Max-Age=3600; Path=/'); return res.end('ok'); }
  const body = PAGES[req.url.split('?')[0]];
  res.statusCode = body ? 200 : 404;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body || 'no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

// — utilidades puras
ok(maskHeaders({ Authorization: 'x', Cookie: 'y', Accept: 'z', 'X-Api-Key': 'k' }).Authorization === '***' && maskHeaders({ Accept: 'z' }).Accept === 'z', 'maskHeaders enmascara cabeceras sensibles');
ok((() => { try { checkUrl('file:///etc/passwd'); return false; } catch { return true; } })(), 'checkUrl rechaza file:');

if (!findBrowser()) { console.log('SIN navegador: se omite la parte CDP'); } else {
  const d = createCdpDriver();
  try {
    const l = await d.launch();
    ok(l.ok && d.isOpen(), 'launch headless con perfil en data/browser/profile');
    ok(fs.existsSync(path.join(dir, 'browser', 'profile')), 'perfil persistente creado');
    await d.navigate({ url: base + '/' });
    let s = await d.snapshot();
    ok(s.title === 'Inicio' && s.url === base + '/', 'snapshot: url y título');
    const by = (role, name) => s.nodes.find((n) => n.role === role && n.name.includes(name));
    const input = by('textbox', 'Nombre'), sel = s.nodes.find((n) => n.role === 'combobox'), submit = by('button', 'Enviar'), link = by('link', 'Ir a dos');
    ok(input && sel && submit && link, 'snapshot: textbox, combobox, botón y enlace con ref');
    ok(s.nodes.some((n) => n.frame && n.name.includes('Botón del marco')), 'snapshot incluye el iframe');
    if (!s.nodes.some((n) => n.frame && n.name.includes('Botón del marco'))) console.log(JSON.stringify(s.nodes.filter((n) => n.frame)));
    const r0 = input.ref;
    const s2 = await d.snapshot();
    ok(s2.nodes.find((n) => n.role === 'textbox')?.ref === r0, 'refs estables entre snapshots');
    ok(renderSnapshot(s).includes(`[${r0}] textbox`), 'renderSnapshot');

    await d.type({ ref: input.ref, text: 'Ana' });
    await d.act({ ref: sel.ref, action: 'select', value: 'azul' });
    await d.act({ ref: submit.ref });
    ok((await d.evaluate({ expression: "document.getElementById('out').textContent" })).value === 'enviado:Ana:azul', 'formulario: type + select + click por ref');
    await d.type({ ref: input.ref, text: 'Zoe', clear: true, submit: true });
    ok((await d.evaluate({ expression: "document.getElementById('out').textContent" })).value === 'enviado:Zoe:azul', 'type clear + Enter envía');

    const fb = s.nodes.find((n) => n.frame && n.role === 'button');
    await d.act({ ref: fb.ref });
    const fr = d.evaluate({ expression: "document.querySelector('iframe').contentDocument.title" });
    ok((await fr).value === 'clic-frame', 'clic por ref dentro del iframe');

    await d.act({ x: 5, y: 5, action: 'hover' });
    await rejects(d.act({ ref: 'e9999' }), 404, 'ref desconocido sin coordenadas');
    ok((await d.act({ ref: 'e9999', x: 5, y: 5, action: 'hover' })).via === 'xy', 'fallback a coordenadas');

    const sc = await d.scroll({ dy: 600 });
    ok(sc.scrollY > 0, `scroll por rueda (scrollY=${sc.scrollY})`);
    await d.waitFor({ text: 'Final' });

    // popup → pasa a ser la pestaña activa
    await d.navigate({ url: base + '/' });
    s = await d.snapshot();
    await d.act({ ref: s.nodes.find((n) => n.role === 'button' && n.name === 'Abrir popup').ref });
    await d.waitFor({ ms: 800 });
    const tabs = await d.tabs.list();
    ok(tabs.length === 2 && tabs.find((t) => t.active)?.title === 'Popup', 'popup detectado y activo');
    ok((await d.snapshot()).nodes.some((n) => n.name === 'Soy el popup'), 'snapshot de la pestaña activa (popup)');
    await d.tabs.select({ id: tabs.find((t) => t.title === 'Inicio').id });
    await d.tabs.close({ id: tabs.find((t) => t.title === 'Popup').id });
    ok((await d.tabs.list()).length === 1, 'tabs.select y tabs.close');

    // navegación
    s = await d.snapshot();
    await d.act({ ref: s.nodes.find((n) => n.role === 'link').ref });
    await d.waitFor({ url: '/dos' });
    ok((await d.back()).url === base + '/' && (await d.forward()).url === base + '/dos' && (await d.reload()).title === 'Dos', 'enlace, back, forward y reload');
    await rejects(d.navigate({ url: 'file:///etc/passwd' }), 400, 'navigate rechaza file:');

    // consola y red
    await d.navigate({ url: base + '/' });
    s = await d.snapshot();
    await d.act({ ref: s.nodes.find((n) => n.name === 'Log').ref });
    await d.waitFor({ ms: 500 });
    ok((await d.console()).entries.some((e) => e.text === 'hola consola'), 'registro de consola');
    const net = (await d.network()).entries.find((e) => e.url.endsWith('/api'));
    ok(net && net.status === 200 && net.requestHeaders.authorization === '***' && net.responseHeaders['set-cookie'] === '***', 'registro de red con cabeceras enmascaradas');
    for (let i = 0; i < 250; i++) await d.evaluate({ expression: `console.log('x${i}')` });
    ok((await d.console({ limit: 1000 })).entries.length === 200, 'anillo de consola limitado a 200');

    // screenshot
    await d.evaluate({ expression: 'window.resizeTo(1600,900)' });
    const shot = await d.screenshot();
    const buf = fs.readFileSync(shot.path);
    ok(buf.subarray(1, 4).toString() === 'PNG' && shot.width <= 1280 && shot.path.includes(path.join('browser', 'captures')), `screenshot PNG ≤1280 (${shot.width}x${shot.height})`);

    // evaluate con error
    await rejects(d.evaluate({ expression: 'throw new Error("x")' }), 422, 'evaluate con excepción');
    await rejects(d.waitFor({ text: 'nunca', timeout: 300 }), 408, 'waitFor agota el tiempo');

    // perfil persistente: cookie sobrevive al cierre
    await d.navigate({ url: base + '/setc' });
    await d.close();
    ok(!d.isOpen() && fs.existsSync(path.join(dir, 'browser', 'profile')), 'close no borra el perfil');
    await d.launch();
    await d.navigate({ url: base + '/dos' });
    ok((await d.evaluate({ expression: 'document.cookie' })).value.includes('persist=si'), 'la sesión (cookie) sobrevive al reinicio');
    await d.close();

    // cierre por inactividad
    process.env.AO_BROWSER_IDLE_MS = '600';
    await d.launch();
    await new Promise((r) => setTimeout(r, 1500));
    ok(!d.isOpen(), 'cierre por inactividad (AO_BROWSER_IDLE_MS)');
  } catch (e) { ok(false, `excepción: ${e.stack}`); } finally { await d.close(); }
}

// — fake
const f = createFakeDriver();
await f.launch();
await f.navigate({ url: 'http://x.test/a' });
const fs1 = await f.snapshot();
ok(fs1.nodes.length === 4 && fs1.url === 'http://x.test/a', 'fake: snapshot');
await f.type({ ref: 'e2', text: 'hola' });
ok((await f.snapshot()).nodes[1].value === 'hola', 'fake: type refleja el valor');
ok((await f.tabs.new({ url: 'http://x.test/b' })).active && (await f.tabs.list()).length === 2, 'fake: pestañas');
ok(fs.existsSync((await f.screenshot()).path), 'fake: screenshot');
await rejects(f.act({ ref: 'zz' }), 404, 'fake: ref desconocido');

srv.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo en verde');
process.exit(fails ? 1 : 0);
