#!/usr/bin/env node
// e2e de la voz de salida del Guía (FT-52), sin piper ni nube:
//
//   node scripts/tts-e2e.mjs [captura.png]
//
// Arranca el servidor con AO_DATA_DIR temporal, el proveedor de Guide `fake` y AO_TTS_CMD apuntando a un script que escribe un WAV
// corto (y apunta el texto que recibe). Comprueba la API (/api/guide/tts, caché, ajustes, 503) y, si hay Chrome + puppeteer-core,
// la UI: ▶ pide el texto plano, el <audio> reproduce, ⏸ para, una sola reproducción a la vez, cambio de voz en Ajustes y el
// estado sin proveedor (botón deshabilitado con tooltip; respaldo con speechSynthesis si existe).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tts-e2e-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)); }); });
const base = `http://127.0.0.1:${port}`;

// WAV de 2 s (mono, 8 kHz, 16 bit) con un tono suave: lo bastante largo para ver ⏸ antes de que termine
const wavPath = path.join(tmp, 'tone.wav');
{
  const rate = 8000, n = rate * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2);
  fs.writeFileSync(wavPath, buf);
}
const calls = path.join(tmp, 'calls.log');
const ttsCmd = path.join(tmp, 'tts.sh'); // recibe <salida.wav> <voz> <idioma>; el texto, por stdin
fs.writeFileSync(ttsCmd, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$2" "$3" "$(cat)" >> "${calls}"\ncp "${wavPath}" "$1"\n`, { mode: 0o755 });
const startServer = (extraEnv, p) => {
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AO_PORT: String(p), AO_DATA_DIR: path.join(tmp, 'data' + p), HOME: tmp, AO_GUIDE_FAKE: '1', OPENAI_API_KEY: '', ...extraEnv } });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; }); proc.stderr.on('data', (d) => { proc.log += d; });
  return proc;
};
const server = startServer({ AO_TTS_CMD: ttsCmd }, port);
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* parado */ } fs.rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/guide/tools'); break; } catch { await sleep(100); } }

const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const postJ = (p, b) => post(p, b).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const callLines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);

console.log('\n▸ API /api/guide/tts');
const st = await fetch(base + '/api/guide/tts').then((r) => r.json());
check('GET: piper por defecto, tres proveedores y voz femenina por defecto', st.provider === 'piper' && st.providers.map((p) => p.name).join() === 'piper,openai,browser' && /sharvard/.test(st.voice) && st.voices.some((v) => v.gender === 'female'), JSON.stringify(st));
check('piper disponible con AO_TTS_CMD; openai no (sin clave)', st.providers[0].ok && !st.providers[1].ok && st.providers[2].ok, JSON.stringify(st.providers));
const r1 = await post('/api/guide/tts', { text: 'Hola, mundo' });
const b1 = Buffer.from(await r1.arrayBuffer());
check('POST devuelve audio/wav (RIFF)', r1.status === 200 && r1.headers.get('content-type') === 'audio/wav' && b1.subarray(0, 4).toString() === 'RIFF', `${r1.status} ${r1.headers.get('content-type')}`);
check('el comando recibió voz, idioma y texto', callLines().at(-1) === `${st.voice}|es|Hola, mundo`, callLines().join(' / '));
await post('/api/guide/tts', { text: 'Hola, mundo' });
check('el mismo texto y voz sale de la caché (no vuelve a ejecutar el comando)', callLines().length === 1, String(callLines().length));
check('sin texto → 400', (await postJ('/api/guide/tts', { text: '  ' })).status === 400);
check('más de 4000 caracteres → 413', (await postJ('/api/guide/tts', { text: 'a'.repeat(4001) })).status === 413);
const s2 = await postJ('/api/settings', { ttsVoice: 'es_AR-daniela-high', ttsProvider: 'nada' });
check('ajustes guardan ttsVoice y ignoran un proveedor desconocido', s2.ttsVoice === 'es_AR-daniela-high' && !s2.ttsProvider, JSON.stringify({ v: s2.ttsVoice, p: s2.ttsProvider }));
await post('/api/guide/tts', { text: 'Otra frase' });
check('POST usa la voz elegida en Ajustes', callLines().at(-1).startsWith('es_AR-daniela-high|'), callLines().at(-1));
await post('/api/guide/tts', { text: 'Otra frase', voice: 'es_ES-mls_9972-low' });
check('POST acepta una voz explícita del proveedor', callLines().at(-1).startsWith('es_ES-mls_9972-low|'), callLines().at(-1));
for (let i = 0; i < 55; i++) await post('/api/guide/tts', { text: 'relleno ' + i });
await post('/api/guide/tts', { text: 'Hola, mundo', voice: st.voice });
check('la caché solo guarda los últimos 50 audios', callLines().filter((l) => l.endsWith('|Hola, mundo')).length === 2);
const op = await postJ('/api/settings', { ttsProvider: 'openai', ttsVoice: 'nova' });
check('con openai y sin clave → 503 con motivo', op.ttsProvider === 'openai' && (await postJ('/api/guide/tts', { text: 'hola' })).status === 503);
const ov = await fetch(base + '/api/guide/tts').then((r) => r.json());
check('GET con openai: voces femeninas nova/shimmer', ov.provider === 'openai' && ov.voices.some((v) => v.id === 'nova') && ov.voices.some((v) => v.id === 'shimmer'));
check('GET ?provider= enseña las voces de otro proveedor sin cambiar el elegido', (await fetch(base + '/api/guide/tts?provider=piper').then((r) => r.json())).voices.some((v) => /sharvard/.test(v.id)));
const br = await postJ('/api/settings', { ttsProvider: 'browser' });
check('browser: lo sintetiza el cliente (el servidor responde 503)', br.ttsProvider === 'browser' && (await postJ('/api/guide/tts', { text: 'hola' })).status === 503);
await postJ('/api/settings', { ttsProvider: 'piper', ttsVoice: '', guideProvider: 'fake' });

