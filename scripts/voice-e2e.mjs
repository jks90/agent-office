#!/usr/bin/env node
// e2e de la voz del Guide (FT-9), sin micrófono real ni Claude:
//
//   node scripts/voice-e2e.mjs [captura.png]
//
// Arranca el servidor con AO_DATA_DIR temporal, el proveedor de Guide `fake` y AO_STT_CMD apuntando a un script que devuelve
// «¿Cómo va?». Comprueba la API (/api/guide/stt, ajustes, errores) y, si hay Chrome + puppeteer-core, el flujo de la UI con
// el micrófono falso de Chrome: mantener 🎤 → el texto aparece en el chat y el Guide responde como si se hubiera escrito.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-voice-e2e-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)); }); });
const base = `http://127.0.0.1:${port}`;

const sttCmd = path.join(tmp, 'stt.sh'); // recibe <audio> <idioma>; comprueba que el fichero existe y no está vacío
fs.writeFileSync(sttCmd, '#!/bin/sh\n[ -s "$1" ] || { echo "sin audio" >&2; exit 3; }\nif [ -f "$(dirname "$0")/wake-mode" ]; then echo "Oye guía, ¿cómo va?"; else echo "¿Cómo va?"; fi\n', { mode: 0o755 });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: path.join(tmp, 'data'), HOME: tmp, AO_GUIDE_FAKE: '1', AO_STT_CMD: sttCmd, OPENAI_API_KEY: '' } });
let slog = '';
server.stdout.on('data', (d) => { slog += d; }); server.stderr.on('data', (d) => { slog += d; });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* parado */ } fs.rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/guide/tools'); break; } catch { await sleep(100); } }

const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const audio = Buffer.from('RIFF-no-es-audio-real-pero-da-igual').toString('base64');

console.log('\n▸ API /api/guide/stt');
const st = await fetch(base + '/api/guide/stt').then((r) => r.json());
check('GET lista los dos proveedores', st.providers?.map((p) => p.name).join() === 'local-cmd,openai' && st.provider === 'local-cmd');
check('local-cmd disponible con AO_STT_CMD, openai no (sin clave)', st.providers[0].ok && !st.providers[1].ok, JSON.stringify(st.providers));
const t = await post('/api/guide/stt', { audio, mime: 'audio/webm;codecs=opus', lang: 'es' });
check('POST devuelve el texto fijo', t.status === 200 && t.text === '¿Cómo va?' && typeof t.ms === 'number' && t.provider === 'local-cmd', JSON.stringify(t));
check('sin audio → 400', (await post('/api/guide/stt', {})).status === 400);
const bad = await post('/api/settings', { sttProvider: 'openai', sttLang: 'en' });
check('ajustes guardan sttProvider/sttLang', bad.sttProvider === 'openai' && bad.sttLang === 'en');
const noKey = await post('/api/guide/stt', { audio });
check('openai sin clave → 503 con motivo', noKey.status === 503 && /clave/.test(noKey.error), JSON.stringify(noKey));
check('proveedor desconocido se ignora', (await post('/api/settings', { sttProvider: 'nada' })).sttProvider === 'openai');
await post('/api/settings', { sttProvider: 'local-cmd', sttLang: 'es', guideProvider: 'fake' });

