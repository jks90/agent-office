#!/usr/bin/env node
// e2e del modo EDIFICIO de la oficina 3D (FT-46), sin Claude: servidor temporal + Chrome headless (WebGL por SwiftShader).
//
//   node scripts/building-e2e.mjs [captura.png]
//
// Comprueba `?view=building` → canvas.dataset.officeMode y aoOffice.debugState(); una planta por proyecto CON equipo
// (los sin equipo no salen), orden planta baja = más antiguo, etiqueta «nombre · N trabajando · M en cola» con ⏸ si está
// parado, hover (cursor pointer + resalte) y clic (onFloorClick), tope de 12 plantas con la «+N» agrupada, vuelta a `floor`
// y que no haya errores de consola.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const port = 7800 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-building-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`); return j; };
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const a = await api('POST', '/api/projects', { name: 'Alfa' });
  if (!a.team?.length) await api('POST', '/api/agents', { name: 'Ana', role: 'back', engine: 'demo', projectId: a.id });
  const b = await api('POST', '/api/projects', { name: 'Beta' });
  await api('POST', '/api/agents', { name: 'Bea', role: 'front', engine: 'demo', projectId: b.id });
  await api('POST', '/api/tasks', { projectId: b.id, role: 'front', title: 'Una tarea en cola' });
  await api('POST', '/api/projects', { name: 'Vacío' });

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/?view=building', { waitUntil: 'networkidle2' });
  await sleep(4000);
  const st = await page.evaluate(() => ({ ds: document.querySelector('#office').dataset.officeMode, dbg: window.aoOffice.debugState(), labels: [...document.querySelectorAll('.o3d-floor')].map((e) => e.textContent), canvasLabels: document.querySelectorAll('.o3d-pill').length }));
  check('dataset.officeMode = building', st.ds === 'building', st.ds);
  check('debugState().mode = building', st.dbg.mode === 'building');
  const names = st.dbg.floors.map((f) => f.name);
  check('plantas = Alfa (baja) y Beta (arriba), sin «Vacío»', names.join(',') === 'Alfa,Beta', names.join(','));
  check('Beta: 1 en cola', st.dbg.floors[1]?.queued === 1, JSON.stringify(st.dbg.floors[1]));
  check('etiquetas HTML por planta', st.labels.length === 2 && /Beta · 0 trabajando · 1 en cola/.test(st.labels[1]), st.labels.join(' | '));
  check('⏸ en proyectos parados', st.labels.every((l) => l.startsWith('⏸')), st.labels.join(' | '));
  check('sin personajes ni pills en modo edificio', st.canvasLabels === 0, String(st.canvasLabels));

  // Hover: buscar un punto del canvas que caiga sobre una planta (barrido por la mitad inferior).
  const box = await (await page.$('#office')).boundingBox();
  let hovered = null;
  for (let fy = 0.55; fy < 0.95 && !hovered; fy += 0.05) for (let fx = 0.3; fx < 0.7; fx += 0.05) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    const r = await page.evaluate(() => ({ cursor: document.querySelector('#office').style.cursor, hover: window.aoOffice.hoverFloor }));
    if (r.cursor === 'pointer') { hovered = { ...r, fx, fy }; break; }
  }
  check('hover sobre una planta → cursor pointer y planta resaltada', !!hovered && hovered.hover >= 0, JSON.stringify(hovered));
  if (hovered) {
    await sleep(200); // las etiquetas se recolocan en el siguiente frame
    const hl = await page.evaluate(() => [...document.querySelectorAll('.o3d-floor.hover')].length);
    check('etiqueta de la planta con clase hover', hl === 1, String(hl));
    await page.evaluate(() => { window.__clicked = null; window.aoOffice.onFloorClick = (id) => { window.__clicked = id; }; });
    await page.mouse.click(box.x + box.width * hovered.fx, box.y + box.height * hovered.fy);
    const clicked = await page.evaluate(() => window.__clicked);
    check('clic dispara onFloorClick con el projectId (gancho para FT-47)', [a.id, b.id].includes(clicked), String(clicked));
    if (shot) await page.screenshot({ path: shot });
  }
  await page.mouse.move(box.x + 5, box.y + 5);
  const off = await page.evaluate(() => ({ cursor: document.querySelector('#office').style.cursor, hover: window.aoOffice.hoverFloor }));
  check('fuera del edificio → sin hover', off.hover === -1 && off.cursor !== 'pointer', JSON.stringify(off));

  // Más de 12 proyectos con equipo → 11 + planta «+N» que no se abre.
  const many = await page.evaluate(() => {
    const projects = []; const agents = [];
    for (let i = 0; i < 15; i++) { agents.push({ id: 'ag' + i, name: 'A' + i, role: 'back', status: i % 2 ? 'working' : 'idle' }); projects.push({ id: 'p' + i, name: 'P' + i, team: ['ag' + i], running: true, createdAt: 1000 + i }); }
    projects.push({ id: 'none', name: 'Sin equipo', team: [], running: true, createdAt: 1 });
    window.aoOffice.update({ agents: [], tasks: [], roles: {}, projects, allAgents: agents, allTasks: [{ id: 't1', projectId: 'p14', status: 'review' }] });
    const d = window.aoOffice.debugState();
    return { n: d.floors.length, last: d.floors[d.floors.length - 1], first: d.floors[0].name, labels: document.querySelectorAll('.o3d-floor').length, grouped: document.querySelectorAll('.o3d-floor.grouped').length };
  });
  check('tope de 12 plantas', many.n === 12, String(many.n));
  check('planta baja = más antiguo (P0)', many.first === 'P0', many.first);
  check('última planta «+4 proyectos» agrupa trabajando/revisión', many.last.projectId === null && many.last.name === '+4 proyectos' && many.last.working === 2 && many.last.review === 1, JSON.stringify(many.last));
  check('12 etiquetas, 1 agrupada', many.labels === 12 && many.grouped === 1, `${many.labels}/${many.grouped}`);

  // Vuelta a la sala.
  const back = await page.evaluate(() => { window.aoOffice.setMode('floor'); return { ds: document.querySelector('#office').dataset.officeMode, mode: window.aoOffice.debugState().mode, floorsVisible: window.aoOffice.building.visible, room: window.aoOffice.room.visible }; });
  check('setMode(floor) → dataset y grupos', back.ds === 'floor' && back.mode === 'floor' && !back.floorsVisible && back.room, JSON.stringify(back));
  await sleep(1500);
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) { failed++; console.log('✗ ' + e.message); }
finally { if (browser) await browser.close().catch(() => {}); server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK');
process.exit(failed ? 1 : 0);
