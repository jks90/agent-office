#!/usr/bin/env node
// e2e · el Guía ve los flows del workspace de flow-test (flowtest.listFlows / flowtest.readFlow).
// Servidor temporal + flow-test FALSO (/access, /workspace/flows, /workspace/flow). Comprueba: listar por la carpeta del
// proyecto (no solo el repo), sin proyecto = todos, filtro por texto, solo .flow.json; leer un flow devuelve el resumen de
// nodos (HTTP con método y URL, notas, SQL); 404 claro si no existe; las dos son de solo lectura (sin confirmación).
import { spawn } from 'node:child_process';
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
const until = async (fn, ms = 10_000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const files = [
  { path: 'flowtest/flow-test/flows/api-store.flow.json', name: 'api-store.flow.json', type: 'flow', mtime: 1 },
  { path: 'flowtest/arquitectura-guide.flow.json', name: 'arquitectura-guide.flow.json', type: 'flow', mtime: 2 },
  { path: 'flowtest/agent-office/data/worktrees/abc/FT-1/flows/api-store.flow.json', name: 'api-store.flow.json', type: 'flow', mtime: 5 },
  { path: 'flowtest/README.md', name: 'README.md', type: 'md', mtime: 3 },
  { path: 'gestionlab/10-stock.flow.json', name: '10-stock.flow.json', type: 'flow', mtime: 4 },
];
const flow = { name: 'Arquitectura', nodes: [{ id: 'h1', name: 'Crear tarea', curl: 'curl -X POST "{{ao}}/api/tasks" -d "{}"' }],
  infoNodes: [{ id: 'i1', name: 'Nota', content: 'Explica el Guía' }, { id: 'm1', name: 'Diagrama', content: 'graph TD', renderMode: 'mermaid' }],
  sqlNodes: [{ id: 's1', name: 'Consulta', query: 'select 1' }], connections: [{ from: 'h1', to: 'i1' }], envVariables: { ao: 'x' } };
const ftPort = await freePort();
const ft = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname === '/access') return json(200, { mode: 'licensed', plan: 'e2e' });
  if (u.pathname === '/workspace/flows') return json(200, { dir: '/app/flows', files });
  if (u.pathname === '/workspace/flow') return u.searchParams.get('path') === 'flowtest/arquitectura-guide.flow.json' ? json(200, { path: u.searchParams.get('path'), mtime: 2, flow }) : json(404, { error: `No existe flows/${u.searchParams.get('path')}` });
  json(404, {});
}).listen(ftPort, '127.0.0.1');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gflows-'));
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${ftPort}`, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: path.join(tmp, 'home'), AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' } });
process.on('exit', () => { try { server.kill('SIGTERM'); ft.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const tool = async (name, args) => { const r = await fetch(base + '/api/guide/tool', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': 'e2e' }, body: JSON.stringify({ name, args }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } });
  await until(async () => (await (await fetch(base + '/api/state')).json()).projects.some((p) => p.folder === 'flowtest')); // syncWorkspace crea el proyecto por carpeta
  const unwrap = (r) => r.body?.result ?? r.body;
  const l1 = unwrap(await tool('flowtest.listFlows', { projectId: 'flowtest' }));
  check('lista los flows de la carpeta del proyecto, también los de repos enlazados', l1.total === 2 && l1.flows.some((f) => f.path === 'flowtest/flow-test/flows/api-store.flow.json'), JSON.stringify(l1).slice(0, 300));
  check('solo .flow.json (sin .md) y sin las copias de los worktrees de los agentes', !l1.flows.some((f) => /\.md$|data\/worktrees/.test(f.path)));
  const pr = (await (await fetch(base + '/api/state')).json()).projects.find((p) => p.folder === 'flowtest');
  check('el recuento del proyecto tampoco cuenta esas copias', pr?.flows === 2, String(pr?.flows));
  const l2 = unwrap(await tool('flowtest.listFlows', {}));
  check('sin proyecto: todos los flows del workspace', l2.total === 3, JSON.stringify(l2).slice(0, 200));
  const l3 = unwrap(await tool('flowtest.listFlows', { query: 'STOCK' }));
  check('filtro por texto (sin distinguir mayúsculas)', l3.total === 1 && l3.flows[0].path === 'gestionlab/10-stock.flow.json');
  const r1 = await tool('flowtest.readFlow', { path: 'flowtest/arquitectura-guide.flow.json' });
  const f1 = unwrap(r1);
  check('leer un flow: resumen con nombre, recuentos, conexiones y variables', f1.name === 'Arquitectura' && f1.counts?.http === 1 && f1.counts?.nota === 1 && f1.counts?.mermaid === 1 && f1.counts?.sql === 1 && f1.connections === 1 && f1.variables === 1, JSON.stringify(f1).slice(0, 300));
  check('el nodo HTTP trae método y URL; la nota, su texto', f1.nodes?.some((n) => n.kind === 'http' && n.detail === 'POST {{ao}}/api/tasks') && f1.nodes?.some((n) => n.kind === 'nota' && /Explica el Guía/.test(n.detail)));
  check('solo lectura: no pide confirmación', r1.status === 200 && !r1.body?.confirm && !r1.body?.needsConfirmation, JSON.stringify(r1.body).slice(0, 150));
  const r404 = await tool('flowtest.readFlow', { path: 'flowtest/no-existe.flow.json' });
  check('flow inexistente: 404 con el motivo de flow-test', r404.status === 404 && /No existe/.test(JSON.stringify(r404.body)), JSON.stringify(r404));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