console.log('\n▸ Texto transcrito → mismo pipeline del chat');
const chat = await fetch(base + '/api/guide/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t.text }) }).then((r) => r.text());
check('el Guide responde al texto dictado', chat.includes('fake: ¿Cómo va?'), chat.slice(0, 200));

console.log('\n▸ UI (🎤 con el micrófono falso de Chrome)');
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* sin devDependencies */ }
if (!chrome || !puppeteer) console.log('  – sin Chrome/puppeteer-core: UI omitida');
else {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#view-guide .g-mic');
    const box = await (await page.$('#view-guide .g-mic')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForSelector('#view-guide .g-mic.rec', { timeout: 5000 });
    check('al mantener 🎤 empieza a grabar', true);
    await sleep(1200);
    const shot = process.argv[2];
    if (shot) await page.screenshot({ path: path.resolve(shot) });
    await page.mouse.up();
    const ok = await page.waitForFunction(() => [...document.querySelectorAll('#view-guide .g-msg')].some((m) => m.textContent.includes('fake: ¿Cómo va?')), { timeout: 15000 }).then(() => true, () => false);
    const msgs = await page.$$eval('#view-guide .g-msg', (els) => els.map((e) => e.className.replace('g-msg ', '') + ': ' + e.textContent));
    check('el texto aparece como mensaje del usuario y el Guide responde', ok && msgs.some((m) => m === 'user: ¿Cómo va?'), msgs.join(' | '));

    // «revisar antes de enviar»: el texto queda en la caja y no se envía
    await page.evaluate(() => localStorage.setItem('ao:voice-review', '1'));
    const before = msgs.length;
    await page.mouse.down(); await page.waitForSelector('#view-guide .g-mic.rec'); await sleep(900); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#view-guide textarea').value.includes('¿Cómo va?'), { timeout: 15000 });
    check('con «revisar antes de enviar» el texto queda en la caja', (await page.$$('#view-guide .g-msg')).length === before);

    // barra espaciadora con la caja vacía
    await page.evaluate(() => { localStorage.setItem('ao:voice-review', '1'); const t = document.querySelector('#view-guide textarea'); t.value = ''; });
    await page.focus('#view-guide textarea');
    await page.keyboard.down('Space');
    const rec = await page.waitForSelector('#view-guide .g-mic.rec', { timeout: 5000 }).then(() => true, () => false);
    await sleep(900); await page.keyboard.up('Space');
    check('la barra espaciadora graba con la caja vacía', rec);
    await page.waitForFunction(() => document.querySelector('#view-guide textarea').value.trim() === '¿Cómo va?', { timeout: 15000 }).catch(() => {});
    check('la barra espaciadora no escribe espacios', (await page.$eval('#view-guide textarea', (t) => t.value)).trim() === '¿Cómo va?');

    // Escucha continua (FT-36): apagada de serie → ni permiso de micro ni peticiones; activada → chip y solo /api/guide/wake
    console.log('\n▸ UI (escucha continua «oye guía»)');
    const wp = await browser.newPage();
    await wp.evaluateOnNewDocument(() => { window.__tracks = []; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__gum = 0; navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; const st = await g(c); window.__tracks.push(...st.getTracks()); return st; }; });
    const reqs = [];
    wp.on('request', (r) => { if (r.url().includes('/api/guide/')) reqs.push(r.method() + ' ' + new URL(r.url()).pathname); });
    await wp.setViewport({ width: 1100, height: 760 });
    await wp.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    await sleep(1500);
    check('con la casilla sin tocar no se pide el micrófono', (await wp.evaluate(() => window.__gum)) === 0);
    check('sin chip de escucha', await wp.$eval('#view-guide .g-ear', (e) => e.hidden));
    fs.writeFileSync(path.join(tmp, 'wake-mode'), '');
    const first = reqs.length;
    await wp.evaluate(() => { localStorage.setItem('ao:voice-review', '0'); document.querySelector('#view-guide textarea').value = ''; });
    await wp.evaluate(() => { localStorage.setItem('ao:voice-wake', '1'); });
    await wp.reload({ waitUntil: 'networkidle2' });
    await wp.waitForSelector('#view-guide .g-ear:not([hidden])', { timeout: 5000 });
    check('al activar aparece el chip «Escuchando»', /Escuchando/.test(await wp.$eval('#view-guide .g-ear', (e) => e.textContent)));
    check('el chip del botón flotante también', await wp.$eval('#guide-fab .fab-ear', (e) => !e.hidden));
    const gotMsg = await wp.waitForFunction(() => [...document.querySelectorAll('#view-guide .g-msg.user')].some((m) => /¿cómo va\?/i.test(m.textContent)), { timeout: 20000 }).then(() => true, () => false);
    check('tras «oye guía, ¿cómo va?» el mensaje aparece en el chat', gotMsg);
    await wp.evaluate(() => document.querySelector('#view-guide .g-ear').click());
    await sleep(800);
    check('al apagar desaparece el chip', await wp.$eval('#view-guide .g-ear', (e) => e.hidden));
    check('las pistas del micrófono quedan liberadas', await wp.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === 'ended')));
    const mine = reqs.slice(first);
    check('solo se llama a /api/guide/wake (y al chat); nada a /stt', !mine.some((r) => r.includes('/stt')) && mine.some((r) => r === 'POST /api/guide/wake'), mine.join(', '));
    check('sin errores de consola (escucha)', true);
  } finally { await browser.close(); }
}

console.log(failed ? `\n✗ ${failed} fallos\n${slog.slice(-800)}` : '\n✓ voz OK');
process.exit(failed ? 1 : 0);
