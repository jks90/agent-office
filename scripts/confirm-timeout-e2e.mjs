#!/usr/bin/env node
// FT-128 · e2e de las confirmaciones 🛡 largas del Guía por ao-mcp: una que se contesta a los 6 s sigue, una sin respuesta
// en el tope (AO_CONFIRM_TIMEOUT_MS reducido) da un error claro y se retira de 🔔, y un reintento idéntico no duplica la pregunta.
//
//   node scripts/confirm-timeout-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ctimeout-e2e-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* parado */ } } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function startServer(name, extraEnv = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace'), browserPolicy: { default: 'ask', domains: {} } } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dir, AO_GUIDE_FAKE: '1', AO_DESKTOP: 'fake', AO_BROWSER: 'fake', ...extraEnv } });
  procs.push(proc);
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ao-client': 'ct-e2e' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) }; };
  if (!(await until(async () => { try { return (await call('GET', '/api/state')).ok; } catch { return false; } }))) throw new Error(`El servidor ${name} no arrancó:\n${log}`);
  await call('POST', '/api/settings', { guideProvider: 'fake' });
  const pending = async () => (await call('GET', '/api/questions')).body.filter((q) => q.kind === 'confirm');
  return { base, call, pending, proc };
}

// Cliente ao-mcp por stdio: devuelve mcpCall(name, args) → texto de la respuesta
function startMcp(base, env = {}) {
  const p = spawn(process.execPath, ['bin/ao-mcp.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, AO_URL: base, ...env } });
  procs.push(p);
  const waiters = new Map();
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  let n = 0;
  return (name, args) => new Promise((resolve) => { const id = ++n; waiters.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
}
const textOf = (m) => m.result?.content?.[0]?.text || m.error?.message || '';

try {
  section('tope por defecto: se contesta a los 6 s y la tool sigue');
  const a = await startServer('a');
  const mcpA = startMcp(a.base);
  const t0 = Date.now();
  const pA = mcpA('browser_navigate', { url: 'https://lenta.test/' });
  const q = await until(async () => (await a.pending())[0], 8000, 80);
  check('aparece la 🛡', !!q && /lenta\.test/.test(q.question));
  await sleep(6000);
  await a.call('POST', `/api/questions/${q.id}/answer`, { answer: 'Sí' });
  const rA = await pA;
  check('tras 6 s la tool devuelve el resultado', !rA.result?.isError && Date.now() - t0 >= 6000, textOf(rA));

  section('sin respuesta en el tope: error claro, sin duplicados');
  const b = await startServer('b', { AO_CONFIRM_TIMEOUT_MS: '2500' });
  const mcpB = startMcp(b.base);
  const p1 = mcpB('browser_navigate', { url: 'https://muda.test/' });
  await until(async () => (await b.pending())[0], 8000, 80);
  const p2 = mcpB('browser_navigate', { url: 'https://muda.test/' }); // reintento idéntico del modelo
  await sleep(500);
  check('el reintento idéntico reutiliza la pregunta (1 sola 🛡)', (await b.pending()).length === 1, JSON.stringify(await b.pending()));
  const [r1, r2] = await Promise.all([p1, p2]);
  check('ambas tools devuelven isError con «no ha contestado»', r1.result?.isError && r2.result?.isError && /no ha contestado/.test(textOf(r1)) && /no ha contestado/.test(textOf(r2)), `${textOf(r1)} | ${textOf(r2)}`);
  check('la pregunta se retira de 🔔', (await b.pending()).length === 0);
  check('no es «fetch failed»', !/fetch failed/.test(textOf(r1)));

  section('tope de ao-mcp (AO_MCP_TOOL_TIMEOUT_MS)');
  const mcpC = startMcp(a.base, { AO_MCP_TOOL_TIMEOUT_MS: '1500' });
  const rC = await mcpC('browser_navigate', { url: 'https://otra.test/' });
  check('ao-mcp corta con error claro', rC.result?.isError && /no ha contestado/.test(textOf(rC)), textOf(rC));
} catch (e) {
  failed++;
  console.log(`  ✗ excepción: ${e.stack || e}`);
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
