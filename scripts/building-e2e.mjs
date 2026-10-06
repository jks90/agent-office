#!/usr/bin/env node
// e2e del EDIFICIO de la oficina 3D (FT-46/FT-70), de la navegación edificio ↔ planta (FT-47) y su QA completo (FT-48), sin Claude:
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
    labels: [...document.querySelectorAll('.o3d-floor')].map((e) => e.title || e.textContent), activeLabels: [...document.querySelectorAll('.o3d-floor.active')].map((e) => e.title || e.textContent),
    pills: document.querySelectorAll('.o3d-pill').length, floorLabelsShown: [...document.querySelectorAll('.o3d-floor')].filter((e) => getComputedStyle(e).display !== 'none').length,
    crumb: document.querySelector('#office-crumb').textContent.trim(), live: document.querySelector('#office-live').textContent,
    select: document.querySelector('#project').value, stored: localStorage.getItem('ao:officeMode'), focused: document.activeElement === document.querySelector('#office'),
    drawerHidden: document.querySelector('#drawer').hidden, drawerText: document.querySelector('#drawer').textContent,
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
  const agentPoint = (id) => page.evaluate((agentId) => {
    const o = window.aoOffice, a = o.actors.get(agentId);
    if (!a?.group.visible) return null;
    const p = o.project(a.x, 0.8, a.z), r = o.cv.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, id);

  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await sleep(4000);
  let st = await state();
  console.log('— FT-46: el edificio');
  check('con 2 proyectos con equipo la Oficina abre en modo edificio (sin ?view=building)', st.ds === 'building' && st.dbg.mode === 'building', st.ds);
  const names = st.dbg.floors.map((f) => f.name);
  check('plantas = Alfa (baja), Beta y Dirección/Guía (arriba), sin «Vacío»', names.join(',') === 'Alfa,Beta,Dirección / Guía', names.join(','));
  check('C («Vacío», sin equipo) no tiene planta', !st.dbg.floors.some((f) => f.projectId === c.id));
  const [fa, fb] = st.dbg.floors;
  check('contadores de Alfa: 0 trabajando, 1 en cola, 1 en revisión, parada', fa.working === 0 && fa.queued === 1 && fa.review === 1 && fa.running === false, JSON.stringify(fa));
  check('contadores de Beta: 0 trabajando, 2 en cola, 1 en revisión, 0 fallidas, parada', fb.working === 0 && fb.queued === 2 && fb.review === 1 && fb.failed === 0 && fb.running === false, JSON.stringify(fb));
  const snap = await api('GET', '/api/state');
  const exp = (p) => { const team = snap.agents.filter((x) => p.team.includes(x.id)); const ts = snap.tasks.filter((t) => t.projectId === p.id); return { working: team.filter((x) => x.status === 'working').length, queued: ts.filter((t) => t.status === 'todo').length, review: ts.filter((t) => t.status === 'review').length, failed: ts.filter((t) => t.status === 'failed').length, running: !!p.running }; };
  check('los contadores de las plantas coinciden con /api/state e incluyen fallidos', st.dbg.floors.filter((f) => f.projectId).every((f) => { const e = exp(snap.projects.find((p) => p.id === f.projectId)); return ['working', 'queued', 'review', 'failed', 'running'].every((k) => f[k] === e[k]); }), JSON.stringify(st.dbg.floors));
  check('etiquetas HTML por planta con fallidos', st.labels.length === 3 && /Beta · 0 trabajando · 2 en cola · 1 en revisión · 0 fallidos/.test(st.labels[1]), st.labels.join(' | '));
  check('⏸ en proyectos parados, pero no en Dirección/Guía', st.labels.slice(0, 2).every((l) => l.startsWith('⏸')) && !st.labels[2].startsWith('⏸'), st.labels.join(' | '));
  check('planta superior reservada a Dirección/Guía con estado del Guía', st.dbg.floors[2]?.guide?.status === 'escuchando' && /Dirección \/ Guía · escuchando/.test(st.labels[2]), JSON.stringify(st.dbg.floors[2]));
  check('debugState expone agentes visibles por planta', st.dbg.floors[0].visibleAgents.length === 1 && st.dbg.floors[1].visibleAgents.length === 2, JSON.stringify(st.dbg.floors.map((f) => f.visibleAgents)));
  const withFailed = await page.evaluate((pid) => {
    const d = window.aoOffice.debugState();
    const projects = d.floors.filter((f) => f.projectId).map((f) => ({ id: f.projectId, name: f.name, team: f.visibleAgents.map((a) => a.id), running: f.running, createdAt: f.name === 'Alfa' ? 1 : 2 }));
    const agents = d.floors.flatMap((f) => f.visibleAgents.map((a) => ({ ...a, projectId: f.projectId })));
    window.aoOffice.update({ projects, allAgents: agents, allTasks: [{ id: 'fail-1', projectId: pid, agentId: agents.find((a) => a.projectId === pid)?.id, status: 'failed', title: 'Fallo visible' }] });
    const after = window.aoOffice.debugState();
    return { beta: after.floors.find((f) => f.projectId === pid), labels: [...document.querySelectorAll('.o3d-floor')].map((e) => e.title || e.textContent) };
  }, b.id);
  check('FT-70: los fallidos se cuentan y rotulan en la tarjeta de planta', withFailed.beta.failed === 1 && /1 fallidos/.test(withFailed.labels.find((l) => l.includes('Beta')) || ''), JSON.stringify(withFailed));
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
  const rects = (await state()).dbg.floors.map((f) => f.screen);
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  check('plantas distinguibles: sus rectángulos de pantalla no se solapan', rects.every((r, i) => rects.every((s, j) => i >= j || overlap(r, s) < Math.min(r.w * r.h, s.w * s.h) * 0.08)), JSON.stringify(rects));
  const sight3 = (await state()).dbg.floors.filter((f) => f.projectId).flatMap((f) => f.visibleAgents.map((a) => ({ floor: f.name, id: a.id, clearSight: a.clearSight, inRect: a.inRect, blockedBy: a.blockedBy })));
  check('FT-70: cada mini agente proyecta dentro de su planta y no lo tapa otra losa (3 plantas)', sight3.length === 3 && sight3.every((a) => a.clearSight && a.inRect), JSON.stringify(sight3));
  await page.screenshot({ path: path.join(shotDir, 'building-1-edificio-3-plantas.png') });

  const five = await page.evaluate(() => {
    const projects = Array.from({ length: 4 }, (_, i) => ({ id: 'ft70-p' + i, name: 'FT70 P' + (i + 1), team: ['ft70-a' + i, 'ft70-b' + i], running: true, createdAt: 10 + i }));
    const agents = projects.flatMap((p, i) => p.team.map((id, j) => ({ id, name: `Ag ${i}-${j}`, role: j ? 'qa' : 'back', status: 'working', projectId: p.id })));
    const tasks = agents.map((a, i) => ({ id: 'ft70-t' + i, projectId: a.projectId, agentId: a.id, status: i % 3 === 0 ? 'review' : 'doing', title: 'FT-70 visible' }));
    window.aoOffice.update({ projects, allAgents: agents, allTasks: tasks, agents: [], tasks: [], questions: [] });
    const d = window.aoOffice.debugState();
    return {
      floors: d.floors.length,
      rects: d.floors.map((f) => f.screen),
      agents: d.floors.filter((f) => f.projectId).flatMap((f) => f.visibleAgents.map((a) => ({ floor: f.name, id: a.id, clearSight: a.clearSight, inRect: a.inRect, blockedBy: a.blockedBy }))),
    };
  });
  check('FT-70: con 5 plantas encuadradas los rectángulos siguen separados', five.floors === 5 && five.rects.every((r, i) => five.rects.every((s, j) => i >= j || overlap(r, s) < Math.min(r.w * r.h, s.w * s.h) * 0.08)), JSON.stringify(five.rects));
  check('FT-70: con 5 plantas todos los agentes de proyecto siguen visibles desde cámara', five.agents.length === 8 && five.agents.every((a) => a.clearSight && a.inRect), JSON.stringify(five.agents));
  // FT-77 v2 · contrato visual (spec/visual-contract.json del pack) medido a 1920×1080 con 5 plantas
  {
    const vp = page.viewport();
    await page.setViewport({ width: 1920, height: 1080 });
    await sleep(900);
    const m = await page.evaluate(() => {
      const o = window.aoOffice, cv = document.querySelector('#office').getBoundingClientRect();
      const rs = o.floors.map((_, i) => o.floorFullScreenRect(i));
      const top = Math.min(...rs.map((r) => r.y)), bottom = Math.max(...rs.map((r) => r.y + r.h));
      return { widths: rs.map((r) => Math.round(r.w)), xs: rs.map((r) => Math.round(r.x)), heightShare: (bottom - top) / cv.height, canvasH: cv.height };
    });
    check('v2: plantas alineadas en un único eje vertical (mismo x en pantalla, ±4 px)', m.xs.every((x) => Math.abs(x - m.xs[0]) <= 4), JSON.stringify(m.xs));
    check('v2: ancho visual de planta 550–750 px a 1920×1080', m.widths.every((w) => w >= 550 && w <= 750), JSON.stringify(m.widths));
    check('v2: el edificio ocupa el 65–80 % del alto útil (±5 %)', m.heightShare >= 0.6 && m.heightShare <= 0.85, m.heightShare.toFixed(2));
    await page.screenshot({ path: path.join(shotDir, 'building-v2-1920.png') });
    await page.setViewport(vp);
    await sleep(500);
  }
  await page.screenshot({ path: path.join(shotDir, 'building-1-edificio-5-plantas.png') });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  await clickFloor('Beta');
  const anim = await page.evaluate(() => window.aoOffice.debugState().animating);
  await sleep(700);
  st = await state();
  check('clic en la planta Beta → modo floor con el proyecto Beta', st.ds === 'floor' && st.select === b.id && st.title === 'Beta', `${st.ds} ${st.title}`);
  check('transición de cámara al entrar (≤ 400 ms) y ya terminada', anim === true && st.dbg.animating === false, `${anim}/${st.dbg.animating}`);
  check('miga «Edificio › Beta» con el botón y etiquetas de planta ocultas', /Edificio\s*›\s*Beta/.test(st.crumb) && st.floorLabelsShown === 0, `${st.crumb} / ${st.floorLabelsShown}`);
  check('el canvas muestra personajes de Beta (actors ≥ 1)', st.dbg.actors >= 1 && st.pills >= 1, `actors=${st.dbg.actors} pills=${st.pills}`);
  check('debugState.projectId activo = Beta', st.dbg.activeProjectId === b.id, String(st.dbg.activeProjectId));

  console.log('— FT-71: nivel agente y vuelta paso a paso');
  const betaAgent = (await api('GET', '/api/state')).agents.find((ag) => ag.name === 'Bea') || (await api('GET', '/api/state')).agents.find((ag) => ag.projectId === b.id);
  const ap = await agentPoint(betaAgent.id);
  check('un agente de la planta Beta se puede apuntar con la cámara', !!ap, JSON.stringify(ap));
  const beforeAgentCam = st.dbg.camera;
  await page.mouse.move(ap.x, ap.y);
  await sleep(150);
  await page.mouse.click(ap.x, ap.y);
  await sleep(700);
  st = await state();
  check('clic en agente → officeLevel=agent y ficha lateral abierta con sus datos', st.ds === 'floor' && st.dbg.officeLevel === 'agent' && st.dbg.selectedAgentId === betaAgent.id && !st.drawerHidden && st.drawerText.includes(betaAgent.name), JSON.stringify({ level: st.dbg.officeLevel, selected: st.dbg.selectedAgentId, drawerHidden: st.drawerHidden }));
  check('debugState expone cámara acercada al agente', st.dbg.camera.span < beforeAgentCam.span && st.dbg.camera.center.x !== beforeAgentCam.center.x, JSON.stringify({ before: beforeAgentCam, after: st.dbg.camera }));
  const ctxAgent = await api('GET', '/api/context');
  check('/api/context publica officeLevel=agent y selectedAgentId', ctxAgent.officeLevel === 'agent' && ctxAgent.selectedAgentId === betaAgent.id, JSON.stringify(ctxAgent));
  await page.keyboard.press('Escape');
  await sleep(650);
  st = await state();
  check('Esc desde agente vuelve solo a planta y cierra la ficha', st.ds === 'floor' && st.dbg.officeLevel === 'floor' && st.drawerHidden, JSON.stringify({ level: st.dbg.officeLevel, drawerHidden: st.drawerHidden }));
  await page.keyboard.press('Escape');
  await sleep(650);
  st = await state();
  check('segundo Esc vuelve de planta a edificio', st.ds === 'building' && st.dbg.officeLevel === 'building', JSON.stringify({ ds: st.ds, level: st.dbg.officeLevel }));
  await clickFloor('Beta');
  await sleep(700);

  console.log('— FT-69: planta compacta por zonas');
  const floor69 = await page.evaluate(async () => {
    const mkAgent = (id, role, status = 'working', taskId = 't-' + id) => ({ id, name: id.toUpperCase(), role, status, taskId, projectId: 'ft69', activity: 'FT-69' });
    const agents6 = [
      mkAgent('dev1', 'back'), mkAgent('dev2', 'front'), mkAgent('qa1', 'qa'),
      mkAgent('doc1', 'docs'), mkAgent('rev1', 'reviewer'), mkAgent('idle1', 'manager', 'idle', null),
    ];
    const tasks6 = [
      { id: 't-dev1', projectId: 'ft69', agentId: 'dev1', status: 'doing', title: 'Implementar' },
      { id: 't-dev2', projectId: 'ft69', agentId: 'dev2', status: 'doing', title: 'UI' },
      { id: 't-qa1', projectId: 'ft69', agentId: 'qa1', status: 'doing', title: 'Tests' },
      { id: 't-doc1', projectId: 'ft69', agentId: 'doc1', status: 'doing', title: 'Docs' },
      { id: 't-rev1', projectId: 'ft69', agentId: 'rev1', status: 'review', title: 'Revisar' },
      { id: 'todo1', projectId: 'ft69', status: 'todo', title: 'Pendiente' },
    ];
    window.aoOffice.setMode('floor');
    window.aoOffice.update({ agents: agents6, tasks: tasks6, questions: [], roles: {}, title: 'FT-69', selected: null, projectId: 'ft69' });
    await new Promise((r) => setTimeout(r, 2600));
    const d1 = window.aoOffice.debugState();
    window.aoOffice.update({ agents: agents6, tasks: tasks6, questions: [], roles: {}, title: 'FT-69', selected: null, projectId: 'ft69' });
    await new Promise((r) => setTimeout(r, 200));
    const d2 = window.aoOffice.debugState();
    const before = d2.slots.dev1;
    const tasksReview = tasks6.map((t) => t.id === 't-dev1' ? { ...t, status: 'review' } : t);
    window.aoOffice.update({ agents: agents6, tasks: tasksReview, questions: [], roles: {}, title: 'FT-69', selected: null, projectId: 'ft69' });
    await new Promise((r) => setTimeout(r, 120));
    const moving = window.aoOffice.debugState().slots.dev1;
    await new Promise((r) => setTimeout(r, 3000));
    const after = window.aoOffice.debugState().slots.dev1;
    const ids = Object.keys(d1.slots);
    const zoneArea = Object.values(d1.zones).reduce((sum, z) => sum + z.w * z.d, 0);
    const floorArea = d1.floorSize.rx * d1.floorSize.rz;
    const slotSig = (s) => JSON.stringify({ zone: s.zone, module: s.module, slot: s.slot, x: s.x, z: s.z, status: s.status });
    const stable = ids.every((id) => slotSig(d1.slots[id]) === slotSig(d2.slots[id]));
    const agents10 = Array.from({ length: 10 }, (_, i) => mkAgent('m' + i, i % 3 === 0 ? 'qa' : i % 4 === 0 ? 'docs' : 'back'));
    const tasks10 = agents10.map((ag, i) => ({ id: 't-' + ag.id, projectId: 'ft69', agentId: ag.id, status: i % 5 === 0 ? 'review' : 'doing', title: 'T' + i }));
    window.aoOffice.update({ agents: agents10, tasks: tasks10, questions: [], roles: {}, title: 'FT-69 10', selected: null, projectId: 'ft69' });
    await new Promise((r) => setTimeout(r, 400));
    const d10 = window.aoOffice.debugState();
    return { zones: Object.keys(d1.zones), slots: ids.length, stable, before, moving, after, areaRatio: zoneArea / floorArea, floorSize6: d1.floorSize, size10: d10.floorSize?.kind, slots10: Object.keys(d10.slots).length };
  });
  check('debugState expone zones y slots de 6 agentes', floor69.zones.includes('development') && floor69.zones.includes('review') && floor69.slots === 6, JSON.stringify(floor69));
  check('slots estables entre refrescos idénticos', floor69.stable, JSON.stringify(floor69));
  check('working → review cambia de zona y se anima sin salto', floor69.before.zone === 'development' && floor69.moving.zone === 'review' && floor69.moving.moving === true && floor69.after.zone === 'review', JSON.stringify({ before: floor69.before, moving: floor69.moving, after: floor69.after }));
  check('4–6 agentes usan planta compacta 8.2×5.7 sin gran vacío', floor69.floorSize6?.kind === 'compact' && floor69.floorSize6?.rx === 8.2 && floor69.floorSize6?.rz === 5.7 && floor69.areaRatio >= 0.6, JSON.stringify(floor69));
  check('10 agentes usan oficina media con todos los slots asignados', floor69.size10 === 'medium' && floor69.slots10 === 10, JSON.stringify(floor69));
  await page.evaluate(() => {
    const mkAgent = (id, role, status = 'working', taskId = 't-' + id) => ({ id, name: id.toUpperCase(), role, status, taskId, projectId: 'ft69', activity: 'FT-69' });
    const agents4 = [mkAgent('dev1', 'back'), mkAgent('qa1', 'qa'), mkAgent('doc1', 'docs'), mkAgent('rev1', 'reviewer')];
    const tasks4 = agents4.map((ag, i) => ({ id: 't-' + ag.id, projectId: 'ft69', agentId: ag.id, status: i === 3 ? 'review' : 'doing', title: 'T' + i }));
    window.aoOffice.setMode('floor');
    window.aoOffice.update({ agents: agents4, tasks: tasks4, questions: [], roles: {}, title: 'FT-69 4', selected: null, projectId: 'ft69' });
  });
  await sleep(2600);
  await page.screenshot({ path: path.join(shotDir, 'ft-69-planta-4-agentes.png') });
  await page.evaluate(() => {
    const mkAgent = (id, role, status = 'working', taskId = 't-' + id) => ({ id, name: id.toUpperCase(), role, status, taskId, projectId: 'ft69', activity: 'FT-69' });
    const agents10 = Array.from({ length: 10 }, (_, i) => mkAgent('m' + i, i % 3 === 0 ? 'qa' : i % 4 === 0 ? 'docs' : 'back'));
    const tasks10 = agents10.map((ag, i) => ({ id: 't-' + ag.id, projectId: 'ft69', agentId: ag.id, status: i % 5 === 0 ? 'review' : 'doing', title: 'T' + i }));
    window.aoOffice.update({ agents: agents10, tasks: tasks10, questions: [], roles: {}, title: 'FT-69 10', selected: null, projectId: 'ft69' });
  });
  await sleep(2600);
  await page.screenshot({ path: path.join(shotDir, 'ft-69-planta-10-agentes.png') });
  await page.screenshot({ path: path.join(shotDir, 'building-2-planta-beta.png') });
  st = await state();
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
  check('al añadir equipo a C aparece una tercera planta de proyecto sin recargar', st.dbg.floors.map((f) => f.name).join(',') === 'Alfa,Beta,Vacío,Dirección / Guía' && st.labels.length === 4 && await page.evaluate(() => window.__noReload === true), st.dbg.floors.map((f) => f.name).join(','));
  check('la planta de C lleva sus contadores (1 en cola)', st.dbg.floors[2]?.queued === 1, JSON.stringify(st.dbg.floors[2]));
  check('el resumen del pie pasa a «3 proyectos con equipo»', /3 proyectos con equipo/.test(st.live), st.live);
  await page.screenshot({ path: path.join(shotDir, 'building-4-tres-plantas.png') });
  await api('PATCH', `/api/projects/${c.id}/team`, { remove: [cag.id] });
  await sleep(1500);
  st = await state();
  check('al quitar el equipo de C desaparece su planta', st.dbg.floors.map((f) => f.name).join(',') === 'Alfa,Beta,Dirección / Guía' && st.labels.length === 3, st.dbg.floors.map((f) => f.name).join(','));
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
    return { n: d.floors.length, groupedFloor: d.floors[d.floors.length - 2], guide: d.floors[d.floors.length - 1], first: d.floors[0].name, labels: document.querySelectorAll('.o3d-floor').length, grouped: document.querySelectorAll('.o3d-floor.grouped').length };
  });
  check('tope de 12 plantas', many.n === 12, String(many.n));
  check('planta baja = más antiguo (P0)', many.first === 'P0', many.first);
  check('penúltima planta «+5 proyectos» agrupa trabajando/revisión/fallidos', many.groupedFloor.projectId === null && many.groupedFloor.name === '+5 proyectos' && many.groupedFloor.working === 2 && many.groupedFloor.review === 1 && many.guide.name === 'Dirección / Guía', JSON.stringify(many));
  check('12 etiquetas, 2 no-proyecto (agrupada + guía)', many.labels === 12 && many.grouped === 2, `${many.labels}/${many.grouped}`);

  // Solo UN proyecto con equipo (Beta se queda sin Bea): al abrir la Oficina se entra directo a la planta de Alfa.
  await api('PATCH', `/api/projects/${b.id}/team`, { remove: (await api('GET', '/api/state')).projects.find((p) => p.id === b.id).team });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  st = await state();
  check('con un solo proyecto con equipo se entra directo a su planta (aunque se recordara el edificio)', st.ds === 'floor' && st.title === 'Alfa' && st.stored === 'building', `${st.ds} ${st.title} ${st.stored}`);
  check('…y el botón Edificio sigue disponible', /Edificio/.test(st.crumb) && (await page.$('#office-crumb button')) !== null, st.crumb);
  await clickCrumb();
  await sleep(500);
  check('…y lleva al edificio de una planta de proyecto más Dirección/Guía', (await state()).ds === 'building' && (await state()).dbg.floors.length === 2);
  await page.screenshot({ path: path.join(shotDir, 'building-5-una-planta.png') });
  await sleep(1000);
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
} catch (e) { failed++; console.log('✗ ' + e.message); }
finally { if (browser) await browser.close().catch(() => {}); server.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK');
process.exit(failed ? 1 : 0);
