#!/usr/bin/env node
// e2e de FT-75 (memoria) — basado en el de FT-66 · sin cuota a mitad de tarea: pausa y reanudación automática.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-memory-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, repo, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
try { execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo }); } catch { /* ya confirmado */ }


const promptsLog = path.join(tmp, 'prompts.jsonl');
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
  out({ type: 'system', subtype: 'init', session_id: 'sess-mem', model: 'haiku', tools: [] });
  fs.appendFileSync('hecho.txt', 'x\\n');
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Hecho.\\n\\nLECCIONES:\\n- En este repo las pruebas se lanzan con node scripts/x-e2e.mjs y necesitan Chrome headless\\n- [proyecto] Las capturas de los e2e van a resumen/ y no se versionan' });
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
  const p = await call('POST', '/api/projects', { name: 'mem', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'haiku' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  console.log('Lecciones al terminar');
  const t1 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Primera tarea', role: 'back', repo: 'demo' });
  const d1 = await until(async () => { const x = await task(t1.id); return x?.status === 'review' ? x : null; }, 20_000, 300);
  check('la primera tarea termina en Revisión', !!d1);
  check('el bloque LECCIONES se quita del resumen', d1 && !/LECCIONES/.test(d1.summary) && /Hecho\./.test(d1.summary), d1?.summary);
  const who = d1?.agentId || a.id;
  const ag = await call('GET', `/api/memory/${p.id}?agent=${who}`), pr = await call('GET', `/api/memory/${p.id}`);
  check('lección del agente guardada con su código', /node scripts\/x-e2e\.mjs/.test(ag.text) && new RegExp(`\\(${d1.code}\\)`).test(ag.text), ag.text);
  check('lección «[proyecto]» en la memoria del proyecto', /capturas de los e2e van a resumen/.test(pr.text) && !/capturas/.test(ag.text), pr.text);
  check('el primer prompt pide lecciones (LECCIONES:) y no trae memoria', (() => { const l = fs.readFileSync(promptsLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x)); return /LECCIONES:/.test(l[0]) && !/Memoria de tareas anteriores/.test(l[0]); })());
  console.log('Corrección al devolver');
  await call('POST', `/api/tasks/${t1.id}/reject`, { feedback: 'No borres los tests existentes. Además revisa el README.' });
  const ag2 = await call('GET', `/api/memory/${p.id}?agent=${who}`);
  check('la primera frase de la corrección pasa a su memoria', /Corrección de revisión: No borres los tests existentes\./.test(ag2.text) && !/README/.test(ag2.text), ag2.text);
  await until(async () => (await task(t1.id))?.status === 'review', 20_000, 300);
  console.log('Memoria en el prompt de la siguiente tarea');
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Segunda tarea', role: 'back', repo: 'demo' });
  await until(async () => (await task(t2.id))?.status === 'review', 20_000, 300);
  const prompts = fs.readFileSync(promptsLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const last = prompts.at(-1);
  check('el prompt de la segunda tarea trae la memoria del proyecto y la suya', /Memoria de tareas anteriores/.test(last) && /capturas de los e2e/.test(last) && /No borres los tests existentes/.test(last), last.slice(0, 300));
  check('sin duplicados: repetir la misma lección no la añade otra vez', ((await call('GET', `/api/memory/${p.id}?agent=${who}`)).text.match(/x-e2e\.mjs/g) || []).length === 1);
  console.log('Tope y edición');
  const big = Array.from({ length: 200 }, (_, i) => `- lección de relleno número ${i} con algo de texto para ocupar espacio`).join('\n');
  const capped = await call('PUT', `/api/memory/${p.id}?agent=${who}`, { text: big });
  check('el tope recorta la memoria (≤6000 caracteres) y conserva las más recientes', capped.text.length <= 6000 && /número 199/.test(capped.text) && !/número 0 /.test(capped.text), String(capped.text.length));
  await call('POST', '/api/settings', { agentMemory: false });
  const t3 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tercera sin memoria', role: 'back', repo: 'demo' });
  await until(async () => (await task(t3.id))?.status === 'review', 20_000, 300);
  const l3 = fs.readFileSync(promptsLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).at(-1);
  check('con agentMemory=false no hay memoria ni petición de lecciones', !/Memoria de tareas anteriores/.test(l3) && !/LECCIONES:/.test(l3));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
