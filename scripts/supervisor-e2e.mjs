#!/usr/bin/env node
// FT-122 · e2e del Coordinador / Supervisor de serie: viene en el equipo; con la delegación apagada deja «✅ listo para aprobar»
// (checks verdes) o devuelve con nota (checks rojos); con la delegación encendida aprueba (también reviewRequired) y recorta
// dependencias que sobran (sin delegar, solo propone).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, trimDeps, changedLines } from '../server/supervisor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// Lógica pura
check('decide: checks rojos → devuelve con la verificación en la nota', decide({ checks: { ok: false, failed: 'npm test' } }).action === 'reject');
check('decide: verdes sin delegar → recomienda', decide({ checks: { ok: true } }).action === 'recommend');
check('decide: verdes y delegado → aprueba', decide({ checks: { ok: true }, delegated: true }).action === 'approve');
check('decide: ficheros sensibles → solo recomienda aunque delegue', decide({ checks: { ok: true }, delegated: true, sensitive: ['.env'] }).action === 'recommend');
const tr = trimDeps([
  { id: 'a', code: 'X-1', title: 'Navegador', status: 'review', dependsOn: [] },
  { id: 'b', code: 'X-2', title: 'Otra cosa', description: 'nada que ver', status: 'todo', dependsOn: ['a'] },
  { id: 'c', code: 'X-3', title: 'Sobre X-1', status: 'todo', dependsOn: ['a'] },
]);
check('trimDeps: recorta la que no menciona a la bloqueante y respeta la que sí', tr.length === 1 && tr[0].code === 'X-2', JSON.stringify(tr));

