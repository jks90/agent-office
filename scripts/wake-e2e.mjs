#!/usr/bin/env node
// e2e de la escucha continua «oye guía» (FT-38; cubre FT-35 y FT-36), sin micrófono real ni Claude:
//
//   node scripts/wake-e2e.mjs
//
// Servidores temporales (AO_DATA_DIR/HOME desechables, Guide `fake`, AO_STT_CMD → script falso cuyo texto cambia según el fichero
// `mode`) y Chrome con micrófono falso alimentado con un WAV (--use-file-for-fake-audio-capture). El «OpenAI» es un mock HTTP
// (AO_OPENAI_BASE) que cuenta llamadas. Sin Chrome/puppeteer-core solo se prueba la API.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wake-e2e-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)); }); });

// Micrófono falso: 3 s de tono a 440 Hz, bien por encima del umbral del VAD (RMS 0,02). Chrome lo repite en bucle.
const wav = path.join(tmp, 'voz.wav');
{ const rate = 16000, n = rate * 3, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.5 * 32767), 44 + i * 2);
  fs.writeFileSync(wav, buf); }

// STT falso: el texto sale de `mode` (wake → «Oye guía, ¿cómo va?»; nowake → «hola qué tal»; sin fichero → «¿Cómo va?»)
const sttCmd = path.join(tmp, 'stt.sh');
fs.writeFileSync(sttCmd, '#!/bin/sh\n[ -s "$1" ] || { echo "sin audio" >&2; exit 3; }\nm=$(cat "$(dirname "$0")/mode" 2>/dev/null)\ncase "$m" in wake) echo "Oye guía, ¿cómo va?";; nowake) echo "hola qué tal";; *) echo "¿Cómo va?";; esac\n', { mode: 0o755 });
const setMode = (m) => fs.writeFileSync(path.join(tmp, 'mode'), m);

// «OpenAI» de pega: cuenta peticiones
let openaiHits = 0;
const mock = http.createServer((req, res) => { openaiHits++; req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'hola desde openai' })); }); });
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

