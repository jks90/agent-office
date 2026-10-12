#!/usr/bin/env node
// e2e de FT-191 · UI de las tareas asignadas al humano. Servidor temporal (sin arrancar el equipo). Comprueba: crear con
// «👤 Yo (humano)», insignia «asignada a ti», editar una normal y asignarla al humano, arrastrar a Revisión y Hecho, que el
// contador del inbox/🔔 no suba, el filtro «Mías», reasignar a un agente (la insignia desaparece) y consola limpia.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-humanui-'));
const stubPort = await freePort();
const stub = http.createServer((req, res) => res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: tmp }, stdio: 'ignore' });
let browser;
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json(); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);

try {
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const p = await call('POST', '/api/projects', { name: 'Humano UI' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  const ag = await call('POST', '/api/agents', { name: 'Bea', role: 'back', engine: 'demo', projectId: p.id });
  const normal = await call('POST', '/api/tasks', { projectId: p.id, role: 'back', status: 'backlog', title: 'Normal para editar' });
  if (!ag.id || !normal.id) throw new Error('no pude preparar: ' + JSON.stringify([ag, normal]));

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.click('[data-tab="tasks"]');
  await page.waitForSelector('#board .card');
  const inboxN = () => page.evaluate(() => ({ tab: document.querySelector('#tab-inbox-count')?.textContent || '', bell: document.querySelector('#review-chip')?.hidden ? '' : document.querySelector('#review-chip').textContent }));
  const colOf = (id) => page.evaluate((i) => document.querySelector(`.card[data-task="${i}"]`)?.closest('.col')?.dataset.col || null, id);
  const badge = (id) => page.evaluate((i) => !!document.querySelector(`.card[data-task="${i}"] .human-badge`), id);
  const base0 = await inboxN();

  console.log('Crear con «Yo (humano)»');
  await page.evaluate(() => document.querySelector('[data-action="new-task"]').click());
  await page.waitForSelector('#dialog select[name="assignedAgentId"]');
  await page.type('#dialog input[name="title"]', 'Hecha por mí');
  await page.select('#dialog select[name="role"]', 'back'); // por defecto sale «que lo decida el PO» (Coordi)
  await page.select('#dialog select[name="assignedAgentId"]', 'human');
  await page.evaluate(() => [...document.querySelectorAll('#dialog button')].find((b) => b.textContent.trim() === 'Crear').click());
  await page.waitForFunction(() => [...document.querySelectorAll('#board .card .human-badge')].length === 1, { timeout: 8000 });
  const mine = (await call('GET', '/api/state')).tasks.find((t) => t.title === 'Hecha por mí');
  check('la tarea se crea con assignedAgentId=human', mine?.assignedAgentId === 'human');
  check('insignia «asignada a ti»', await badge(mine.id));
  check('sin «sin agente para este rol»', await page.evaluate((i) => !/sin agente/.test(document.querySelector(`.card[data-task="${i}"]`).innerText), mine.id));

  console.log('Editar una normal → humano');
  await page.evaluate((i) => document.querySelector(`.card[data-task="${i}"] [data-edit]`).click(), normal.id);
  await page.waitForSelector('#dialog select[name="assignedAgentId"]');
  await page.select('#dialog select[name="assignedAgentId"]', 'human');
  await page.evaluate(() => [...document.querySelectorAll('#dialog button')].find((b) => b.textContent.trim() === 'Guardar').click());
  await page.waitForFunction((i) => !!document.querySelector(`.card[data-task="${i}"] .human-badge`), { timeout: 8000 }, normal.id);
  check('la editada pasa a humano', await badge(normal.id));
  check('«👤 Mías (2)» en el filtro', (await page.$eval('#mine-filter', (b) => b.textContent)).includes('2'));

  console.log('Arrastrar a Revisión y Hecho');
  const drag = (id, col) => page.evaluate((i, c) => {
    const dt = new DataTransfer();
    document.querySelector(`.card[data-task="${i}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    document.querySelector(`.col[data-col="${c}"] .cards`).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, id, col);
  await drag(mine.id, 'review');
  await page.waitForFunction((i) => document.querySelector(`.card[data-task="${i}"]`)?.closest('.col')?.dataset.col === 'review', { timeout: 8000 }, mine.id);
  check('a Revisión', (await colOf(mine.id)) === 'review');
  await sleep(300);
  const inRev = await inboxN();
  check('el inbox y la 🔔 no suben', inRev.tab === base0.tab && inRev.bell === base0.bell, JSON.stringify([base0, inRev]));
  check('el resumen no cuenta «por revisar»', await page.evaluate(() => !/[1-9]\d* por revisar/.test(document.querySelector('#tab-summary').innerText)));
  await drag(mine.id, 'done');
  await page.waitForFunction((i) => document.querySelector(`.card[data-task="${i}"]`)?.closest('.col')?.dataset.col === 'done', { timeout: 8000 }, mine.id);
  check('a Hecho', (await colOf(mine.id)) === 'done');

  console.log('Filtro «Mías»');
  await page.click('#mine-filter');
  await sleep(200);
  check('solo se ven las humanas', await page.evaluate(() => [...document.querySelectorAll('#board .card')].every((c) => c.querySelector('.human-badge'))));
  await page.click('#mine-filter');

  console.log('Reasignar a un agente');
  await page.select(`.card[data-task="${normal.id}"] select[data-assign]`, ag.id).catch(() => null);
  const sel = await page.$(`.card[data-task="${normal.id}"] select[data-assign]`);
  if (sel) await page.evaluate((i, a) => { const s = document.querySelector(`.card[data-task="${i}"] select[data-assign]`); s.value = a; s.dispatchEvent(new Event('change', { bubbles: true })); }, normal.id, ag.id);
  else await page.evaluate(async (i, a) => { await fetch(`/api/tasks/${i}/assign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: a }) }); }, normal.id, ag.id);
  await page.waitForFunction((i) => !document.querySelector(`.card[data-task="${i}"] .human-badge`), { timeout: 8000 }, normal.id);
  check('la insignia desaparece', !(await badge(normal.id)));
  // FT-194 · modal «Ver la tarea»: «Asignar a…» con «👤 Yo (humano)» y vuelta a un agente
  console.log('Modal: Asignar a… (FT-194)');
  await page.evaluate((i) => document.querySelector(`.card[data-task="${i}"]`).click(), normal.id);
  await page.waitForSelector('#dialog[open] select[data-assign]', { timeout: 8000 });
  const optVals = await page.evaluate(() => [...document.querySelectorAll('#dialog select[data-assign] option')].map((o) => o.value));
  check('el modal ofrece «human»', optVals.includes('human'), optVals.join(','));
  const setSel = (v) => page.evaluate((x) => { const s = document.querySelector('#dialog select[data-assign]'); s.value = x; s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const agentChip = await page.evaluate(() => { const c = document.querySelector('#dialog .who-chip:not(.human)'); return c ? getComputedStyle(c).backgroundColor + '|' + getComputedStyle(c).color : null; });
  await setSel('human');
  await page.waitForSelector('#dialog .who-chip.human', { timeout: 8000 });
  const humanChip = await page.evaluate(() => { const c = document.querySelector('#dialog .who-chip.human'); return getComputedStyle(c).backgroundColor + '|' + getComputedStyle(c).color; });
  check('modal: insignia «asignada a ti» tras elegir human', (await task(normal.id)).assignedAgentId === 'human');
  check('insignia humana con estilo distinto al del agente', !!agentChip && agentChip !== humanChip, `${agentChip} vs ${humanChip}`);
  await setSel(ag.id);
  await page.waitForFunction(() => !document.querySelector('#dialog .who-chip.human'), { timeout: 8000 });
  check('modal: reasignada a un agente, sin insignia humana', (await task(normal.id)).assignedAgentId === ag.id);
  check('sin errores de consola', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  failed++; console.error('✗ ' + (e.stack || e.message));
} finally {
  await browser?.close();
  console.log(failed ? `\n${failed} fallo(s)` : '\nTodo OK');
  process.exit(failed ? 1 : 0);
}
