#!/usr/bin/env node
// e2e · catálogos de MCP y scripts para los agentes (server/toolcatalog.js).
// Servidor temporal + ~/.claude.json y ~/.codex/config.toml FALSOS (AO_CLAUDE_JSON, CODEX_HOME) + claude y codex FALSOS que
// apuntan argv/prompt (y el contenido del --mcp-config). Comprueba: inventario sin secretos, catálogo por nombre (mcp.json sin
// claves), scripts del repo con su descripción, asignación por agente y por rol; al lanzar, Claude recibe los MCP en un FICHERO
// 0600 (borrado al acabar) con sus mcp__ permitidos y los scripts en la lista blanca, el prompt y --add-dir; Codex conserva el
// MCP que ya define su config y recibe por -c el que solo tiene Claude.
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
const until = async (fn, ms = 15_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tools-'));
const home = path.join(tmp, 'home'), dataDir = path.join(tmp, 'data'), ws = path.join(home, 'ws'), repo = path.join(home, 'repo'), codexHome = path.join(tmp, 'codex'), claudeDir = path.join(tmp, 'claude');
for (const d of [home, dataDir, ws, repo, codexHome, claudeDir, path.join(repo, 'scripts')]) fs.mkdirSync(d, { recursive: true });
const SECRET = 'clave-supersecreta-123';
const claudeJson = path.join(tmp, 'claude.json');
fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'demo-mcp': { type: 'stdio', command: 'demo-server', args: ['--x'], env: { TOKEN: SECRET } }, 'hostinger-vps': { command: 'npx', args: ['hostinger'] } },
  projects: { [repo]: { mcpServers: { 'de-proyecto': { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: `Bearer ${SECRET}` } } } } } }));
fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.solo-codex]\ncommand = "x"\n[mcp_servers.demo-mcp]\ncommand = "demo-server"\n');
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
fs.writeFileSync(path.join(repo, 'scripts', 'hola.mjs'), '#!/usr/bin/env node\n// Saluda al mundo desde un script del equipo\nconsole.log("hola");\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

const log = path.join(tmp, 'runs.jsonl');
const fakeClaude = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const a = process.argv.slice(2);
if (!a.includes('-p')) { console.log(a.includes('status') ? JSON.stringify({ loggedIn: true }) : '2.1.300 (Claude Code)'); process.exit(0); }
const i = a.indexOf('--mcp-config'), cfg = a[i + 1];
let mcpFile = null; try { if (fs.existsSync(cfg)) mcpFile = { path: cfg, mode: (fs.statSync(cfg).mode & 0o777).toString(8), body: fs.readFileSync(cfg, 'utf8') }; } catch {}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).once('line', (line) => {
  let text = ''; try { const m = JSON.parse(line).message; text = typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join(''); } catch { text = line; }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ engine: 'claude', args: a, mcpFile, prompt: text }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'haiku', tools: [] });
  fs.appendFileSync('hecho.txt', 'x\\n');
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Hecho.' });
  setTimeout(() => process.exit(0), 50);
});
`, { mode: 0o755 });
const fakeCodex = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) prompt += c;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ engine: 'codex', args: a, prompt }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 't1' });
fs.writeFileSync('hecho.txt', 'ok\\n');
out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Terminado' } });
out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 } });
`, { mode: 0o755 });

