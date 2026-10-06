#!/usr/bin/env node
// e2e del EDIFICIO de la oficina 3D (FT-46) y de la navegación edificio ↔ planta (FT-47), sin Claude:
// servidor temporal + Chrome headless (WebGL por SwiftShader).
//
//   node scripts/building-e2e.mjs [captura.png]
//
// Con 3 proyectos (2 con equipo): la Oficina abre en modo edificio; una planta por proyecto CON equipo (los sin equipo no
// salen), orden planta baja = más antiguo, etiqueta «nombre · N trabajando · M en cola» con ⏸ si está parado, hover (cursor
// pointer + resalte), tope de 12 plantas con la «+N» agrupada. Navegación (FT-47): clic en la planta → su sala (transición de
// cámara, miga «Edificio › proyecto», `ao:officeMode`); «🏢 Edificio» y Esc vuelven; el desplegable cambia de planta en `floor`
// y solo resalta en `building`; `app.navigate` del Guide entra en la planta; `officeMode` en `/api/context`; modo recordado
// al recargar; con un solo proyecto con equipo se entra directo a su planta; sin errores de consola.
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
  const state = () => page.evaluate(() => ({
    ds: document.querySelector('#office').dataset.officeMode, dbg: window.aoOffice.debugState(), title: window.aoOffice.title,
    labels: [...document.querySelectorAll('.o3d-floor')].map((e) => e.textContent), activeLabels: [...document.querySelectorAll('.o3d-floor.active')].map((e) => e.textContent),
    pills: document.querySelectorAll('.o3d-pill').length, floorLabelsShown: [...document.querySelectorAll('.o3d-floor')].filter((e) => getComputedStyle(e).display !== 'none').length,
    crumb: document.querySelector('#office-crumb').textContent.trim(), live: document.querySelector('#office-live').textContent,
    select: document.querySelector('#project').value, stored: localStorage.getItem('ao:officeMode'), focused: document.activeElement === document.querySelector('#office'),
  }));
  // Punto del canvas que cae sobre la planta `name` (raycaster del propio office3d) → clic REAL del ratón ahí.
  const floorPoint = (name) => page.evaluate((nm) => {
    const o = window.aoOffice, i = o.floors.findIndex((f) => f.name === nm);
    if (i < 0) return null;
    const r = o.cv.getBoundingClientRect();
    for (let fy = 0.05; fy < 1; fy += 0.02) for (let fx = 0.2; fx < 0.8; fx += 0.02) { const e = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }; if (o.pickFloor(e) === i) return { x: e.clientX, y: e.clientY }; }
    return null;
  }, name);
  const clickFloor = async (name) => { const p = await floorPoint(name); if (!p) throw new Error('no encuentro la planta ' + name + ' en pantalla'); await page.mouse.move(p.x, p.y); await sleep(100); await page.mouse.click(p.x, p.y); };

  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await sleep(4000);
  let st = await state();
  console.log('— FT-46: el edificio');
  check('con 2 proyectos con equipo la Oficina abre en modo edificio (sin ?view=building)', st.ds === 'building' && st.dbg.mode === 'building', st.ds);
  const names = st.dbg.floors.map((f) => f.name);
  check('plantas = Alfa (baja) y Beta (arriba), sin «Vacío»', names.join(',') === 'Alfa,Beta', names.join(','));
  check('Beta: 1 en cola', st.dbg.floors[1]?.queued === 1, JSON.stringify(st.dbg.floors[1]));
  check('etiquetas HTML por planta', st.labels.length === 2 && /Beta · 0 trabajando · 1 en cola/.test(st.labels[1]), st.labels.join(' | '));
  check('⏸ en proyectos parados', st.labels.every((l) => l.startsWith('⏸')), st.labels.join(' | '));
  check('sin personajes ni pills en modo edificio', st.pills === 0, String(st.pills));
  check('miga «🏢 Edificio» y resumen de la empresa en el pie', st.crumb === '🏢 Edificio' && /2 proyectos con equipo/.test(st.live), `${st.crumb} / ${st.live}`);
  check('la planta del proyecto del desplegable va resaltada', st.activeLabels.length === 1 && st.activeLabels[0].includes(st.select === a.id ? 'Alfa' : 'Beta'), JSON.stringify(st.activeLabels));

  // Hover con el ratón de verdad sobre la planta Beta.
  const pb = await floorPoint('Beta');
  check('la planta Beta se puede apuntar con el raycaster', !!pb, JSON.stringify(pb));
  await page.mouse.move(pb.x, pb.y);
  await sleep(200);
  const hov = await page.evaluate(() => ({ cursor: document.querySelector('#office').style.cursor, hover: window.aoOffice.hoverFloor, hl: document.querySelectorAll('.o3d-floor.hover').length }));
  check('hover sobre una planta → cursor pointer, planta y etiqueta resaltadas', hov.cursor === 'pointer' && hov.hover === 1 && hov.hl === 1, JSON.stringify(hov));
  const box = await (await page.$('#office')).boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  const off = await page.evaluate(() => ({ cursor: document.querySelector('#office').style.cursor, hover: window.aoOffice.hoverFloor }));
  check('fuera del edificio → sin hover', off.hover === -1 && off.cursor !== 'pointer', JSON.stringify(off));

  console.log('— FT-47: entrar y salir de una planta');
  await clickFloor('Beta');
  const anim = await page.evaluate(() => window.aoOffice.debugState().animating);
  await sleep(700);
  st = await state();
  check('clic en la planta Beta → modo floor con el proyecto Beta', st.ds === 'floor' && st.select === b.id && st.title === 'Beta', `${st.ds} ${st.title}`);
  check('transición de cámara al entrar (≤ 400 ms) y ya terminada', anim === true && st.dbg.animating === false, `${anim}/${st.dbg.animating}`);
  check('miga «Edificio › Beta» con el botón y etiquetas de planta ocultas', /Edificio\s*›\s*Beta/.test(st.crumb) && st.floorLabelsShown === 0, `${st.crumb} / ${st.floorLabelsShown}`);
  check('modo recordado en localStorage ao:officeMode=floor', st.stored === 'floor', String(st.stored));
  check('el canvas queda enfocado tras el clic', st.focused);
  if (shot) await page.screenshot({ path: shot });
  await page.click('#office-crumb button');
  await sleep(600);
  st = await state();
  check('«🏢 Edificio» vuelve al edificio y lo recuerda', st.ds === 'building' && st.stored === 'building' && st.crumb === '🏢 Edificio', `${st.ds} ${st.stored}`);
  await clickFloor('Alfa');
  await sleep(600);
  st = await state();
  check('clic en Alfa → su planta', st.ds === 'floor' && st.select === a.id, `${st.ds} ${st.select}`);
  await page.keyboard.press('Escape');
  await sleep(600);
  st = await state();
  check('Esc con el canvas enfocado vuelve al edificio', st.ds === 'building', st.ds);

  console.log('— FT-47: desplegable y Guide');
  await page.select('#project', b.id);
  await sleep(300);
  st = await state();
  check('en el edificio, cambiar el proyecto solo resalta su planta', st.ds === 'building' && st.activeLabels.length === 1 && st.activeLabels[0].includes('Beta'), `${st.ds} ${JSON.stringify(st.activeLabels)}`);
  await clickFloor('Beta');
  await sleep(500);
  await page.select('#project', a.id);
  await sleep(300);
  st = await state();
  check('en una planta, cambiar el proyecto cambia de planta', st.ds === 'floor' && st.title === 'Alfa', `${st.ds} ${st.title}`);
  await page.click('#office-crumb button');
  await sleep(500);
  await api('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'office', projectId: 'Beta' } });
  await sleep(700);
  st = await state();
  check('app.navigate {view:office, projectId} del Guide entra en la planta de Beta', st.ds === 'floor' && st.select === b.id && st.title === 'Beta', `${st.ds} ${st.title}`);
  const ctx = await api('GET', '/api/context');
  check('/api/context lleva officeMode=floor (FT-2)', ctx.officeMode === 'floor' && ctx.view === 'office', JSON.stringify({ officeMode: ctx.officeMode, view: ctx.view }));
  await api('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'tasks' } });
  await sleep(500);
  await api('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'office' } });
  await sleep(700);
  st = await state();
  check('app.navigate {view:office} sin proyecto respeta el modo recordado (floor)', st.ds === 'floor', st.ds);
  await page.click('#office-crumb button');
  await sleep(500);
  check('/api/context pasa a officeMode=building', (await api('GET', '/api/context')).officeMode === 'building');

  console.log('— FT-47: persistencia y un solo proyecto');
  await clickFloor('Alfa');
  await sleep(500);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('al recargar se recuerda el modo (floor) y el proyecto', st.ds === 'floor' && st.title === 'Alfa', `${st.ds} ${st.title}`);
  await page.click('#office-crumb button');
  await sleep(500);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('al recargar se recuerda el modo (building)', st.ds === 'building', st.ds);
  await page.click('.nav-item[data-tab="tasks"]');
  await page.click('.nav-item[data-tab="office"]');
  await sleep(400);
  check('ir a Tareas y volver a Oficina mantiene el edificio', (await state()).ds === 'building');

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

  // Solo UN proyecto con equipo (Beta se queda sin Bea): al abrir la Oficina se entra directo a la planta de Alfa.
  const bea = (await api('GET', '/api/state')).agents.find((x) => x.name === 'Bea');
  await api('PATCH', `/api/projects/${b.id}/team`, { remove: [bea.id] });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('con un solo proyecto con equipo se entra directo a su planta (aunque se recordara el edificio)', st.ds === 'floor' && st.title === 'Alfa' && st.stored === 'building', `${st.ds} ${st.title} ${st.stored}`);
  check('…y el botón Edificio sigue disponible', /Edificio/.test(st.crumb) && (await page.$('#office-crumb button')) !== null, st.crumb);
  await page.click('#office-crumb button');
  await sleep(500);
  check('…y lleva al edificio de una planta', (await state()).ds === 'building');
  await sleep(1000);
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) { failed++; console.log('✗ ' + e.message); }
finally { if (browser) await browser.close().catch(() => {}); server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK');
process.exit(failed ? 1 : 0);
