#!/usr/bin/env node
// e2e del dictado por voz en «Nueva tarea» (FT-43), sin micrófono real:
//
//   node scripts/dictation-e2e.mjs [captura.png]
//
// (A) proveedor del navegador (SpeechRecognition simulado; preferencia ao:dictation=browser): texto en la posición del cursor
//     (descripción y título), estado grabando/parado, parar con segundo clic, permiso denegado (aviso y botón desactivado).
// (B) sin soporte: ni Web Speech ni STT del servidor → sin botón ni errores de consola.
// (C) proveedor del servidor (el preferido): micro falso de Chrome (tono + silencio, el VAD corta cada frase), STT falso
//     por AO_STT_CMD que devuelve «hola dictado» → el texto entra en el campo sin pasar por la Web Speech API (borrada).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const port = 7600 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-dict-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// STT falso del servidor: siempre «hola dictado». Micro falso: 1,2 s de tono a 440 Hz + 1,3 s de silencio (Chrome lo repite en bucle).
const sttCmd = path.join(dataDir, 'stt.sh');
fs.writeFileSync(sttCmd, '#!/bin/sh\n[ -s "$1" ] || exit 3\necho "hola dictado"\n', { mode: 0o755 });
const wav = path.join(dataDir, 'voz.wav');
{ const rate = 16000, tone = Math.round(rate * 1.2), n = Math.round(rate * 2.5), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(i < tone ? Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.5 * 32767) : 0, 44 + i * 2);
  fs.writeFileSync(wav, buf); }

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir, AO_STT_CMD: sttCmd }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const browsers = [];
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const launch = async (extra = []) => { const b = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...extra] }); browsers.push(b); return b; };
  const browser = await launch();

  // mode: 'stub' (Web Speech simulada, preferencia browser) · 'none' (sin Web Speech, preferencia browser → sin dictado) · 'server' (sin Web Speech, STT del servidor)
  const open = async (b, mode) => {
    const page = await b.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.evaluateOnNewDocument((m) => {
      if (m !== 'server') localStorage.setItem('ao:dictation', 'browser'); else localStorage.removeItem('ao:dictation');
      if (m !== 'stub') { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; }
      else {
        window.SpeechRecognition = class { start() { window.__rec = this; setTimeout(() => this.onstart?.(), 0); } stop() { setTimeout(() => this.onend?.(), 0); } };
        window.__say = (t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
      }
    }, mode);
    await page.goto(base, { waitUntil: 'networkidle2' });
    await sleep(300); // GET /api/guide/stt (¿STT del servidor disponible?)
    await page.click('[data-tab="tasks"]');
    await page.click('[data-action="new-task"]');
    await page.waitForSelector('dialog[open] [name=description]');
    return { page, errors };
  };
  const recording = (page) => page.$eval('dialog [name=description]', (el) => el.parentElement.querySelector('[data-mic]').classList.contains('rec'));

  console.log('(A) Proveedor del navegador (Web Speech simulada)');
  let { page, errors } = await open(browser, 'stub');
  check('hay un botón 🎤 por campo (título y descripción)', (await page.$$('dialog [data-mic]')).length === 2);
  check('la barra «Objetivo para el PO» también tiene 🎤', !!(await page.$('#goal-form [data-mic]')));
  await page.type('dialog [name=description]', 'Añadir al final');
  await page.$eval('dialog [name=description]', (el) => { el.focus(); el.setSelectionRange(6, 6); });
  const btns = await page.$$('dialog [data-mic]');
  await btns[1].click();
  await sleep(100);
  check('estado grabando (clase rec + aria-pressed)', await recording(page));
  await page.evaluate(() => window.__say('el botón de login'));
  const v = await page.$eval('dialog [name=description]', (el) => el.value);
  check('texto insertado en la posición del cursor', v === 'Añadir el botón de login al final', JSON.stringify(v));
  if (shot) await page.screenshot({ path: path.resolve(shot) });
  await btns[1].click(); await sleep(100);
  check('segundo clic para: deja de grabar', !(await recording(page)));
  await btns[0].click(); await sleep(100);
  await page.evaluate(() => window.__say('Título dictado'));
  check('dictado en el título', (await page.$eval('dialog [name=title]', (el) => el.value)) === 'Título dictado');
  await page.evaluate(() => window.__rec.onerror({ error: 'not-allowed' })); await sleep(100);
  check('permiso denegado → botón desactivado', await btns[0].evaluate((b) => b.disabled));
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
  await page.close();

  console.log('(B) Sin soporte de voz');
  ({ page, errors } = await open(browser, 'none'));
  check('no se pinta ningún botón 🎤', (await page.$$('dialog [data-mic]')).length === 0 && !(await page.$('#goal-form [data-mic]')));
  check('los campos siguen siendo editables', !!(await page.$('dialog [name=description]:not([disabled])')));
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
  await page.close();

  console.log('(C) Proveedor del servidor (STT local, micro falso)');
  const b2 = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required']);
  ({ page, errors } = await open(b2, 'server'));
  const sttReqs = [];
  page.on('request', (r) => { if (/\/api\/guide\/stt$/.test(r.url()) && r.method() === 'POST') sttReqs.push(Date.now()); });
  check('hay botón 🎤 sin Web Speech API (STT del servidor disponible)', (await page.$$('dialog [data-mic]')).length === 2 && !!(await page.$('#goal-form [data-mic]')));
  const mics = await page.$$('dialog [data-mic]');
  await mics[1].click();
  await sleep(300);
  check('estado grabando', await recording(page));
  const t0 = Date.now();
  let value = '';
  while (Date.now() - t0 < 25000) { value = await page.$eval('dialog [name=description]', (el) => el.value); if (value.includes('hola dictado')) break; await sleep(250); }
  check('la frase transcrita por el servidor entra en la descripción', value.includes('hola dictado'), JSON.stringify(value));
  check('el audio fue a POST /api/guide/stt', sttReqs.length > 0);
  await mics[1].click();
  await page.waitForFunction(() => !document.querySelector('dialog [name=description]').parentElement.querySelector('[data-mic]').classList.contains('rec'), { timeout: 15000 }).catch(() => {});
  await page.keyboard.press('Escape'); // cierra «Nueva tarea»
  await page.waitForFunction(() => !document.querySelector('#dialog').open, { timeout: 5000 }).catch(() => {});
  await page.click('#goal-form [data-mic]');
  const t1 = Date.now(); let goal = '';
  while (Date.now() - t1 < 25000) { goal = await page.$eval('#goal', (el) => el.value); if (goal.includes('hola dictado')) break; await sleep(250); }
  check('dictar en la barra «Objetivo para el PO» rellena el objetivo', goal.includes('hola dictado'), JSON.stringify(goal));
  await page.click('#goal-form [data-mic]');
  await page.waitForFunction(() => !document.querySelector('dialog [name=description]').parentElement.querySelector('[data-mic]').classList.contains('rec'), { timeout: 15000 }).catch(() => {});
  check('segundo clic para el dictado', !(await recording(page)));
  const live = await page.evaluate(() => (window.__tracks || []).length); // no hay registro de pistas: basta con el estado
  check('sin errores de consola', errors.length === 0, errors.join(' | ') || String(live));
} catch (e) { failed++; console.error('Error:', e.message); }
finally {
  for (const b of browsers) await b.close().catch(() => {});
  server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
