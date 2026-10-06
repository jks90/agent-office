#!/usr/bin/env node
// e2e · coste y ahorro de Codex sin bajar de modelo.
// Servidor temporal + `codex` FALSO (AO_CODEX_BIN) que apunta argumentos y prompt + CODEX_HOME con un config.toml de usuario
// lleno de MCP. Comprueba: los MCP/plugins/memorias del usuario van apagados por -c (flow-test no) y la salida de órdenes
// acotada; el coste ≈ se guarda en la tarea y en la sesión del agente (costEstimated); el aviso de «sin editar» salta a los
// 15 pasos con Codex; el PO recibe el briefing del repo; la regla de agrupar lecturas va en el prompt; y al cargar el
// estado, las tareas de Codex antiguas sin coste reciben el estimado.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cxcost-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), codexHome = path.join(tmp, 'codex');
for (const d of [dataDir, home, repo, codexHome]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n[mcp_servers.unity]\ncommand = "unity"\n[mcp_servers.hostinger-vps]\ncommand = "npx"\n[mcp_servers.hostinger-vps.env]\nA = "1"\n[mcp_servers."raro.uno"]\ncommand = "y"\n[plugins."github@openai-curated"]\nenabled = true\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

// codex falso: «VUELTAS» = 16 órdenes distintas sin editar (y espera: lo corta el aviso); si el prompt trae el aviso, termina.
const runsLog = path.join(tmp, 'runs.jsonl');
const fake = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) prompt += c;
fs.appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ args: a, prompt }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'thr-cost' });
if (/Objetivo del equipo/.test(prompt)) {
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '\\u0060\\u0060\\u0060json\\n[{"title":"Hacer algo","description":"d","role":"back","dependsOn":[]}]\\n\\u0060\\u0060\\u0060' } });
  out({ type: 'turn.completed', usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 1000 } });
} else if (/VUELTAS/.test(prompt) && !/sin editar ningún fichero/.test(prompt)) {
  for (let i = 0; i < 16; i++) {
    out({ type: 'item.started', item: { id: 'c' + i, type: 'command_execution', command: '/usr/bin/zsh -lc "sed -n ' + i + ',9p x"' } });
    out({ type: 'item.completed', item: { id: 'c' + i, type: 'command_execution', command: '/usr/bin/zsh -lc "sed -n ' + i + ',9p x"', exit_code: 0, aggregated_output: '' } });
  }
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync('hecho.txt', 'ok\\n');
  out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'hecho.txt' }], status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Terminado' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 2000 } });
}
`, { mode: 0o755 });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: home, CODEX_HOME: codexHome, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CODEX_BIN: fake, AO_RTK: 'off' } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const st = () => call('GET', '/api/state');
const task = async (id) => (await st()).tasks.find((t) => t.id === id);
const runs = () => (fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const cfg = (r) => r.args.filter((_, i) => r.args[i - 1] === '-c');
process.on('exit', () => { try { server.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const p = await call('POST', '/api/projects', { name: 'cxcost', repos: [{ key: 'demo', path: repo }], engine: 'codex' });
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Rita', role: 'back', engine: 'codex', model: 'gpt-5.5' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });

  console.log('Aislamiento y coste estimado');
  const t1 = await call('POST', '/api/tasks', { projectId: p.id, title: 'Normal', role: 'back', repo: 'demo' });
  const d1 = await until(async () => { const x = await task(t1.id); return x?.status === 'review' ? x : null; }, 20_000, 300);
  check('la tarea termina en Revisión', !!d1);
  const c1 = cfg(runs()[0] || { args: [] });
  check('apaga los MCP del usuario (unity, hostinger-vps, "raro.uno")', ['mcp_servers.unity.enabled=false', 'mcp_servers.hostinger-vps.enabled=false', 'mcp_servers."raro.uno".enabled=false'].every((x) => c1.includes(x)), JSON.stringify(c1));
  check('no toca la subtabla .env ni a flow-test', !c1.some((x) => /\.env\.enabled|flow_test\.enabled/.test(x)));
  check('apaga plugins y memorias, sin instrucciones de apps y con la salida de órdenes acotada', ['features.plugins=false', 'features.memories=false', 'include_apps_instructions=false', 'tool_output_token_limit=8000'].every((x) => c1.includes(x)), JSON.stringify(c1));
  const est = ((100000 - 80000) * 1.25 + 80000 * 0.125 + 2000 * 10) / 1e6;
  check(`coste ≈ guardado en la tarea (${est} $) y marcado como estimado`, Math.abs((d1?.costUsd || 0) - est) < 1e-6 && d1?.costEstimated === true, `${d1?.costUsd} ${d1?.costEstimated}`);
  const ag = (await st()).agents.find((x) => x.id === (d1?.agentId || a.id));
  check('la sesión del agente lleva el coste ≈', Math.abs((ag?.usage?.costUsd || 0) - est) < 1e-6 && ag?.usage?.costEstimated === true, JSON.stringify(ag?.usage));
  check('el prompt pide agrupar lecturas', /Agrupa: cada paso/.test(runs()[0]?.prompt || ''));

  console.log('Atascos con Codex');
  const t2 = await call('POST', '/api/tasks', { projectId: p.id, title: 'VUELTAS', role: 'back', repo: 'demo' });
  const d2 = await until(async () => { const x = await task(t2.id); return x?.status === 'review' ? x : null; }, 25_000, 300);
  const vr = runs().filter((r) => /VUELTAS/.test(r.prompt));
  check('a los 15 pasos sin editar se le avisa y se relanza con el aviso', vr.length === 2 && /15 pasos seguidos sin editar/.test(vr[1].prompt), `${vr.length} lanzamientos`);
  check('tras el aviso termina en Revisión', !!d2);

  console.log('Planificación');
  await call('POST', `/api/projects/${p.id}/goal`, { goal: 'Algo nuevo' });
  const pr = await until(async () => runs().find((r) => /Objetivo del equipo/.test(r.prompt)), 20_000, 300);
  check('el PO recibe el briefing del repo antes del objetivo', pr && /Briefing del repo/.test(pr.prompt) && pr.prompt.indexOf('Briefing del repo') < pr.prompt.indexOf('Objetivo del equipo'), pr?.prompt.slice(0, 200));
} catch (e) { failed++; console.error('Error:', e.message); }

console.log('Relleno de tareas antiguas');
const d2dir = path.join(tmp, 'data2'); fs.mkdirSync(d2dir);
fs.writeFileSync(path.join(d2dir, 'state.json'), JSON.stringify({ settings: {}, projects: [], agents: [], tasks: [
  { id: 'a1', code: 'X-1', projectId: 'p', status: 'done', dependsOn: [], costUsd: null, usage: { input: 200000, output: 20000, cache: 6000000, total: 6220000, source: 'codex turn.completed' } },
  { id: 'a2', code: 'X-2', projectId: 'p', status: 'done', dependsOn: [], costUsd: 0.5, usage: { input: 1, output: 1, cache: 1, total: 3, source: 'claude result' } },
] }));
const loaded = JSON.parse(execFileSync(process.execPath, ['-e', "import('./server/store.js').then((s) => console.log(JSON.stringify(s.get().tasks)))"], { cwd: ROOT, env: { ...process.env, AO_DATA_DIR: d2dir }, encoding: 'utf8' }).trim().split('\n').at(-1));
const old = loaded.find((t) => t.id === 'a1'), other = loaded.find((t) => t.id === 'a2');
check('una tarea de Codex sin coste recibe el ≈ al cargar', Math.abs(old.costUsd - (200000 * 1.25 + 6000000 * 0.125 + 20000 * 10) / 1e6) < 1e-6 && old.costEstimated, JSON.stringify(old));
check('las que ya tenían coste no cambian', other.costUsd === 0.5 && !other.costEstimated);

console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
