#!/usr/bin/env node
// e2e de FT-134 · sin procesos en segundo plano en los workers `claude -p`.
// Servidor temporal + `claude` FALSO (AO_CLAUDE_BIN) que: (1) ejecuta el hook de --settings con un Bash run_in_background:true y guarda la
// respuesta; (2) el 1.er intento termina con «me avisará…» sin cambios → la tarea vuelve a Por hacer (no a Revisión); el 2.º entrega un fichero.
import { spawn, execFileSync } from 'node:child_process';
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
const until = async (fn, ms = 10_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-nobg-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

const hookLog = path.join(tmp, 'hook.log'), runsLog = path.join(tmp, 'runs.log');
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv;
const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
let prompt = '', tag = '', n = 0;
readline.createInterface({ input: process.stdin }).once('line', (l) => {
  prompt = l; tag = (l.match(/\\[(A|LOOP|DOC|BUILD)\\]/) || [])[1];
  fs.appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ tag, env: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS }) + '\\n');
  n = fs.readFileSync(${JSON.stringify(runsLog)}, 'utf8').trim().split('\\n').map((x) => JSON.parse(x)).filter((x) => x.tag === tag).length;
  run();
});
function run() {
  out({ type: 'system', subtype: 'init', session_id: 's' + n, model: 'haiku', tools: [] });
  for (const h of settings.hooks.PreToolUse.flatMap((x) => x.hooks)) {
    if (!/ao-nobg/.test(h.command)) continue;
    const res = execSync(h.command, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node scripts/browser-bench.mjs', run_in_background: true } }) }).toString();
    const ok = execSync(h.command, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }) }).toString();
    fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ res, ok, rules: /SEGUNDO PLANO/.test(prompt) }) + '\\n');
  }
  let result = 'Lancé el benchmark en segundo plano; me avisará cuando termine.';
  if (tag === 'A' && n >= 2) { fs.writeFileSync('entregable.txt', 'hecho\\n'); result = 'Hecho: entregable.txt creado.'; }
  if (tag === 'DOC') { fs.writeFileSync(${JSON.stringify(path.join(tmp, 'informe-fuera.md'))}, 'informe\\n'); result = 'Informe en ${path.join(tmp, 'informe-fuera.md')}; me avisará el lanzador si algo falla.'; }
  if (tag === 'BUILD') result = 'Cuando termine el build lo comprobé: todo bien, sin cambios necesarios.';
  out({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, session_id: 's' + n });
}
`, { mode: 0o755 });

const stubPort = await freePort();
const stub = http.createServer((req, res) => res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' }).end(req.url === '/access' ? JSON.stringify({ mode: 'licensed', plan: 'e2e' }) : '{}')).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);

try {
  const p = await call('POST', '/api/projects', { name: 'nobg', repos: [{ key: 'r', path: repo }], engine: 'claude' });
  await call('POST', '/api/agents', { projectId: p.id, name: 'Vera', role: 'back', engine: 'claude', model: 'haiku' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const runTag = async (tag) => { // tareas una a una, para separar sus ejecuciones
    const t = await call('POST', '/api/tasks', { projectId: p.id, title: `Lanzar benchmark [${tag}]`, role: 'back', repo: 'r', sizeChecked: true });
    return { t, done: await until(async () => { const x = await task(t.id); return ['review', 'failed'].includes(x?.status) ? x : null; }, 40_000, 250) };
  };
  const { t, done } = await runTag('A');
  check('acaba en Revisión tras el 2.º intento (no tras el 1.º)', done?.status === 'review' && done.attempts === 2, JSON.stringify({ s: done?.status, a: done?.attempts }));
  check('el resumen final es el del intento con entregable', /entregable\.txt/.test(done?.summary || ''), done?.summary);
  const readRuns = () => fs.readFileSync(runsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const runs = readRuns().filter((r) => r.tag === 'A');
  check('2 ejecuciones, con CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', runs.length === 2 && runs.every((r) => r.env === '1'), JSON.stringify(runs));
  // 1 · tope: reencola UNA vez; a la segunda va a Revisión con la nota
  const loop = await runTag('LOOP');
  check('tope: a la 2.ª vez va a Revisión con la nota «dos veces»', loop.done?.status === 'review' && loop.done.attempts === 2 && /esperando un aviso dos veces/.test(loop.done.summary || '') && loop.done.nobgRequeued === true, JSON.stringify({ s: loop.done?.status, a: loop.done?.attempts, sum: (loop.done?.summary || '').slice(0, 80) }));
  check('tope: solo 2 ejecuciones del bucle', readRuns().filter((r) => r.tag === 'LOOP').length === 2);
  // 2 · entregable fuera del repo (ruta absoluta modificada en el intento) → no reencola
  const doc = await runTag('DOC');
  check('ruta absoluta citada y modificada = entregable: no se reencola', doc.done?.status === 'review' && doc.done.attempts === 1 && !doc.done.nobgRequeued, JSON.stringify({ s: doc.done?.status, a: doc.done?.attempts }));
  // 3 · «cuando termine» a secas no promete aviso → no reencola
  const build = await runTag('BUILD');
  check('«cuando termine el build lo comprobé» NO reencola', build.done?.status === 'review' && build.done.attempts === 1 && !build.done.nobgRequeued, JSON.stringify({ s: build.done?.status, a: build.done?.attempts }));
  const hooks = fs.readFileSync(hookLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const d = hooks[0] && JSON.parse(hooks[0].res).hookSpecificOutput;
  check('el hook rechaza run_in_background:true con el motivo', d?.permissionDecision === 'deny' && /primer plano con timeout/.test(d.permissionDecisionReason), hooks[0]?.res);
  check('el hook no opina de un Bash normal', hooks[0]?.ok === '', JSON.stringify(hooks[0]?.ok));
  check('el prompt lleva la regla de segundo plano', hooks.every((h) => h.rules));
  const ev = await call('GET', `/api/events?taskId=${t.id}`);
  check('hubo una reencolada sin AgentCompleted intermedio', (Array.isArray(ev) ? ev : []).filter((e) => e.type === 'AgentCompleted').length === 1, '');
} catch (e) { failed++; console.log('  ✗ excepción:', e.message); }
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
