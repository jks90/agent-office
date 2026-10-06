#!/usr/bin/env node
// e2e de la cuota de las suscripciones (FT-45): normalización de Claude y Codex, caché, token caducado, sin login,
// chip y tarjetas en la UI (puppeteer) y guardarraíl del orquestador con un agente demo tratado como «claude».
//
//   node scripts/quota-e2e.mjs [captura.png]   # opcional: guarda la captura del Resumen
//
// Mocks HTTP de los dos endpoints de uso (AO_CLAUDE_USAGE_URL / AO_CODEX_USAGE_URL), ficheros de login falsos
// (CLAUDE_CONFIG_DIR / CODEX_HOME) y AO_QUOTA_ENGINE_MAP=demo=claude. Sale con 1 si falla algún check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-quota-e2e-'));
let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ── Mocks de los endpoints de uso ─────────────────────────────────────────
const inISO = (min) => new Date(Date.now() + min * 60_000).toISOString();
const claudeBody = (session, weekly, fable) => ({
  limits: [
    { kind: 'session', group: 'session', percent: session, severity: session >= 95 ? 'critical' : session >= 80 ? 'warning' : 'normal', resets_at: inISO(72), is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal', resets_at: inISO(3000), is_active: true },
    { kind: 'weekly_fable', group: 'weekly', percent: fable, severity: 'normal', resets_at: inISO(3000), is_active: true },
  ],
  five_hour: { utilization: session, resets_at: inISO(72) }, seven_day: { utilization: weekly, resets_at: inISO(3000) }, seven_day_opus: null, extra_usage: null,
});
const codexBody = (primary, secondary, limitReached = false) => ({
  plan_type: 'plus',
  rate_limit: {
    allowed: !limitReached, limit_reached: limitReached,
    primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_after_seconds: 5400, reset_at: Math.floor(Date.now() / 1000) + 5400 },
    secondary_window: { used_percent: secondary, limit_window_seconds: 604800, reset_after_seconds: 400000, reset_at: Math.floor(Date.now() / 1000) + 400000 },
  },
  credits: null, rate_limit_reached_type: null,
});
const mock = { claude: claudeBody(88, 46, 69), codex: codexBody(84, 30), hits: { claude: 0, codex: 0 }, seen: {} };
const mockPort = await freePort();
const mockSrv = http.createServer((req, res) => {
  const which = req.url.startsWith('/claude') ? 'claude' : req.url.startsWith('/codex') ? 'codex' : null;
  if (!which) return res.writeHead(404).end('{}');
  mock.hits[which]++; mock.seen[which] = req.headers;
  if (mock.fail?.[which]) return res.writeHead(mock.fail[which], { 'content-type': 'application/json', 'retry-after': '1' }).end('{}');
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mock[which]));
}).listen(mockPort, '127.0.0.1');
const CLAUDE_URL = `http://127.0.0.1:${mockPort}/claude`, CODEX_URL = `http://127.0.0.1:${mockPort}/codex`;

// ── Logins falsos ─────────────────────────────────────────────────────────
const claudeDir = path.join(tmp, 'claude'), codexDir = path.join(tmp, 'codex'), emptyDir = path.join(tmp, 'vacio');
for (const d of [claudeDir, codexDir, emptyDir]) fs.mkdirSync(d, { recursive: true });
const TOKEN_C = 'sk-ant-oat-SECRETO-claude', TOKEN_X = 'eyJ-SECRETO-codex';
const writeClaudeLogin = (expiresAt) => fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_C, refreshToken: 'r', expiresAt, subscriptionType: 'max' } }));
writeClaudeLogin(Date.now() + 3600_000);
fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN_X, account_id: 'acc-123' } }));

