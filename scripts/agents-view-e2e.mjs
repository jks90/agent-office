#!/usr/bin/env node
// FT-209 (QA de FT-206): vista Agentes — orden Plantilla/Repositorios/Memoria, plegado por defecto, botones de cabecera,
// espaciado; captura en /tmp. Servidor temporal con AO_DATA_DIR propio. Uso: node scripts/agents-view-e2e.mjs [captura.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = path.resolve(process.argv[2] || '/tmp/ft209-agentes.png');
const port = 7600 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft209-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No hay Chrome (AO_CHROME)'); process.exit(2); }
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
let fails = 0;
const check = (ok, msg, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  let proj = (await api('GET', '/api/state')).projects?.[0];
  if (!proj) proj = await api('POST', '/api/projects', { name: 'Demo FT-209' });
  if (!proj.team?.length) for (const [name, role] of [['Olga', 'po'], ['Bruno', 'back']]) await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: proj.id });
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('error: ' + m.text()); });
  await page.goto(`${base}/?view=agents`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('ao:collapsed'));
  await page.goto(`${base}/?view=agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-agents:not([hidden]) #team', { timeout: 15000 });
  await sleep(2500);
  const info = () => page.evaluate(() => {
    const out = {};
    for (const s of ['team', 'repos', 'cmemory']) {
      const h = document.querySelector(`[data-section="${s}"]`), b = h.nextElementSibling, r = h.getBoundingClientRect(), br = b.getBoundingClientRect();
      out[s] = { top: Math.round(r.top), collapsed: h.classList.contains('collapsed'), bodyVisible: getComputedStyle(b).display !== 'none' && br.height > 0, bodyH: Math.round(br.height), bodyBottom: Math.round(br.bottom), headMarginTop: getComputedStyle(h).marginTop };
    }
    return out;
  });
  const a = await info();
  console.log('estado inicial', JSON.stringify(a));
  check(a.team.top < a.repos.top && a.repos.top < a.cmemory.top, '1) orden Plantilla → Repositorios → Memoria', `tops ${a.team.top}/${a.repos.top}/${a.cmemory.top}`);
  check(a.team.bodyVisible && !a.team.collapsed, '2a) Plantilla abierta por defecto');
  check(a.repos.collapsed && !a.repos.bodyVisible, '2b) Repositorios plegada por defecto');
  check(a.cmemory.collapsed && !a.cmemory.bodyVisible, '2c) Memoria plegada por defecto');
  await page.screenshot({ path: shot, fullPage: true });
  console.log('captura (estado inicial):', shot);
  // plegar/desplegar cada sección (clic en la cabecera, fuera de botones)
  for (const s of ['team', 'repos', 'cmemory']) {
    const before = (await info())[s].collapsed;
    for (let k = 0; k < 2; k++) await page.evaluate((sec) => document.querySelector(`[data-section="${sec}"] h3`).click(), s);
    await sleep(150);
    const mid = (await info())[s];
    check(mid.collapsed === before, `2d) ${s}: plegar y desplegar vuelve al estado inicial`);
    await page.evaluate((sec) => document.querySelector(`[data-section="${sec}"] h3`).click(), s);
    const t = (await info())[s];
    check(t.collapsed !== before && t.bodyVisible === !t.collapsed, `2d) ${s}: un clic alterna`, `collapsed=${t.collapsed}`);
    await page.evaluate((sec) => document.querySelector(`[data-section="${sec}"] h3`).click(), s);
  }
  // despliega las tres para medir espaciado
  await page.evaluate(() => { localStorage.setItem('ao:collapsed', '{}'); });
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
  await page.evaluate(() => document.querySelectorAll('[data-section].collapsed h3').forEach((h) => h.click()));
  await sleep(300);
  const open = await info();
  const gaps = [open.repos.top - open.team.bodyBottom, open.cmemory.top - open.repos.bodyBottom];
  console.log('huecos entre secciones (px)', gaps.join(' / '), '· margin-top cabeceras', open.repos.headMarginTop);
  check(gaps.every((g) => g >= 8 && g <= 80), '4) espaciado entre secciones razonable (8–80 px)');
  await page.screenshot({ path: shot.replace(/\.png$/, '-abiertas.png'), fullPage: true });
  console.log('captura (todas abiertas):', shot.replace(/\.png$/, '-abiertas.png'));
  // 3) botones
  await page.evaluate(() => document.querySelector('[data-action="add-repo"]').click()); await sleep(400);
  const dlg1 = await page.evaluate(() => document.querySelector('dialog[open] h3, .modal h3, dialog h3')?.textContent || '');
  check(/repositorio/i.test(dlg1), '3a) «＋ Añadir repo» abre su formulario', dlg1);
  await page.keyboard.press('Escape'); await sleep(200);
  await page.evaluate(() => document.querySelector('dialog[open]')?.close?.());
  const reqs = [];
  page.on('request', (r) => reqs.push(r.method() + ' ' + new URL(r.url()).pathname));
  await page.evaluate(() => document.querySelector('[data-action="reload-cmemory"]').click()); await sleep(800);
  check(reqs.some((r) => /GET \/api\/.*(claude-memory|cmem)/.test(r)), '3b) «↻» lanza la petición de memoria', reqs.filter((r) => /memory|cmem/.test(r)).join(', ') || reqs.join(', '));
  await page.evaluate(() => document.querySelector('[data-action="hire"]').click()); await sleep(400);
  const dlg2 = await page.evaluate(() => document.querySelector('dialog[open] h3, .modal h3, dialog h3')?.textContent || '');
  check(/Contratar/i.test(dlg2), '3c) «＋ Contratar» abre su formulario', dlg2);
  await page.evaluate(() => document.querySelector('dialog[open]')?.close?.()); await sleep(200);
  await page.evaluate(() => document.querySelector('[data-action="publish-team"]').click()); await sleep(800);
  const dlg3 = await page.evaluate(() => (document.querySelector('dialog[open]')?.textContent || document.querySelector('.toast')?.textContent || '').slice(0, 120));
  check(!!dlg3 || reqs.some((r) => /marketplace|publish/.test(r)), '3d) «⬆ Publicar equipo» responde (sin publicar)', dlg3 || reqs.filter((r) => /marketplace|publish/.test(r)).join(', '));
  check(errors.length === 0, '2e) sin errores en la consola', errors.join(' | '));
} catch (e) { console.error('✗ excepción', e); fails++; }
finally { try { await browser?.close(); } catch {} server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(fails ? `\n${fails} checks KO` : '\ntodo OK');
process.exit(fails ? 1 : 0);
