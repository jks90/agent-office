#!/usr/bin/env node
// e2e de FT-66 · sin cuota a mitad de tarea: pausa y reanudación automática.
// Servidor temporal + `claude` FALSO (AO_CLAUDE_BIN): la 1ª ejecución avanza (escribe un fichero) y muere con
// «Claude AI usage limit reached|<epoch>»; la 2ª termina bien. Mock de los endpoints de cuota (AO_CLAUDE_USAGE_URL).
// Comprueba: la tarea NO acaba en Fallidas sino en Por hacer con quotaPaused y la hora; lo hecho queda confirmado en su
// rama; el agente queda libre; no se relanza antes de la hora; después sigue sola con --resume de su sesión y termina en
// Revisión; «Reanudar ya» la relanza sin esperar; sobrevive a un reinicio del servidor durante la espera.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-qpause-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, repo, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
try { execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo }); } catch { /* ya confirmado */ }

// claude falso: cuenta ejecuciones, guarda sus argumentos y simula el corte por cuota en la primera
const counter = path.join(tmp, 'runs'), argsLog = path.join(tmp, 'args.jsonl'), resetFile = path.join(tmp, 'reset');
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); } // comprobaciones de sesión/versión de AgentOffice
const n = (Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-qpause', model: 'haiku', tools: [] });
if (n === 1) {
  fs.writeFileSync('avance.txt', 'medio hecho\\n');
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|' + fs.readFileSync(${JSON.stringify(resetFile)}, 'utf8').trim(), total_cost_usd: 0.01 });
  process.exit(1);
}
fs.appendFileSync('avance.txt', 'terminado\\n');
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hecho' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Terminado tras la pausa', total_cost_usd: 0.02 });
process.exit(0);
`, { mode: 0o755 });

const mockPort = await freePort();
let usage = 10;
const mock = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ limits: [{ kind: 'session', percent: usage, resets_at: new Date(Date.now() + 3600e3).toISOString() }] }))).listen(mockPort, '127.0.0.1');
const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir, AO_CLAUDE_USAGE_URL: `http://127.0.0.1:${mockPort}/u`, AO_CODEX_USAGE_URL: `http://127.0.0.1:${mockPort}/u`, AO_QUOTA_TTL: '1000' };
let server;
const startServer = async () => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100); };
const stopServer = async () => { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server?.kill('SIGTERM'); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  await startServer();
  console.log('Pausa por cuota a mitad de tarea');
  const p = await call('POST', '/api/projects', { name: 'qpause', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'haiku' });
  fs.writeFileSync(resetFile, String(Math.round((Date.now() + 6000) / 1000)));
  const t = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea que se queda sin cuota', role: 'back', repo: 'demo' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const paused = await until(async () => { const x = await task(t.id); return x?.quotaPaused ? x : null; }, 15_000);
  check('la tarea NO va a Fallidas: queda en Por hacer con quotaPaused', !!paused && paused.status === 'todo' && paused.quotaPaused.engine === 'claude', JSON.stringify(paused && { s: paused.status, e: paused.error }));
  check('la hora de reinicio sale del mensaje del CLI', !!paused && Math.abs(paused.quotaPaused.resetsAt - Number(fs.readFileSync(resetFile, 'utf8')) * 1000) < 1500);
  check('la tarjeta dice «⏸ sin cuota de Claude: sigue sola a las HH:MM»', /^⏸ sin cuota de Claude: sigue sola a las \d\d:\d\d$/.test(paused?.activity || ''), paused?.activity);
  const agentFree = (await call('GET', '/api/state')).agents.find((x) => x.id === a.id);
  check('el agente queda libre', agentFree?.status === 'idle');
  let branchLog = '';
  try { branchLog = execFileSync('git', ['log', '--oneline', paused.branch], { cwd: repo, encoding: 'utf8' }); } catch (e) { branchLog = String(e.message); }
  check('lo hecho queda confirmado en su rama', /avance antes de quedarse sin cuota/.test(branchLog), branchLog.slice(0, 200));
  const ev = (await call('GET', `/api/events?taskId=${t.id}`));
  check('evento AgentPaused {reason:"quota"}', Array.isArray(ev) && ev.some((e) => e.type === 'AgentPaused' && e.data?.reason === 'quota'));

  console.log('Sobrevive a un reinicio y no arranca antes de la hora');
  await stopServer(); await startServer();
  const after = await task(t.id);
  check('tras reiniciar el servidor sigue pausada', after?.quotaPaused && after.status === 'todo');
  await sleep(1500);
  check('no se relanza antes de la hora de reinicio', (await task(t.id)).status === 'todo' && Number(fs.readFileSync(counter, 'utf8')) === 1);

  console.log('Reanudación automática');
  const done = await until(async () => { const x = await task(t.id); return x?.status === 'review' ? x : null; }, 25_000, 300);
  check('pasada la hora sigue SOLA y termina en Revisión', !!done, JSON.stringify(await task(t.id)).slice(0, 300));
  const runs = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const second = runs[1] || [];
  check('se relanza con --resume de su sesión', second.includes('--resume') && second[second.indexOf('--resume') + 1] === 'sess-qpause', JSON.stringify(second.slice(0, 12)));
  check('ya no queda quotaPaused y el resumen es el del segundo intento', done && !done.quotaPaused && /Terminado tras la pausa/.test(done.summary || ''));
  let wt = ''; try { wt = execFileSync('git', ['show', `${done.branch}:avance.txt`], { cwd: repo, encoding: 'utf8' }); } catch (e) { wt = String(e.message); }
  check('continúa sobre lo hecho (avance.txt tiene ambas líneas)', /medio hecho[\s\S]*terminado/.test(wt), wt);

  console.log('«Reanudar ya»');
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(resetFile, String(Math.round((Date.now() + 3600e3) / 1000))); // dentro de 1 h
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Segunda tarea sin cuota', role: 'back', repo: 'demo' });
  const p2 = await until(async () => { const x = await task(t2.id); return x?.quotaPaused ? x : null; }, 15_000);
  check('segunda tarea pausada hasta dentro de 1 h', !!p2 && p2.quotaPaused.resetsAt > Date.now() + 3000_000);
  const rn = await call('POST', `/api/tasks/${t2.id}/resume-now`);
  check('POST /resume-now responde ok', rn.ok === true, JSON.stringify(rn));
  check('«Reanudar ya» la relanza sin esperar y termina en Revisión', !!(await until(async () => (await task(t2.id))?.status === 'review', 20_000, 300)));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
