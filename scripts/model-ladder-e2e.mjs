#!/usr/bin/env node
// e2e de FT-60 · cascada de modelos con escalado, con los DOS motores.
// Servidor temporal + `claude` y `codex` FALSOS (AO_CLAUDE_BIN / AO_CODEX_BIN) que registran el modelo pedido (--model / -m).
// Comprueba: 1.ª vez el peldaño barato (haiku / el mini de models_cache.json), «Devolver» → siguiente, tope de 2 escalados,
// error del agente → el reintento sube (sin doble escalado al reintentar), minModel de la tarea respetado, y la lógica pura (rol, plan).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick, ladderFor, historyText, MAX_ESCALATIONS } from '../server/model-ladder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ladder-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home');
fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'gpt-5.5' }, { slug: 'gpt-5.5-mini', display_name: 'mini' }, { slug: 'gpt-5.5-review', display_name: 'r' }] }));
const mkRepo = (name) => {
  const d = path.join(tmp, name); fs.mkdirSync(d);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  fs.writeFileSync(path.join(d, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: d });
  return d;
};
const repos = { claude: mkRepo('repo-claude'), codex: mkRepo('repo-codex') };

// Los falsos anotan {engine, model, task} y fallan si el id de la tarea está en failFile (error del agente).
const runsLog = path.join(tmp, 'runs.jsonl'), failFile = path.join(tmp, 'fail.txt');
fs.writeFileSync(failFile, '');
const common = `
import fs from 'node:fs';
const a = process.argv.slice(2);
const failing = () => fs.readFileSync(${JSON.stringify(failFile)}, 'utf8').split('\\n').includes(process.env.AO_TASK);
const log = (engine, model) => fs.appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ engine, model, task: process.env.AO_TASK, fail: failing() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
`;
const fakeClaude = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node${common}
if (!a.includes('-p')) { console.log(a.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); }
log('claude', a[a.indexOf('--model') + 1]);
out({ type: 'system', subtype: 'init', session_id: 'sess-' + process.env.AO_TASK, model: 'x', tools: [] });
if (failing()) { out({ type: 'result', subtype: 'success', is_error: true, result: 'boom', total_cost_usd: 0.01 }); process.exit(1); }
fs.appendFileSync('hecho.txt', 'ok\\n');
out({ type: 'result', subtype: 'success', is_error: false, result: 'Terminado', total_cost_usd: 0.01 });
process.exit(0);
`, { mode: 0o755 });
const fakeCodex = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node${common}
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { /* se consume el prompt */ }
log('codex', a[a.indexOf('-m') + 1]);
out({ type: 'thread.started', thread_id: 'thr-' + process.env.AO_TASK });
if (failing()) { out({ type: 'turn.failed', error: { message: 'boom' } }); process.exit(1); }
fs.appendFileSync('hecho.txt', 'ok\\n');
out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Terminado' } });
out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } });
process.exit(0);
`, { mode: 0o755 });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, quotaGuard: false, agentMemory: false, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_CODEX_BIN: fakeCodex, AO_RTK: 'off' };
let server;
const startServer = async () => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
const runs = (id) => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).filter((r) => r.task === id);
process.on('exit', () => { try { server?.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

// Espera a que la tarea esté en `status` habiendo hecho ya `n` ejecuciones del motor.
const settled = (id, status, n) => until(async () => { const t = await task(id); return t?.status === status && runs(id).length >= n ? t : null; });
const models = (id) => runs(id).map((r) => r.model);

async function scenario(engine, [cheap, top]) {
  console.log(`\nMotor ${engine}: escalera ${cheap} → ${top}`);
  const p = await call('POST', '/api/projects', { name: `lad-${engine}`, repos: [{ key: 'demo', path: repos[engine] }], engine });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  await call('POST', '/api/agents', { projectId: p.id, name: `Ana-${engine}`, role: 'back', engine }); // sin model → manda la cascada
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const mk = (title, extra = {}) => call('POST', '/api/tasks', { projectId: p.id, title, role: 'back', repo: 'demo', ...extra });

  const t1 = await mk('Tarea normal');
  let t = await settled(t1.id, 'review', 1);
  check('1.ª vez: modelo barato', models(t1.id)[0] === cheap, JSON.stringify(models(t1.id)));
  check('modelHistory registrado', t?.modelHistory?.length === 1 && t.modelHistory[0].model === cheap);

  await call('POST', `/api/tasks/${t1.id}/reject`, { feedback: 'falta algo' });
  t = await settled(t1.id, 'review', 2);
  check('al devolver sube al siguiente modelo', models(t1.id)[1] === top, JSON.stringify(models(t1.id)));
  check('la tarjeta enseña «barato → caro»', historyText(t?.modelHistory) === `${cheap} → ${top}`, historyText(t?.modelHistory));

  await call('POST', `/api/tasks/${t1.id}/reject`, { feedback: 'otra vez' });
  t = await settled(t1.id, 'review', 3);
  await call('POST', `/api/tasks/${t1.id}/reject`, { feedback: 'y otra' });
  t = await settled(t1.id, 'review', 4);
  check(`tope de ${MAX_ESCALATIONS} escalados (escalations no pasa de ${MAX_ESCALATIONS})`, t?.escalations === MAX_ESCALATIONS, String(t?.escalations));
  check('sigue en el techo, sin inventar modelos', models(t1.id).slice(2).every((m) => m === top), JSON.stringify(models(t1.id)));

  const t2 = await mk('Tarea con minModel', { minModel: top });
  t = await settled(t2.id, 'review', 1);
  check('minModel de la tarea: empieza en el peldaño alto', models(t2.id)[0] === top && t.minModel === top, JSON.stringify(models(t2.id)));

  const t3 = await mk('Tarea que falla');
  fs.appendFileSync(failFile, t3.id + '\n');
  t = await settled(t3.id, 'failed', 1);
  check('error del agente: va a Fallidas y sube un peldaño', t?.status === 'failed' && t.escalations === 1, JSON.stringify(t && { s: t.status, e: t.escalations }));
  fs.writeFileSync(failFile, '');
  await call('POST', `/api/tasks/${t3.id}/reject`, { feedback: '' }); // «Reintentar»
  t = await settled(t3.id, 'review', 2);
  check('el reintento usa el modelo siguiente', models(t3.id)[0] === cheap && models(t3.id)[1] === top, JSON.stringify(models(t3.id)));
  check('reintentar desde «fallida» no escala dos veces', t?.escalations === 1, String(t?.escalations));
  await call('POST', `/api/projects/${p.id}/run`, { running: false });
}

try {
  console.log('Lógica pura');
  const lad = { claude: ['haiku', 'sonnet'], codex: ['gpt-5.5-mini', 'gpt-5.5'] };
  check('plan empieza arriba', pick('claude', lad.claude, { plan: true }).model === 'sonnet');
  check('minModel de rol «sonnet» en Codex → 2.º peldaño', pick('codex', lad.codex, { floor: 'sonnet', all: lad }).model === 'gpt-5.5');
  check('minModel «opus» (fuera de escalera) se respeta', pick('claude', lad.claude, { floor: 'opus', all: lad }).model === 'opus');
  check('minModel «opus» en Codex → techo de Codex', pick('codex', lad.codex, { floor: 'opus', all: lad }).model === 'gpt-5.5');
  check('con 4 escalados pedidos solo cuentan 2', pick('claude', ['a1', 'a2', 'a3', 'a4'].map((x) => 'claude-' + x), { escalations: 4 }).level === 2);
  check('escalera de Ajustes manda; valores de otro motor se descartan', ladderFor('claude', { modelLadder: { claude: 'haiku, gpt-5.5, opus' } }, home).join() === 'haiku,opus');
  check('mini de Codex sacado de models_cache.json (sin «review»)', ladderFor('codex', {}, home).join() === 'gpt-5.5-mini,gpt-5.5');

  await startServer();
  await scenario('claude', ['haiku', 'sonnet']);
  await scenario('codex', ['gpt-5.5-mini', 'gpt-5.5']);

  console.log('\nAjustes y snapshot');
  const snap = await state();
  check('el snapshot publica las escaleras efectivas', snap.modelLadders?.claude?.join() === 'haiku,sonnet' && snap.modelLadders?.codex?.join() === 'gpt-5.5-mini,gpt-5.5', JSON.stringify(snap.modelLadders));
  await call('POST', '/api/settings', { modelLadder: { claude: 'sonnet, opus', codex: '' } });
  const snap2 = await state();
  check('POST /api/settings guarda la escalera y valida por motor', snap2.modelLadders.claude.join() === 'sonnet,opus' && snap2.settings.modelLadder?.codex === undefined, JSON.stringify(snap2.settings.modelLadder));
} catch (e) { failed++; console.error('Error:', e.stack || e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
