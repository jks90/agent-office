#!/usr/bin/env node
// FT-148: los agentes reales están SIEMPRE donde dice su estado. Servidor temporal + Chrome headless; se inyectan agentes en
// cada estado con aoOffice.update(), se acelera el reloj con aoOffice.simulate(s) y se mira dónde acaba cada avatar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 7990 + Math.floor(Math.random() * 20);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fidelity-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;
const REST = new Set(['cafe', 'nevera', 'planta', 'charla']); // paseos permitidos (descanso/recreo)

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 12000 });

  await page.evaluate(() => {
    const ag = (id, extra = {}) => ({ id, name: id, role: 'back', engine: 'demo', status: 'idle', ...extra });
    const tk = (id, agentId, status, extra = {}) => ({ id: 'T-' + id, code: 'T-' + id, title: 'x', status, agentId, role: 'back', projectId: 'p', ...extra });
    const agents = [
      ag('work', { status: 'working', taskId: 'T-work' }), ag('rev', { taskId: 'T-rev' }), ag('wait', { taskId: 'T-wait' }),
      ag('dep', { taskId: 'T-dep' }), ag('fail', { taskId: 'T-fail' }), ag('quota', { status: 'working', taskId: 'T-quota', quotaBlocked: true }),
      ag('free'), ag('ask', { status: 'working', taskId: 'T-ask' }),
    ];
    const tasks = [
      tk('work', 'work', 'doing'), tk('rev', 'rev', 'review'), tk('wait', 'wait', 'todo'), tk('dep', 'dep', 'todo', { dependsOn: ['T-nope'] }),
      tk('fail', 'fail', 'failed'), tk('quota', 'quota', 'doing', { quotaBlocked: true }), tk('ask', 'ask', 'doing'),
    ];
    const mine = { total: 1, items: [{ kind: 'question', agentId: 'ask', projectId: 'p' }] };
    window.aoOffice.update({ agents, tasks, questions: [], roles: {}, title: 'T', bubbles: 'todas', mine });
  });
  const dbg = () => page.evaluate(() => window.aoOffice.debugState());

  await page.evaluate(() => window.aoOffice.simulate(40));
  const d = await dbg();
  const S = d.slots;
  const at = (id) => { const s = S[id]; return s && Math.hypot(s.ax - s.x, s.az - s.z) < 0.12 && !s.moving; };
  // Cada estado → su zona, y el avatar ya en su hueco.
  // FT-149 (v3): revisión → qa; bloqueado por dependencia → Kanban (wait-i); el libre se sienta en el sofá y NO pasea (el ambiente son personajes aparte).
  const expect = { work: 'development', rev: 'qa', wait: 'board', dep: 'board', fail: 'development', quota: 'development' };
  for (const [id, zone] of Object.entries(expect)) check(`${id}: zona ${zone} y en su sitio`, S[id]?.zone === zone && at(id), JSON.stringify(S[id]));
  check('work: sentado tecleando', S.work?.sit === true && S.work.wander === null, JSON.stringify(S.work));
  check('fail: sentado en su mesa (aro rojo)', S.fail?.status === 'failed', JSON.stringify(S.fail));
  check('quota: en su mesa, no pasea', S.quota?.status === 'blocked' && S.quota.wander === null, JSON.stringify(S.quota));
  const ask = d.waiting.ask;
  check('ask: junto a la mesa «Tú»', !!ask && !ask.moving && Math.hypot(ask.ax - d.deskPos.x, ask.az - d.deskPos.z) < 1.6, JSON.stringify({ ask, desk: d.deskPos }));
  check('free: en descanso o en un paseo de recreo', S.free?.zone === 'idle', JSON.stringify(S.free));

  // 60 s simulados: el que trabaja no se mueve de su mesa; el libre solo pasea por recreo; nadie más pasea.
  const home = { x: S.work.ax, z: S.work.az };
  let workMoved = false, badWander = [], freeWandered = false;
  for (let t = 0; t < 60; t += 1) {
    await page.evaluate(() => window.aoOffice.simulate(1));
    const s = (await dbg()).slots;
    if (Math.hypot(s.work.ax - home.x, s.work.az - home.z) > 0.01 || !String(s.work.key).startsWith('development')) workMoved = true;
    for (const [id, v] of Object.entries(s)) {
      if (v.wander && id !== 'free') badWander.push(id + ':' + v.wander);
      if (v.wander && id === 'free') { freeWandered = true; if (!REST.has(v.wander)) badWander.push(id + ':' + v.wander); }
    }
  }
  check('work no sale de su mesa en 60 s simulados', !workMoved);
  check('solo el libre pasea y solo por descanso/recreo', badWander.length === 0, badWander.join(','));
  check('el libre NO pasea (v3: solo el ambiente se mueve)', !freeWandered);

  // Cambio de estado: work pasa a revisión y camina a su zona.
  await page.evaluate(() => {
    const o = window.aoOffice;
    o.update({ agents: o.agents.map((a) => (a.id === 'work' ? { ...a, status: 'idle' } : a)), tasks: o.tasks.map((t) => (t.agentId === 'work' ? { ...t, status: 'review' } : t)), questions: [] });
    o.simulate(30);
  });
  const s2 = (await dbg()).slots.work;
  check('al cambiar de estado camina a su sitio nuevo (Revisión)', s2.zone === 'qa' && Math.hypot(s2.ax - s2.x, s2.az - s2.z) < 0.12, JSON.stringify(s2));

  check('sin errores de página', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed++;
  console.error(e);
} finally {
  await browser?.close();
  stop();
}
console.log(failed ? `\n✗ ${failed} fallo(s)` : '\n✓ office-fidelity-e2e OK');
process.exit(failed ? 1 : 0);