// ── 1. Módulo en proceso: normalización, caché, caducado, sin login ───────
section('server/quota.js: normalización, caché y errores');
Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, AO_CLAUDE_USAGE_URL: CLAUDE_URL, AO_CODEX_USAGE_URL: CODEX_URL });
const q = await import('../server/quota.js');
const c = await q.readClaudeQuota();
check('Claude: ok, plan max y 3 ventanas (sesión, semanal, modelo)', c.ok && c.plan === 'max' && c.windows.map((w) => w.id).join() === 'session,weekly,model:fable', JSON.stringify(c.windows.map((w) => w.id)));
check('Claude: porcentajes 88 / 46 / 69 y severidad warning en la sesión', c.windows.map((w) => w.percent).join() === '88,46,69' && c.windows[0].severity === 'warning');
check('Claude: resetsAt en ms (~72 min)', Math.abs(c.windows[0].resetsAt - Date.now() - 72 * 60_000) < 60_000);
check('Claude: cabeceras Bearer + anthropic-beta', mock.seen.claude.authorization === `Bearer ${TOKEN_C}` && mock.seen.claude['anthropic-beta'] === 'oauth-2025-04-20');
check('Claude: etiqueta del modelo', c.windows[2].label.includes('Fable'));
const x = await q.readCodexQuota();
check('Codex: ok, plan plus, sesión 84 % y semanal 30 %', x.ok && x.plan === 'plus' && x.windows.map((w) => `${w.id}:${w.percent}`).join() === 'session:84,weekly:30');
check('Codex: severidad por umbral (84 → warning) y resetsAt en ms', x.windows[0].severity === 'warning' && Math.abs(x.windows[0].resetsAt - Date.now() - 5400_000) < 60_000);
check('Codex: cabeceras Bearer + ChatGPT-Account-Id', mock.seen.codex.authorization === `Bearer ${TOKEN_X}` && mock.seen.codex['chatgpt-account-id'] === 'acc-123');
check('Severidad crítica por umbral (≥95)', q.normalizeCodex(codexBody(96, 1)).windows[0].severity === 'critical');
check('Codex: limit_reached → limitReached', q.normalizeCodex(codexBody(100, 5, true)).limitReached === true);
check('Claude: sin `limits`, usa five_hour/seven_day/seven_day_sonnet', (() => { const n = q.normalizeClaude({ five_hour: { utilization: 10, resets_at: inISO(5) }, seven_day: { utilization: 20 }, seven_day_sonnet: { utilization: 30 }, seven_day_opus: null }); return n.windows.map((w) => w.id).join() === 'session,weekly,model:sonnet'; })());
const before = { ...mock.hits };
await q.readClaudeQuota(); await q.readCodexQuota(); await q.readAll();
check('Caché de 60 s: no vuelve a llamar al proveedor', mock.hits.claude === before.claude && mock.hits.codex === before.codex, JSON.stringify(mock.hits));
await q.readClaudeQuota({ force: true });
check('force=1 se salta la caché', mock.hits.claude === before.claude + 1);
q.resetCache();
writeClaudeLogin(Date.now() - 1000);
const h0 = mock.hits.claude;
const exp = await q.readClaudeQuota();
check('Token caducado: ok:false «token caducado: usa claude una vez», sin llamar a la red', !exp.ok && /token caducado: usa claude una vez/.test(exp.reason) && mock.hits.claude === h0, exp.reason);
process.env.CLAUDE_CONFIG_DIR = emptyDir; process.env.CODEX_HOME = emptyDir; q.resetCache();
const nl = await q.readClaudeQuota(), nx = await q.readCodexQuota();
check('Sin fichero de login: {ok:false, reason:"sin login"} en ambos', !nl.ok && nl.reason === 'sin login' && !nx.ok && nx.reason === 'sin login');
check('Ninguna respuesta contiene los tokens', !JSON.stringify([c, x, exp]).includes('SECRETO'));
Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir });
writeClaudeLogin(Date.now() + 3600_000);
// 429 del proveedor: espera creciente y última lectura buena marcada como antigua (no «sin dato»)
q.resetCache();
const good = await q.readClaudeQuota();
mock.fail = { claude: 429 };
const st1 = await q.readClaudeQuota({ force: true });
check('429 con dato bueno previo: se enseña el último dato marcado stale (con motivo y hora de reintento)', st1.ok && st1.stale && /429/.test(st1.staleReason) && st1.windows.length === good.windows.length && st1.retryAt > Date.now(), JSON.stringify(st1).slice(0, 200));
const h429 = mock.hits.claude;
await q.readClaudeQuota({ force: true });
check('En espera tras el 429 ni el «forzar» vuelve a preguntar', mock.hits.claude === h429);
q.resetCache();
const st2 = await q.readClaudeQuota();
check('429 sin dato previo: sin dato con el motivo «limita las consultas (429)»', !st2.ok && /limita las consultas \(429\)/.test(st2.reason), st2.reason);
mock.fail = null; q.resetCache();
// Instancia de pruebas (AO_DATA_DIR propio) sin endpoint propio: no usa la cuota real del usuario
const savedUrl = process.env.AO_CLAUDE_USAGE_URL; delete process.env.AO_CLAUDE_USAGE_URL; process.env.AO_DATA_DIR = tmp;
const hT = mock.hits.claude, ti = await q.readClaudeQuota();
check('Instancia de pruebas sin endpoint propio: no consulta la cuota real', !ti.ok && /instancia de pruebas/.test(ti.reason) && mock.hits.claude === hT, ti.reason);
process.env.AO_CLAUDE_USAGE_URL = savedUrl; delete process.env.AO_DATA_DIR; q.resetCache();

