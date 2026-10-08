#!/usr/bin/env node
// FT-150: personajes de ambiente (visita, reparto, limpieza, reunión, mantenimiento). Servidor temporal + Chrome headless.
// Comprueba: aparecen y se van, tope de 3, no ocupan mesas ni mueven a los agentes, el interruptor settings.officeAmbient los apaga
// y prefers-reduced-motion también. (office-fidelity-e2e debe seguir en verde con el ambiente encendido.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8010 + Math.floor(Math.random() * 20);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ambient-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 20000 });

  // Servidor: el interruptor se guarda (por defecto encendido).
  const st0 = await (await fetch(base + '/api/state')).json().catch(() => ({}));
  check('por defecto officeAmbient no está apagado', st0.settings?.officeAmbient !== false);
  const put = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ officeAmbient: false }) });
  const st1 = await (await fetch(base + '/api/state')).json().catch(() => ({}));
  check('POST /api/settings guarda officeAmbient=false', put.ok && st1.settings?.officeAmbient === false, `status ${put.status}`);
  await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ officeAmbient: true }) });

  // Equipo de 3 (2 ocupados + 1 libre → banda «mixed»/«quiet» según el caso): se inyecta como en office-fidelity-e2e.
  const inject = (ambient) => page.evaluate((amb) => {
    const ag = (id, extra = {}) => ({ id, name: id, role: 'back', engine: 'demo', status: 'idle', ...extra });
    const agents = [ag('w1', { status: 'working', taskId: 'T-w1' }), ag('w2', { status: 'working', taskId: 'T-w2' }), ag('free')];
    const tasks = ['w1', 'w2'].map((a) => ({ id: 'T-' + a, code: 'T-' + a, title: 'x', status: 'doing', agentId: a, role: 'back', projectId: 'p' }));
    window.aoOffice.update({ agents, tasks, questions: [], roles: {}, title: 'T', bubbles: 'todas', ambient: amb });
  }, ambient);
  const dbg = () => page.evaluate(() => window.aoOffice.debugState());
  await inject(true);
  await page.evaluate(() => window.aoOffice.simulate(40));
  const base0 = await dbg();
  const slots0 = JSON.stringify(Object.fromEntries(Object.entries(base0.slots).map(([k, v]) => [k, [v.zone, v.slot, v.x, v.z]])));
  check('hay reserva de ≤3 mallas reutilizables', base0.ambient?.meshes === 3 && base0.ambient.max === 3, JSON.stringify(base0.ambient));

  // Reloj acelerado ×40: en 3 min de reloj de pared pasan ~2 h de ambiente.
  await page.evaluate(() => { window.aoOffice.ambientScale = 40; });
  const kinds = new Set(); let maxN = 0, minDist = 99, appeared = false, wentAway = false, mixedNames = true;
  for (let i = 0; i < 300; i++) {
    const d = await dbg();
    const a = d.ambient.visible; maxN = Math.max(maxN, a.length);
    if (a.length) appeared = true; else if (appeared) wentAway = true;
    for (const c of a) {
      kinds.add(c.kind);
      if (!/^ambient:/.test(c.id)) mixedNames = false;
      for (const s of Object.values(d.slots)) minDist = Math.min(minDist, Math.hypot(c.x - s.ax, c.z - s.az));
    }
    if (kinds.size >= 4 && wentAway && i > 60) break;
    await sleep(100);
  }
  check('aparecen personajes de ambiente', appeared);
  check('se van (la planta vuelve a quedar sin ellos)', wentAway);
  check(`varios tipos de episodio (${[...kinds].join(',')})`, kinds.size >= 3, [...kinds].join(','));
  check('nunca más de 3 a la vez', maxN <= 3 && maxN >= 1, String(maxN));
  check('ids con espacio de nombres «ambient:» (no son agentes)', mixedNames);
  check('no pisan a ningún agente real (≥0,4 u)', minDist >= 0.4, minDist.toFixed(2));
  const d2 = await dbg();
  check('los agentes siguen en las mismas mesas y zonas', JSON.stringify(Object.fromEntries(Object.entries(d2.slots).map(([k, v]) => [k, [v.zone, v.slot, v.x, v.z]]))) === slots0);
  check('el ambiente no cambia el recuento de agentes reales', d2.actors === base0.actors, `${base0.actors} → ${d2.actors}`);

  // Interruptor apagado → ninguno.
  await inject(false);
  await sleep(600);
  const off = await dbg();
  check('con el interruptor apagado no hay ambiente', off.ambient.on === false && off.ambient.visible.length === 0, JSON.stringify(off.ambient));
  await inject(true);

  // prefers-reduced-motion → sin ambiente.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sleep(800);
  const red = await dbg();
  check('con prefers-reduced-motion no hay ambiente', red.ambient.on === false && red.ambient.visible.length === 0, JSON.stringify(red.ambient));
  check('sin errores de página', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (err) {
  console.error('  ✗ excepción:', err.message);
  failed++;
} finally {
  try { await browser?.close(); } catch { /* noop */ }
  stop();
}
console.log(failed ? `\n${failed} fallo(s)` : '\nOK');
process.exit(failed ? 1 : 0);
