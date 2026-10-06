#!/usr/bin/env node
// e2e de FT-57 · paridad Codex del ahorro de tokens (esfuerzo, hook de RTK, tope por intento, reanudar).
// Servidor temporal + `codex` FALSO (AO_CODEX_BIN: imprime eventos JSON como `codex exec --json`) + `rtk` FALSO (AO_RTK_BIN).
// Comprueba: args con -c esfuerzo/hook y PATH con rtk; el filtro del hook deja pasar solo la lista blanca (nunca `rtk run`);
// corte por tope → tarea en Revisión con aviso (budgetHit); «Devolver» reanuda con `exec resume <thread>`;
// y con AO_RTK=off no se añade hook ni PATH.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cxeco-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo');
for (const d of [dataDir, home, repo]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

// rtk falso: `rtk hook codex` reescribe según el comando que le llega por stdin (git status → rtk git status; «peligro» → rtk run …)
const rtkDir = path.join(tmp, 'rtkbin'); fs.mkdirSync(rtkDir);
const rtkFake = path.join(rtkDir, 'rtk');
fs.writeFileSync(rtkFake, `#!/usr/bin/env node
import fs from 'node:fs';
const inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const c = String(inp.tool_input?.command || '');
const to = /^git status/.test(c) ? 'rtk git status' : /peligro/.test(c) ? 'rtk run ' + c : null;
if (to) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: to } } }));
`, { mode: 0o755 });

// codex falso: registra argumentos y PATH; según el título del prompt gasta poco o mucho (y entonces se queda esperando)
const argsLog = path.join(tmp, 'args.jsonl');
const fake = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) prompt += c;
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify({ args: a, path: process.env.PATH, title: (prompt.match(/Tarea [^:]*: (.*)/) || [])[1] || '' }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'thr-e2e-1' });
out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: '/usr/bin/zsh -lc "git status"' } });
out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: '/usr/bin/zsh -lc "git status"', exit_code: 0, aggregated_output: '' } });
if (/GASTONA/.test(prompt)) {
  out({ type: 'turn.completed', usage: { input_tokens: 400000, cached_input_tokens: 300000, output_tokens: 200000 } }); // ≈ 2,6 $
  setInterval(() => {}, 1000); // no termina solo: tiene que cortarlo el tope
} else {
  fs.writeFileSync('hecho.txt', 'ok\\n');
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Terminado' } });
  out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 } });
}
`, { mode: 0o755 });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), maxTaskUsd: 0.5, agentEffort: 'low' } }));
const mkEnv = (extra) => ({ ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CODEX_BIN: fake, AO_RTK_BIN: rtkFake, ...extra });
let server;
const startServer = async (extra = {}) => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: mkEnv(extra), stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100); };
const stopServer = async () => { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
const runs = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const cfg = (r) => r.args.filter((_, i) => r.args[i - 1] === '-c');
process.on('exit', () => { try { server?.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

// ¿Es RTK_RULES-only el filtro? Se prueba directamente con stdin sintético.
const filter = (cmd) => execFileSync(process.execPath, ['bin/ao-rtk-codex.mjs', rtkFake], { cwd: ROOT, input: JSON.stringify({ tool_input: { command: cmd } }), encoding: 'utf8' });

try {
  console.log('Filtro del hook de RTK');
  check('git status → reescritura permitida', /rtk git status/.test(filter('git status')));
  check('«rtk run …» NO pasa (no imprime nada)', filter('peligro rm -rf x') === '');
  check('sin reescritura → sin salida', filter('echo hola') === '');

  await startServer();
  const p = await call('POST', '/api/projects', { name: 'cxeco', repos: [{ key: 'demo', path: repo }], engine: 'codex' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  await call('POST', '/api/agents', { projectId: p.id, name: 'Cora', role: 'back', engine: 'codex', model: 'gpt-5.5' });

  console.log('Tarea normal: esfuerzo, hook y PATH');
  const t1 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea normal', role: 'back', repo: 'demo' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  check('termina en Revisión', !!(await until(async () => (await task(t1.id))?.status === 'review')));
  const r1 = runs().find((r) => r.title === 'Tarea normal') || { args: [], path: '' };
  check('-c model_reasoning_effort="low"', cfg(r1).includes('model_reasoning_effort="low"'), JSON.stringify(cfg(r1)));
  check('-c model_reasoning_summary="concise"', cfg(r1).includes('model_reasoning_summary="concise"'));
  check('-c hooks.PreToolUse con el filtro de RTK', cfg(r1).some((c) => /^hooks\.PreToolUse=.*ao-rtk-codex\.mjs.*rtk/.test(c)), JSON.stringify(cfg(r1)));
  check('-c features.codex_hooks=true', cfg(r1).includes('features.codex_hooks=true'));
  check('PATH con el directorio de rtk', r1.path.split(':')[0] === rtkDir, r1.path.slice(0, 80));
  check('sin sesión previa no hay «resume»', !r1.args.includes('resume'));
  check('guarda el thread_id como sessionId', (await task(t1.id)).sessionId === 'thr-e2e-1');

  console.log('Tope por intento');
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea cara GASTONA', role: 'back', repo: 'demo' });
  const hit = await until(async () => { const x = await task(t2.id); return x?.status === 'review' ? x : null; }, 20_000);
  check('el corte lleva la tarea a Revisión (no a Fallidas)', !!hit && hit.status === 'review', JSON.stringify(hit && { s: hit.status, e: hit.error }));
  check('budgetHit y aviso «TOPE DE GASTO ALCANZADO»', !!hit?.budgetHit && /TOPE DE GASTO ALCANZADO/.test(hit.summary || ''), (hit?.summary || '').slice(0, 120));
  const ev = await call('GET', `/api/events?taskId=${t2.id}`);
  check('evento AgentBlocked {reason:"budget"}', Array.isArray(ev) && ev.some((e) => e.type === 'AgentBlocked' && e.data?.reason === 'budget'));

  console.log('Reintento: reanuda la sesión');
  await call('POST', `/api/tasks/${t2.id}/reject`, { feedback: 'sigue, pero sin GASTONA' });
  await until(async () => runs().filter((r) => /GASTONA/.test(r.title)).length >= 2, 20_000);
  const r2 = runs().filter((r) => /GASTONA/.test(r.title))[1] || { args: [] };
  const i = r2.args.indexOf('resume');
  check('segundo intento: «resume thr-e2e-1» antes del «-»', i > 0 && r2.args[i + 1] === 'thr-e2e-1' && r2.args[r2.args.length - 1] === '-', JSON.stringify(r2.args));

  console.log('Sin rtk (AO_RTK=off)');
  await stopServer(); await startServer({ AO_RTK: 'off' });
  const before = runs().length;
  const t3 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea sin rtk', role: 'back', repo: 'demo' });
  await until(async () => (await task(t3.id))?.status === 'review');
  const r3 = runs().slice(before).find((r) => r.title === 'Tarea sin rtk') || { args: [], path: rtkDir };
  check('no se añade hook ni features.codex_hooks', !cfg(r3).some((c) => /hooks|codex_hooks/.test(c)), JSON.stringify(cfg(r3)));
  check('PATH sin el directorio de rtk', !r3.path.split(':').includes(rtkDir));
  check('el esfuerzo sí se mantiene', cfg(r3).includes('model_reasoning_effort="low"'));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
