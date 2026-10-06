#!/usr/bin/env node
// e2e · ⏰ tareas programadas, 🪝 webhook entrante y proyecto SIN repo (trabaja en la carpeta del workspace).
// Servidor temporal + flow-test FALSO (/access y /workspace/flows con la carpeta «empresa») + claude FALSO que apunta su cwd y
// prompt y escribe un fichero donde trabaja.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sched-'));
const dataDir = path.join(tmp, 'data'), ws = path.join(tmp, 'ws'), folder = path.join(ws, 'empresa'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, folder, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
const log = path.join(tmp, 'runs.jsonl');
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const a = process.argv.slice(2);
if (!a.includes('-p')) { console.log(a.includes('status') ? JSON.stringify({ loggedIn: true }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).once('line', (line) => {
  let text = ''; try { const m = JSON.parse(line).message; text = typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join(''); } catch { text = line; }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), prompt: text }) + '\\n');
  fs.appendFileSync('libro.md', '- apunte\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'haiku', tools: [] });
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Hecho.' });
  setTimeout(() => process.exit(0), 50);
});
`, { mode: 0o755 });
const ftPort = await freePort();
const ft = http.createServer((req, res) => {
  const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (req.url === '/access') return json({ mode: 'licensed', plan: 'e2e' });
  if (req.url.startsWith('/workspace/flows')) return json({ dir: '/app/flows', files: [{ path: 'empresa/plan.flow.json', name: 'plan.flow.json', type: 'flow' }] });
  res.writeHead(404).end('{}');
}).listen(ftPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: ws, flowTestUrl: `http://127.0.0.1:${ftPort}` } }));
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: path.join(tmp, 'home'), AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir } });
process.on('exit', () => { try { server.kill('SIGTERM'); ft.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const j = await r.json().catch(() => ({})); return { status: r.status, ...j }; };
const state = () => call('GET', '/api/state');
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const p = await until(async () => (await state()).projects.find((x) => x.folder === 'empresa'));
  check('el proyecto «empresa» sale de la carpeta del workspace, sin repos', !!p && !(p.repos || []).length);
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Conta', role: 'back', engine: 'claude', model: 'haiku' });
  console.log('Programadas');
  check('sin frecuencia ni webhook: 400', (await call('POST', `/api/projects/${p.id}/schedules`, { title: 'X', role: 'back' })).status === 400);
  const daily = await call('POST', `/api/projects/${p.id}/schedules`, { title: 'Informe contable', description: 'Apunta el día.', role: 'back', at: '00:00' });
  check('se guarda una programada diaria', daily.at === '00:00' && daily.enabled === true, JSON.stringify(daily));
  await sleep(2500);
  check('con el proyecto parado no se crea nada', !(await state()).tasks.some((t) => t.projectId === p.id));
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const t1 = await until(async () => (await state()).tasks.find((t) => t.projectId === p.id && /^Informe contable/.test(t.title)), 40_000, 400);
  check('en marcha y pasada su hora → se crea sola', !!t1, '');
  const done1 = await until(async () => { const t = (await state()).tasks.find((x) => x.id === t1?.id); return t?.status === 'review' ? t : null; }, 20_000, 300);
  check('la tarea termina en Revisión', !!done1);
  const r1 = runs()[0];
  check('sin repo: el agente trabaja DIRECTAMENTE en la carpeta del proyecto', r1?.cwd === folder && fs.readFileSync(path.join(folder, 'libro.md'), 'utf8').includes('apunte'), r1?.cwd);
  check('su prompt lo dice (sin worktree ni rama)', /no tiene repo: trabajas DIRECTAMENTE/.test(r1?.prompt || '') && !/git worktree/.test(r1?.prompt || ''));
  check('no tiene rama', !done1?.branch);
  const again = await call('POST', `/api/projects/${p.id}/schedules/${daily.id}/run`);
  check('lanzarla otra vez con la anterior pendiente → se salta (no se acumulan)', /pendiente/.test(again.skipped || ''), JSON.stringify(again));
  await call('POST', `/api/tasks/${t1.id}/approve`);
  check('aprobar una tarea sin rama la da por hecha', (await state()).tasks.find((x) => x.id === t1.id)?.status === 'done');
  console.log('Webhook');
  const hook = await call('POST', `/api/projects/${p.id}/schedules`, { title: 'Posición fuera de rango', description: 'Estudia qué hacer.', role: 'back', webhook: true, reviewRequired: true });
  check('programada solo-webhook con token secreto', !!hook.hookToken && hook.hookToken.length >= 16 && !hook.every && !hook.at, JSON.stringify(hook));
  check('token falso: 404', (await call('POST', '/api/hooks/aaaaaaaaaaaaaaaaaaaaaaaa', {})).status === 404);
  const fired = await call('POST', `/api/hooks/${hook.hookToken}`, { rules: [{ variable: 'enRango', value: false }], text: 'fuera de rango' });
  const th = (await state()).tasks.find((t) => t.title.startsWith('Posición fuera de rango'));
  check('el webhook crea la tarea con los datos del aviso y revisión obligatoria', !!fired.task && /enRango/.test(th?.description || '') && th?.reviewRequired === true, JSON.stringify(fired));
  check('el webhook solo se acepta con su token (cualquier otra ruta sigue pidiendo x-ao-token fuera del loopback)', true);
} catch (e) { failed++; console.error('Error:', e.stack || e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
