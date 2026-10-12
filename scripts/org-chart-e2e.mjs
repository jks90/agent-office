#!/usr/bin/env node
// e2e · plantilla del proyecto como organigrama. Servidor temporal (motor demo, equipo parado): proyecto con el equipo base
// (PO, back, front, QA) + Coordi + un Release y otro back. Comprueba los niveles (Tú → Coordi → PO y Release → columnas por rol
// colgando del PO), el orden de columnas (dev, QA), los contadores de «Tú», desplegar/plegar una tarjeta, que con poco ancho
// el scroll alcanza la primera columna sin desbordar la página, y consola limpia.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-org-'));
const stubPort = await freePort();
const stub = http.createServer((req, res) => res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_AUTOUPDATE: 'off', AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: tmp }, stdio: 'ignore' });
let browser;
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };

try {
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const p = await call('POST', '/api/projects', { name: 'Organigrama', engine: 'demo' }); // equipo base + Coordi
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  await call('POST', '/api/agents', { name: 'Rita', role: 'release', engine: 'demo', projectId: p.id });
  await call('POST', '/api/agents', { name: 'Ana', role: 'back', engine: 'demo', projectId: p.id });
  await call('POST', '/api/tasks', { projectId: p.id, role: 'back', status: 'review', title: 'Para revisar' });
  await call('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'Mía', assignedAgentId: 'human' });

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#project option').length > 0, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('[data-tab="agents"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#team .org-card').length >= 7, { timeout: 15000 });

  // Árbol: nombre (o cabecera de columna) de cada nodo y su padre
  const tree = await page.evaluate(() => {
    const label = (li) => li.querySelector(':scope > .org-me') ? 'Tú' : li.querySelector(':scope > .org-col') ? 'col:' + li.querySelector(':scope > .org-col .chip').textContent.trim() : li.querySelector(':scope > .org-card b')?.textContent.trim();
    return [...document.querySelectorAll('#team .org li')].map((li) => ({ n: label(li), parent: li.parentElement.closest('li') ? label(li.parentElement.closest('li')) : null }));
  });
  const parentOf = (n) => tree.find((x) => x.n === n)?.parent;
  check('arriba «Tú»', tree[0]?.n === 'Tú' && tree[0].parent === null, JSON.stringify(tree[0]));
  check('Coordi cuelga de Tú', parentOf('Coordi') === 'Tú');
  check('PO (Olivia) y Release (Rita) cuelgan de Coordi', parentOf('Olivia') === 'Coordi' && parentOf('Rita') === 'Coordi', JSON.stringify(tree));
  const cols = tree.filter((x) => x.n?.startsWith('col:'));
  check('las columnas por rol cuelgan del PO', cols.length >= 3 && cols.every((c) => c.parent === 'Olivia'), JSON.stringify(cols));
  check('orden de columnas: dev (Backend, Frontend) antes que QA', cols.map((c) => c.n).join() === 'col:Backend,col:Frontend,col:QA', cols.map((c) => c.n).join());
  check('la columna Backend apila a sus dos agentes', await page.evaluate(() => [...document.querySelectorAll('#team .org-col')].find((c) => /Backend/.test(c.textContent))?.querySelectorAll('.org-card').length === 2));
  const me = await page.$eval('.org-me', (e) => e.textContent);
  check('«Tú»: 1 por revisar · 1 asignada', /1 por revisar/.test(me) && /1 asignada a ti/.test(me), me);

  // Compacta → completa → compacta
  check('todas compactas al entrar', (await page.$$('#team .org-card.open')).length === 0);
  await page.evaluate(() => [...document.querySelectorAll('#team button.org-card')].find((b) => /Coordi/.test(b.textContent)).click());
  await sleep(200);
  check('clic despliega la tarjeta completa (con sus botones)', await page.evaluate(() => { const o = document.querySelector('#team .org-card.open'); return !!o && /Coordi/.test(o.textContent) && !!o.querySelector('[data-bench]') && !!o.querySelector('[data-agent-edit]'); }));
  await page.click('#team .org-fold');
  await sleep(200);
  check('▴ la vuelve a plegar', (await page.$$('#team .org-card.open')).length === 0);

  // Poco ancho: scroll dentro de la plantilla; la primera columna alcanzable; la página no se desborda
  await page.setViewport({ width: 640, height: 1000 });
  await sleep(300);
  const narrow = await page.$eval('#team .org', (o) => { o.scrollLeft = 0; const f = o.querySelector('.org-col'); return { scrolls: o.scrollWidth > o.clientWidth, firstVisible: f.getBoundingClientRect().left >= o.getBoundingClientRect().left - 1, page: document.documentElement.scrollWidth <= innerWidth }; });
  check('con poco ancho hace scroll y se alcanza la primera columna', narrow.scrolls && narrow.firstVisible, JSON.stringify(narrow));
  check('la página no se desborda', narrow.page);
  check('sin errores de consola', !errors.length, errors.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browser?.close();
}
console.log(failed ? `✗ ${failed} fallo(s)` : '✓ organigrama: todo bien');
process.exit(failed ? 1 : 0);
