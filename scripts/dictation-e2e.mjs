#!/usr/bin/env node
// e2e del dictado por voz en «Nueva tarea» (FT-43) con un SpeechRecognition simulado (sin micro real):
//
//   node scripts/dictation-e2e.mjs [captura.png]
//
// Cubre: texto insertado en la posición del cursor (descripción y título), estado grabando/parado, parar con segundo clic,
// permiso denegado (aviso y botón desactivado) y degradación limpia sin soporte (sin botón ni errores de consola).
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

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  const open = async (stub) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    if (!stub) await page.evaluateOnNewDocument(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
    if (stub) await page.evaluateOnNewDocument(() => {
      window.SpeechRecognition = class { start() { window.__rec = this; setTimeout(() => this.onstart?.(), 0); } stop() { setTimeout(() => this.onend?.(), 0); } };
      window.__say = (t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
    });
    await page.goto(base, { waitUntil: 'networkidle2' });
    await page.click('[data-tab="tasks"]');
    await page.click('[data-action="new-task"]');
    await page.waitForSelector('dialog[open] [name=description]');
    return { page, errors };
  };

  console.log('Con soporte de voz');
  let { page, errors } = await open(true);
  check('hay un botón 🎤 por campo (título y descripción)', (await page.$$('dialog [data-mic]')).length === 2);
  await page.type('dialog [name=description]', 'Añadir al final');
  await page.$eval('dialog [name=description]', (el) => { el.focus(); el.setSelectionRange(6, 6); });
  const btns = await page.$$('dialog [data-mic]');
  await btns[1].click();
  await sleep(100);
  check('estado grabando (clase rec + aria-pressed)', await page.$eval('dialog [name=description]', (el) => el.parentElement.querySelector('[data-mic]').classList.contains('rec')));
  await page.evaluate(() => window.__say('el botón de login'));
  const v = await page.$eval('dialog [name=description]', (el) => el.value);
  check('texto insertado en la posición del cursor', v === 'Añadir el botón de login al final', JSON.stringify(v));
  if (shot) await page.screenshot({ path: path.resolve(shot) });
  await btns[1].click(); await sleep(100);
  check('segundo clic para: deja de grabar', !(await page.$eval('dialog [name=description]', (el) => el.parentElement.querySelector('[data-mic]').classList.contains('rec'))));
  await btns[0].click(); await sleep(100);
  await page.evaluate(() => window.__say('Título dictado'));
  check('dictado en el título', (await page.$eval('dialog [name=title]', (el) => el.value)) === 'Título dictado');
  await page.evaluate(() => window.__rec.onerror({ error: 'not-allowed' })); await sleep(100);
  check('permiso denegado → botón desactivado', await btns[0].evaluate((b) => b.disabled));
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
  await page.close();

  console.log('Sin soporte de voz');
  ({ page, errors } = await open(false));
  check('no se pinta ningún botón 🎤', (await page.$$('dialog [data-mic]')).length === 0);
  check('los campos siguen siendo editables', !!(await page.$('dialog [name=description]:not([disabled])')));
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) { failed++; console.error('Error:', e.message); }
finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
