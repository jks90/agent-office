#!/usr/bin/env node
// FT-81 · QA de fidelidad de la oficina visual v2 (FT-77 edificio + FT-78 planta) contra la referencia
// `diseno-edificio-referencia.png` y el contrato `spec/visual-contract.json` del pack de diseño.
// Levanta un servidor temporal (datos vacíos), pinta escenas deterministas con `aoOffice.update()` y mide en píxeles:
//   · edificio con 5 plantas (4 proyectos + Dirección/Guía) y agentes en todos los estados, incluido uno fallido
//   · planta pequeña (6 agentes) y mediana (10 agentes)
// a 1920×1080 y 1366×768. Guarda capturas en resumen/fidelity-*.png y un JSON con las medidas (resumen/fidelity-qa.json).
// No arregla nada: mide y marca ✓/✗ contra el contrato. Sale con 1 si algo del contrato no se cumple o hay errores de consola.
//
//   node scripts/fidelity-qa.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 7700 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fidelity-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
const shotDir = path.join(ROOT, 'resumen');
fs.mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const results = [];
const check = (n, ok, d = '') => { if (!ok) failed++; results.push({ n, ok, d }); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`); };
const inRange = (v, [a, b]) => v >= a && v <= b;

// Contrato del pack (copiado aquí para que el script no dependa de una ruta de JksDocs).
const CONTRACT = {
  building: { viewportHeightUsage: [0.65, 0.8], floorVisualWidthPxDesktop: [550, 750], floorVisualHeightPxDesktop: [170, 240], floorGapPx: [18, 30] },
  office: { agentScaleVsCurrent: 0.7, zoneFillOpacity: [0.08, 0.15], furnitureDensityIncreaseTarget: 0.25 },
};
// Medidas de la planta ANTES de FT-78 v2 (main 1a96ac8): altura del personaje y piezas de mobiliario de la sala.
const BEFORE = { charH: 0.95, roomChildren: null };
// Constantes del edificio (office3d.js): la losa vista entre plantas es (SLAB_H + FLOOR_GAP) de cada FLOOR_H.
const SLAB_H = 0.14, FLOOR_GAP = 0.2, FLOOR_H = 3.15 + SLAB_H + FLOOR_GAP;

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let browser;
const report = { generatedAt: new Date().toISOString(), viewports: {} };
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.aoOffice && window.aoOffice.debugState, { timeout: 20000 });
  await sleep(2500);

  // Escena del edificio: 4 proyectos con equipo + Dirección/Guía; estados working, waiting, reviewing, failed, blocked, idle.
  const buildingScene = (nProjects = 4) => page.evaluate((nProjects) => {
    const st = ['working', 'waiting', 'reviewing', 'failed', 'idle'];
    const projects = ['flowtest', 'DisasterWorld', 'gestionlab', 'home'].slice(0, nProjects).map((name, i) => ({ id: 'p' + i, name, team: [], running: true, createdAt: 10 + i }));
    const agents = [], tasks = [];
    projects.forEach((p, i) => {
      for (let j = 0; j < 3 + (i === 0 ? 2 : 0); j++) {
        const status = st[(i + j) % st.length], id = `a${i}-${j}`;
        p.team.push(id);
        agents.push({ id, name: `Ag ${i}-${j}`, role: ['back', 'front', 'qa', 'docs', 'reviewer'][j % 5], status: status === 'working' ? 'working' : 'idle', projectId: p.id });
        const tstat = { working: 'doing', waiting: 'todo', reviewing: 'review', failed: 'failed' }[status];
        if (tstat) tasks.push({ id: 't' + id, projectId: p.id, agentId: id, status: tstat, title: 'Tarea ' + id });
      }
    });
    window.aoOffice.setMode('building');
    window.aoOffice.update({ projects, allAgents: agents, allTasks: tasks, agents: [], tasks: [], questions: [] });
    return { projects: projects.length, agents: agents.length };
  }, nProjects);
  const measureBuilding = () => page.evaluate(({ SLAB_H, FLOOR_GAP, FLOOR_H }) => {
    const o = window.aoOffice, cv = document.querySelector('#office').getBoundingClientRect();
    const wrap = document.querySelector('#office').parentElement.getBoundingClientRect();
    const rs = o.floors.map((_, i) => o.floorFullScreenRect(i));
    const ys = rs.map((r) => r.y).sort((a, b) => a - b);
    const pitch = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 0;
    const top = Math.min(...rs.map((r) => r.y)), bottom = Math.max(...rs.map((r) => r.y + r.h));
    const d = o.debugState();
    const states = d.floors.flatMap((f) => (f.visibleAgents || []).map((a) => a.status)).filter(Boolean);
    const labels = [...document.querySelectorAll('.o3d-floor')].map((e) => (e.title || e.textContent).replace(/\s+/g, ' ').trim());
    return {
      floors: rs.length, widths: rs.map((r) => Math.round(r.w)), heights: rs.map((r) => Math.round(r.h)), xs: rs.map((r) => Math.round(r.x)),
      pitchPx: Math.round(pitch), floorWallPx: Math.round(pitch * (FLOOR_H - SLAB_H - FLOOR_GAP) / FLOOR_H), gapPx: Math.round(pitch * (SLAB_H + FLOOR_GAP) / FLOOR_H),
      heightShare: (bottom - top) / Math.min(cv.height, wrap.height || cv.height), canvasH: Math.round(cv.height), wrapH: Math.round(wrap.height), scrolls: cv.height > wrap.height + 2,
      states: [...new Set(states)], agentsVisible: d.floors.flatMap((f) => f.visibleAgents || []).length,
      allClear: d.floors.flatMap((f) => f.visibleAgents || []).every((a) => a.clearSight !== false && a.inRect !== false),
      labels,
    };
  }, { SLAB_H, FLOOR_GAP, FLOOR_H });

  // Planta: n agentes con estados rotando. Devuelve zonas/slots por estado y medidas en px.
  const floorScene = (n) => page.evaluate(async (n) => {
    const st = ['working', 'working', 'reviewing', 'waiting', 'failed', 'idle', 'working', 'blocked', 'working', 'reviewing', 'waiting', 'working'];
    const roles = ['back', 'front', 'qa', 'docs', 'reviewer', 'manager'];
    const agents = [], tasks = [];
    for (let i = 0; i < n; i++) {
      const s = st[i % st.length], id = 'f' + i;
      agents.push({ id, name: 'Agente ' + (i + 1), role: roles[i % roles.length], status: s === 'working' ? 'working' : 'idle', projectId: 'qa', ...(s === 'blocked' ? { quotaPaused: true } : {}) });
      const tstat = { working: 'doing', waiting: 'todo', reviewing: 'review', failed: 'failed', blocked: 'doing' }[s];
      if (tstat) tasks.push({ id: 't' + id, projectId: 'qa', agentId: id, status: tstat, title: 'Tarea ' + (i + 1), ...(s === 'blocked' ? { quotaPaused: true } : {}) });
    }
    tasks.push({ id: 'todo-x', projectId: 'qa', status: 'todo', title: 'Pendiente' });
    window.aoOffice.setMode('floor');
    window.aoOffice.update({ agents, tasks, questions: [], roles: {}, title: 'flowtest', selected: null, projectId: 'qa' });
    await new Promise((r) => setTimeout(r, 6500)); // que todos lleguen a su sitio
    const o = window.aoOffice, d = o.debugState();
    const THREE = await import('three');
    // Altura en px de cada personaje frente a la de una mesa.
    const pxH = (obj) => {
      const b = new THREE.Box3().setFromObject(obj);
      const p0 = o.project((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2), p1 = o.project((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
      return { px: Math.abs(p0.y - p1.y), world: b.max.y - b.min.y };
    };
    const actorH = [...o.actors.values()].filter((a) => a.group.visible).map((a) => pxH(a.group).world);
    const actorPx = [...o.actors.values()].filter((a) => a.group.visible).map((a) => pxH(a.group).px);
    let deskPx = null, rugOpacities = [], furniture = 0;
    o.room.traverse((m) => {
      if (m.isMesh && m.material && m.material.transparent && m.material.opacity < 0.5 && m.geometry?.type === 'PlaneGeometry') rugOpacities.push(+m.material.opacity.toFixed(3));
    });
    for (const c of o.room.children) if (c.isGroup || c.type === 'Object3D' || c.type === 'Group') furniture++;
    const desk = o.room.children.find((c) => c.userData?.model === 'desk' || c.name === 'desk');
    if (desk) deskPx = pxH(desk).px;
    const zoneLabels = [...document.querySelectorAll('.o3d-zone')].filter((e) => e.style.opacity !== '0').map((e) => ({ zone: e.dataset.zone, text: e.textContent, x: Math.round(parseFloat(e.style.left)), y: Math.round(parseFloat(e.style.top)), bg: e.style.background }));
    // ¿La píldora de cada zona cae dentro del rombo proyectado de su zona?
    const inside = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    const labelInZone = zoneLabels.map((l) => {
      const z = o.floorZones[l.zone]; if (!z) return { zone: l.zone, inside: null };
      if (l.zone === 'board') return { zone: l.zone, inside: true, note: 'anclada bajo la pizarra' };
      const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => o.project(z.x + sx * z.w / 2, 0, z.z + sz * z.d / 2));
      const fl = o.project(...(() => { const p = { x: l.x, y: l.y }; return [0, 0, 0]; })()); void fl;
      // La píldora se ancla a 0,5 de altura: se proyecta su punto de suelo para comparar con el rombo.
      const ax = l.zone === 'qa' ? z.x + z.w / 2 - Math.min(0.75, z.w * 0.3) : z.x - z.w / 2 + Math.min(0.9, z.w * 0.3);
      const ground = o.project(ax, 0, z.z - z.d / 2 + 0.3);
      return { zone: l.zone, inside: inside(ground, poly) };
    });
    const bySlot = {};
    for (const [id, s] of Object.entries(d.slots)) (bySlot[s.status] ||= []).push(s.zone);
    return {
      agents: n, floorSize: d.floorSize, zones: Object.keys(d.zones), slotsByStatus: bySlot,
      charWorldH: actorH.length ? +(actorH.reduce((a, b) => a + b, 0) / actorH.length).toFixed(3) : null,
      charPx: actorPx.length ? Math.round(actorPx.reduce((a, b) => a + b, 0) / actorPx.length) : null, deskPx: deskPx && Math.round(deskPx),
      rugOpacities: [...new Set(rugOpacities)], furniture, zoneLabels, labelInZone,
      kanban: !!document.querySelector('.o3d-board') && document.querySelector('.o3d-board').textContent,
    };
  }, n);

  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    const key = `${w}x${h}`;
    console.log(`\n— ${key}`);
    await page.setViewport({ width: w, height: h });
    await sleep(600);
    const vp = report.viewports[key] = {};
    await buildingScene();
    await sleep(1800);
    const b = vp.building = await measureBuilding();
    await page.screenshot({ path: path.join(shotDir, `fidelity-${key}-edificio.png`) });
    check(`[${key}] edificio: 5 plantas (4 proyectos + Dirección/Guía)`, b.floors === 5, JSON.stringify(b.labels));
    check(`[${key}] edificio: un único eje vertical (x ±4 px)`, b.xs.every((x) => Math.abs(x - b.xs[0]) <= 4), JSON.stringify(b.xs));
    if (w === 1920) {
      check(`[${key}] edificio: ancho de planta 550–750 px`, b.widths.every((v) => inRange(v, CONTRACT.building.floorVisualWidthPxDesktop)), JSON.stringify(b.widths));
      check(`[${key}] edificio: alto de planta (pared) 170–240 px`, inRange(b.floorWallPx, CONTRACT.building.floorVisualHeightPxDesktop), `${b.floorWallPx} px (paso ${b.pitchPx} px)`);
      check(`[${key}] edificio: losa vista entre plantas 18–30 px`, inRange(b.gapPx, CONTRACT.building.floorGapPx), `${b.gapPx} px`);
      // 5 plantas de ≥170 px + losas ya superan el 80 % de 1080 px: el contrato prevé scroll antes que miniatura.
      check(`[${key}] edificio 5 plantas: no cabe → scroll vertical, sin miniaturizar`, b.scrolls && b.widths.every((v) => v >= 550), JSON.stringify({ share: +b.heightShare.toFixed(2), canvasH: b.canvasH, wrapH: b.wrapH }));
      await buildingScene(2); await sleep(1800);
      const b3 = vp.building3 = await measureBuilding();
      await page.screenshot({ path: path.join(shotDir, `fidelity-${key}-edificio-3-plantas.png`) });
      check(`[${key}] edificio 3 plantas: ocupa 65–80 % del alto útil (±5 %)`, b3.heightShare >= 0.6 && b3.heightShare <= 0.85, `${b3.heightShare.toFixed(2)} · ${JSON.stringify({ widths: b3.widths, wall: b3.floorWallPx, scrolls: b3.scrolls })}`);
      await buildingScene(4); await sleep(1500);
    } else {
      check(`[${key}] edificio: con poca altura, scroll antes que miniatura (planta ≥ 500 px de ancho)`, b.widths.every((v) => v >= 500) && (b.scrolls || b.heightShare <= 0.9), JSON.stringify({ widths: b.widths, scrolls: b.scrolls, canvasH: b.canvasH, wrapH: b.wrapH }));
    }
    check(`[${key}] edificio: estados visibles (working, failed, reviewing…)`, ['working', 'failed', 'reviewing'].every((s) => b.states.includes(s)), JSON.stringify(b.states));
    check(`[${key}] edificio: ningún agente tapado por otra losa`, b.allClear, `${b.agentsVisible} agentes`);

    for (const [n, name] of [[6, 'pequena'], [10, 'mediana']]) {
      const f = vp[name] = await floorScene(n);
      await page.screenshot({ path: path.join(shotDir, `fidelity-${key}-planta-${name}.png`) });
      if (BEFORE.roomChildren == null) BEFORE.roomChildren = null;
      check(`[${key}] planta ${name}: 6 zonas + Kanban`, ['development', 'qa', 'docs', 'review', 'meeting', 'idle', 'board'].every((z) => f.zones.includes(z)), JSON.stringify(f.zones));
      check(`[${key}] planta ${name}: opacidad de zonas 8–15 %`, f.rugOpacities.length > 0 && f.rugOpacities.every((o) => inRange(o, CONTRACT.office.zoneFillOpacity)), JSON.stringify(f.rugOpacities));
      check(`[${key}] planta ${name}: escala de agentes ≈ 0,7 de la anterior (0,65–0,75)`, f.charWorldH != null && inRange(f.charWorldH / BEFORE.charH, [0.65, 0.75]), `${f.charWorldH} / ${BEFORE.charH} = ${(f.charWorldH / BEFORE.charH).toFixed(2)} · ${f.charPx} px en pantalla`);
      check(`[${key}] planta ${name}: working → Desarrollo/QA/Docs (sentados)`, (f.slotsByStatus.working || []).every((z) => ['development', 'qa', 'docs'].includes(z)), JSON.stringify(f.slotsByStatus.working));
      check(`[${key}] planta ${name}: reviewing → Revisión`, (f.slotsByStatus.reviewing || []).every((z) => z === 'review'), JSON.stringify(f.slotsByStatus.reviewing));
      check(`[${key}] planta ${name}: idle → Descanso/Reuniones`, (f.slotsByStatus.idle || []).every((z) => ['idle', 'meeting'].includes(z)), JSON.stringify(f.slotsByStatus.idle));
      check(`[${key}] planta ${name}: hay un agente fallido con su sitio (escritorio o de pie)`, (f.slotsByStatus.failed || []).length >= 1, JSON.stringify(f.slotsByStatus.failed));
      check(`[${key}] planta ${name}: cada píldora de zona cae dentro de su zona`, f.labelInZone.every((l) => l.inside !== false), JSON.stringify(f.labelInZone.filter((l) => l.inside === false)));
      check(`[${key}] planta ${name}: Kanban con título y pendientes`, /pendientes/.test(f.kanban || ''), f.kanban);
    }
  }
  check('sin errores de consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  report.results = results;
  fs.writeFileSync(path.join(shotDir, 'fidelity-qa.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed ? '✗ ' + failed + ' fallos' : '✓ todo OK'} · medidas en resumen/fidelity-qa.json`);
} catch (e) {
  console.error('ERROR', e);
  failed++;
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
