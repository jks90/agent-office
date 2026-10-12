#!/usr/bin/env node
// FT-187 · tareas asignadas al usuario humano (assignedAgentId = 'human'): ningún agente las coge, las mueves tú a mano
// (review/done sin rechazo) y no cuentan como aviso (🔔, «por revisar», ReviewPending, pendientes del Guía, alertas del coordinador).
// Una tarea de agente sigue funcionando igual. Servidor temporal (la interfaz la cubre human-ui-e2e).
//   node scripts/human-task-ui-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-human-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => (req.url === '/access' ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })) : res.writeHead(404).end('{}'))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}`, reviewNudgeMin: 0 } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: dataDir, AO_RTK: 'off' }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', stop);
const raw = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const call = async (...a) => (await raw(...a)).j;
const task = async (id) => (await call('GET', '/api/state')).tasks.find((t) => t.id === id);


try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const P = await call('POST', '/api/projects', { name: 'Humano', engine: 'demo' });
  const mk = (extra) => raw('POST', '/api/tasks', { projectId: P.id, role: 'back', ...extra });

  // ── crear / validar ──
  const bad = await mk({ title: 'Agente inexistente', assignedAgentId: 'nope' });
  check('asignado desconocido al crear → 400', bad.status >= 400 && bad.status < 500, String(bad.status));
  const mine = (await mk({ title: 'Mi tarea', assignedAgentId: 'human' })).j;
  check('se crea asignada al humano', mine.assignedAgentId === 'human' && mine.status === 'todo', JSON.stringify(mine).slice(0, 160));
  const noRole = await mk({ title: 'Sin rol', assignedAgentId: 'human', });
  check('asignada al humano no exige rol', noRole.status === 200, String(noRole.status));

  // ── ningún agente la coge (equipo libre, proyecto en marcha) ──
  await call('POST', `/api/projects/${P.id}/run`, { running: true });
  await sleep(4500); // varios ticks (1,5 s)
  let t = await task(mine.id);
  check('con el equipo libre y en marcha, el agente NO la coge', t.status === 'todo' && !t.agentId && !t.attempts, JSON.stringify({ s: t.status, a: t.agentId }));
  check('el snapshot no le prevé agente', !t.plannedAgentId);

  // ── una tarea de agente sigue funcionando igual ──
  const ag = (await mk({ title: 'Tarea de agente' })).j;
  let started = false;
  for (let i = 0; i < 100 && !started; i++) { const x = await task(ag.id); started = x && x.status !== 'todo'; if (!started) await sleep(200); }
  check('la tarea de agente la coge un agente', started);
  t = await task(mine.id);
  check('…y la del humano sigue sin tocar', t.status === 'todo' && !t.agentId);

  // ── el usuario la mueve a mano: review y done, sin 409 ──
  const toReview = await raw('PATCH', `/api/tasks/${mine.id}`, { status: 'review' });
  check('humano: Por hacer → Revisión (200)', toReview.status === 200 && toReview.j.status === 'review', String(toReview.status) + ' ' + (toReview.j.error || ''));
  await sleep(6500); // da tiempo a reviewNudge (5 s, reviewNudgeMin = 0) y a la revisión automática
  t = await task(mine.id);
  check('en Revisión no se marca como aviso (sin nudged ni revisor)', !t.nudged && !t.reviewing && !t.reviewNote, JSON.stringify({ n: t.nudged, r: t.reviewing, note: t.reviewNote }));
  const toDone = await raw('PATCH', `/api/tasks/${mine.id}`, { status: 'done' });
  check('humano: Revisión → Hecho (200)', toDone.status === 200 && toDone.j.status === 'done', String(toDone.status) + ' ' + (toDone.j.error || ''));
  const back = await raw('PATCH', `/api/tasks/${mine.id}`, { status: 'todo' });
  check('humano: Hecho → Por hacer (reabrir)', back.status === 200 && back.j.status === 'todo');
  const toFailed = await raw('PATCH', `/api/tasks/${mine.id}`, { status: 'failed' });
  check('«Fallida» no es destino manual (400)', toFailed.status === 400, String(toFailed.status));
  await sleep(2500);
  check('reabierta, sigue sin cogerla nadie', !(await task(mine.id)).agentId);

  // ── aprobar una del humano en revisión ──
  const m2 = (await mk({ title: 'Otra mía', assignedAgentId: 'human', status: 'review' })).j;
  check('creada ya en Revisión: sin revisión de agente', m2.status === 'review' && !m2.reviewing);
  const ap = await raw('POST', `/api/tasks/${m2.id}/approve`, {});
  check('aprobarla pasa a Hecho', ap.status < 300 && (await task(m2.id)).status === 'done', String(ap.status));

  // ── reasignar: humano ⇄ agente ──
  const m3 = (await mk({ title: 'Cambiante', status: 'backlog' })).j;
  const toMe = await raw('POST', `/api/tasks/${m3.id}/assign`, { agentId: 'human' });
  check('/assign human', toMe.status === 200 && toMe.j.assignedAgentId === 'human', String(toMe.status));
  const toRole = await raw('PATCH', `/api/tasks/${m3.id}`, { assignedAgentId: '' });
  check('PATCH assignedAgentId vacío → vuelve a elegirse por rol', toRole.status === 200 && !toRole.j.assignedAgentId);
  const toMe2 = await raw('PATCH', `/api/tasks/${m3.id}`, { assignedAgentId: 'human' });
  check('PATCH assignedAgentId human', toMe2.j.assignedAgentId === 'human');
  const state = await call('GET', '/api/state');
  const agentId = state.projects.find((p) => p.id === P.id).team.map((id) => state.agents.find((a) => a.id === id)).find((a) => a?.role === 'back')?.id;
  if (agentId) {
    const toAg = await raw('POST', `/api/tasks/${m3.id}/assign`, { agentId });
    check('reasignar a un agente del equipo', toAg.status === 200 && toAg.j.assignedAgentId === agentId, String(toAg.status));
  } else console.log('  · sin agente back en el equipo: me salto la reasignación a agente');

  // ── funciones puras de avisos ──
  const review = await import('../server/review.js');
  const coord = await import('../server/coordinator.js');
  const old = Date.now() - 3600e3;
  const tasks = [
    { id: 'h', code: 'X-1', title: 'mía', status: 'review', assignedAgentId: 'human', reviewAt: old, dependsOn: [] },
    { id: 'a', code: 'X-2', title: 'del agente', status: 'review', reviewAt: old, dependsOn: [] },
    { id: 'd', code: 'X-3', title: 'espera a la mía', status: 'todo', dependsOn: ['h'] },
  ];
  const pend = review.pendingBlock(tasks, Date.now(), 0);
  check('«pendientes de revisión» del Guía: solo la del agente', pend.includes('X-2') && !pend.includes('X-1'), pend);
  const alerts = coord.reviewPlan({ tasks, reviewPolicy: 'manual', now: Date.now(), reviewNudgeMin: 0 });
  check('el coordinador no alerta de bloqueo por una tarea del humano', !alerts.some((x) => String(x.taskId || x.code || x.why).includes('X-1') || x.taskId === 'h'), JSON.stringify(alerts).slice(0, 200));

} catch (e) { console.error('ERROR', e); failed++; }
finally { stop(); console.log(failed ? `✗ ${failed} fallos` : '✓ todo OK'); process.exit(failed ? 1 : 0); }
