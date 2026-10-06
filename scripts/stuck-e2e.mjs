#!/usr/bin/env node
// e2e de FT-62 · agente atascado: aviso en caliente y, si sigue, corte y paso a Revisión «⚠️ atascado».
// Servidor temporal + `claude` y `codex` FALSOS (AO_CLAUDE_BIN / AO_CODEX_BIN) que repiten la misma orden sin parar.
// Claude: el aviso llega por stdin (mensaje en caliente) y luego se corta. Codex (sin stdin en caliente): se reencola la
// tarea con el aviso en el prompt y el 2.º intento se corta. Ambos: lo hecho queda en la rama, AgentBlocked {reason:'stuck'}.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stuck-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
const mkRepo = (name) => {
  const r = path.join(tmp, name);
  fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
  fs.writeFileSync(path.join(r, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: r });
  return r;
};
const repoC = mkRepo('repo-claude'), repoX = mkRepo('repo-codex');

// claude falso: repite `ls -la` (Bash, ok) sin parar; guarda lo que le llega por stdin
const stdinLog = path.join(tmp, 'claude-stdin.log');
const fakeClaude = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => fs.appendFileSync(${JSON.stringify(stdinLog)}, l + '\\n'));
fs.writeFileSync('trabajo.txt', 'algo hecho\\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-stuck', model: 'haiku', tools: [] });
let i = 0;
setInterval(() => {
  const id = 'tu' + (++i);
  out({ type: 'assistant', message: { id: 'm' + i, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls -la' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'x' }] } });
}, 80);
`, { mode: 0o755 });

// codex falso: repite el mismo comando; guarda el prompt (stdin) de cada ejecución
const codexRuns = path.join(tmp, 'codex-runs.jsonl');
const fakeCodex = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv[2] !== 'exec') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(codexRuns)}, JSON.stringify({ prompt: prompt }) + '\\n');
  fs.writeFileSync('trabajo.txt', 'algo hecho\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 't1' });
  let i = 0;
  setInterval(() => {
    const id = 'item_' + (++i), item = { id, type: 'command_execution', command: '/usr/bin/zsh -lc "npm run build"', aggregated_output: '', exit_code: null, status: 'in_progress' };
    out({ type: 'item.started', item });
    out({ type: 'item.completed', item: { ...item, exit_code: 0, status: 'completed' } });
  }, 80);
});
`, { mode: 0o755 });

const stubPort = await freePort(); // flow-test falso: solo la comprobación de licencia
const stub = http.createServer((req, res) => res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' }).end(req.url === '/access' ? JSON.stringify({ mode: 'licensed', plan: 'e2e' }) : '{}')).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_CODEX_BIN: fakeCodex, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);

async function scenario(engine, repo, key) {
  const p = await call('POST', '/api/projects', { name: `stuck-${engine}`, repos: [{ key, path: repo }], engine });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  await call('POST', '/api/agents', { projectId: p.id, name: engine === 'claude' ? 'Ana' : 'Beto', role: 'back', engine, model: engine === 'claude' ? 'haiku' : '' });
  const t = await call('POST', '/api/tasks', { projectId: p.id, title: `Tarea atascada ${engine}`, role: 'back', repo: key });
  if (!t.id) throw new Error('no pude crear la tarea: ' + JSON.stringify(t));
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const done = await until(async () => { const x = await task(t.id); return ['review', 'failed'].includes(x?.status) ? x : null; }, 30_000, 250);
  check('la tarea acaba en Revisión (no Fallidas)', done?.status === 'review', JSON.stringify(done || await task(t.id)).slice(0, 600));
  check('el resumen empieza por «⚠️ atascado:» con la señal', /^⚠️ atascado: repite la orden «/.test(done?.summary || ''), (done?.summary || '').slice(0, 120));
  check('t.stuck guardado para la tarjeta', /ls -la|npm run build/.test(done?.stuck || ''), done?.stuck);
  let files = ''; try { files = execFileSync('git', ['show', `${done.branch}:trabajo.txt`], { cwd: repo, encoding: 'utf8' }); } catch (e) { files = String(e.message); }
  check('lo hecho queda en la rama', /algo hecho/.test(files), files.slice(0, 100));
  const ev = await call('GET', `/api/events?taskId=${t.id}`);
  const blocked = (Array.isArray(ev) ? ev : []).filter((e) => e.type === 'AgentBlocked' && e.data?.reason === 'stuck');
  check('un evento AgentBlocked {reason:"stuck", signal}', blocked.length === 1 && !!blocked[0].data.signal, JSON.stringify(blocked.map((b) => b.data)));
  const a = (await call('GET', '/api/state')).agents.find((x) => x.name === (engine === 'claude' ? 'Ana' : 'Beto'));
  check('el agente queda libre', a?.status === 'idle');
  const warned = (Array.isArray(ev) ? ev : []).filter((e) => e.type === 'AgentProgress' && e.data?.stuck);
  check('hubo UN aviso (AgentProgress stuck) antes del corte', warned.length === 1, String(warned.length));
}

try {
  console.log('Claude · aviso por stdin y corte');
  await scenario('claude', repoC, 'rc');
  const sent = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8').trim().split('\n') : [];
  const nudges = sent.filter((l) => /Nota del sistema de AgentOffice: repite la orden/.test(l));
  check('el aviso en caliente llegó UNA vez por stdin, con redacción neutra', nudges.length === 1 && /cambia de enfoque/.test(nudges[0]) && !/INSTRUCCI/.test(nudges[0]), `${nudges.length} avisos de ${sent.length} mensajes`);

  console.log('Codex · aviso por reencolado y corte');
  await scenario('codex', repoX, 'rx');
  const runs = fs.readFileSync(codexRuns, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('Codex se lanzó 2 veces (la 2.ª con el aviso en el prompt)', runs.length === 2 && !/Nota del sistema/.test(runs[0].prompt) && /Nota del sistema de AgentOffice: repite la orden/.test(runs[1].prompt), `${runs.length} ejecuciones`);
} catch (e) { failed++; console.log('  ✗ excepción:', e.message); }
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