console.log('\n▸ UI (▶ en cada respuesta del Guía)');
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* sin devDependencies */ }
if (!chrome || !puppeteer) console.log('  – sin Chrome/puppeteer-core: UI omitida');
else {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  // espía de <audio>: el elemento no está en el DOM, así que se engancha en play() de cada uno
  const spy = () => {
    window.__ev = []; window.__playing = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.__spied) { this.__spied = true; for (const t of ['play', 'pause', 'ended']) this.addEventListener(t, () => { window.__ev.push(t); if (t === 'play') window.__playing.add(this); else window.__playing.delete(this); }); }
      return play.call(this);
    };
  };
  const waitFn = (page, fn, arg, ms = 10000) => page.waitForFunction(fn, { timeout: ms }, arg).then(() => true, () => false);
  const send = async (page, text, n) => {
    await page.type('#view-guide textarea', text);
    await page.keyboard.press('Enter');
    return waitFn(page, (k) => document.querySelectorAll('#view-guide .g-msg.assistant').length >= k && !document.querySelector('#view-guide .g-typing'), n);
  };
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(spy);
    await page.setViewport({ width: 1100, height: 760 });
    const errors = [], reqs = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/503|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('request', (r) => { if (r.url().endsWith('/api/guide/tts') && r.method() === 'POST') reqs.push(JSON.parse(r.postData())); });
    await page.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#view-guide textarea');
    check('respuesta del Guía con markdown', await send(page, 'Dime **algo** con `código` y [un enlace](http://x.y)', 1));
    await page.waitForSelector('#view-guide .g-msg.assistant .g-play:not([disabled])');
    check('cada respuesta del Guía tiene su ▶', (await page.$$eval('#view-guide .g-msg.assistant', (els) => els.every((e) => e.querySelector('.g-play')?.textContent === '▶'))));
    check('las burbujas del usuario no tienen ▶', (await page.$$('#view-guide .g-msg.user .g-play')).length === 0);

    await page.click('#view-guide .g-msg.assistant .g-play');
    check('el audio se reproduce (evento play)', await waitFn(page, () => window.__ev.includes('play')));
    check('el botón pasa a ⏸', await waitFn(page, () => document.querySelector('#view-guide .g-play')?.textContent === '⏸'));
    check('pide POST /api/guide/tts con el texto plano (sin markdown ni código)', reqs.length === 1 && reqs[0].text === 'fake: Dime algo con código y un enlace', JSON.stringify(reqs));
    const shot = process.argv[2];
    if (shot) await page.screenshot({ path: path.resolve(shot) });
    await page.click('#view-guide .g-play');
    check('⏸ para la reproducción', await waitFn(page, () => window.__playing.size === 0 && document.querySelector('#view-guide .g-play')?.textContent === '▶'));
    await page.click('#view-guide .g-play');
    check('al terminar (ended) el botón vuelve a ▶', await waitFn(page, () => window.__ev.includes('ended') && document.querySelector('#view-guide .g-play')?.textContent === '▶', null, 8000));

    // una sola reproducción a la vez
    check('segunda respuesta', await send(page, 'Otra cosa', 2));
    await page.waitForFunction(() => document.querySelectorAll('#view-guide .g-play').length === 2);
    const plays = await page.$$('#view-guide .g-play');
    await plays[0].click();
    await waitFn(page, () => window.__playing.size === 1);
    await (await page.$$('#view-guide .g-play'))[1].click();
    await waitFn(page, () => [...document.querySelectorAll('#view-guide .g-play')].map((b) => b.textContent).join() === '▶,⏸' || [...document.querySelectorAll('#view-guide .g-play')].map((b) => b.textContent).join() === '▶,⏳');
    await sleep(300);
    check('solo una reproducción a la vez', await page.evaluate(() => window.__playing.size <= 1 && [...document.querySelectorAll('#view-guide .g-play')].filter((b) => b.textContent !== '▶').length === 1));

    // cambiar de chat para
    await page.click('#view-guide [data-g="new"]');
    check('cambiar de chat para el audio', await waitFn(page, () => window.__playing.size === 0));

    // Ajustes: cambio de voz y «Probar voz»
    await page.click('[data-action="settings"]');
    await page.waitForSelector('#tts-voice option[value="es_AR-daniela-high"]');
    const opts = await page.$$eval('#tts-voice option', (o) => o.map((x) => x.value));
    check('Ajustes lista las voces femeninas de piper', opts.includes('es_ES-sharvard-medium:F') && opts.includes('es_AR-daniela-high'), opts.join());
    await page.select('#tts-voice', 'es_ES-mls_9972-low');
    const before = reqs.length;
    await page.click('[data-tts-test]');
    check('«Probar voz» reproduce una frase de muestra con la voz elegida', await waitFn(page, () => window.__ev.filter((e) => e === 'play').length >= 3) && reqs.length === before + 1 && reqs.at(-1).voice === 'es_ES-mls_9972-low' && /Hola/.test(reqs.at(-1).text), JSON.stringify(reqs.at(-1)));
    await page.click('[data-tts-test]');
    await page.screenshot({ path: path.join(tmp, 'ajustes.png') });
    await page.$eval('dialog form .row button:not(.ghost)', (b) => b.click());
    await waitFn(page, async () => (await (await fetch('/api/guide/tts')).json()).voice === 'es_ES-mls_9972-low');
    check('al guardar, la voz elegida queda en los ajustes', (await fetch(base + '/api/guide/tts').then((r) => r.json())).voice === 'es_ES-mls_9972-low');
    check('sin errores de consola', errors.length === 0, errors.join(' | '));
    await page.close();

    // Sin proveedor (openai sin clave): respaldo con speechSynthesis si existe; si no, ▶ deshabilitado con tooltip
    await postJ('/api/settings', { ttsProvider: 'openai', ttsVoice: 'nova' });
    const fb = await browser.newPage();
    await fb.evaluateOnNewDocument(() => {
      window.__said = [];
      const voices = [{ name: 'Microsoft Pablo', lang: 'es-ES' }, { name: 'Microsoft Helena', lang: 'es-ES' }, { name: 'English Female', lang: 'en-US' }];
      const ss = { speaking: false, getVoices: () => voices, cancel() { this.speaking = false; }, speak(u) { window.__said.push({ text: u.text, voice: u.voice?.name, lang: u.lang, rate: u.rate, pitch: u.pitch }); this.speaking = true; setTimeout(() => { this.speaking = false; u.onend?.(); }, 600); } };
      Object.defineProperty(window, 'speechSynthesis', { value: ss, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    });
    await fb.setViewport({ width: 1100, height: 760 });
    await fb.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    await fb.waitForSelector('#view-guide textarea');
    check('respuesta (respaldo)', await send(fb, 'Hola guía', 1));
    await fb.click('#view-guide .g-play');
    check('503 del servidor → respaldo del navegador con voz femenina en español', await waitFn(fb, () => window.__said.length === 1 && window.__said[0].voice === 'Microsoft Helena' && window.__said[0].lang === 'es-ES' && window.__said[0].rate === 1, null, 8000), JSON.stringify(await fb.evaluate(() => window.__said)));
    await fb.close();
    const nb = await browser.newPage();
    await nb.evaluateOnNewDocument(() => { Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); });
    await nb.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    await nb.waitForSelector('#view-guide textarea');
    check('respuesta (sin navegador)', await send(nb, 'Hola otra vez', 1));
    check('sin proveedor ni speechSynthesis: ▶ deshabilitado con tooltip', await waitFn(nb, () => { const b = document.querySelector('#view-guide .g-play'); return b?.disabled && /no disponible/.test(b.title); }));
    await nb.close();
  } finally { await browser.close(); }
}

console.log(failed ? `\n✗ ${failed} fallos\n${server.log.slice(-800)}` : '\n✓ tts OK');
process.exit(failed ? 1 : 0);
