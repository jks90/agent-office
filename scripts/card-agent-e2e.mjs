#!/usr/bin/env node
// e2e de FT-50 · la tarjeta dice quién hará la tarea (asignado o previsto), el clic abre su configuración y se reasigna
// desde la tarjeta. Sin Claude: servidor temporal (motor demo, flow-test de pega) + Chrome headless.
//
//   node scripts/card-agent-e2e.mjs [captura.png]
//
// API: `plannedAgentId`/`plannedReason` en el snapshot (misma regla que el planificador: rol o `handles`, libre antes que
// ocupado), POST /api/tasks/:id/assign (400 si el agente no está fichado, 404 si no existe, 409 si la tarea ya empezó).
// UI: chip «previsto: <agente> · motor», aviso ámbar si nadie tiene el rol, clic → #drawer del agente, «Asignar a…» cambia
// `assignedAgentId` y el chip (y «automático» lo deshace), el chip ámbar abre «Contratar agente» con el rol preseleccionado,
// la misma fila en el modal «Ver la tarea»; sin errores de consola.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-card-agent-'));
const dataDir = path.join(tmp, 'data');
const homeDir = path.join(tmp, 'home'); // HOME vacío: no se importa el workspace real de flow-test
fs.mkdirSync(homeDir, { recursive: true });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (n, ok, d = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// flow-test de pega: solo /access (la suite «vigente» deja crear tareas y arrancar el equipo).
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir } });
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return Object.assign({ http: r.status, ok: r.ok }, Array.isArray(j) ? { list: j } : j); // `http`: las tareas ya traen `status`
};
const state = () => api('GET', '/api/state');
const taskIn = async (id) => (await state()).tasks.find((t) => t.id === id);
let browser;
try {
  if (!(await until(() => fetch(base + '/api/state').then(() => true).catch(() => false), 10_000))) throw new Error('el servidor no arranca');

  section('Preparación: proyecto demo con equipo (Olivia PO, Bruno back, Frida front; Quique QA al banquillo) + Berta (back)');
  const p = await api('POST', '/api/projects', { name: 'Tienda', engine: 'demo' });
  let st = await state();
  const byName = (n) => st.agents.find((a) => a.name === n);
  const quique = byName('Quique'), bruno = byName('Bruno');
  await api('PATCH', `/api/projects/${p.id}/team`, { remove: [quique.id] });
  const berta = await api('POST', '/api/agents', { name: 'Berta', role: 'back', engine: 'demo', projectId: p.id });
  const t1 = await api('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'Pago con tarjeta' });
  const t2 = await api('POST', '/api/tasks', { projectId: p.id, role: 'qa', title: 'Probar el pago' });
  check('proyecto, equipo y tareas creados', p.id && berta.id && t1.id && t2.id);

  section('API: agente previsto en el snapshot (campo calculado) y POST /api/tasks/:id/assign');
  st = await state();
  const s1 = st.tasks.find((t) => t.id === t1.id), s2 = st.tasks.find((t) => t.id === t2.id);
  check('tarea back sin asignar → plannedAgentId = Bruno (primero del equipo con el rol)', s1.plannedAgentId === bruno.id, JSON.stringify([s1.plannedAgentId, bruno.id]));
  check('…y sin plannedReason', s1.plannedReason === null);
  check('tarea qa sin nadie del rol → plannedAgentId null y motivo «sin agente para el rol QA en el equipo»', s2.plannedAgentId === null && /sin agente para el rol QA en el equipo/.test(s2.plannedReason || ''), JSON.stringify(s2.plannedReason));
  const persisted = await until(() => { try { const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); return j.tasks?.length >= 2 ? j : null; } catch { return null; } }, 5000); // el store guarda con debounce
  check('plannedAgentId NO se persiste en data/state.json', !!persisted && !persisted.tasks.some((t) => 'plannedAgentId' in t || 'plannedReason' in t));
  let r = await api('POST', `/api/tasks/${t1.id}/assign`, { agentId: quique.id });
  check('asignar a un agente del banquillo → 400', r.http === 400 && /no está fichado/.test(r.error || ''), `${r.http} ${r.error}`);
  r = await api('POST', `/api/tasks/${t1.id}/assign`, { agentId: 'nadie' });
  check('asignar a un agente inexistente → 404', r.http === 404, String(r.http));
  r = await api('POST', `/api/tasks/${t1.code}/assign`, { agentId: berta.id });
  check('asignar (por código de tarea) a Berta → assignedAgentId fijado y plannedAgentId = Berta', r.ok && r.assignedAgentId === berta.id && (await taskIn(t1.id)).plannedAgentId === berta.id);
  r = await api('POST', `/api/tasks/${t1.id}/assign`, { agentId: null });
  check('agentId vacío → vuelve a elegirse por rol (Bruno)', r.ok && !r.assignedAgentId && (await taskIn(t1.id)).plannedAgentId === bruno.id);

  section('UI: chip en la tarjeta, clic → cajón del agente, «Asignar a…», aviso ámbar → Contratar, fila en el modal');
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.click('[data-tab="tasks"]');
  const chipSel = (id) => `.card[data-task="${id}"] .who-chip`;
  await page.waitForSelector(chipSel(t1.id), { timeout: 10_000 });
  const chip = (id) => page.$eval(chipSel(id), (el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), cls: el.className, agent: el.dataset.agent || null, hireRole: el.dataset.hireRole ?? null }));
  let c1 = await chip(t1.id);
  check('tarjeta back: chip «👤 previsto: Bruno · demo» (clase planned)', /^👤 previsto: Bruno · demo$/.test(c1.text) && /planned/.test(c1.cls) && c1.agent === bruno.id, JSON.stringify(c1));
  const c2 = await chip(t2.id);
  check('tarjeta qa: chip ámbar «⚠️ sin agente para este rol» con el rol para contratar', /sin agente para este rol/.test(c2.text) && /warn/.test(c2.cls) && c2.hireRole === 'qa', JSON.stringify(c2));
  const amber = await page.$eval(chipSel(t2.id), (el) => getComputedStyle(el).color);
  check('…pintado en ámbar', /251,\s*191,\s*36/.test(amber), amber);
  check('la tarjeta qa no ofrece «Asignar a…» (nadie compatible)', !(await page.$(`.card[data-task="${t2.id}"] select[data-assign]`)));

  await page.click(chipSel(t1.id));
  await page.waitForSelector('#drawer:not([hidden]) h2', { timeout: 5000 });
  check('clic en el chip → se abre el cajón de Bruno (motor y modelo editables)', (await page.$eval('#drawer h2', (el) => el.textContent)) === 'Bruno' && !!(await page.$('#drawer [data-f=engine]')) && !!(await page.$('#drawer [data-f=model]')));
  if (shot) { fs.mkdirSync(path.dirname(path.resolve(shot)), { recursive: true }); await page.screenshot({ path: path.resolve(shot) }); }
  await page.click('#drawer [data-close]');
  await page.waitForSelector('#drawer[hidden]', { timeout: 5000 });

  const opts = await page.$$eval(`.card[data-task="${t1.id}"] select[data-assign] option`, (os) => os.map((o) => [o.value, o.textContent]));
  check('«Asignar a…» lista a los del equipo compatibles con el rol (Bruno y Berta), no a Frida', opts.some(([v]) => v === bruno.id) && opts.some(([v]) => v === berta.id) && opts.length === 3, JSON.stringify(opts));
  await page.select(`.card[data-task="${t1.id}"] select[data-assign]`, berta.id);
  check('elegir a Berta → assignedAgentId = Berta en el servidor', !!(await until(async () => (await taskIn(t1.id)).assignedAgentId === berta.id)));
  await until(async () => /Berta/.test((await chip(t1.id)).text));
  c1 = await chip(t1.id);
  check('…y el chip pasa a fijo «👤 Berta · demo» (sin «previsto:»)', /^👤 Berta · demo$/.test(c1.text) && !/planned/.test(c1.cls) && c1.agent === berta.id, JSON.stringify(c1));
  const auto = await page.$(`.card[data-task="${t1.id}"] select[data-assign] option[value="__auto"]`);
  check('asignada: aparece la opción «(automático: por rol)»', !!auto);
  await page.select(`.card[data-task="${t1.id}"] select[data-assign]`, '__auto');
  check('«automático» → se quita la asignación y vuelve «previsto: Bruno»', !!(await until(async () => !(await taskIn(t1.id)).assignedAgentId)) && !!(await until(async () => /previsto: Bruno/.test((await chip(t1.id)).text))));

  await page.click(chipSel(t2.id));
  await page.waitForSelector('dialog[open] select[name=role]', { timeout: 5000 });
  check('clic en el chip ámbar → «Contratar agente» con el rol QA preseleccionado', /Contratar agente/.test(await page.$eval('dialog[open] h3', (el) => el.textContent)) && (await page.$eval('dialog[open] select[name=role]', (el) => el.value)) === 'qa');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dialog').open, { timeout: 5000 });

  await page.click(`.card[data-task="${t1.id}"] [data-open]`);
  await page.waitForSelector('dialog[open] .task-who .who-chip', { timeout: 5000 });
  const mc = await page.$eval('dialog[open] .task-who .who-chip', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  check('el modal «Ver la tarea» lleva la misma fila de agente', /^👤 previsto: Bruno · demo$/.test(mc) && !!(await page.$('dialog[open] .task-who select[data-assign]')), mc);
  await page.select('dialog[open] .task-who select[data-assign]', berta.id);
  check('asignar desde el modal también funciona…', !!(await until(async () => (await taskIn(t1.id)).assignedAgentId === berta.id)));
  check('…y la fila del modal se refresca con el estado SSE', !!(await until(() => page.$eval('dialog[open] .task-who .who-chip', (el) => /Berta/.test(el.textContent)).catch(() => false))));
  await page.click('dialog[open] .task-who .who-chip');
  await page.waitForSelector('#drawer:not([hidden]) h2', { timeout: 5000 });
  check('clic en el chip del modal → se cierra el modal y se abre el cajón de Berta', !(await page.$eval('#dialog', (d) => d.open)) && (await page.$eval('#drawer h2', (el) => el.textContent)) === 'Berta');
  await page.click('#drawer [data-close]');
  check('sin errores de consola', errors.length === 0, errors.join(' | '));

  section('Regla «libre antes que ocupado»: con Bruno trabajando, una tarea back nueva prevé a Berta');
  await api('POST', `/api/tasks/${t1.id}/assign`, { agentId: null });
  await api('POST', `/api/projects/${p.id}/run`, { running: true });
  const working = await until(async () => { const s = await state(); return s.agents.find((a) => a.id === bruno.id)?.status === 'working' ? s : null; });
  check('al poner a trabajar, Bruno (el previsto) coge la tarea', !!working && working.tasks.find((t) => t.id === t1.id)?.agentId === bruno.id);
  const t3 = await api('POST', '/api/tasks', { projectId: p.id, role: 'back', title: 'Devoluciones', status: 'backlog' });
  const s3 = await taskIn(t3.id);
  check('tarea back en Backlog mientras Bruno trabaja → previsto Berta (libre)', s3.plannedAgentId === berta.id, JSON.stringify([s3.plannedAgentId, berta.id]));
  r = await api('POST', `/api/tasks/${t1.id}/assign`, { agentId: berta.id });
  check('asignar una tarea ya en curso → 409', r.http === 409, String(r.http));
  await api('POST', `/api/projects/${p.id}/run`, { running: false });
} catch (e) { failed++; console.error('✗ Error:', e.stack || e.message); }
finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM'); stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${failed ? '✗' : '✓'} ${passed} correctos · ${failed} fallos`);
process.exit(failed ? 1 : 0);
