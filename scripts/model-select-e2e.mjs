#!/usr/bin/env node
// FT-55: selector de modelo único. El cajón del agente usa <select> (no texto libre), cambiar motor repinta las
// opciones, elegir modelo hace PATCH, «Otro…» acepta un id manual y los no disponibles salen deshabilitados con su nota.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 7890 + Math.floor(Math.random() * 80);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-model-select-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${j.error || ''}`);
  return j;
};
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);

// Lista fija (no depende del CLI instalado): un Claude no disponible y un Codex.
const MODELS = {
  claude: [{ id: 'sonnet', label: 'Sonnet (alias)', available: true }, { id: 'claude-fable-5-1', label: 'Fable 5.1', available: false, note: 'requiere Claude Code ≥ 2.1.251' }],
  codex: [{ id: 'gpt-5.5', label: 'gpt-5.5', available: true }],
};

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const project = await api('POST', '/api/projects', { name: 'FT-55 Modelos' });
  const agent = await api('POST', '/api/agents', { name: 'Marta', role: 'back', engine: 'claude', projectId: project.id });
  const model = async () => (await api('GET', '/api/state')).agents.find((a) => a.id === agent.id).model;

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().endsWith('/api/engines/models') ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MODELS) }) : r.continue()));
  await page.goto(base + '/?view=agents', { waitUntil: 'networkidle2' });
  await page.waitForSelector(`[data-agent="${agent.id}"]`, { timeout: 10000 });
  await page.click(`[data-agent="${agent.id}"]`);
  await page.waitForSelector('#drawer:not([hidden]) [data-f=modelbox] select.model-select', { timeout: 8000 });

  check('el cajón no tiene <input type=text> de modelo', await page.evaluate(() => !document.querySelector('#drawer input[data-f=model]') && !!document.querySelector('#drawer select.model-select')));
  const opts = () => page.$$eval('#drawer .model-select option', (os) => os.map((o) => ({ v: o.value, t: o.textContent, d: o.disabled, title: o.title })));
  let o = await opts();
  check('motor claude: solo modelos de Claude + Otro…', o.some((x) => x.v === 'sonnet') && !o.some((x) => x.v === 'gpt-5.5') && o.some((x) => x.v === '__other'));
  const fable = o.find((x) => x.v === 'claude-fable-5-1');
  check('no disponible: deshabilitado con su nota', fable?.d && /2\.1\.251/.test(fable.title), JSON.stringify(fable));

  await page.select('#drawer .model-select', 'sonnet');
  await sleep(600);
  check('elegir modelo hace PATCH y el snapshot lo refleja', (await model()) === 'sonnet', await model());

  await page.select('#drawer [data-f=engine]', 'codex');
  await sleep(600);
  o = await opts();
  check('cambiar motor repinta las opciones', o.some((x) => x.v === 'gpt-5.5') && !o.some((x) => x.v === 'claude-fable-5-1'));
  check('el valor actual se conserva como «actual: …»', o.some((x) => x.v === 'sonnet' && /actual/.test(x.t)));

  await page.select('#drawer .model-select', '__other');
  check('«Otro…» muestra el campo de texto', await page.$eval('#drawer .model-other', (e) => e.style.display !== 'none'));
  await page.type('#drawer .model-other', 'gpt-9-prueba');
  await page.$eval('#drawer .model-other', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await sleep(600);
  check('«Otro…» acepta un id manual', (await model()) === 'gpt-9-prueba', await model());

  await page.select('#drawer [data-f=engine]', 'auto');
  await sleep(400);
  check('motor auto: ambos grupos y pista', await page.evaluate(() => document.querySelectorAll('#drawer optgroup').length === 2 && /decide si va a Claude o a Codex/.test(document.querySelector('#drawer .model-hint').textContent)));

  // Diálogo «Contratar»: mismo componente
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#drawer [data-close]')?.click());
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser?.close();
}
console.log(failed ? `\n${failed} fallo(s)` : '\nOK');
process.exit(failed ? 1 : 0);
