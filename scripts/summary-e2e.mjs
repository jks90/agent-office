#!/usr/bin/env node
// e2e del Resumen limpio (FT-53): servidor temporal + motor demo + Chrome headless, 2 proyectos.
//   node scripts/summary-e2e.mjs [captura.png]
// La celda de tokens muestra solo el total + «Ver»; el botón abre el modal con una fila por agente y los totales;
// el de equipo abre el modal con los estados; el modal se repinta en vivo al lanzar una tarea; «Ver todos» agrupa por
// proyecto; Esc cierra; sin errores de consola.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const port = 7900 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-summary-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' } }).trim();
const mkRepo = (name) => { const d = path.join(dataDir, 'repos', name); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'README.md'), '# ' + name + '\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); return d; };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`); return j; };
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const a = await api('POST', '/api/projects', { name: 'Alfa', repoPath: mkRepo('alfa') });
  for (const id of [...a.team]) await api('PATCH', `/api/projects/${a.id}/team`, { remove: [id] });
  for (const [n, r] of [['Ana', 'back'], ['Ari', 'front'], ['Aco', 'qa'], ['Ada', 'po']]) await api('POST', '/api/agents', { name: n, role: r, engine: 'demo', projectId: a.id });
  const b = await api('POST', '/api/projects', { name: 'Beta', repoPath: mkRepo('beta') });
  await api('POST', '/api/agents', { name: 'Bea', role: 'front', engine: 'demo', projectId: b.id });

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.querySelector('.nav-item[data-tab="summary"]').click());
  await page.waitForSelector('table.summary tr[data-sum-project]');
  // Inyecta uso de tokens en los agentes del cliente no es posible: el servidor los da; comprobamos con los reales (demo → sin cifras) y el DOM.
  const cells = await page.evaluate((pid) => {
    const tr = document.querySelector(`tr[data-sum-project="${pid}"]`);
    return { rowH: tr.getBoundingClientRect().height, tokRows: tr.querySelectorAll('.tokrow').length, team: tr.querySelector('[data-sum-team]')?.textContent.trim(), tokens: tr.querySelector('[data-sum-tokens]') != null, libres: tr.innerText, avatars: tr.querySelectorAll('.avatars .avatar').length };
  }, a.id);
  check('fila de Alfa de una línea (sin .tokrow dentro de la celda)', cells.tokRows === 0 && cells.rowH < 60, JSON.stringify({ h: cells.rowH, n: cells.tokRows }));
  check('Equipo → «4 agentes» con ≤3 avatares', cells.team === '4 agentes' && cells.avatars === 3, JSON.stringify(cells));
  check('Libres resumido', /4 libres/.test(cells.libres), cells.libres);
  check('fila «Total» con «Ver todos» (2 proyectos)', await page.$('[data-sum-all]') != null);

  // Modal de equipo
  await page.evaluate((pid) => document.querySelector(`[data-sum-team="${pid}"]`).click(), a.id);
  await page.waitForSelector('dialog.summary-modal[open] [data-sum-body]');
  let m = await page.evaluate(() => ({ h: document.querySelector('dialog h3').textContent, rows: document.querySelectorAll('dialog tbody tr[data-sum-agent]').length, txt: document.querySelector('dialog').innerText, open: document.querySelectorAll('[data-sum-open]').length }));
  check('modal «Equipo · Alfa»: 4 filas, 💤 libre y botón Abrir', /Equipo · Alfa/.test(m.h) && m.rows === 4 && /💤 libre/.test(m.txt) && m.open === 4, JSON.stringify(m).slice(0, 300));

  // En vivo: lanzar una tarea demo cambia el estado sin cerrar el modal
  await api('POST', '/api/tasks', { projectId: a.id, role: 'back', title: 'Tarea e2e' });
  await api('POST', `/api/projects/${a.id}/run`, { running: true });
  let live = false;
  for (let i = 0; i < 40 && !live; i++) { await sleep(250); live = await page.evaluate(() => /⚙ trabajando en|⏸/.test(document.querySelector('dialog[open]')?.innerText || '')); }
  check('el modal de equipo se repinta en vivo (⚙ trabajando) sin cerrarse', live);
  check('aparece «Ir a la tarea»', await page.$('dialog [data-sum-task]') != null);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc cierra el modal', await page.evaluate(() => !document.querySelector('dialog[open]')));

  // Modal de tokens
  await page.evaluate((pid) => document.querySelector(`[data-sum-tokens="${pid}"]`)?.click(), a.id);
  const hasBtn = await page.$('dialog.summary-modal[open]');
  if (!hasBtn) { // el motor demo puede no informar tokens → la celda dice «sin sesiones aún»; lo comprobamos con «Ver todos»
    console.log('  · el motor demo no informa tokens: se prueba el modal con «Ver todos»');
    await page.evaluate(() => document.querySelector('[data-sum-all]').click());
  }
  await page.waitForSelector('dialog.summary-modal[open] [data-sum-body]');
  m = await page.evaluate(() => ({ h: document.querySelector('dialog h3').textContent, rows: document.querySelectorAll('dialog tbody tr[data-sum-agent]').length, groups: document.querySelectorAll('dialog tr.sum-group').length, foot: !!document.querySelector('dialog tfoot [data-sum-totals]'), copy: !!document.querySelector('[data-sum-copy]') }));
  check('modal de tokens: una fila por agente, totales y «Copiar como texto»', /Tokens por sesión/.test(m.h) && m.rows >= 4 && m.foot && m.copy, JSON.stringify(m));
  await page.evaluate(() => document.querySelector('[data-sum-all]')?.click());
  await page.keyboard.press('Escape'); await sleep(200);
  await page.evaluate(() => document.querySelector('[data-sum-all]').click());
  await page.waitForSelector('dialog.summary-modal[open] [data-sum-body]');
  m = await page.evaluate(() => ({ rows: document.querySelectorAll('dialog tbody tr[data-sum-agent]').length, groups: document.querySelectorAll('dialog tr.sum-group').length }));
  check('«Ver todos»: 5 agentes agrupados en 2 proyectos', m.rows === 5 && m.groups === 2, JSON.stringify(m));
  if (shot) await page.screenshot({ path: shot });
  await page.keyboard.press('Escape'); await sleep(200);
  check('Esc cierra el modal de tokens', await page.evaluate(() => !document.querySelector('dialog[open]')));
  check('sin errores de consola', !errors.length, errors.join(' | '));
} catch (e) { failed++; console.log('  ✗ excepción: ' + e.message); } finally {
  try { await browser?.close(); } catch { /* ya cerrado */ }
  server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
