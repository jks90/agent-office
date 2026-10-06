#!/usr/bin/env node
// e2e de FT-74 · tablero de tareas compacto. Servidor temporal (motor demo, sin arrancar el equipo) con 15 tareas en
// «Por hacer» + una en Backlog y una en Revisión. Comprueba, a 1400×900: ≥8 tarjetas visibles en Por hacer, la barra
// hover y el «⋯», clic → modal, drag & drop, «Detallado» (diseño anterior), el modo recordado tras recargar y consola limpia.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-density-'));
const stubPort = await freePort();
const stub = http.createServer((req, res) => res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: tmp }, stdio: 'ignore' });
let browser;
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };

try {
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const p = await call('POST', '/api/projects', { name: 'Densidad' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  for (let i = 1; i <= 15; i++) await call('POST', '/api/tasks', { projectId: p.id, role: i % 2 ? 'back' : 'front', status: 'todo', title: `Tarea ${i}: un título bastante largo para comprobar que se recorta a dos líneas como mucho en la tarjeta compacta del tablero` });
  const bk = await call('POST', '/api/tasks', { projectId: p.id, role: 'back', status: 'backlog', title: 'Tarea en backlog' });
  const rv = await call('POST', '/api/tasks', { projectId: p.id, role: 'back', status: 'review', title: 'Tarea en revisión' });
  if (!bk.id || !rv.id) throw new Error('no pude crear tareas: ' + JSON.stringify([bk, rv]));

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.click('[data-tab="tasks"]');
  await page.waitForSelector('#board .card');

  const visible = (sel) => page.evaluate((s) => {
    const col = document.querySelector('.col[data-col="todo"] .cards').getBoundingClientRect();
    return [...document.querySelectorAll(`.col[data-col="todo"] ${s}`)].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= col.top - 1 && r.bottom <= col.bottom + 1; }).length;
  }, sel);

  console.log('Modo compacto (por defecto)');
  check('el tablero arranca en compacto', await page.evaluate(() => document.querySelector('#board').classList.contains('compact') && !!document.querySelector('#board .card.compact')));
  const n = await visible('.card');
  check('≥8 tarjetas visibles en Por hacer a 1400×900', n >= 8, `visibles: ${n}`);
  check('sin resumen ni fila de botones visibles', await page.evaluate(() => !document.querySelector('.card.compact .sum') && !document.querySelector('.card.compact .acts')));
  const lines = await page.evaluate(() => { const t = document.querySelector('.card.compact .t'); return Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)); });
  check('título a 2 líneas como mucho', lines <= 2, `líneas: ${lines}`);

  console.log('Barra hover y «⋯»');
  const barOpacity = () => page.evaluate(() => getComputedStyle(document.querySelector('.col[data-col="review"] .card .bar')).opacity);
  check('la barra está oculta sin ratón', (await barOpacity()) === '0');
  await page.hover('.col[data-col="review"] .card');
  await sleep(250);
  check('al pasar el ratón aparece la barra', (await barOpacity()) === '1');
  const barTxt = await page.$eval('.col[data-col="review"] .card .bar', (b) => b.innerText);
  check('Revisión: ✓ Aprobar · ↩ Devolver · Ver cambios', /Aprobar/.test(barTxt) && /Devolver/.test(barTxt) && /Ver cambios/.test(barTxt), barTxt);
  await page.click('.col[data-col="review"] .card [data-more]');
  check('«⋯» abre el menú con ✎ y Mover a…', await page.evaluate(() => { const m = document.querySelector('.col[data-col="review"] .more-menu.open'); return !!m && /Editar/.test(m.innerText) && /Mover a/.test(m.innerText) && m.getBoundingClientRect().height > 0; }));
  await page.mouse.click(700, 5);
  check('un clic fuera lo cierra', await page.evaluate(() => !document.querySelector('.more-menu.open')));

  console.log('Clic en la tarjeta → modal');
  await page.click('.col[data-col="todo"] .card .t');
  await page.waitForSelector('#dialog[open]');
  check('abre «Ver la tarea»', await page.evaluate(() => /Tarea 1:/.test(document.querySelector('#dialog').innerText)));
  await page.keyboard.press('Escape'); await sleep(200);

  console.log('Drag & drop (FT-27)');
  const moved = await page.evaluate(async () => {
    const card = document.querySelector('.col[data-col="todo"] .card'), id = card.dataset.task;
    const dt = new DataTransfer(), col = document.querySelector('.col[data-col="backlog"]');
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 800));
    return !!document.querySelector(`.col[data-col="backlog"] .card[data-task="${id}"]`);
  });
  check('arrastrar de Por hacer a Backlog la mueve', moved);

  console.log('Detallado y persistencia');
  await page.click('#density [data-density="detailed"]');
  check('«Detallado» conserva el diseño anterior', await page.evaluate(() => !document.querySelector('#board').classList.contains('compact') && !!document.querySelector('#board .card .acts') && !document.querySelector('.card.compact')));
  check('se guarda en localStorage ao:boardDensity', (await page.evaluate(() => localStorage.getItem('ao:boardDensity'))) === 'detailed');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.click('[data-tab="tasks"]'); await page.waitForSelector('#board .card');
  check('tras recargar sigue en Detallado', await page.evaluate(() => !document.querySelector('.card.compact')));
  await page.click('#density [data-density="compact"]');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.click('[data-tab="tasks"]'); await page.waitForSelector('#board .card');
  check('y vuelve a Compacto y se recuerda', await page.evaluate(() => !!document.querySelector('.card.compact')));
  check('sin errores de consola', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  failed++; console.error('✗ ' + (e.stack || e.message));
} finally {
  await browser?.close();
  console.log(failed ? `\n${failed} fallo(s)` : '\nTodo OK');
  process.exit(failed ? 1 : 0);
}