const servers = [];
async function startServer(name, extra = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AO_PORT: String(port), AO_DATA_DIR: path.join(tmp, name, 'data'), HOME: path.join(tmp, name), AO_GUIDE_FAKE: '1', OPENAI_API_KEY: '', ...extra };
  fs.mkdirSync(env.HOME, { recursive: true });
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  const s = { base, log: '' };
  proc.stdout.on('data', (d) => { s.log += d; }); proc.stderr.on('data', (d) => { s.log += d; });
  servers.push(proc);
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/guide/tools'); break; } catch { await sleep(100); } }
  return s;
}
process.on('exit', () => { servers.forEach((p) => { try { p.kill('SIGTERM'); } catch { /* parado */ } }); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (base, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const audio = Buffer.from('RIFF-no-es-audio-real-pero-da-igual').toString('base64');

// A: con STT local (y «OpenAI» de pega para el caso 5) · B: sin ningún STT local (PATH vacío → sin python3 ni faster-whisper)
const A = await startServer('a', { AO_STT_CMD: sttCmd, OPENAI_API_KEY: 'sk-test', AO_OPENAI_BASE: mockBase });
const emptyBin = path.join(tmp, 'vacio'); fs.mkdirSync(emptyBin);
const B = await startServer('b', { PATH: emptyBin, AO_STT_CMD: '' });

console.log('\n▸ API /api/guide/wake (curl)');
setMode('wake');
const stA = await fetch(A.base + '/api/guide/stt').then((r) => r.json());
check('GET /api/guide/stt incluye wake.ok=true con STT local', stA.wake?.ok === true, JSON.stringify(stA.wake));
const w1 = await post(A.base, '/api/guide/wake', { audio, mime: 'audio/webm', durationMs: 1500 });
check('«Oye guía, ¿cómo va?» → wake:true y rest «¿cómo va?»', w1.status === 200 && w1.wake === true && w1.rest === '¿cómo va?', JSON.stringify(w1));
setMode('nowake');
const w2 = await post(A.base, '/api/guide/wake', { audio, mime: 'audio/webm' });
check('«hola qué tal» → wake:false y rest vacío', w2.status === 200 && w2.wake === false && !w2.rest, JSON.stringify(w2));
const big = Buffer.alloc(201 * 1024, 1).toString('base64');
const w3 = await post(A.base, '/api/guide/wake', { audio: big, mime: 'audio/webm' });
check('audio de más de 200 KB → 413', w3.status === 413, JSON.stringify(w3).slice(0, 160));
const w4 = await post(A.base, '/api/guide/wake', { audio, mime: 'audio/webm', durationMs: 5000 });
check('durationMs > 3000 → 413', w4.status === 413, JSON.stringify(w4).slice(0, 160));
check('sin audio → 400', (await post(A.base, '/api/guide/wake', {})).status === 400);
const stB = await fetch(B.base + '/api/guide/stt').then((r) => r.json());
check('sin STT local: wake.ok=false con motivo', stB.wake?.ok === false && !!stB.wake.reason, JSON.stringify(stB.wake));
const w5 = await post(B.base, '/api/guide/wake', { audio, mime: 'audio/webm' });
check('sin STT local → 503 con motivo', w5.status === 503 && /STT local/.test(w5.error || ''), JSON.stringify(w5));
await post(A.base, '/api/settings', { sttProvider: 'openai' });
const before = openaiHits;
const w6 = await post(A.base, '/api/guide/wake', { audio, mime: 'audio/webm' });
check('con sttProvider=openai el wake sigue usando el STT local (el mock de OpenAI no recibe nada)', w6.status === 200 && openaiHits === before, `status ${w6.status}, hits ${openaiHits - before}`);
const s1 = await post(A.base, '/api/guide/stt', { audio });
check('control: /api/guide/stt con openai sí llega al mock', s1.status === 200 && s1.text === 'hola desde openai' && openaiHits === before + 1, JSON.stringify(s1));
await post(A.base, '/api/settings', { sttProvider: 'local-cmd', guideProvider: 'fake' });
await post(B.base, '/api/settings', { guideProvider: 'fake' });

console.log('\n▸ UI (escucha continua con el micrófono falso de Chrome)');
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* sin devDependencies */ }
if (!chrome || !puppeteer) console.log('  – sin Chrome/puppeteer-core: UI omitida');
else {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  // Página nueva con contador de getUserMedia, pistas y registro de peticiones /api/guide/*
  async function open(base, { wakeOn = false } = {}) {
    const page = await browser.newPage();
    const reqs = [];
    const errors = [];
    page.on('request', (r) => { if (r.url().includes('/api/guide/')) reqs.push(r.method() + ' ' + new URL(r.url()).pathname); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => { window.__tracks = []; window.__gum = 0; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; const st = await g(c); window.__tracks.push(...st.getTracks()); return st; }; });
    await page.setViewport({ width: 1100, height: 760 });
    await page.goto(base + '/?view=guide', { waitUntil: 'networkidle2' });
    if (wakeOn) { await page.evaluate(() => localStorage.setItem('ao:voice-wake', '1')); await page.reload({ waitUntil: 'networkidle2' }); }
    return { page, reqs, errors, count: (re) => reqs.filter((r) => re.test(r)).length };
  }
  const userMsgs = (page) => page.$$eval('#view-guide .g-msg.user', (els) => els.map((e) => e.textContent.trim()));
  try {
    // (1) instalación limpia
    console.log('  · instalación limpia');
    const c = await open(A.base);
    await sleep(2000);
    check('(1) la casilla está apagada', await (async () => { await c.page.click('[data-action="settings"]'); await c.page.waitForSelector('input[name=voiceWake]'); return c.page.$eval('input[name=voiceWake]', (e) => !e.checked && !e.disabled); })());
    check('(1) no hay chip de escucha ni marca en el botón flotante', await c.page.evaluate(() => document.querySelector('#view-guide .g-ear').hidden && document.querySelector('#guide-fab .fab-ear').hidden));
    check('(1) no se piden permisos de micrófono (getUserMedia = 0)', (await c.page.evaluate(() => window.__gum)) === 0);
    check('(1) no se pide /api/guide/wake', c.count(/\/api\/guide\/wake/) === 0, c.reqs.join(', '));
    await c.page.close();

    // (2)(3) activar con frase de activación
    console.log('  · activar y decir «oye guía, ¿cómo va?»');
    setMode('nowake');
    const p = await open(A.base);
    await p.page.evaluate(() => localStorage.setItem('ao:voice-review', '0'));
    await p.page.evaluate(() => localStorage.setItem('ao:voice-wake', '1'));
    await p.page.reload({ waitUntil: 'networkidle2' });
    await p.page.waitForSelector('#view-guide .g-ear:not([hidden])', { timeout: 5000 });
    check('(2) aparece el chip «Escuchando»', /Escuchando/.test(await p.page.$eval('#view-guide .g-ear', (e) => e.textContent)));
    check('(2) aparece la marca 👂 del botón flotante', await p.page.$eval('#guide-fab .fab-ear', (e) => !e.hidden));
    const got = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { if (p.count(/POST \/api\/guide\/wake/) > 0) return true; await sleep(200); } return false; })();
    check('(2) llegan peticiones a /api/guide/wake', got, p.reqs.join(', '));
    // (4) con «hola qué tal» (modo nowake) no se envía nada al chat
    await sleep(3000);
    check('(4) «hola qué tal» → ninguna petición al chat y ningún mensaje del usuario', p.count(/^POST \/api\/guide\/chat$/) === 0 && (await userMsgs(p.page)).length === 0, p.reqs.join(', '));
    check('(2) mientras no se dice la frase no hay peticiones a /api/guide/stt', p.count(/^POST \/api\/guide\/stt/) === 0, p.reqs.join(', '));
    // (3) ahora el STT devuelve la frase
    setMode('wake');
    const ok3 = await p.page.waitForFunction(() => [...document.querySelectorAll('#view-guide .g-msg.user')].some((m) => /¿cómo va\?/i.test(m.textContent)), { timeout: 20000 }).then(() => true, () => false);
    check('(3) «oye guía, ¿cómo va?» → el mensaje entra en el chat', ok3, (await userMsgs(p.page)).join(' | '));
    const ok3b = await p.page.waitForFunction(() => [...document.querySelectorAll('#view-guide .g-msg')].some((m) => m.textContent.includes('fake: ¿cómo va?')), { timeout: 15000 }).then(() => true, () => false);
    check('(3) el Guía fake responde', ok3b, (await p.page.$$eval('#view-guide .g-msg', (els) => els.map((e) => e.textContent))).join(' | '));
    check('(3) el mensaje enviado no lleva «oye guía»', (await userMsgs(p.page)).every((t) => !/oye gu/i.test(t)), (await userMsgs(p.page)).join(' | '));
    check('(3) sigue sin haber peticiones a /api/guide/stt', p.count(/^POST \/api\/guide\/stt/) === 0, p.reqs.join(', '));

    // (7) con el Guía ocupado no salen peticiones a /wake: se retiene la respuesta del chat
    console.log('  · Guía ocupado');
    setMode('nowake');
    await p.page.waitForFunction(() => !document.querySelector('#view-guide textarea').disabled, { timeout: 15000 });
    await p.page.setRequestInterception(true);
    let release;
    const held = new Promise((r) => { release = r; });
    let heldReq = null;
    p.page.on('request', (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (r.url().includes('/api/guide/chat') && r.method() === 'POST') { heldReq = r; held.then(() => r.continue()); } else r.continue();
    });
    await p.page.type('#view-guide textarea', 'tarea larga');
    await p.page.keyboard.press('Enter');
    await p.page.waitForFunction(() => document.querySelector('#view-guide textarea').disabled, { timeout: 5000 });
    await sleep(1500); // deja drenar lo que estuviera en vuelo
    const w0 = p.count(/POST \/api\/guide\/wake/);
    const trk = await p.page.evaluate(() => window.__tracks.filter((t) => t.readyState === 'live').length);
    await sleep(4000);
    check('(7) con G.busy no salen peticiones a /api/guide/wake', heldReq && p.count(/POST \/api\/guide\/wake/) === w0, `${p.count(/POST \/api\/guide\/wake/) - w0} nuevas`);
    check('(7) ... y el micrófono queda suelto mientras tanto', trk === 0, `${trk} pistas vivas`);
    check('(7) el chip pasa a «en pausa»', /pausa/.test(await p.page.$eval('#view-guide .g-ear', (e) => e.textContent)));
    release();
    await p.page.waitForFunction(() => !document.querySelector('#view-guide textarea').disabled, { timeout: 15000 });
    const w1n = p.count(/POST \/api\/guide\/wake/);
    await sleep(3500);
    check('(7) al terminar el Guía se reanuda la escucha (vuelven las peticiones a /wake)', p.count(/POST \/api\/guide\/wake/) > w1n, p.reqs.slice(-4).join(', '));
    await p.page.setRequestInterception(false);

    // (8) apagar
    console.log('  · apagar');
    await p.page.click('#view-guide .g-ear');
    await sleep(800);
    check('(8) al apagar la escucha el chip desaparece', await p.page.$eval('#view-guide .g-ear', (e) => e.hidden));
    check('(8) ... la marca del botón flotante también', await p.page.$eval('#guide-fab .fab-ear', (e) => e.hidden));
    check('(8) ... las pistas del micrófono quedan liberadas', await p.page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === 'ended')));
    const wEnd = p.count(/POST \/api\/guide\/wake/);
    await sleep(3000);
    check('(8) ... y no salen más peticiones a /wake', p.count(/POST \/api\/guide\/wake/) === wEnd);
    check('(8) la preferencia queda apagada', (await p.page.evaluate(() => localStorage.getItem('ao:voice-wake'))) === '0');
    check('sin errores de página (incluida la carga con la escucha activa)', p.errors.length === 0, p.errors.join(' | '));
    await p.page.close();

    // (5) sttProvider=openai: el mock de OpenAI no recibe nada del wake
    console.log('  · sttProvider=openai');
    await post(A.base, '/api/settings', { sttProvider: 'openai' });
    setMode('nowake');
    const hits0 = openaiHits;
    const o = await open(A.base, { wakeOn: true });
    await o.page.waitForSelector('#view-guide .g-ear:not([hidden])', { timeout: 5000 });
    const gotO = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { if (o.count(/POST \/api\/guide\/wake/) >= 2) return true; await sleep(200); } return false; })();
    check('(5) con sttProvider=openai la escucha sigue mandando segmentos a /api/guide/wake', gotO, o.reqs.join(', '));
    check('(5) el mock de OpenAI recibe 0 peticiones', openaiHits === hits0, `${openaiHits - hits0} peticiones`);
    check('(5) tampoco hay peticiones a /api/guide/stt', o.count(/^POST \/api\/guide\/stt/) === 0);
    await o.page.close();
    await post(A.base, '/api/settings', { sttProvider: 'local-cmd' });

    // (6) sin STT local
    console.log('  · sin STT local');
    const n = await open(B.base);
    await n.page.click('[data-action="settings"]');
    await n.page.waitForSelector('input[name=voiceWake]');
    const dis = await n.page.waitForFunction(() => document.querySelector('input[name=voiceWake]').disabled, { timeout: 5000 }).then(() => true, () => false);
    check('(6) la casilla queda deshabilitada', dis);
    const info = await n.page.$eval('#wake-info', (e) => e.textContent);
    check('(6) ... con su motivo', /no disponible/.test(info) && /STT local/i.test(info), info);
    check('(6) ... y no se pide el micrófono ni /wake', (await n.page.evaluate(() => window.__gum)) === 0 && n.count(/\/api\/guide\/wake/) === 0);
    await n.page.close();
  } finally { await browser.close(); }
}

console.log(failed ? `\n✗ ${failed} fallos\n${A.log.slice(-600)}\n${B.log.slice(-300)}` : '\n✓ escucha continua OK');
process.exit(failed ? 1 : 0);
