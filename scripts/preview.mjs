#!/usr/bin/env node
// Captura de la oficina SIN navegador visible: levanta un servidor temporal con un proyecto demo
// en marcha, espera a que los agentes se muevan y hace una foto con Chrome headless (WebGL por SwiftShader).
//
//   node scripts/preview.mjs out.png                 # captura de la oficina tras 12 s
//   node scripts/preview.mjs out.png --wait 20000    # más tiempo (p. ej. para que alguien se siente)
//   node scripts/preview.mjs out.png --full          # la página entera, no solo la oficina
//   node scripts/preview.mjs out.png --query "x=1"   # parámetros extra en la URL
//
// Imprime también los errores de consola de la página. Pensado para que un agente pueda VER lo que
// pinta: captura → mirar el PNG → corregir → repetir. Necesita `npm install` (puppeteer-core) y Chrome/Chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'preview.png');
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const wait = Number(opt('wait', 12000));
const query = opt('query', '');
const full = args.includes('--full');
const port = 7490 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-preview-'));

const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  .find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (pon AO_CHROME=/ruta/al/binario)'); process.exit(2); }

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', stop);

const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
  return j;
};

let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const { projects } = await api('GET', '/api/state');
  const pid = projects[0].id;
  // Equipo en marcha: PO planificando, back y front en su mesa, QA en la zona de descanso.
  await api('POST', `/api/projects/${pid}/goal`, { goal: 'Alta de clientes con email y verificación' });
  for (const role of ['back', 'front']) await api('POST', '/api/tasks', { projectId: pid, role, title: `Prueba de ${role}` });
  await api('POST', `/api/projects/${pid}/run`, { running: true });

  browser = await puppeteer.launch({
    executablePath: chrome, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
  const url = `${base}/${query ? '?' + query : ''}`;
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, wait));
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  const target = full ? page : (await page.$('.office-wrap')) || page;
  await target.screenshot({ path: out });
  console.log(`📸 ${out}  (${full ? 'página entera' : 'oficina'}, tras ${wait} ms, ~${fps} fps en headless)`);
  if (errors.length) { console.log('⚠ Errores/avisos de la página:'); for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ' + e); } else console.log('✓ Sin errores de consola');
} catch (e) {
  console.error('Error:', e.message);
  if (serverLog.trim()) console.error(serverLog.trim());
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}