// ── 2. Servidor temporal ──────────────────────────────────────────────────
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
const homeDir = path.join(tmp, 'home'), dataDir = path.join(tmp, 'data');
fs.mkdirSync(homeDir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_QUOTA_TTL: '1500', AO_QUOTA_ENGINE_MAP: 'demo=claude' },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
let browser;
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { mockSrv.close(); stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const state = async () => (await call('GET', '/api/state')).body;
await until(async () => { try { await fetch(base + '/api/state'); return true; } catch { return false; } }, 10_000, 100);

try {
  section('API: GET /api/quota y snapshot SSE');
  mock.claude = claudeBody(88, 46, 69); mock.codex = codexBody(84, 30);
  const api = (await call('GET', '/api/quota?force=1')).body;
  check('GET /api/quota devuelve claude y codex con la forma común', api.claude?.ok && api.codex?.ok && Array.isArray(api.claude.windows) && typeof api.claude.fetchedAt === 'number', JSON.stringify(api).slice(0, 200));
  const snap = await until(async () => { const s = await state(); return s.quota?.claude && s.quota?.codex ? s : null; }, 5000);
  check('El snapshot /api/state trae `quota`', !!snap, serverLog.slice(-300));
  check('Ajuste por defecto: quotaGuard no está desactivado', snap?.settings.quotaGuard !== false);

  section('UI: chip y tarjetas');
  const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((p) => p && fs.existsSync(p));
  if (!chrome) throw new Error('No encuentro Chrome/Chromium (AO_CHROME=…)');
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  const chipText = async () => page.$eval('#quota-chip', (e) => (e.hidden ? '' : e.textContent.trim())).catch(() => '');
  check('Chip: «Claude 88 % · Codex 84 %»', await until(async () => (await chipText()) === 'Claude 88 % · Codex 84 %', 6000), await chipText());
  check('Chip en ámbar (≥80)', await page.$eval('#quota-chip', (e) => e.classList.contains('warn') && !e.classList.contains('bad')));
  await page.click('#quota-chip');
  const cards = await until(async () => { const t = await page.$eval('#quota-cards', (e) => e.innerText).catch(() => ''); return /Claude/.test(t) && /Codex/.test(t) ? t : null; }, 5000);
  check('Clic en el chip abre el Resumen con las tarjetas', !!cards && await page.$eval('#summary', (e) => e.offsetParent !== null));
  check('Tarjeta Claude: plan, Sesión 5 h 88 %, Semanal 46 %, modelo Fable 69 %, «se reinicia en 1 h 1x min»', /max/.test(cards) && /Sesión 5 h[\s\S]*88 %/.test(cards) && /Semanal 7 d[\s\S]*46 %/.test(cards) && /Fable[\s\S]*69 %/.test(cards) && /se reinicia en 1 h \d\d min/.test(cards), cards);
  check('Tarjeta Codex: plan plus, sesión 84 % y semanal 30 %', /plus/.test(cards) && /84 %/.test(cards) && /30 %/.test(cards));
  check('El bloque queda encima de la tabla «Tokens por sesión»', await page.$eval('#summary', (e) => e.innerHTML.indexOf('quota-cards') < e.innerHTML.indexOf('Tokens por sesión')));
  await page.screenshot({ path: path.join(tmp, 'quota.png') });
  // Sube a 98 % → chip rojo (el servidor refresca con su TTL de 1,5 s)
  mock.claude = claudeBody(98, 46, 69);
  check('Chip en rojo con ≥95 % (llega solo por SSE)', await until(async () => page.$eval('#quota-chip', (e) => e.classList.contains('bad') && /Claude 98 %/.test(e.textContent)).catch(() => false), 8000));
  check('Barras con color por severidad (rojo en la sesión)', await page.$eval('[data-quota-win="claude:session"] .tokbar', (e) => e.classList.contains('bad')));

  section('Sin dato: tarjeta con el motivo');
  fs.rmSync(path.join(codexDir, 'auth.json'));
  check('Codex sin login → tarjeta «sin dato · sin login»', await until(async () => /sin dato · sin login/.test(await page.$eval('#quota-cards', (e) => e.innerText).catch(() => '')), 8000));
  check('El chip solo muestra el motor con dato', (await chipText()) === 'Claude 98 %', await chipText());
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN_X, account_id: 'acc-123' } }));

  section('Guardarraíl del orquestador (agente demo tratado como «claude»)');
  // Claude está al 98 % (≥97)
  const proj = (await call('POST', '/api/projects', { name: 'e2e-quota', engine: 'demo' })).body;
  await call('POST', `/api/projects/${proj.id}/run`, { running: true });
  const t = (await call('POST', '/api/tasks', { projectId: proj.id, role: 'back', title: 'Tarea con cuota agotada' })).body;
  const held = await until(async () => { const x = (await state()).tasks.find((k) => k.id === t.id); return x?.activity?.startsWith('⏸') ? x : null; }, 8000);
  check('La tarea queda en todo con activity «⏸ Claude al 98 %: espera al reinicio de las HH:MM»', !!held && held.status === 'todo' && /^⏸ Claude al 98 %: espera al reinicio de las \d\d:\d\d$/.test(held.activity), held?.activity);
  await sleep(2500);
  const still = (await state()).tasks.find((k) => k.id === t.id);
  check('Sigue en todo sin arrancar (sin agentes trabajando)', still.status === 'todo' && !(await state()).agents.some((a) => a.status === 'working'));
  const ev = (await call('GET', `/api/events?taskId=${t.id}`)).body.filter((e) => e.type === 'AgentBlocked' && e.data.reason === 'quota');
  check('Evento AgentBlocked {reason:"quota"} emitido una sola vez', ev.length === 1, `${ev.length}`);
  // Guardarraíl apagado → arranca aunque esté al 98 %
  await call('POST', '/api/settings', { quotaGuard: false });
  check('Con quotaGuard=false la tarea arranca (aunque esté al 98 %)', !!(await until(async () => (await state()).tasks.find((k) => k.id === t.id).status !== 'todo', 10_000)));
  await call('POST', '/api/settings', { quotaGuard: true });
  // Segunda tarea: se frena y se reanuda sola al bajar el %
  const t2 = (await call('POST', '/api/tasks', { projectId: proj.id, role: 'front', title: 'Se reanuda al bajar el %' })).body;
  check('Con el guardarraíl activo de nuevo, la segunda tarea espera', !!(await until(async () => (await state()).tasks.find((k) => k.id === t2.id)?.quotaBlocked, 8000)));
  mock.claude = claudeBody(40, 46, 69);
  check('Al bajar el % (40 %), tick() la retoma sola y limpia el aviso', !!(await until(async () => { const x = (await state()).tasks.find((k) => k.id === t2.id); return x.status !== 'todo' && !x.quotaBlocked; }, 12_000)));
  section('Ajustes: casilla del guardarraíl');
  check('El diálogo de Ajustes trae la casilla «Guardarraíl de cuota» marcada', await (async () => {
    await page.evaluate(() => document.querySelector('[data-action="settings"]').click());
    return !!(await until(async () => page.$eval('input[name=quotaGuard]', (e) => e.checked).catch(() => false), 4000));
  })());
  check('Sin errores de página', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (process.argv[2]) fs.copyFileSync(path.join(tmp, 'quota.png'), path.resolve(process.argv[2]));
} catch (e) {
  failed++; console.log(`  ✗ excepción: ${e.message}`);
  if (serverLog.trim()) console.log(serverLog.trim().slice(-1500));
} finally {
  if (browser) await browser.close().catch(() => {});
  console.log(`\n${failed ? '✗' : '✓'} ${passed} correctos, ${failed} fallidos`);
  cleanup();
  process.exit(failed ? 1 : 0);
}