// FT-122 (revisión): reglas de recorte más estrictas
const kinds = { qa1: 'qa', doc1: 'docs', dev: 'dev', plan: 'planner' };
const kindOf = (t) => kinds[t.role] || 'dev';
const T = (o) => ({ title: o.id, description: '', dependsOn: [], status: 'todo', role: 'dev', ...o });
const rr = trimDeps([T({ id: 'd1', code: 'Y-1', status: 'review' }), T({ id: 'q', code: 'Y-2', role: 'qa1', dependsOn: ['d1'] })], kindOf);
check('trimDeps: un QA que depende de un dev en review sin mencionarlo → sin recorte', rr.length === 0, JSON.stringify(rr));
const rd = trimDeps([T({ id: 'd1', code: 'Y-1', status: 'review' }), T({ id: 'docs', code: 'Y-3', role: 'doc1', dependsOn: ['d1'] })], kindOf);
check('trimDeps: docs tampoco', rd.length === 0);
const rp = trimDeps([T({ id: 'pl', code: 'Y-4', role: 'plan', status: 'failed' }), T({ id: 'x', code: 'Y-5', dependsOn: ['pl'] })], kindOf);
check('trimDeps: nunca si la bloqueante es planner', rp.length === 0);
const rv = trimDeps([T({ id: 'd1', code: 'Y-1', status: 'review' }), T({ id: 'x', code: 'Y-6', dependsOn: ['d1'] })], kindOf);
check('trimDeps: bloqueante en review → solo propuesta (auto=false)', rv.length === 1 && rv[0].auto === false);
const rf = trimDeps([T({ id: 'f1', code: 'Y-7', status: 'failed' }), T({ id: 'x', code: 'Y-8', dependsOn: ['f1'] })], kindOf);
check('trimDeps: dev que depende de otro dev failed sin relación → recorte automático', rf.length === 1 && rf[0].auto === true);
check('trimDeps: depsKept (la persona dijo «Mantener») no se vuelve a proponer', trimDeps([T({ id: 'f1', code: 'Y-7', status: 'failed' }), T({ id: 'x', code: 'Y-8', dependsOn: ['f1'], depsKept: true })], kindOf).length === 0);
check('changedLines cuenta +/- sin cabeceras', changedLines('--- a/x\n+++ b/x\n@@\n+a\n-b\n c\n') === 2);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sup-'));
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => { if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })); res.writeHead(404).end('{}'); }).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'ws'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: path.join(tmp, 'home'), AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off', AO_SUPERVISOR_MS: '300' } });
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* aún no */ } await sleep(100); }
  const p = await call('POST', '/api/projects', { name: 'sup', engine: 'demo' });
  await call('PATCH', `/api/projects/${p.id}`, { coordinator: '' });
  const st0 = await call('GET', '/api/state');
  const pr0 = st0.projects.find((x) => x.id === p.id);
  const sup = st0.agents.find((a) => pr0.team.includes(a.id) && a.role === 'coordinador');
  check('el proyecto nuevo trae al Coordinador en su equipo', !!sup, JSON.stringify(pr0.team));
  check('delegación apagada por defecto', !pr0.supervisorApproves);

  const mk = (title, extra) => call('POST', '/api/tasks', { projectId: p.id, title, role: 'back', status: 'review', ...extra });
  const ok = await mk('Verde', { checks: ['true'] });
  const bad = await mk('Roja', { checks: ['false'] });
  const req = await mk('Obligatoria', { checks: ['true'], reviewRequired: true });
  const dep = await call('POST', '/api/tasks', { projectId: p.id, title: 'Algo independiente', role: 'back', status: 'backlog', dependsOn: [req.id] });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });

  const okR = await until(async () => { const t = await task(ok.id); return t.supervisor ? t : null; });
  check('sin delegar: checks verdes → recomendación «listo para aprobar» y sigue en revisión', okR?.status === 'review' && okR.supervisor.action === 'recommend' && /listo para aprobar/.test(okR.supervisor.text), JSON.stringify(okR?.supervisor));
  const reqR = await until(async () => { const t = await task(req.id); return t.supervisor ? t : null; });
  check('sin delegar: la de revisión obligatoria tampoco se aprueba', reqR?.status === 'review' && reqR.supervisor.action === 'recommend');
  const badR = await until(async () => { const t = await task(bad.id); return t.reviewLog?.some((l) => l.by === 'coordinador') ? t : null; });
  check('checks rojos → devuelta al agente con nota concreta', badR && badR.status !== 'review' && badR.reviewLog.some((l) => l.verdict === 'rejected' && /false/.test(l.text)), JSON.stringify(badR?.reviewLog));
  const prop = await until(async () => (await task(dep.id)).depProposal);
  check('sin delegar: propone recortar la dependencia (y no la aplica)', !!prop && (await task(dep.id)).dependsOn.length === 1, JSON.stringify(prop));

  await call('PATCH', `/api/projects/${p.id}`, { supervisorApproves: true });
  const okD = await until(async () => { const t = await task(ok.id); return t.status === 'done' ? t : null; });
  check('delegación on: checks verdes → aprobada y fusionada por el coordinador', !!okD && okD.autoApproved?.by === 'coordinador', JSON.stringify(okD?.autoApproved));
  const reqD = await until(async () => { const t = await task(req.id); return t.status === 'done' ? t : null; });
  check('delegación on: también la de revisión obligatoria', !!reqD);
  const depD = await task(dep.id);
  check('delegación on: con la bloqueante en review la dependencia NO se auto-recorta (solo propuesta)', depD.dependsOn.length === 1);
  const kept = await call('POST', `/api/tasks/${dep.id}/dep-proposal`, { accept: false });
  const depK = await task(dep.id);
  check('«Mantener» marca depsKept y borra la propuesta', kept.ok && depK.depsKept && !depK.depProposal && depK.dependsOn.length === 1);
  // Proyectos existentes: «Añadir coordinador»
  await call('PATCH', `/api/projects/${p.id}/team`, { remove: [sup.id] });
  const had = (await call('GET', '/api/state')).projects.find((x) => x.id === p.id).team.includes(sup.id);
  if (!had) {
    const add = await call('POST', `/api/projects/${p.id}/supervisor`);
    check('POST /supervisor añade un coordinador al equipo', !!add.agentId, JSON.stringify(add));
    const again = await call('POST', `/api/projects/${p.id}/supervisor`);
    check('si ya hay coordinador, error claro', /ya tiene coordinador/.test(again.error || again.message || ''), JSON.stringify(again));
  } else console.log('  (omitido: no se pudo quitar al coordinador por la API de equipo)');
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