const stubPort = await freePort();
const stub = http.createServer((req, res) => { if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })); res.writeHead(404).end('{}'); }).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: ws, flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_CODEX_BIN: fakeCodex, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, AO_CLAUDE_JSON: claudeJson } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const j = await r.json().catch(() => ({})); return { status: r.status, ...j }; };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const p = await call('POST', '/api/projects', { name: 'tools', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  console.log('Inventario y catálogo');
  let t = await call('GET', '/api/tools');
  const names = t.mcp.inventory.map((m) => m.name);
  check('inventario de MCP: los de Claude (usuario y proyecto) y los de Codex', ['demo-mcp', 'hostinger-vps', 'de-proyecto', 'solo-codex'].every((n) => names.includes(n)), names.join(','));
  check('el inventario no enseña claves', !JSON.stringify(t).includes(SECRET));
  check('marca como arriesgado lo de Hostinger', t.mcp.inventory.find((m) => m.name === 'hostinger-vps')?.risky === true);
  check('añadir al catálogo un MCP que no existe: 404', (await call('POST', '/api/tools/mcp', { name: 'no-existe' })).status === 404);
  for (const n of ['demo-mcp', 'solo-codex', 'de-proyecto']) await call('POST', '/api/tools/mcp', { name: n, description: 'para la prueba' });
  const mcpJson = fs.readFileSync(path.join(ws, '_agentes', 'mcp.json'), 'utf8');
  check('mcp.json del workspace guarda solo nombres (sin claves)', /demo-mcp/.test(mcpJson) && !mcpJson.includes(SECRET) && !/command|env/.test(mcpJson));
  const inv = t.scripts.inventory.find((s) => s.name === 'hola');
  check('inventario de scripts: los de scripts/ del repo con su descripción', inv?.description === 'Saluda al mundo desde un script del equipo', JSON.stringify(inv));
  check('script fuera de tu carpeta personal: 400', (await call('POST', '/api/tools/scripts', { path: '/etc/passwd' })).status === 400);
  await call('POST', '/api/tools/scripts', { path: inv.path });
  t = await call('GET', '/api/tools');
  check('catálogo: 3 MCP y el script', t.mcp.catalog.length === 3 && t.scripts.catalog[0]?.name === 'hola');

  console.log('Asignación');
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'haiku' });
  const r1 = await call('PATCH', `/api/agents/${a.id}`, { mcps: ['demo-mcp', 'de-proyecto'], scripts: ['hola'] });
  check('PATCH del agente guarda mcps y scripts', JSON.stringify(r1.mcps) === '["demo-mcp","de-proyecto"]' && r1.scripts?.[0] === 'hola', JSON.stringify(r1));
  const role = await call('POST', '/api/roles', { id: 'con-mcp', kind: 'dev', system: 'Eres un rol de prueba.', mcps: ['solo-codex'], scripts: ['hola'] });
  const roleFile = fs.readFileSync(path.join(ws, '_agentes', 'roles', 'con-mcp.md'), 'utf8');
  check('el rol guarda mcps: y scripts: en su frontmatter y los expone', /mcps: solo-codex/.test(roleFile) && /scripts: hola/.test(roleFile) && role.mcps?.[0] === 'solo-codex', roleFile.slice(0, 200));

  console.log('Lanzamiento con Claude');
  const t1 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Con herramientas', role: 'back', repo: 'demo' });
  await call('POST', `/api/tasks/${t1.id}/assign`, { agentId: a.id }); // la hace Ana (el proyecto trae más agentes con rol back)
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  check('la tarea termina en Revisión', !!(await until(async () => (await task(t1.id))?.status === 'review', 25_000, 300)));
  const rc = runs().find((x) => x.engine === 'claude');
  const cfgArg = rc.args[rc.args.indexOf('--mcp-config') + 1];
  check('--mcp-config es un FICHERO (las claves no van en la línea de órdenes)', !!rc.mcpFile && cfgArg === rc.mcpFile.path && !rc.args.join(' ').includes(SECRET), cfgArg.slice(0, 80));
  check('el fichero es 0600 y lleva los MCP con su definición', rc.mcpFile?.mode === '600' && /demo-mcp/.test(rc.mcpFile.body) && rc.mcpFile.body.includes(SECRET) && /de-proyecto/.test(rc.mcpFile.body), rc.mcpFile?.mode);
  check('el fichero se borra al acabar', !fs.existsSync(cfgArg));
  const allowed = rc.args.slice(rc.args.indexOf('--allowedTools') + 1);
  check('mcp__ de los asignados en las herramientas permitidas', allowed.includes('mcp__demo-mcp') && allowed.includes('mcp__de-proyecto'), allowed.join(' ').slice(0, 300));
  check('el script en la lista blanca (Bash(node <ruta>:*))', allowed.includes(`Bash(node ${inv.path}:*)`));
  check('el prompt lista el script y los MCP', /Scripts del equipo/.test(rc.prompt) && rc.prompt.includes(`node ${inv.path}`) && /MCP que tienes además/.test(rc.prompt));
  const addDirs = rc.args.flatMap((x, i) => (rc.args[i - 1] === '--add-dir' ? [x] : []));
  check('la carpeta del script va en --add-dir', rc.args.includes(path.join(repo, 'scripts')), JSON.stringify(addDirs));

  console.log('Lanzamiento con Codex');
  await call('PATCH', `/api/agents/${a.id}`, { engine: 'codex', model: 'gpt-5.5', role: 'con-mcp' });
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Con Codex', role: 'con-mcp', repo: 'demo' });
  await until(async () => (await task(t2.id))?.status === 'review', 25_000, 300);
  const rx = runs().find((x) => x.engine === 'codex');
  const cfg = rx ? rx.args.filter((_, i) => rx.args[i - 1] === '-c') : [];
  check('Codex: el MCP de su config asignado por el ROL no se apaga', !!rx && !cfg.includes('mcp_servers.solo-codex.enabled=false'), cfg.filter((c) => /mcp_servers/.test(c)).join(' | '));
  check('Codex: el que define su config (demo-mcp) tampoco', !cfg.includes('mcp_servers.demo-mcp.enabled=false'));
  check('Codex: el que solo tiene Claude (de-proyecto) se le pasa por -c', cfg.some((c) => /^mcp_servers\.de_proyecto\.url=/.test(c)), cfg.join(' | ').slice(0, 300));
} catch (e) { failed++; console.error('Error:', e.stack || e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
