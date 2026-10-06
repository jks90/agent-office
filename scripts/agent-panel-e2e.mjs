#!/usr/bin/env node
// FT-68: ficha lateral del agente con datos operativos reales.
// Servidor temporal + motor demo + Chrome headless. Verifica apertura desde Oficina y Agentes,
// estado/duracion/tarea/herramienta/actividad, actualizacion en vivo, acciones, Esc y consola limpia.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2] || path.join(ROOT, 'resumen', 'agent-panel-ft-68.png');
const port = 7890 + Math.floor(Math.random() * 80);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-agent-panel-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
fs.mkdirSync(path.dirname(shot), { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${j.error || ''}`);
  return j;
};
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const project = await api('POST', '/api/projects', { name: 'FT-68 Panel' });
  for (const id of [...(project.team || [])]) await api('PATCH', `/api/projects/${project.id}/team`, { remove: [id] });
  const agent = await api('POST', '/api/agents', { name: 'Diego', role: 'back', engine: 'demo', projectId: project.id });
  const task = await api('POST', '/api/tasks', { projectId: project.id, role: 'back', title: 'Implementar ficha lateral FT-68' });
  await api('POST', `/api/projects/${project.id}/run`, { running: true });

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction((id) => window.aoOffice?.debugState().actors > 0 && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 12000 }, agent.id);

  const actorPoint = async (id) => page.evaluate((agentId) => {
    const o = window.aoOffice, r = o.cv.getBoundingClientRect();
    for (let fy = 0.1; fy < 0.95; fy += 0.025) for (let fx = 0.1; fx < 0.95; fx += 0.025) {
      const e = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy };
      if (o.pickActor(e) === agentId) return { x: e.clientX, y: e.clientY };
    }
    return null;
  }, id);

  await page.waitForFunction((id) => {
    const a = window.aoOffice?.agents?.find?.((x) => x.id === id);
    return a?.status === 'working';
  }, { timeout: 12000 }, agent.id).catch(() => {});
  const p = await actorPoint(agent.id);
  check('el personaje se puede localizar en la Oficina', !!p, JSON.stringify(p));
  if (p) await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#drawer:not([hidden])', { timeout: 8000 });
  await page.waitForFunction(() => /Read|Edit|Bash|Grep|Think|demo|herramienta|usando/i.test(document.querySelector('[data-f=tool]')?.textContent || ''), { timeout: 12000 });
  let panel = await page.evaluate(() => ({
    text: document.querySelector('#drawer').innerText,
    activity: [...document.querySelectorAll('.agent-activity li')].map((x) => x.textContent.trim()),
    actions: [...document.querySelectorAll('#drawer button')].map((x) => x.textContent.trim()),
    hasModel: !!document.querySelector('#drawer [data-f=model]'),
    role: document.querySelector('#drawer')?.getAttribute('role'),
    active: document.activeElement === document.querySelector('#drawer'),
  }));
  check('la ficha muestra nombre, rol, estado y duracion', /Diego/.test(panel.text) && /Backend|back/i.test(panel.text) && /Trabajando|En pausa|Bloqueado/.test(panel.text) && /\d+s|\d+m/.test(panel.text), panel.text);
  check('la tarea actual es clicable y muestra codigo/titulo', panel.text.includes(task.title) && /#|FT-/.test(panel.text), panel.text);
  check('herramienta activa combina motor/modelo y ultima tool', /demo/i.test(panel.text) && /Read|Edit|Bash|Grep|Think/.test(panel.text), panel.text);
  check('actividad reciente trae eventos del Activity Stream', panel.activity.length > 0 && panel.activity.some((x) => /leyendo|usando|empezando|asignado/i.test(x)), panel.activity.join(' | '));
  check('acciones existentes presentes', ['Abrir tarea', 'Ver log'].every((x) => panel.actions.includes(x)) && panel.actions.some((x) => /Mensaje/.test(x)) && panel.actions.some((x) => /Pausar|Reanudar/.test(x)) && panel.actions.some((x) => /Reasignar/.test(x)), panel.actions.join(' | '));
  check('mantiene edicion de motor/modelo y rol dialog accesible', panel.hasModel && panel.role === 'dialog' && panel.active);

  const before = panel.activity.join('\n');
  await page.waitForFunction((old) => document.querySelector('.agent-activity')?.innerText !== old, { timeout: 9000 }, before).catch(() => {});
  panel = await page.evaluate(() => ({ activity: document.querySelector('.agent-activity')?.innerText || '', hidden: document.querySelector('#drawer').hidden }));
  check('la actividad se actualiza en vivo sin cerrar', !panel.hidden && panel.activity !== before, panel.activity);

  await page.click('.nav-item[data-tab="agents"]');
  await page.click(`[data-agent="${agent.id}"]`);
  check('tambien se abre desde la vista Agentes', await page.$eval('#drawer', (x) => !x.hidden && /Diego/.test(x.innerText)));
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc cierra la ficha', await page.$eval('#drawer', (x) => x.hidden));
  await page.screenshot({ path: shot, fullPage: true });
  check('sin errores de consola', errors.length === 0, errors.join(' | '));
  console.log(`📸 ${shot}`);
} catch (e) {
  console.error('Error:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}
if (failed) process.exitCode = 1;
