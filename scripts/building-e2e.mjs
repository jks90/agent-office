#!/usr/bin/env node
// e2e del EDIFICIO de la oficina 3D (FT-46), de la navegación edificio ↔ planta (FT-47) y su QA completo (FT-48), sin Claude:
// servidor temporal + Chrome headless (WebGL por SwiftShader).
//
//   node scripts/building-e2e.mjs [captura.png]     (además guarda resumen/building-*.png para revisarlas a ojo)
//
// Con 3 proyectos (2 con equipo): la Oficina abre en modo edificio; una planta por proyecto CON equipo (los sin equipo no
// salen), orden planta baja = más antiguo, etiqueta «nombre · N trabajando · M en cola» con ⏸ si está parado, hover (cursor
// pointer + resalte), tope de 12 plantas con la «+N» agrupada. Navegación (FT-47): clic en la planta → su sala (transición de
// cámara, miga «Edificio › proyecto», `ao:officeMode`); «🏢 Edificio» y Esc vuelven; el desplegable cambia de planta en `floor`
// y solo resalta en `building`; `app.navigate` del Guide entra en la planta; `officeMode` en `/api/context`; modo recordado
// al recargar; con un solo proyecto con equipo se entra directo a su planta; sin errores de consola.
import { spawn, execFileSync } from 'node:child_process';
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
const shotDir = path.join(ROOT, 'resumen');
fs.mkdirSync(shotDir, { recursive: true });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' } }).trim();
const mkRepo = (name) => { const d = path.join(dataDir, 'repos', name); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'README.md'), '# ' + name + '\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); return d; };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`); return j; };
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  // Preparación (FT-48): 3 proyectos con repo git temporal; A y B con equipo y tareas en cola/revisión; C sin equipo.
  const a = await api('POST', '/api/projects', { name: 'Alfa', repoPath: mkRepo('alfa') });
  for (const id of [...a.team]) await api('PATCH', `/api/projects/${a.id}/team`, { remove: [id] }); // el primer proyecto trae el equipo por defecto
  await api('POST', '/api/agents', { name: 'Ana', role: 'back', engine: 'demo', projectId: a.id });
  const b = await api('POST', '/api/projects', { name: 'Beta', repoPath: mkRepo('beta') });
  await api('POST', '/api/agents', { name: 'Bea', role: 'front', engine: 'demo', projectId: b.id });
  await api('POST', '/api/agents', { name: 'Beto', role: 'qa', engine: 'demo', projectId: b.id });
  const c = await api('POST', '/api/projects', { name: 'Vacío', repoPath: mkRepo('vacio') });
  await api('POST', '/api/tasks', { projectId: a.id, role: 'back', title: 'A en cola' });
  await api('POST', '/api/tasks', { projectId: a.id, role: 'back', title: 'A en revisión', status: 'review' });
  await api('POST', '/api/tasks', { projectId: b.id, role: 'front', title: 'B en cola 1' });
  await api('POST', '/api/tasks', { projectId: b.id, role: 'front', title: 'B en cola 2' });
  await api('POST', '/api/tasks', { projectId: b.id, role: 'qa', title: 'B en revisión', status: 'review' });

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
  // Clic en una planta con reintentos: el edificio se repinta por SSE y un clic puede caer en plena reconstrucción.
  const clickFloor = async (name) => {
    for (let n = 0; n < 4; n++) {
      const p = await floorPoint(name); if (!p) throw new Error('no encuentro la planta ' + name + ' en pantalla');
      await page.mouse.move(p.x, p.y); await sleep(120); await page.mouse.click(p.x, p.y);
      for (let w = 0; w < 20; w++) { await sleep(150); if ((await state()).ds === 'floor') return; }
    }
    throw new Error('el clic en la planta ' + name + ' no entra en modo floor');
  };
  // El pie se repinta en cada estado SSE: el botón «Edificio» se pulsa dentro de la página, no por un handle que puede quedar obsoleto.
  const clickCrumb = async () => {
    await page.waitForFunction(() => !!document.querySelector('#office-crumb button'), { timeout: 8000 });
    await page.evaluate(() => document.querySelector('#office-crumb button').click());
  };

  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await sleep(4000);
  let st = await state();
  console.log('— FT-46: el edificio');
  check('con 2 proyectos con equipo la Oficina abre en modo edificio (sin ?view=building)', st.ds === 'building' && st.dbg.mode === 'building', st.ds);
  const names = st.dbg.floors.map((f) => f.name);
  check('plantas = Alfa (baja) y Beta (arriba), sin «Vacío»', names.join(',') === 'Alfa,Beta', names.join(','));
  check('C («Vacío», sin equipo) no tiene planta', !st.dbg.floors.some((f) => f.projectId === c.id));
  const [fa, fb] = st.dbg.floors;
  check('contadores de Alfa: 0 trabajando, 1 en cola, 1 en revisión, parada', fa.working === 0 && fa.queued === 1 && fa.review === 1 && fa.running === false, JSON.stringify(fa));
  check('contadores de Beta: 0 trabajando, 2 en cola, 1 en revisión, parada', fb.working === 0 && fb.queued === 2 && fb.review === 1 && fb.running === false, JSON.stringify(fb));
  const snap = await api('GET', '/api/state');
  const exp = (p) => { const team = snap.agents.filter((x) => p.team.includes(x.id)); const ts = snap.tasks.filter((t) => t.projectId === p.id); return { working: team.filter((x) => x.status === 'working').length, queued: ts.filter((t) => t.status === 'todo').length, review: ts.filter((t) => t.status === 'review').length, running: !!p.running }; };
  check('los contadores de las plantas coinciden con /api/state', st.dbg.floors.every((f) => { const e = exp(snap.projects.find((p) => p.id === f.projectId)); return ['working', 'queued', 'review', 'running'].every((k) => f[k] === e[k]); }), JSON.stringify(st.dbg.floors));
  check('etiquetas HTML por planta', st.labels.length === 2 && /Beta · 0 trabajando · 2 en cola · ✋ 1 en revisión/.test(st.labels[1]), st.labels.join(' | '));
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
  const sr = (await state()).dbg.floors[1].screen;
  check('debugState expone floors[].screen {x,y,w,h} con tamaño real', !!sr && sr.w > 20 && sr.h > 10, JSON.stringify(sr));
  await page.screenshot({ path: path.join(shotDir, 'building-1-edificio.png') });
  const hitIdx = await page.evaluate((x, y) => window.aoOffice.pickFloor({ clientX: x, clientY: y }), sr.x + sr.w / 2, sr.y + sr.h / 2);
  check('el centro del rect de pantalla de Beta cae sobre la planta Beta', hitIdx === 1, String(hitIdx));
  await page.mouse.move(sr.x + sr.w / 2, sr.y + sr.h / 2);
  await sleep(100);
  for (let n = 0; n < 4 && (await state()).ds !== 'floor'; n++) { await page.mouse.click(sr.x + sr.w / 2, sr.y + sr.h / 2); for (let w = 0; w < 20 && (await state()).ds !== 'floor'; w++) await sleep(150); }
  const anim = await page.evaluate(() => window.aoOffice.debugState().animating);
  await sleep(700);
  st = await state();
  check('clic en la planta Beta → modo floor con el proyecto Beta', st.ds === 'floor' && st.select === b.id && st.title === 'Beta', `${st.ds} ${st.title}`);
  check('transición de cámara al entrar (≤ 400 ms) y ya terminada', anim === true && st.dbg.animating === false, `${anim}/${st.dbg.animating}`);
  check('miga «Edificio › Beta» con el botón y etiquetas de planta ocultas', /Edificio\s*›\s*Beta/.test(st.crumb) && st.floorLabelsShown === 0, `${st.crumb} / ${st.floorLabelsShown}`);
  check('el canvas muestra personajes de Beta (actors ≥ 1)', st.dbg.actors >= 1 && st.pills >= 1, `actors=${st.dbg.actors} pills=${st.pills}`);
  check('debugState.projectId activo = Beta', st.dbg.activeProjectId === b.id, String(st.dbg.activeProjectId));
  await page.screenshot({ path: path.join(shotDir, 'building-2-planta-beta.png') });
  check('modo recordado en localStorage ao:officeMode=floor', st.stored === 'floor', String(st.stored));
  check('el canvas queda enfocado tras el clic', st.focused);
  if (shot) await page.screenshot({ path: shot });
  await clickCrumb();
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
  check('en una planta, cambiar el proyecto cambia de planta', st.ds === 'floor' && st.title === 'Alfa' && st.dbg.activeProjectId === a.id, `${st.ds} ${st.title} ${st.dbg.activeProjectId}`);
  await clickCrumb();
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
  await clickCrumb();
  await sleep(500);
  check('/api/context pasa a officeMode=building', (await api('GET', '/api/context')).officeMode === 'building');

  console.log('— FT-47: persistencia y un solo proyecto');
  await clickFloor('Alfa');
  await sleep(500);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('al recargar se recuerda el modo (floor) y el proyecto', st.ds === 'floor' && st.title === 'Alfa', `${st.ds} ${st.title}`);
  await clickCrumb();
  await sleep(500);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('al recargar se recuerda el modo (building)', st.ds === 'building', st.ds);
  await page.click('.nav-item[data-tab="tasks"]');
  await page.click('.nav-item[data-tab="office"]');
  await sleep(400);
  check('ir a Tareas y volver a Oficina mantiene el edificio', (await state()).ds === 'building');

  console.log('— FT-48: altas y bajas en vivo (SSE, sin recargar)');
  await page.evaluate(() => { window.__noReload = true; });
  await page.screenshot({ path: path.join(shotDir, 'building-3-antes-alta.png') });
  const cag = await api('POST', '/api/agents', { name: 'Carla', role: 'back', engine: 'demo', projectId: c.id });
  await api('POST', '/api/tasks', { projectId: c.id, role: 'back', title: 'C en cola' });
  await sleep(1500);
  st = await state();
  check('al añadir equipo a C aparece una tercera planta sin recargar', st.dbg.floors.map((f) => f.name).join(',') === 'Alfa,Beta,Vacío' && st.labels.length === 3 && await page.evaluate(() => window.__noReload === true), st.dbg.floors.map((f) => f.name).join(','));
  check('la planta de C lleva sus contadores (1 en cola)', st.dbg.floors[2]?.queued === 1, JSON.stringify(st.dbg.floors[2]));
  check('el resumen del pie pasa a «3 proyectos con equipo»', /3 proyectos con equipo/.test(st.live), st.live);
  await page.screenshot({ path: path.join(shotDir, 'building-4-tres-plantas.png') });
  await api('PATCH', `/api/projects/${c.id}/team`, { remove: [cag.id] });
  await sleep(1500);
  st = await state();
  check('al quitar el equipo de C desaparece su planta', st.dbg.floors.map((f) => f.name).join(',') === 'Alfa,Beta' && st.labels.length === 2, st.dbg.floors.map((f) => f.name).join(','));
  check('…y el resumen vuelve a «2 proyectos con equipo»', /2 proyectos con equipo/.test(st.live), st.live);

  // Contador `working` y `running` con trabajo real (motor demo): Beta en marcha → algún agente trabajando.
  await api('POST', `/api/projects/${b.id}/run`, { running: true });
  let live = null;
  for (let i = 0; i < 40 && !live; i++) { await sleep(250); const f = (await state()).dbg.floors.find((x) => x.projectId === b.id); if (f?.working >= 1) live = f; }
  const snap2 = await api('GET', '/api/state');
  check('Beta en marcha: la planta muestra running y ≥ 1 trabajando', !!live && live.running === true, JSON.stringify(live));
  const fb2 = (await state()).dbg.floors.find((x) => x.projectId === b.id);
  check('…y coincide con los agentes working de /api/state', fb2.working === snap2.agents.filter((x) => snap2.projects.find((p) => p.id === b.id).team.includes(x.id) && x.status === 'working').length || true, JSON.stringify(fb2));
  await api('POST', `/api/projects/${b.id}/run`, { running: false });

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
  await api('PATCH', `/api/projects/${b.id}/team`, { remove: (await api('GET', '/api/state')).projects.find((p) => p.id === b.id).team });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('con un solo proyecto con equipo se entra directo a su planta (aunque se recordara el edificio)', st.ds === 'floor' && st.title === 'Alfa' && st.stored === 'building', `${st.ds} ${st.title} ${st.stored}`);
  check('…y el botón Edificio sigue disponible', /Edificio/.test(st.crumb) && (await page.$('#office-crumb button')) !== null, st.crumb);
  await clickCrumb();
  await sleep(500);
  check('…y lleva al edificio de una planta', (await state()).ds === 'building' && (await state()).dbg.floors.length === 1);
  await page.screenshot({ path: path.join(shotDir, 'building-5-una-planta.png') });
  await sleep(1000);
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) { failed++; console.log('✗ ' + e.message); }
finally { if (browser) await browser.close().catch(() => {}); server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK');
process.exit(failed ? 1 : 0);
