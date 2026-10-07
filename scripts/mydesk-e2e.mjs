#!/usr/bin/env node
// FT-124: «mi mesa» en la planta — avisos 🔔 del proyecto, línea agente→mesa, clic → Para ti filtrado, punto en el edificio.
// Servidor temporal con stub de flow-test + Chrome headless. Proyecto A: 1 pregunta + 2 revisiones; proyecto B: sin pendientes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2] || path.join(ROOT, 'resumen', 'mydesk-ft-124.png');
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
fs.mkdirSync(path.dirname(shot), { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mydesk-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => (req.url === '/access' ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })) : res.writeHead(404).end('{}'))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}`, reviewNudgeMin: 0 } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', stop);
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const bubbles = () => [...document.querySelectorAll('.o3d-bubble.me')].map((b) => ({ t: b.textContent, o: b.style.opacity }));

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const A = await call('POST', '/api/projects', { name: 'ProyA', engine: 'demo' });
  const B = await call('POST', '/api/projects', { name: 'ProyB', engine: 'demo' });
  const mk = (extra) => call('POST', '/api/tasks', { projectId: A.id, role: 'back', ...extra });
  await mk({ title: 'Revisión uno', status: 'review' });
  await mk({ title: 'Revisión dos', status: 'review' });
  const doing = await mk({ title: 'Con duda' });
  await call('POST', `/api/projects/${A.id}/run`, { running: true }); // el motor demo la pone en curso
  for (let i = 0; i < 100; i++) { if ((await call('GET', '/api/state')).tasks.find((t) => t.id === doing.id)?.status === 'doing') break; await sleep(200); }
  check('tarea en curso', (await call('GET', '/api/state')).tasks.find((t) => t.id === doing.id)?.status === 'doing');
  const q = await call('POST', '/api/questions', { taskId: doing.id, question: '¿Seguimos por A o B?', options: ['A', 'B'] });
  check('pregunta creada', !!q.id, JSON.stringify(q).slice(0, 120));

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 12000 });
  await page.select('#project', A.id);
  await page.waitForFunction(() => [...document.querySelectorAll('.o3d-bubble.me')].some((b) => b.textContent.startsWith('🔔 3')), { timeout: 10000 }).catch(() => {});
  await sleep(1500);

  let bs = await page.evaluate(bubbles);
  console.log('  mesa:', bs.map((b) => b.t).join(' | '));
  check('mesa «Tú» con 🔔 3 y desglose', bs.length === 1 && /^🔔 3 · /.test(bs[0].t) && bs[0].t.includes('❓1') && bs[0].t.includes('✋2'), JSON.stringify(bs));
  check('burbuja de la mesa visible', bs[0]?.o === '1');
  const lines = await page.evaluate(() => [...document.querySelectorAll('.o3d-mine-lines line')].map((l) => ({ a: l.dataset.agent, k: l.dataset.kind, d: l.getAttribute('stroke-dasharray'), o: l.style.opacity })));
  check('línea discontinua agente → mesa (pregunta)', lines.length === 1 && lines[0].a === (await call('GET', '/api/state')).tasks.find((t) => t.id === doing.id)?.agentId && lines[0].k === 'question' && !!lines[0].d && lines[0].o !== '0', JSON.stringify(lines));
  const agentBubble = await page.evaluate(() => [...document.querySelectorAll('.o3d-bubble:not(.me)')].map((b) => b.textContent));
  check('burbuja del agente: ❓ te pregunta', agentBubble.some((t) => t.includes('te pregunta')), JSON.stringify(agentBubble));
  const papers = await page.evaluate(() => window.aoOffice.deskPapers?.children.length);
  check('pila de papeles = 3', papers === 3, String(papers));
  await page.screenshot({ path: shot });

  // clic en la burbuja → Para ti filtrado por el proyecto
  await page.keyboard.press('Escape'); // la app abre sola el diálogo de la pregunta pendiente
  await sleep(300);
  await page.click('.o3d-bubble.me');
  await page.waitForFunction(() => !document.querySelector('#view-inbox')?.hidden && document.querySelector('[data-inbox-filter]'), { timeout: 5000 }).catch(() => {});
  const inbox = await page.evaluate(() => ({ chip: document.querySelector('[data-inbox-filter]')?.textContent || '', rows: document.querySelectorAll('#inbox .inbox-row').length, text: document.querySelector('#inbox')?.textContent || '' }));
  check('clic abre Para ti filtrado por ProyA', inbox.chip.includes('ProyA') && inbox.rows === 3, JSON.stringify({ chip: inbox.chip, rows: inbox.rows }));
  await page.click('[data-inbox-clear]');
  await sleep(300);
  check('quitar filtro', await page.evaluate(() => !document.querySelector('[data-inbox-filter]')));

  // vista edificio: punto con el número en la planta de ProyA
  await page.evaluate(() => window.aoOffice.setMode('building'));
  await sleep(1200);
  const dots = await page.evaluate(() => [...document.querySelectorAll('.o3d-floor')].map((f) => ({ n: f.querySelector('.n')?.textContent, mine: f.querySelector('.mine')?.textContent || null })));
  check('edificio: la planta de ProyA muestra 3', dots.find((d) => d.n?.includes('ProyA'))?.mine === '3', JSON.stringify(dots));

  // proyecto sin pendientes
  await page.evaluate(() => window.aoOffice.setMode('floor'));
  await page.select('#project', B.id);
  await page.waitForFunction(() => [...document.querySelectorAll('.o3d-bubble.me')].some((b) => b.textContent.includes('nada te espera')), { timeout: 8000 }).catch(() => {});
  bs = await page.evaluate(bubbles);
  check('sin pendientes: «✅ nada te espera»', bs.length === 1 && bs[0].t === '✅ nada te espera', JSON.stringify(bs));
  check('consola limpia', errors.length === 0, errors.join('; '));
} catch (e) { failed++; console.error(e); } finally { await browser?.close(); stop(); }
console.log(failed ? `FALLÓ (${failed})` : 'OK');
process.exit(failed ? 1 : 0);
