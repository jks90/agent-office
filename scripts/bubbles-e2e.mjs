#!/usr/bin/env node
// FT-123: burbujas de estado siempre visibles y sin solape. Servidor temporal + Chrome headless;
// se inyectan 3 agentes trabajando en mesas contiguas con aoOffice.update().
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2] || path.join(ROOT, 'resumen', 'bubbles-ft-123.png');
const port = 7970 + Math.floor(Math.random() * 20);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bubbles-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
fs.mkdirSync(path.dirname(shot), { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;

const rects = () => [...document.querySelectorAll('.o3d-bubble')].filter((b) => b.style.opacity === '1').map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, l: r.left, r: r.right, top: r.top, b: r.bottom }; });
const inter = (a, c) => a.l < c.r && a.r > c.l && a.top < c.b && a.b > c.top;
let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 12000 });
  const inject = (bubbles) => page.evaluate((bubbles) => {
    const mk = (id, name, code) => ({ id, name, role: 'back', engine: 'demo', status: 'working', taskId: code, task: code, activity: 'Editando server/team.js' });
    const agents = [mk('a1', 'Óscar', 'FT-115'), mk('a2', 'Sofía', 'FT-114'), mk('a3', 'Marta', 'FT-113')];
    const tasks = agents.map((a) => ({ id: a.taskId, code: a.taskId, title: 'x', status: 'doing', agentId: a.id, role: 'back', projectId: 'p' }));
    window.aoOffice.update({ agents, tasks, questions: [], roles: {}, title: 'T', bubbles });
  }, bubbles);
  await inject('todas');
  await sleep(2500);
  let rs = await page.evaluate(rects);
  console.log(rs.map((r) => r.t).join(' | '));
  check('3 burbujas visibles', rs.length === 3, String(rs.length));
  let ok = true;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (inter(rs[i], rs[j])) ok = false;
  check('sin intersección de rectángulos', ok, JSON.stringify(rs));
  await page.screenshot({ path: shot });
  await inject('al pasar');
  await sleep(600);
  rs = await page.evaluate(rects);
  check("modo 'al pasar': ninguna burbuja", rs.length === 0, String(rs.length));
  check('consola limpia', errors.length === 0, errors.join('; '));
} catch (e) { failed++; console.error(e); } finally { await browser?.close(); stop(); }
console.log(failed ? `FALLÓ (${failed})` : 'OK');
process.exit(failed ? 1 : 0);
