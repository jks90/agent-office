#!/usr/bin/env node
// e2e de la memoria de Claude Code del repo (~/.claude/projects/<repo>/memory) en AgentOffice — basado en memory-e2e.mjs.
// Servidor temporal + `claude` FALSO que apunta prompt y argv. Comprueba: el índice MEMORY.md va en el prompt y la carpeta
// en --add-dir; la API lista (con frontmatter), lee, escribe y borra (quitando su línea del índice) y rechaza nombres raros;
// con claudeMemory=false no hay ni índice ni --add-dir.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cmemory-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, repo, claudeDir]) fs.mkdirSync(d, { recursive: true });
// Memoria de Claude del repo, donde la guardaría Claude Code (ruta del repo con / → -)
const memDir = path.join(claudeDir, 'projects', path.resolve(repo).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [Trampa del build](trampa-build.md) — el build necesita NODE_OPTIONS=--max-old-space-size=4096\n');
fs.writeFileSync(path.join(memDir, 'trampa-build.md'), '---\nname: trampa-build\ndescription: el build necesita más memoria\nmetadata:\n  type: feedback\n---\n\nUsar NODE_OPTIONS.\n');
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
try { execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo }); } catch { /* ya confirmado */ }


const promptsLog = path.join(tmp, 'prompts.jsonl'), argvLog = path.join(tmp, 'argv.jsonl');
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => {
  let text = ''; try { const m = JSON.parse(line).message; text = typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join(''); } catch { text = line; }
  fs.appendFileSync(${JSON.stringify(promptsLog)}, JSON.stringify(text) + '\\n');
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-cmem', model: 'haiku', tools: [] });
  fs.appendFileSync('hecho.txt', 'x\\n');
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Hecho.' });
  setTimeout(() => process.exit(0), 50);
});
`, { mode: 0o755 });
const stubPort = await freePort();
const stub = http.createServer((req, res) => { if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })); res.writeHead(404).end('{}'); }).listen(stubPort, '127.0.0.1');
const mockPort = await freePort();
const mock = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ limits: [{ kind: 'session', percent: 5, resets_at: new Date(Date.now() + 3600e3).toISOString() }] }))).listen(mockPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir, AO_CLAUDE_USAGE_URL: `http://127.0.0.1:${mockPort}/u`, AO_CODEX_USAGE_URL: `http://127.0.0.1:${mockPort}/u` } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server.kill('SIGTERM'); mock.close(); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const p = await call('POST', '/api/projects', { name: 'cmem', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'haiku' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  console.log('API');
  const list = await call('GET', `/api/projects/${p.id}/claude-memory`);
  check('lista la memoria del repo con su carpeta', list[0]?.repo === 'demo' && list[0]?.dir === memDir && !list[0].inherited, JSON.stringify(list).slice(0, 200));
  const f0 = list[0]?.files?.[0];
  check('lee el frontmatter (nombre, tipo, descripción) y que está en el índice', f0?.name === 'trampa-build' && f0?.type === 'feedback' && /más memoria/.test(f0?.description) && f0?.inIndex, JSON.stringify(f0));
  const url = (n) => `/api/projects/${p.id}/claude-memory/file?repo=demo&name=${encodeURIComponent(n)}`;
  check('lee un fichero', /NODE_OPTIONS/.test((await call('GET', url('trampa-build.md'))).text));
  await call('PUT', url('nueva.md'), { text: '---\nname: nueva\ndescription: d\n---\nx' });
  check('escribe un fichero nuevo en la carpeta real', fs.existsSync(path.join(memDir, 'nueva.md')));
  check('rechaza rutas fuera de la carpeta', /no válido/.test((await call('GET', url('../../x.md'))).error || '') || !fs.existsSync(path.join(claudeDir, 'x.md')));
  check('rechaza ficheros que no son .md', /no válido/.test((await call('PUT', url('x.sh'), { text: 'x' })).error || ''));
  fs.appendFileSync(path.join(memDir, 'MEMORY.md'), '- [Nueva](nueva.md) — d\n');
  await call('DELETE', url('nueva.md'));
  check('borrar quita el fichero y su línea del índice', !fs.existsSync(path.join(memDir, 'nueva.md')) && !/nueva\.md/.test(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')) && /trampa-build/.test(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')));
  console.log('Prompt del agente');
  const t1 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Primera tarea', role: 'back', repo: 'demo' });
  check('la tarea termina en Revisión', !!(await until(async () => (await task(t1.id))?.status === 'review', 20_000, 300)));
  const pr1 = lines(promptsLog).at(-1), av1 = lines(argvLog).at(-1);
  check('el prompt trae el índice de la memoria y su carpeta', /Memoria del proyecto/.test(pr1) && /max-old-space-size=4096/.test(pr1) && pr1.includes(memDir), pr1.slice(0, 300));
  check('el índice va en la parte estable (antes de la TAREA)', pr1.indexOf('Memoria del proyecto') < pr1.indexOf('════════ TAREA'));
  check('la carpeta de la memoria va en --add-dir', av1.includes('--add-dir') && av1.includes(memDir), JSON.stringify(av1));
  console.log('Revisor automático con Claude');
  const nRuns = lines(argvLog).length;
  await call('PATCH', `/api/projects/${p.id}`, { reviewPolicy: 'auto-qa' }); // revisa en el momento lo que ya esperaba (t1)
  check('activar auto-qa lanza el revisor sobre lo que ya esperaba', !!(await until(async () => lines(argvLog).length > nRuns, 20_000, 300)));
  const rv = lines(argvLog).at(-1);
  const mi = rv.indexOf('--model');
  check('el revisor recibe un modelo de verdad (no «[object Object]»)', mi >= 0 && typeof rv[mi + 1] === 'string' && !/object/i.test(rv[mi + 1]), rv[mi + 1]);
  const held = await until(async () => { const x = await task(t1.id); return x?.reviewNote ? x : null; }, 20_000, 300);
  check('sin veredicto válido queda para la persona, con motivo', /veredicto válido/.test(held?.reviewNote || ''), held?.reviewNote);
  const again = await call('POST', `/api/tasks/${t1.id}/review-again`);
  check('«🔎 Revisar otra vez» relanza el revisor', again.ok && !!(await until(async () => lines(argvLog).length > nRuns + 1, 20_000, 300)), JSON.stringify(again));
  await until(async () => !!(await task(t1.id))?.reviewNote, 20_000, 300);
  await call('PATCH', `/api/projects/${p.id}`, { reviewPolicy: '' });

  console.log('Desactivada');
  await call('POST', '/api/settings', { claudeMemory: false });
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Segunda sin memoria', role: 'back', repo: 'demo' });
  await until(async () => (await task(t2.id))?.status === 'review', 20_000, 300);
  const pr2 = lines(promptsLog).at(-1), av2 = lines(argvLog).at(-1);
  check('con claudeMemory=false no hay índice ni --add-dir de la memoria', !/Memoria del proyecto/.test(pr2) && !av2.includes(memDir));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
