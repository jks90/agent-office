#!/usr/bin/env node
// Captura de la oficina SIN navegador visible: levanta un servidor temporal con un proyecto demo
// en marcha, espera a que los agentes se muevan y hace una foto con Chrome headless (WebGL por SwiftShader).
//
//   node scripts/preview.mjs out.png                 # captura de la oficina tras 12 s
//   node scripts/preview.mjs out.png --wait 20000    # más tiempo (p. ej. para que alguien se siente)
//   node scripts/preview.mjs out.png --full          # la página entera, no solo la oficina
//   node scripts/preview.mjs out.png --query "x=1"   # parámetros extra en la URL
//   node scripts/preview.mjs out.png --building      # el EDIFICIO (FT-46): 3 proyectos con equipo y 1 sin él (con varios equipos la Oficina abre en modo edificio, FT-47)
//   node scripts/preview.mjs out.png --building --floor <nombre>   # entra en la planta de ese proyecto haciendo clic en ella (FT-47)
//   node scripts/preview.mjs out.png --agent-panel   # FT-68: abre la ficha lateral de un agente antes de capturar
//
// Imprime también los errores de consola de la página. Pensado para que un agente pueda VER lo que
// pinta: captura → mirar el PNG → corregir → repetir. Necesita `npm install` (puppeteer-core) y Chrome/Chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'preview.png');
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const wait = Number(opt('wait', 12000));
const query = opt('query', '');
const full = args.includes('--full');
const building = args.includes('--building');
const agentPanel = args.includes('--agent-panel');
const floorOf = opt('floor', '');   // FT-47: nombre del proyecto cuya planta se abre (clic en su etiqueta)
const port = 7490 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-preview-'));

const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  .find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (pon AO_CHROME=/ruta/al/binario)'); process.exit(2); }

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', stop);

const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
  return j;
};

let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // Los proyectos llegan del workspace de flow-test en segundo plano: si aún no hay ninguno, creamos el demo
  // (el primer proyecto ficha al equipo base) para que la captura no dependa de flow-test.
  let demo = (await api('GET', '/api/state')).projects[0];
  if (!demo) demo = await api('POST', '/api/projects', { name: 'Demo — Tienda online' });
  if (!demo.team?.length) for (const [name, role] of [['Olga', 'po'], ['Bruno', 'back'], ['Fina', 'front'], ['Quim', 'qa']]) await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: demo.id });
  const pid = demo.id;
  // Equipo en marcha: PO planificando, back y front en su mesa, QA en la zona de descanso.
  await api('POST', `/api/projects/${pid}/goal`, { goal: 'Alta de clientes con email y verificación' });
  for (const role of ['back', 'front']) await api('POST', '/api/tasks', { projectId: pid, role, title: `Prueba de ${role}` });
  await api('POST', `/api/projects/${pid}/run`, { running: true });
  if (building) {
    // Más plantas: «Facturación» en marcha con 2 trabajando, «Intranet» parada con cola, «Sin equipo» no debe salir.
    const fact = await api('POST', '/api/projects', { name: 'Facturación' });
    for (const [name, role] of [['Ada', 'po'], ['Linus', 'back'], ['Grace', 'front'], ['Edsger', 'qa']]) await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: fact.id });
    await api('POST', `/api/projects/${fact.id}/goal`, { goal: 'Facturas recurrentes con IVA' });
    for (const t of ['Modelo de factura', 'Pantalla de facturas']) await api('POST', '/api/tasks', { projectId: fact.id, role: t.startsWith('Modelo') ? 'back' : 'front', title: t });
    await api('POST', `/api/projects/${fact.id}/run`, { running: true });
    const intra = await api('POST', '/api/projects', { name: 'Intranet' });
    for (const [name, role] of [['Margaret', 'po'], ['Dennis', 'back']]) await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: intra.id });
    for (const t of ['Login SSO', 'Directorio de empleados', 'Calendario']) await api('POST', '/api/tasks', { projectId: intra.id, role: 'back', title: t });
    await api('POST', '/api/projects', { name: 'Sin equipo' });
  }

  browser = await puppeteer.launch({
    executablePath: chrome, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  const argNum = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) || d : d; };
  await page.setViewport({ width: argNum('--width', 1600), height: argNum('--height', 950) }); // --width/--height: capturas a 1920×1080 para comparar con la referencia (FT-77 v2)
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
  const url = `${base}/${query ? '?' + query : ''}`;
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, wait));
  if (building) console.log('🏢 ' + JSON.stringify(await page.evaluate(() => ({ dataset: document.querySelector('#office')?.dataset.officeMode, labels: [...document.querySelectorAll('.o3d-floor')].map((e) => e.textContent) }))));
  if (floorOf) {
    // Entrar en la planta por el mismo camino que el usuario: clic sobre la fachada de esa planta (FT-47).
    const entered = await page.evaluate(async (name) => {
      const o = window.aoOffice, i = o.floors.findIndex((f) => f.name === name);
      if (i < 0) return 'no hay planta ' + name;
      const r = o.cv.getBoundingClientRect(); let hit = null;
      for (let fy = 0.05; fy < 1 && !hit; fy += 0.02) for (let fx = 0.2; fx < 0.8; fx += 0.02) { const e = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }; if (o.pickFloor(e) === i) { hit = e; break; } }
      if (!hit) return 'no encuentro la planta en pantalla';
      o.cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hit.clientX, clientY: hit.clientY }));
      await new Promise((res) => setTimeout(res, 900));
      return document.querySelector('#office').dataset.officeMode + ' · ' + document.querySelector('#office-crumb').textContent;
    }, floorOf);
    console.log('🚪 ' + entered);
  }
  if (agentPanel) {
    const opened = await page.evaluate(async () => {
      const o = window.aoOffice, agent = o?.agents?.find((a) => a.status === 'working') || o?.agents?.[0];
      if (!o || !agent) return 'sin agente';
      if (document.querySelector('#office')?.dataset.officeMode !== 'floor') o.setMode?.('floor');
      const r = o.cv.getBoundingClientRect(); let hit = null;
      for (let fy = 0.1; fy < 0.95 && !hit; fy += 0.025) for (let fx = 0.1; fx < 0.95; fx += 0.025) {
        const e = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy };
        if (o.pickActor(e) === agent.id) { hit = e; break; }
      }
      if (!hit) return 'no encuentro el personaje';
      o.cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hit.clientX, clientY: hit.clientY }));
      await new Promise((res) => setTimeout(res, 1200));
      return document.querySelector('#drawer')?.hidden ? 'cerrado' : 'abierto · ' + document.querySelector('#drawer h2')?.textContent;
    });
    console.log('👤 ' + opened);
  }
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  const target = full ? page : (await page.$('.office-wrap')) || page;
  await target.screenshot({ path: out });
  console.log(`📸 ${out}  (${full ? 'página entera' : 'oficina'}, tras ${wait} ms, ~${fps} fps en headless)`);
  if (errors.length) { console.log('⚠ Errores/avisos de la página:'); for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ' + e); } else console.log('✓ Sin errores de consola');
} catch (e) {
  console.error('Error:', e.message);
  if (serverLog.trim()) console.error(serverLog.trim());
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}
