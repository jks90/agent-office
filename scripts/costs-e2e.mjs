#!/usr/bin/env node
// e2e de FT-76 (observabilidad de costes). Servidor temporal + `claude` FALSO que emite usos conocidos por turno
// (lectura de fichero, comando con imagen) en DOS intentos (el 2º tras «Devolver»). Comprueba: telemetría por turno
// (data/costs/<proyecto>/<tarea>.jsonl), coste calculado con la tabla de precios, desglose por causa (suma = total,
// reintentos = intento tirado, fichero más caro), KPI y comparación con una línea base (manual y por transcript),
// el recorder de Codex con eventos falsos, el endpoint de detalle/export y — si hay Chrome — la pestaña «💸 Costes» sin errores.
// `node scripts/costs-e2e.mjs ruta.png` guarda una captura de la pestaña.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-costs-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, repo, claudeDir, path.join(home, '.claude', 'projects', 'x')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

// Claude falso: 3 turnos por intento con usos conocidos (precios sonnet: 3 / 0,3 / 3,75 / 15 $ por Mtok).
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const M = 'claude-sonnet-4-5';
const asst = (id, usage, content) => out({ type: 'assistant', message: { id, model: M, usage, content } });
readline.createInterface({ input: process.stdin }).once('line', () => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-cost', model: M, tools: [] });
  asst('m1', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000, output_tokens: 50 }, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/public/app.js' } }]);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } });
  asst('m2', { input_tokens: 10, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1100, output_tokens: 100 }, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'y'.repeat(400) }, { type: 'image', source: {} }] }] } });
  asst('m3', { input_tokens: 5, cache_read_input_tokens: 11000, cache_creation_input_tokens: 500, output_tokens: 200 }, [{ type: 'text', text: 'Listo' }]);
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.055395, result: 'Hecho.' });
  setTimeout(() => process.exit(0), 50);
});
`, { mode: 0o755 });

const port = await freePort(), base = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), costTargetPct: 100 } }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const p = await call('POST', '/api/projects', { name: 'costes', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'sonnet' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const t = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea de costes', role: 'back', repo: 'demo' });
  check('intento 1 llega a Revisión', !!(await until(async () => (await task(t.id))?.status === 'review', 20_000, 300)));
  await call('POST', `/api/tasks/${t.id}/reject`, { feedback: 'Otra vuelta.' });
  await until(async () => { const x = await task(t.id); return x?.status === 'review' && x.attempts === 2; }, 20_000, 300);

  console.log('Telemetría por turno');
  const file = path.join(dataDir, 'costs', p.id, `${t.id}.jsonl`);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check('6 turnos (3 por intento) en data/costs/<proyecto>/<tarea>.jsonl', lines.length === 6 && lines.map((l) => l.attempt).join('') === '111222', String(lines.length));
  check('tokens por turno exactos', lines[0]?.input === 100 && lines[0].cacheWrite === 10000 && lines[1]?.cacheRead === 10000 && lines[2]?.output === 200);
  check('coste del turno 1 = 0,03855 $ con la tabla de precios', near(lines[0]?.costUsd, 0.03855), String(lines[0]?.costUsd));
  check('herramienta y fichero del turno 1 (Read app.js, 4000 bytes)', lines[0]?.tool === 'Read' && lines[0].tools[0].file === '/repo/public/app.js' && lines[0].tools[0].bytes === 4000);
  check('el turno 2 (Bash) devolvió 400 bytes e imagen', lines[1]?.tool === 'Bash' && lines[1].bytes === 400 && lines[1].image === true && lines[0].image === false);
  check('motor y modelo registrados', lines[0]?.engine === 'claude' && /sonnet/.test(lines[0].model));
  check('FT-26 intacto: coste total acumulado de la tarea', near((await task(t.id)).costUsd, 0.11079, 1e-6), String((await task(t.id)).costUsd));

  console.log('Detalle, desglose y KPI');
  const d = await call('GET', `/api/costs/${p.id}/${t.id}`);
  const b = d.breakdown || {};
  check('coste total 0,11079 $; aceptado 0,055395 y tirado 0,055395', near(d.costUsd, 0.11079, 1e-5) && near(d.acceptedUsd, 0.055395, 1e-5) && near(d.discardedUsd, 0.055395, 1e-5), JSON.stringify([d.costUsd, d.acceptedUsd, d.discardedUsd]));
  check('desglose: suma de causas = total y reintentos = intento tirado', near(['arranque', 'lecturas', 'comandos', 'imagenes', 'salida', 'reintentos'].reduce((s, k) => s + b[k], 0), d.costUsd, 1e-4) && near(b.reintentos, 0.055395, 1e-5), JSON.stringify(b));
  check('desglose: salida = (50 + 100 + 200) tokens del intento aceptado (0,00525 $)', near(b.salida, 0.00525, 1e-5), String(b.salida));
  check('desglose: lecturas, comandos e imágenes > 0 y app.js es el fichero más caro', b.lecturas > 0 && b.comandos > 0 && b.imagenes > 0 && b.files?.[0]?.file === '/repo/public/app.js');
  check('curva de contexto por turno del intento aceptado', JSON.stringify(d.curve) === JSON.stringify([10100, 11110, 11505]), JSON.stringify(d.curve));
  check('% de caché y ahorro calculados', d.cachePct > 40 && d.cacheSavedUsd > 0, `${d.cachePct} ${d.cacheSavedUsd}`);

  // Aprobada (simulado: el estado real se cambia solo en memoria para no mezclar git en este e2e) + línea base manual
  process.env.AO_DATA_DIR = dataDir;
  const costs = await import('../server/costs.js');
  const st = await call('GET', '/api/state');
  const state = { ...st, tasks: st.tasks.map((x) => (x.id === t.id ? { ...x, status: 'done' } : x)) };
  await call('POST', '/api/costs/baseline', { code: 'FT-66', costUsd: 0.5 });
  const o = costs.overview(state);
  check('KPI: 1 aprobada, 0,11079 $ por aprobada, 0 % a la primera (1 devolución)', o.kpi.approved === 1 && near(o.kpi.perApprovedUsd, 0.1108, 1e-4) && o.kpi.firstTryPct === 0, JSON.stringify(o.kpi));
  check('vs interactivo (0,5 $): 22 % y cumple el objetivo ≤100 %', o.kpi.ratioPct === 22 && o.kpi.meetsTarget === true, `${o.kpi.ratioPct} ${o.kpi.meetsTarget}`);
  check('tabla por rol/modelo/motor/proyecto', o.byRole[0]?.key === 'back' && /sonnet/.test(o.byModel[0]?.key) && o.byEngine[0]?.key === 'claude' && o.byProject[0]?.key === 'costes');
  check('objetivo semanal: la semana en curso cumple', o.weekly.length === 1 && o.weekly[0].meetsTarget === true);
  const strict = costs.overview({ ...state, settings: { ...state.settings, costTargetPct: 10 } });
  check('con objetivo ≤10 % no cumple y recomienda', strict.kpi.meetsTarget === false && strict.recommendations.some((r) => r.kind === 'objetivo'));
  check('recomendación sobre reintentos (50 % del gasto)', o.recommendations.some((r) => r.kind === 'reintentos'), JSON.stringify(o.recommendations));

  console.log('Línea base por transcript y export');
  const tr = path.join(home, '.claude', 'projects', 'x', 's.jsonl');
  fs.writeFileSync(tr, [{ type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000, output_tokens: 50 } } },
    { type: 'assistant', timestamp: '2026-10-01T10:00:01Z', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000, output_tokens: 50 } } }, // mismo id: no duplica
    { type: 'assistant', timestamp: '2026-10-01T10:30:00Z', message: { id: 'b', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1100, output_tokens: 100 } } }].map((x) => JSON.stringify(x)).join('\n'));
  const bl = await call('POST', '/api/costs/baseline', { code: 'FT-75', transcript: tr, lines: 100 });
  check('transcript: 2 turnos y 0,047205 $ (sin duplicar mensajes)', bl.turns === 2 && near(bl.costUsd, 0.047205, 1e-5), JSON.stringify(bl));
  check('un transcript fuera de ~/.claude se rechaza', !!(await call('POST', '/api/costs/baseline', { code: 'X', transcript: '/etc/passwd' })).error);
  check('GET /api/costs lista tarea y línea base (2)', (await call('GET', '/api/costs')).baseline.length === 2);
  const csv = (await call('GET', '/api/costs/export?format=csv')).csv || '';
  check('export CSV con cabecera y 6 filas', csv.split('\n').length === 7 && /costUsd/.test(csv.split('\n')[0]));

  console.log('Codex (eventos falsos)');
  const cx = costs.recorder({ projectId: 'pcx', taskId: 'tcx', attempt: 1, engine: 'codex', model: 'gpt-5-codex', role: 'back' });
  cx.feed({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'z'.repeat(300) } });
  cx.feed({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } });
  cx.finish();
  const cl = costs.readTurns('pcx', 'tcx');
  check('Codex: 1 turno, entrada fresca 600 + caché 400, coste 0,0013 $, Bash 300 bytes', cl.length === 1 && cl[0].input === 600 && cl[0].cacheRead === 400 && near(cl[0].costUsd, 0.0013, 1e-6) && cl[0].tool === 'Bash' && cl[0].bytes === 300, JSON.stringify(cl[0]));

  const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
  let puppeteer = null; try { puppeteer = (await import('puppeteer-core')).default; } catch { /* sin devDependency */ }
  if (chrome && puppeteer) {
    console.log('Pestaña «💸 Costes»');
    const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
    try {
      const page = await browser.newPage(); await page.setViewport({ width: 1500, height: 900 });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(base, { waitUntil: 'networkidle2' });
      await page.click('[data-tab="summary"]'); await page.click('[data-sum-view="costs"]');
      await page.waitForSelector('.cost-stack', { timeout: 8000 });
      const txt = await page.$eval('#summary', (e) => e.textContent);
      check('la pestaña pinta KPI, desglose y línea base', /coste por tarea aprobada/.test(txt) && /FT-66/.test(txt) && /Arranque/.test(txt), txt.slice(0, 120));
      if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
      check('sin errores de consola', !errors.length, errors.join(' | '));
    } finally { await browser.close(); }
  } else console.log('  (sin Chrome/puppeteer-core: se omite la prueba de UI)');
} catch (e) { failed++; console.error('Error:', e.stack || e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
