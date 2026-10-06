#!/usr/bin/env node
// Columna «Descartada»: una tarea que no se va a hacer pasa a `discarded` (desde Backlog, Por hacer o Fallida), cuenta como
// dependencia resuelta, no se puede mover a «Hecho» a mano y se recupera al Backlog. Servidor temporal + Chrome headless.
//   node scripts/discarded-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 7600 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-discarded-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' } }).trim();
const repo = path.join(dataDir, 'repos', 'r'); fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README.md'), '# r\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const raw = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const api = async (...a) => { const r = await raw(...a); if (r.status >= 400) throw new Error(`${a[0]} ${a[1]} → ${r.status} ${r.j.error || ''}`); return r.j; };
const task = async (id) => (await api('GET', '/api/state')).tasks.find((t) => t.id === id);
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const p = await api('POST', '/api/projects', { name: 'Desc', repoPath: repo });
  for (const id of [...p.team]) await api('PATCH', `/api/projects/${p.id}/team`, { remove: [id] }); // sin agentes: nada arranca solo
  const dup = await api('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'Duplicada', status: 'backlog' });
  const dep = await api('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'Depende de la duplicada', status: 'backlog', dependsOn: [dup.id] });
  check('antes: la dependiente espera a la duplicada', ((await task(dep.id)).waitingOn || []).some((w) => w.id === dup.id));
  await api('PATCH', `/api/tasks/${dup.id}`, { status: 'discarded' });
  check('Backlog → Descartada', (await task(dup.id)).status === 'discarded');
  check('una dependencia descartada cuenta como resuelta', !((await task(dep.id)).waitingOn || []).length, JSON.stringify((await task(dep.id)).waitingOn));
  const todo = await api('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'En Por hacer', status: 'todo' });
  await api('PATCH', `/api/tasks/${todo.id}`, { status: 'discarded' });
  check('Por hacer → Descartada', (await task(todo.id)).status === 'discarded');
  const toDone = await raw('PATCH', `/api/tasks/${dup.id}`, { status: 'done' });
  check('Descartada → Hecho a mano sigue prohibido (409)', toDone.status === 409, String(toDone.status));
  await api('PATCH', `/api/tasks/${todo.id}`, { status: 'backlog' });
  check('Descartada → Backlog (recuperar)', (await task(todo.id)).status === 'backlog');

  if (!chrome) { console.log('  · sin Chrome: me salto la parte de interfaz'); } else {
    browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(base + '/#tasks', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('[data-view="tasks"], [data-nav="tasks"], nav [href="#tasks"]')?.click());
    await page.waitForSelector('#board .col[data-col="discarded"]', { timeout: 15000 });
    const ui = await page.evaluate(() => ({
      cols: [...document.querySelectorAll('#board .col')].map((c) => c.dataset.col),
      label: document.querySelector('#board .col[data-col="discarded"] h4')?.textContent,
      cards: document.querySelectorAll('#board .col[data-col="discarded"] .card').length,
      recover: !!document.querySelector('#board .col[data-col="discarded"] .card [data-park]'),
      discardBtn: !!document.querySelector('#board .col[data-col="backlog"] .card [data-discard]') || !!document.querySelector('#board .col[data-col="backlog"] .card'),
    }));
    check('el tablero tiene la columna «Descartada» la última', ui.cols.at(-1) === 'discarded' && /Descartada/.test(ui.label || ''), JSON.stringify(ui));
    check('la tarjeta descartada está en su columna con «↩ Recuperar»', ui.cards === 1 && ui.recover, JSON.stringify(ui));
    check('sin errores de página', errors.length === 0, errors.join(' | '));
  }
} catch (e) { console.error('ERROR', e); failed++; }
finally { await browser?.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK'); process.exit(failed ? 1 : 0); }
