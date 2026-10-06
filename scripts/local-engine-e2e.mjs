#!/usr/bin/env node
// e2e de FT-54 · motor de IA LOCAL (LM Studio / Ollama) con un servidor OpenAI-compatible FALSO.
// El servidor falso responde /v1/models y /v1/chat/completions (streaming): a la primera petición de `codex exec` devuelve
// una tool call de shell que crea un fichero, y al recibir su resultado un mensaje final. Con el `codex` REAL apuntando a
// él se comprueba que el agente `local` completa una tarea en su worktree. Si `codex` no está instalado, esa parte se salta.
// También: «Probar» guarda la configuración, el estado del motor dice «servidor responde», el guardarraíl de cuota no
// frena al motor local y el proveedor `local-api` del Guía contesta con el fake.
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

let codexOk = true;
try { execFileSync(process.env.AO_CODEX_BIN || 'codex', ['--version'], { stdio: 'ignore' }); } catch { codexOk = false; }
if (!codexOk) console.log('⚠ `codex` no está instalado: se salta la tarea real con el runner de Codex (el resto sí se prueba)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-local-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo');
for (const d of [dataDir, home, repo]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

// ── Servidor OpenAI-compatible falso ───────────────────────────────────────
const MODEL = 'fake-coder';
const requests = [];
const sse = (res, chunks) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.end('data: [DONE]\n\n'); };
const chunk = (delta, finish = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } };
const SHELL = /^(shell|exec_command|shell_command|local_shell)$/;
const fakeLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }, { id: 'otro-modelo' }] }));
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const j = JSON.parse(body || '{}');
      requests.push(j);
      const tools = (j.tools || []).map((t) => t.function?.name || t.name);
      const hasResult = (j.messages || []).some((m) => m.role === 'tool');
      const shell = tools.find((n) => SHELL.test(n));
      const cmd = 'echo hecho-por-la-ia-local > local.txt';
      if (shell && !hasResult) {
        const args = shell === 'exec_command' ? { cmd } : shell === 'shell_command' ? { command: cmd } : { command: ['bash', '-lc', cmd] };
        return sse(res, [chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: shell, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls'), usage]);
      }
      return sse(res, [chunk({ role: 'assistant', content: hasResult ? 'Listo: he creado local.txt' : 'Todo en orden (respuesta del fake local)' }), chunk({}, 'stop'), usage]);
    }
    // Responses API (la única que admite el Codex actual): SSE con eventos tipados
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const j = JSON.parse(body || '{}');
      requests.push(j);
      const tools = (j.tools || []).map((t) => t.name).filter(Boolean);
      const hasResult = (j.input || []).some((m) => m.type === 'function_call_output');
      const shell = tools.find((n) => SHELL.test(n));
      const cmd = 'echo hecho-por-la-ia-local > local.txt';
      const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
      const resp = { id: 'resp_1', object: 'response', model: MODEL };
      let item;
      if (shell && !hasResult) {
        const args = shell === 'exec_command' ? { cmd } : shell === 'shell_command' ? { command: cmd } : { command: ['bash', '-lc', cmd] };
        item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: shell, arguments: JSON.stringify(args), status: 'completed' };
      } else item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Listo: he creado local.txt' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('response.created', { response: resp }));
      res.write(ev('response.output_item.done', { output_index: 0, item }));
      res.end(ev('response.completed', { response: { ...resp, status: 'completed', usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 } } }));
      return;
    }
    res.writeHead(404).end('{}');
  });
}).listen(0, '127.0.0.1');
await until(() => fakeLlm.address(), 2000, 20);
const llmBase = `http://127.0.0.1:${fakeLlm.address().port}/v1`;

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' };
fs.mkdirSync(env.CODEX_HOME, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); fakeLlm.close(); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-ao-client': 'e2e-tab' }, body: b === undefined ? undefined : JSON.stringify(b) }); const j = await r.json().catch(() => ({})); return { status: r.status, ...j }; };
const state = () => call('GET', '/api/state');

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);

  console.log('Ajustes ▸ IA local');
  const bad = await call('POST', '/api/engines/local/probe', { baseUrl: 'http://127.0.0.1:1/v1' });
  check('«Probar» con un servidor caído da error claro', bad.ok === false && /no responde|sin respuesta/.test(bad.error || ''), JSON.stringify(bad).slice(0, 200));
  const pr = await call('POST', '/api/engines/local/probe', { baseUrl: llmBase.replace('/v1', ''), apiKey: 'clave-e2e' }); // sin /v1: se normaliza
  check('«Probar» lista los modelos del servidor', pr.ok && pr.models?.length === 2 && pr.models[0] === MODEL, JSON.stringify(pr).slice(0, 200));
  const st = await state();
  check('se guarda settings.local {baseUrl, model} y allowAuto apagado', st.settings.local?.baseUrl === llmBase && st.settings.local?.model === MODEL && st.settings.local?.allowAuto === false, JSON.stringify(st.settings.local));
  check('la clave NO viaja en el estado SSE', !JSON.stringify(st).includes('clave-e2e'));
  const eng = await call('GET', '/api/engines');
  check('enginesStatus().local: servidor responde, modelos y modelo', eng.local?.loggedIn === true && /3?\s?modelo|2 modelos/.test(eng.local.text) && eng.local.model === MODEL, JSON.stringify(eng.local).slice(0, 250));
  check('«local» es un motor elegible', st.engines.includes('local'));
  const models = await call('GET', '/api/engines/models');
  check('GET /api/engines/models trae la lista local', models.local?.some((m) => m.id === 'otro-modelo'));
  await call('POST', '/api/engines/local/settings', { model: 'otro-modelo' });
  check('el modelo por defecto es elegible', (await state()).settings.local.model === 'otro-modelo');
  await call('POST', '/api/engines/local/settings', { model: MODEL });

  console.log('Guía con IA local (local-api)');
  const gp = (await state()).guideProviders.find((p) => p.id === 'local-api');
  check('aparece «local-api» en el Proveedor del Guía y está lista', gp?.ready === true && gp.defaultModel === MODEL, JSON.stringify(gp));
  await call('POST', '/api/settings', { guideProvider: 'local-api' });
  const r = await fetch(`${base}/api/guide/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': 'e2e-tab' }, body: JSON.stringify({ text: '¿cómo va?' }) });
  let out = ''; for await (const c of r.body) out += new TextDecoder().decode(c);
  check('el Guía responde con el fake local', r.ok && /respuesta del fake local/.test(out), out.slice(0, 300));
  check('el servidor falso recibió la petición con la clave opcional', requests.length > 0);

  console.log('Agente con motor local');
  const p = await call('POST', '/api/projects', { name: 'localp', repos: [{ key: 'demo', path: repo }], engine: 'local' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  const a = await call('POST', '/api/agents', { projectId: p.id, name: 'Lola', role: 'back', engine: 'local', model: MODEL });
  check('se contrata un agente con motor local y modelo elegido', a.engine === 'local' && a.model === MODEL, JSON.stringify(a).slice(0, 200));
  if (codexOk) {
    const t = await call('POST', '/api/tasks', { projectId: p.id, title: 'Crea local.txt', description: 'Crea el fichero local.txt', role: 'back', repo: 'demo' });
    await call('POST', `/api/projects/${p.id}/run`, { running: true });
    const done = await until(async () => { const x = (await state()).tasks.find((q) => q.id === t.id); return ['review', 'done', 'failed'].includes(x?.status) ? x : null; }, 90_000, 500);
    check('la tarea termina (no falla)', done && done.status !== 'failed', JSON.stringify(done && { s: done.status, e: done.error }));
    let file = ''; try { file = execFileSync('git', ['show', `${done.branch}:local.txt`], { cwd: repo, encoding: 'utf8' }); } catch { /* sin fichero */ }
    check('el agente local creó local.txt en su rama', /hecho-por-la-ia-local/.test(file), file);
    check('sin coste', !done?.costUsd);
    check('los tokens se cuentan igual (usage por tarea)', (done?.usage?.total || 0) > 0 || (done?.usage?.output || 0) > 0, JSON.stringify(done?.usage));
    check('el guardarraíl de cuota no lo frenó', !done?.quotaBlocked && !done?.quotaPaused);
  }
} catch (e) {
  failed++; console.log('  ✗ excepción:', e.stack || e.message);
}
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
