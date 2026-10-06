#!/usr/bin/env node
// FT-56 · captura de la pestaña Tareas con una tarea en revisión, su dependiente y una aprobada automáticamente.
//   node scripts/review-shot.mjs out.png
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || 'review.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((f) => f && fs.existsSync(f));
if (!chrome) { console.error('No encuentro Chrome/Chromium (pon AO_CHROME)'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rshot-'));
const stubPort = await freePort(), port = await freePort(), base = `http://127.0.0.1:${port}`;
const stub = http.createServer((req, res) => (req.url === '/access' ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })) : res.writeHead(404).end('{}'))).listen(stubPort, '127.0.0.1');
fs.mkdirSync(path.join(tmp, 'data'));
fs.writeFileSync(path.join(tmp, 'data', 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'x'), flowTestUrl: `http://127.0.0.1:${stubPort}`, reviewNudgeMin: 999 } }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HOME: tmp, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: path.join(tmp, 'data'), AO_RTK: 'off' }, stdio: 'ignore' });
const call = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })).json();
const cleanup = () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* arrancando */ } await sleep(200); }
  const proj = await call('POST', '/api/projects', { name: 'demo', engine: 'demo' });
  const a = await call('POST', '/api/tasks', { projectId: proj.id, title: 'API de pedidos', role: 'back', status: 'review' });
  for (const t of ['Pantalla de pedidos', 'QA de pedidos']) await call('POST', '/api/tasks', { projectId: proj.id, title: t, role: 'front', dependsOn: [a.id] });
  await call('POST', '/api/settings', { reviewPolicy: 'auto' });
  await call('POST', '/api/tasks', { projectId: proj.id, title: 'Corregir typo', role: 'back', status: 'review', checks: ['true'] });
  await sleep(800);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--window-size=1400,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(base + '/', { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('[data-tab="tasks"]').click());
  await sleep(800);
  await page.screenshot({ path: out });
  await browser.close();
  console.log('Captura en', out);
} finally { cleanup(); }
