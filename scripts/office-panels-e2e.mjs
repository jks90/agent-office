#!/usr/bin/env node
// FT-125: paneles de información en los márgenes de la planta 3D + burbuja del agente libre sin ids internos.
// Servidor temporal con un proyecto sembrado en state.json + Chrome headless a 1920×1080, 1366×768 y 600×800.
// Uso: node scripts/office-panels-e2e.mjs [carpeta-de-capturas]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(os.tmpdir(), 'ao-panels-shots');
const port = 7990 + Math.floor(Math.random() * 20);
const stubPort = port + 100;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-panels-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Estado sembrado: proyecto «Demo» con 3 agentes, tareas hechas / en revisión / en cola con dependencias y una épica por prefijo.
const now = Date.now();
const mkT = (n, o) => ({ id: 'tk' + n, code: 'FT-' + n, projectId: 'p1', title: 'x', description: '', role: 'back', kind: 'work', status: 'todo', agentId: null, dependsOn: [], createdAt: now - 9e6, updatedAt: now, costUsd: 0, ...o });
const state = {
  schema: 3,
  settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 2 },
  projects: [{ id: 'p1', name: 'Demo', folder: 'demo', repos: [], team: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], running: false, createdAt: now }],
  // FT-138: 8 agentes y 10 épicas (6 completas) para comprobar que los paneles se ven enteros, sin scroll
  agents: ['a1:Óscar', 'a2:Sofía', 'a3:Marta', 'a4:Diego', 'a5:Lucía', 'a6:Hugo', 'a7:Irene', 'a8:Pablo'].map((s) => { const [id, name] = s.split(':'); return { id, name, role: 'back', engine: 'demo', model: 'sonnet', status: 'idle', taskId: null, activity: '', createdAt: now }; }),
  tasks: [
    mkT(110, { title: 'Épica login: formulario', status: 'done', agentId: 'a1', costUsd: 0.42 }),
    mkT(111, { title: 'Épica login: validación', status: 'done', agentId: 'a2', costUsd: 0.18 }),
    mkT(119, { title: 'Épica login: tokens', status: 'review', agentId: 'a1', costUsd: 0.31 }),
    mkT(120, { title: 'Siguiente cosa grande de la cola', status: 'todo', dependsOn: ['tk119'] }),
    mkT(121, { title: 'Épica login: logout', status: 'todo' }),
    mkT(122, { title: 'Otra tarea suelta', status: 'backlog' }),
    // 9 épicas más: 6 completas (n/n) y 3 con algo pendiente
    ...Array.from({ length: 9 }, (_, i) => [0, 1].map((j) => mkT(130 + i * 2 + j, { title: `[Épica ${i + 1}] parte ${j + 1}`, status: i < 6 || j === 0 ? 'done' : 'todo' }))).flat(),
  ],
};
const stub = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/access' ? { mode: 'licensed', plan: 'e2e' } : {}))).listen(stubPort, '127.0.0.1'); // flow-test falso: sin /access la app queda bajo el candado
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { stub.close(); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;

// Dentro de la página: rectángulos de los paneles visibles, polígonos del suelo (4 esquinas y casco con paredes) y burbujas, en px de página.
const probe = () => {
  const o = window.aoOffice, cr = o.cv.getBoundingClientRect(), vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const sz = o.currentFloorSize;
  const quad = [[0, 0], [sz.rx, 0], [sz.rx, sz.rz], [0, sz.rz]].map(([x, z]) => { const p = o.project(x, 0, z); return { x: p.x + cr.left, y: p.y + cr.top }; });
  const hull = o.floorHull().map((p) => ({ x: p.x + cr.left, y: p.y + cr.top }));
  const panels = [...document.querySelectorAll('.op')].filter(vis).map((el) => ({ id: el.dataset.panel, ...rect(el) }));
  const bubbles = [...document.querySelectorAll('.o3d-bubble')].filter((b) => b.style.opacity === '1' && vis(b)).map((b) => ({ ...rect(b), txt: b.textContent }));
  const root = document.querySelector('.op-root');
  return { panels, quad, hull, bubbles, side: root.classList.contains('side'), toggle: !document.querySelector('.op-toggle').hidden, canvas: { w: cr.width, h: cr.height } };
};
// Rectángulo vs polígono convexo (SAT).
const hits = (r, poly) => {
  const rp = [{ x: r.l, y: r.t }, { x: r.r, y: r.t }, { x: r.r, y: r.b }, { x: r.l, y: r.b }];
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; axes.push({ x: -(b.y - a.y), y: b.x - a.x }); }
  for (const ax of axes) {
    const pr = (pts) => { const d = pts.map((p) => p.x * ax.x + p.y * ax.y); return [Math.min(...d), Math.max(...d)]; };
    const [a0, a1] = pr(rp), [b0, b1] = pr(poly);
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
};
const overlap = (a, c) => a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t;

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  // un evento real para «📜 Actividad»: aprobar la tarea en revisión
  await fetch(base + '/api/tasks/tk119/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => { localStorage.setItem('ao:officeMode', 'floor'); localStorage.setItem('ao:project', 'p1'); });

  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    console.log(`— ${w}×${h}`);
    await page.setViewport({ width: w, height: h });
    await page.goto(base + '/', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor' && document.querySelectorAll('.op').length === 5, { timeout: 15000 });
    await page.keyboard.press('Escape');
    // agentes sobre la planta: dos trabajando y uno libre cuyo último taskId es un id interno (el bug de las burbujas)
    await page.evaluate(() => {
      const ag = [
        { id: 'a1', name: 'Óscar', role: 'back', engine: 'demo', status: 'working', taskId: 'tk119', activity: 'Editando server/team.js' },
        { id: 'a2', name: 'Sofía', role: 'back', engine: 'demo', status: 'working', taskId: 'tk121', activity: 'Escribiendo tests' },
        { id: 'a3', name: 'Marta', role: 'back', engine: 'demo', status: 'idle', taskId: 'tk110', activity: '' },
      ];
      const ts = [{ id: 'tk119', code: 'FT-119', title: 'x', status: 'doing', agentId: 'a1', role: 'back', projectId: 'p1' }, { id: 'tk121', code: 'FT-121', title: 'y', status: 'doing', agentId: 'a2', role: 'back', projectId: 'p1' }, { id: 'tk110', code: 'FT-110', title: 'z', status: 'done', agentId: 'a3', role: 'back', projectId: 'p1' }];
      window.aoOffice.update({ agents: ag, tasks: ts, questions: [], roles: {}, title: 'Demo', bubbles: 'todas' });
    });
    await sleep(2500);
    const r = await page.evaluate(probe);
    check('los 5 paneles visibles', r.panels.length === 5 && !r.side, `${r.panels.map((p) => p.id)} side=${r.side} why=${await page.evaluate(() => aoOffice.panels.why())}`);
    check('sin intersección con el suelo (4 esquinas)', r.panels.every((p) => !hits(p, r.quad)), JSON.stringify(r.panels.filter((p) => hits(p, r.quad)).map((p) => p.id)));
    check('sin intersección con el volumen de la planta', r.panels.every((p) => !hits(p, r.hull)), JSON.stringify(r.panels.filter((p) => hits(p, r.hull)).map((p) => p.id)));
    check('sin intersección con las burbujas', r.panels.every((p) => !r.bubbles.some((b) => overlap(p, b))), JSON.stringify(r.bubbles.map((b) => b.txt)));
    check('dentro del lienzo (por abajo pueden salirse: la vista hace scroll, FT-138)', r.panels.every((p) => p.l >= -1 && p.r <= w + 1 && p.t >= -1));
    const ids = Object.fromEntries(r.panels.map((p) => [p.id, p]));
    check('esquinas: equipo arriba-izq, actividad abajo-izq, progreso arriba-dcha, consumo abajo-dcha', ids.team.t < ids.feed.t && ids.team.l < ids.progress.l && ids.progress.t < ids.usage.t && ids.mine.t > ids.progress.b - 1 && ids.mine.b < ids.usage.t + 1);
    const txt = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.op')].map((e) => [e.dataset.panel, e.textContent])));
    check('Equipo: nombres y modelo', /Óscar/.test(txt.team) && /sonnet/.test(txt.team));
    // FT-138: paneles enteros, sin scroll interno, con los 8 agentes y las 10 épicas a la vista
    const fit = await page.evaluate(() => ({
      over: [...document.querySelectorAll('.op, .op-b')].filter((e) => e.getBoundingClientRect().width > 0 && (e.scrollHeight > e.clientHeight + 1 || ['auto', 'scroll'].includes(getComputedStyle(e).overflowY))).map((e) => e.dataset.panel || e.className),
      names: ['Óscar', 'Sofía', 'Marta', 'Diego', 'Lucía', 'Hugo', 'Irene', 'Pablo'].filter((n) => ![...document.querySelectorAll('.op[data-panel="team"] [data-agent]')].some((e) => e.textContent.includes(n) && e.getBoundingClientRect().height > 0)),
      epics: (document.querySelector('.op[data-panel="progress"]').textContent.match(/Épica \d+/g) || []).length,
      scroll: getComputedStyle(window.aoOffice.cv.parentElement).overflowY,
      low: Math.max(...[...document.querySelectorAll('.op')].map((e) => e.offsetTop + e.offsetHeight)),
      h: window.aoOffice.cv.clientHeight,
    }));
    console.log('   FT-138:', JSON.stringify(fit));
    check('FT-138: ningún panel con scrollHeight > clientHeight ni overflow auto', !fit.over.length, fit.over.join(','));
    check('FT-138: los 8 agentes visibles y las 9 épicas', !fit.names.length && fit.epics >= 9, `${fit.names} épicas=${fit.epics}`);
    check('FT-138: si algo baja más allá del lienzo, la vista hace scroll', fit.low <= fit.h || fit.scroll === 'auto', JSON.stringify(fit));
    check('Progreso: hechas/total y dependencia', /2\/5 hechas|\d+\/\d+ hechas/.test(txt.progress) && /FT-120/.test(txt.progress) && /espera a FT-119|Épicas/.test(txt.progress), txt.progress);
    check('Consumo: coste de hoy y cuota', /Hoy en el proyecto/.test(txt.usage) && /Claude/.test(txt.usage), txt.usage);
    check('Actividad: eventos del proyecto', /FT-119/.test(txt.feed), txt.feed);
    const bub = r.bubbles.map((b) => b.txt);
    console.log('   burbujas:', bub.join(' | '));
    check('burbuja del libre: sin id interno y con nombre', bub.some((t) => /Marta/.test(t) && /libre/.test(t)) && !bub.some((t) => /tk\d+|#tk/.test(t)));
    // plegar un panel y recordarlo
    console.log('   bajo el cursor:', await page.evaluate(() => { const r = document.querySelector('.op[data-panel="feed"] .op-h').getBoundingClientRect(); const e = document.elementFromPoint(r.left + 20, r.top + 8); let c = []; for (let n = e; n && c.length < 6; n = n.parentElement) c.push(n.tagName + (n.id ? "#" + n.id : "") + "." + n.className); return c.join(" < "); }));
    await page.click('.op[data-panel="feed"] .op-h');
    check('panel plegable y recordado', await page.evaluate(() => document.querySelector('.op[data-panel="feed"]').classList.contains('col') && JSON.parse(localStorage.getItem('ao:opCollapsed')).feed === true), await page.evaluate(() => localStorage.getItem('ao:opCollapsed') + ' ' + document.querySelector('.op[data-panel="feed"]').className));
    // FT-138: plegado → solo cabecera con resumen; persiste tras recargar
    await page.click('.op[data-panel="team"] .op-h');
    const fold = await page.evaluate(() => { const e = document.querySelector('.op[data-panel="team"]'); return { h: e.getBoundingClientRect().height, t: e.textContent }; });
    check('FT-138: plegado muestra solo cabecera con resumen', fold.h < 40 && /8 · \d+ trabajando/.test(fold.t), JSON.stringify(fold));
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.aoOffice && document.querySelectorAll('.op').length === 5, { timeout: 15000 });
    await page.keyboard.press('Escape'); await sleep(1500);
    check('FT-138: el pliegue persiste tras recargar', await page.evaluate(() => document.querySelector('.op[data-panel="team"]').classList.contains('col') && document.querySelector('.op[data-panel="feed"]').classList.contains('col') && !document.querySelector('.op[data-panel="usage"]').classList.contains('col')));
    await page.click('.op[data-panel="team"] .op-h');
    check('FT-138: desplegado de nuevo, sin scroll', await page.evaluate(() => { const e = document.querySelector('.op[data-panel="team"]'); return !e.classList.contains('col') && e.scrollHeight <= e.clientHeight + 1 && JSON.parse(localStorage.getItem('ao:opCollapsed')).team === false; }));
    await page.click('.op[data-panel="feed"] .op-h');
    await page.screenshot({ path: path.join(outDir, `panels-${w}x${h}.png`) });
  }

  // Interruptor en Ajustes: officePanels=false oculta los paneles
  await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ officePanels: false }) });
  await sleep(800);
  check('officePanels=false los oculta', await page.evaluate(() => [...document.querySelectorAll('.op')].every((e) => e.getBoundingClientRect().width === 0)));
  await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ officePanels: true }) });

  console.log('— 600×800');
  await page.setViewport({ width: 600, height: 800 });
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice && document.querySelectorAll('.op').length === 5, { timeout: 15000 });
  await sleep(1500);
  let r = await page.evaluate(probe);
  check('plegados en barra lateral (sin paneles flotando)', r.side && r.toggle && r.panels.length === 0, JSON.stringify({ side: r.side, toggle: r.toggle, n: r.panels.length }));
  await page.click('.op-toggle');
  r = await page.evaluate(probe);
  check('la barra se despliega con los 5 paneles', r.panels.length === 5, String(r.panels.length));
  await page.screenshot({ path: path.join(outDir, 'panels-600.png') });
  check('consola limpia', errors.length === 0, errors.join('; '));
} catch (e) { failed++; console.error(e); } finally { await browser?.close(); stop(); }
console.log(failed ? `FALLÓ (${failed})` : 'OK');
process.exit(failed ? 1 : 0);
