#!/usr/bin/env node
// e2e de FT-86 · Ponytail (reglas de «construir lo mínimo»), por rol y por agente, con etiqueta en la telemetría de costes.
// Servidor temporal + `claude` y `codex` FALSOS (AO_CLAUDE_BIN / AO_CODEX_BIN) que vuelcan el prompt recibido (por AO_TASK).
// Comprueba, por motor: apagada = prompt sin el bloque; por agente y por rol = bloque en la parte ESTABLE (antes de «TAREA»);
// con la opción apagada otra vez la parte estable queda byte a byte igual; y que sin el bloque la parte activa == la apagada.
// Telemetría: variant 'base' | 'ponytail' en cada línea, en /api/costs (byVariant, filtro ?variant=) y en el CSV.
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
const until = async (fn, ms = 20_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pony-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), claudeDir = path.join(tmp, 'claude'), dumps = path.join(tmp, 'dumps');
for (const d of [dataDir, home, claudeDir, dumps]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
const mkRepo = (name) => {
  const r = path.join(tmp, name); fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
  fs.writeFileSync(path.join(r, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: r });
  return r;
};

// claude falso: vuelca el prompt (1.er mensaje de usuario stream-json) y emite un turno con uso
const fakeClaude = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
for await (const line of rl) {
  let m; try { m = JSON.parse(line); } catch { continue; }
  const c = m.message?.content;
  fs.writeFileSync(${JSON.stringify(dumps)} + '/' + process.env.AO_TASK + '.txt', typeof c === 'string' ? c : (c || []).map((x) => x.text || '').join(''));
  out({ type: 'system', subtype: 'init', session_id: 's-pony', model: 'claude-sonnet-4-5', tools: [] });
  out({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Hecho' }], usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100, output_tokens: 200 } } });
  fs.writeFileSync('hecho.txt', 'ok\\n');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Terminado', total_cost_usd: 0.01 });
  process.exit(0);
}
`, { mode: 0o755 });

// codex falso: vuelca el prompt (stdin) y emite turn.completed
const fakeCodex = path.join(tmp, 'codex-fake.mjs');
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) prompt += c;
fs.writeFileSync(${JSON.stringify(dumps)} + '/' + process.env.AO_TASK + '.txt', prompt);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'thr-pony' });
fs.writeFileSync('hecho.txt', 'ok\\n');
out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Terminado' } });
out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 } });
`, { mode: 0o755 });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x', HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_CODEX_BIN: fakeCodex, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir };
let server;
const startServer = async () => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100); };
const stopServer = async () => { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server?.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

const MARK = 'CONSTRUIR LO MÍNIMO';
const SEP = '════════ TAREA';
// Lanza una tarea y devuelve {t, prompt, stable, variableless}
async function runOne(p, title) {
  const t = await call('POST', '/api/tasks', { projectId: p.id, title, description: 'Descripción fija', role: 'back', repo: 'demo' });
  if (!t.id) throw new Error('no pude crear la tarea: ' + JSON.stringify(t));
  const done = await until(async () => { const x = await task(t.id); return x?.status === 'review' ? x : null; }, 25_000);
  const f = [t.id, t.code].map((k) => path.join(dumps, `${k}.txt`)).find((x) => fs.existsSync(x));
  const prompt = f ? fs.readFileSync(f, 'utf8') : '';
  return { t: done || t, done: !!done, prompt, stable: prompt.split(SEP)[0] };
}

try {
  await startServer();
  const turnsOf = (p, t) => { try { return fs.readFileSync(path.join(dataDir, 'costs', p.id, `${t.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  const pa = [];
  for (const engine of ['claude', 'codex']) {
    console.log(`Motor ${engine}`);
    const p = await call('POST', '/api/projects', { name: `pony-${engine}`, repos: [{ key: 'demo', path: mkRepo(`repo-${engine}`) }], engine });
    if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
        await call('POST', '/api/agents', { projectId: p.id, name: `Ana-${engine}`, role: 'back', engine });
    await call('POST', `/api/projects/${p.id}/run`, { running: true });
    pa.push(p);

    const r1 = await runOne(p, 'Tarea base uno');
    check('opción apagada (por defecto): termina en Revisión', r1.done);
    check('apagada: el prompt NO lleva el bloque', r1.prompt.length > 200 && !r1.prompt.includes(MARK));
    check('apagada: variant «base» en la tarea y en la telemetría', r1.t.variant === 'base' && turnsOf(p, r1.t).length > 0 && turnsOf(p, r1.t).every((x) => x.variant === 'base'), JSON.stringify(turnsOf(p, r1.t)[0]));

    const ag = { id: r1.t.agentId }; // el agente que cogió la tarea (el equipo base ya trae un «back»)
    await call('PATCH', `/api/agents/${ag.id}`, { ponytail: true });
    check('el agente guarda ponytail=true', (await state()).agents.find((a) => a.id === ag.id)?.ponytail === true);
    const r2 = await runOne(p, 'Tarea ponytail agente');
    check('por agente: el bloque va en la parte ESTABLE (antes de «TAREA»)', r2.stable.includes(MARK) && !r2.prompt.split(SEP)[1].includes(MARK));
    check('por agente: variant «ponytail» en la telemetría', turnsOf(p, r2.t).length > 0 && turnsOf(p, r2.t).every((x) => x.variant === 'ponytail'));
    check('quitando el bloque, la parte estable es idéntica a la apagada', r2.stable.replace(/\nMODO «CONSTRUIR[\s\S]*?cada turno\.\n/, '\n') === r1.stable || r2.stable.replace(/MODO «CONSTRUIR[\s\S]*?cada turno\.\n/, '') === r1.stable);

    await call('PATCH', `/api/agents/${ag.id}`, { ponytail: false });
    await call('POST', '/api/settings', { ponytailRoles: { back: true } });
    check('el rol se persiste en los ajustes', (await state()).settings.ponytailRoles?.back === true);
    const r3 = await runOne(p, 'Tarea ponytail rol');
    check('por rol: bloque en la parte estable y variant «ponytail»', r3.stable.includes(MARK) && r3.t.variant === 'ponytail');

    await call('POST', '/api/settings', { ponytailRoles: { back: false } });
    const r4 = await runOne(p, 'Tarea base dos');
    check('apagada otra vez: sin bloque y parte estable byte a byte igual a la inicial', !r4.prompt.includes(MARK) && r4.stable === r1.stable);
    check('apagada otra vez: variant «base»', r4.t.variant === 'base');
  }

  console.log('Persistencia');
  await stopServer(); await startServer();
  await call('POST', '/api/settings', { ponytailRoles: { back: true, qa: true, 'no valido!': true } });
  await stopServer(); await startServer();
  const st = await state();
  check('ajuste por rol persistido tras reiniciar (y claves inválidas descartadas)', st.settings.ponytailRoles?.back === true && st.settings.ponytailRoles?.qa === true && !('no valido!' in st.settings.ponytailRoles));
  await call('POST', '/api/settings', { ponytailRoles: {} });

  console.log('Costes por variante');
  for (const t of (await state()).tasks.filter((x) => x.status === 'review')) console.log('   approve', t.code, JSON.stringify(await call('POST', `/api/tasks/${t.id}/approve`)).slice(0, 150));
  await until(async () => (await state()).tasks.some((x) => x.status === 'done'), 15_000);
  const all = await call('GET', '/api/costs');
  const bv = Object.fromEntries((all.byVariant || []).map((v) => [v.key, v]));
  check('byVariant con base y ponytail', !!bv.base && !!bv.ponytail, JSON.stringify(all.byVariant));
  check('métricas por tarea aprobada (tokens, salida, devoluciones, líneas)', bv.base && ['perApprovedUsd', 'tokens', 'outputTokens', 'returns', 'lines'].every((k) => k in bv.base));
  check('hay tareas aprobadas de ambas variantes', bv.base?.tasks > 0 && bv.ponytail?.tasks > 0, JSON.stringify(bv));
  const onlyP = await call('GET', '/api/costs?variant=ponytail');
  check('filtro ?variant=ponytail: solo tareas ponytail', onlyP.tasks.length > 0 && onlyP.tasks.every((t) => t.variant === 'ponytail') && onlyP.variant === 'ponytail');
  check('el filtro no esconde la comparación', onlyP.byVariant.length === 2);
  const csv = (await call('GET', '/api/costs/export?format=csv')).csv || '';
  check('el CSV exporta la columna variant', /(^|,)"?variant"?(,|\n)/.test(csv.split('\n')[0]) && /ponytail/.test(csv));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
