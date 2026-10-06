#!/usr/bin/env node
// e2e de FT-56 · revisión visible y revisión automática opcional (servidor temporal, motor demo, sin gastar tokens).
// Tareas creadas ya en «Revisión» (createTask lo admite). Comprueba: tiempo de espera y «bloquea» en la tarjeta de revisión,
// «espera a» en las dependientes, evento ReviewPending (reviewNudgeMin 0), `auto` (aprueba si pasa el check declarado, no si falla,
// y sin checks se comporta como manual), `auto-qa` con revisor demo (aprobar / devolver, tope de 2 ciclos), `reviewRequired`,
// ficheros sensibles (función pura) y TaskReviewed {by} en el Activity Stream.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as review from '../server/review.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-review-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });
const stubPort = await freePort();
const stub = http.createServer((req, res) => (req.url === '/access' ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' })) : res.writeHead(404).end('{}'))).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 2, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}`, reviewNudgeMin: 0 } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
const events = async (q = '') => call('GET', `/api/events?limit=500${q}`);

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000, 100);
  const proj = await call('POST', '/api/projects', { name: 'rev', engine: 'demo' });
  const mk = (title, extra = {}) => call('POST', '/api/tasks', { projectId: proj.id, title, role: 'back', status: 'review', ...extra });

  console.log('Visibilidad (política manual)');
  const a = await mk('Autor FT-A');
  const dep = await call('POST', '/api/tasks', { projectId: proj.id, title: 'Depende de A', role: 'back', dependsOn: [a.id] });
  await sleep(300);
  let st = await state();
  const ta = st.tasks.find((t) => t.id === a.id), td = st.tasks.find((t) => t.id === dep.id);
  check('la tarea en revisión trae reviewSince', typeof ta.reviewSince === 'number' && ta.reviewSince <= Date.now());
  check('«bloquea» lista a la dependiente', ta.blocks?.length === 1 && ta.blocks[0].id === dep.id, JSON.stringify(ta.blocks));
  check('la dependiente dice a quién espera y en qué estado', td.waitingOn?.[0]?.id === a.id && td.waitingOn[0].status === 'review', JSON.stringify(td.waitingOn));
  check('manual: no se aprueba sola', ta.status === 'review' && !ta.autoApproved);
  const pend = await until(async () => (await events()).find((e) => e.type === 'ReviewPending' && e.taskId === a.id), 12_000);
  check('ReviewPending con taskCode, minutes y blocks[]', !!pend && pend.data.taskCode === ta.code && pend.data.minutes >= 0 && pend.data.blocks.includes(td.code), JSON.stringify(pend?.data));
  await sleep(6000);
  check('ReviewPending una sola vez por entrada en revisión', (await events()).filter((e) => e.type === 'ReviewPending' && e.taskId === a.id).length === 1);

  console.log('Política auto (solo tests)');
  await call('POST', '/api/settings', { reviewPolicy: 'auto' });
  const ok = await mk('Pasa checks', { checks: ['true'] });
  check('auto + check que pasa → aprobada', !!(await until(async () => (await task(ok.id))?.status === 'done')));
  const tOk = await task(ok.id);
  check('la tarjeta dice «aprobada por revisión automática»', tOk.autoApproved?.by === 'auto', JSON.stringify(tOk.autoApproved));
  const bad = await mk('Falla checks', { checks: ['false'] });
  await sleep(1500);
  const tBad = await task(bad.id);
  check('auto + check que falla → sigue en revisión con motivo', tBad.status === 'review' && /falló/.test(tBad.reviewNote || ''), tBad.reviewNote);
  const none = await mk('Sin checks');
  await sleep(1000);
  check('auto sin verificaciones declaradas = manual', (await task(none.id)).status === 'review');
  const req = await mk('Obligatoria', { checks: ['true'], reviewRequired: true });
  await sleep(1500);
  const tReq = await task(req.id);
  check('reviewRequired nunca se aprueba sola', tReq.status === 'review' && /obligatoria/.test(tReq.reviewNote || ''), tReq.reviewNote);
  const evOk = (await events()).find((e) => e.type === 'TaskReviewed' && e.taskId === ok.id);
  check('TaskReviewed {by:auto, verdict} en el Activity Stream', evOk?.data.by === 'auto' && evOk.data.verdict?.approve === true, JSON.stringify(evOk?.data));

  console.log('Política auto-qa (revisor demo)');
  await call('POST', '/api/settings', { reviewPolicy: 'auto-qa' });
  const qa = await mk('Todo bien');
  check('auto-qa aprueba si el revisor aprueba', !!(await until(async () => (await task(qa.id))?.status === 'done')), JSON.stringify(await task(qa.id)).slice(-400));
  const tQa = await task(qa.id);
  check('queda «aprobada por QA» con sus motivos', tQa.autoApproved?.by === 'auto-qa' && /demo/.test(tQa.autoApproved.text), JSON.stringify(tQa.autoApproved));
  check('TaskReviewed {by:auto-qa}', (await events()).some((e) => e.type === 'TaskReviewed' && e.taskId === qa.id && e.data.by === 'auto-qa' && e.data.decision === 'approved'));
  const ret = await mk('Mal hecho [revisor:devolver]');
  const back = await until(async () => { const t = await task(ret.id); return t && t.status !== 'review' && t.autoReviews === 1 ? t : null; });
  check('auto-qa devuelve al autor con el feedback', !!back && /revisor/.test(back.feedback || ''), JSON.stringify(back && { s: back.status, f: back.feedback }));
  // Tope de ciclos: se pone el equipo a trabajar; el autor (demo) reentrega y el revisor vuelve a devolver hasta agotar los 2 ciclos
  await call('POST', `/api/projects/${proj.id}/run`, { running: true });
  const capped = await until(async () => { const t = await task(ret.id); return t?.status === 'review' && t.autoReviews === 2 && /dos revisiones automáticas fallidas/.test(t.reviewNote || '') ? t : null; }, 150_000, 500);
  check('tras 2 devoluciones automáticas queda para el humano con «⚠️ dos revisiones automáticas fallidas»', !!capped, JSON.stringify(await task(ret.id)).slice(0, 300));
  await call('POST', `/api/projects/${proj.id}/run`, { running: false });
  check('el tope son 2 ciclos automáticos', review.MAX_AUTO_CYCLES === 2);
  check('el historial de la tarea recoge las decisiones', (capped?.reviewLog || []).filter((r) => r.by === 'auto-qa' && r.verdict === 'rejected').length === 2, JSON.stringify(capped?.reviewLog));

  console.log('Política por proyecto');
  await call('POST', '/api/settings', { reviewPolicy: 'manual' });
  const proj2 = await call('POST', '/api/projects', { name: 'rev2', engine: 'demo' });
  const waiting = await call('POST', '/api/tasks', { projectId: proj2.id, title: 'Ya esperaba', role: 'back', status: 'review' });
  const blocked = await call('POST', '/api/tasks', { projectId: proj2.id, title: 'Depende de la que esperaba', role: 'back', dependsOn: [waiting.id] });
  await sleep(800);
  check('empresa en manual: la del proyecto sigue esperando', (await task(waiting.id)).status === 'review');
  await call('PATCH', `/api/projects/${proj2.id}`, { reviewPolicy: 'auto-qa' });
  check('el proyecto pasa a auto-qa y guarda su política', (await state()).projects.find((p) => p.id === proj2.id)?.reviewPolicy === 'auto-qa');
  check('al activarla, lo que ya esperaba se revisa y se aprueba (sin tocar nada más)', !!(await until(async () => (await task(waiting.id))?.status === 'done')), (await task(waiting.id)).reviewNote);
  check('…y la dependiente deja de esperar', !(await task(blocked.id)).waitingOn?.length, JSON.stringify((await task(blocked.id)).waitingOn));
  const other = await mk('Otro proyecto en manual');
  await sleep(1000);
  check('los proyectos sin política propia siguen la de la empresa (manual)', (await task(other.id)).status === 'review');
  await call('PATCH', `/api/projects/${proj2.id}`, { reviewPolicy: '' });
  check('«Igual que la empresa» quita la política propia', !(await state()).projects.find((p) => p.id === proj2.id)?.reviewPolicy);
  check('policyOf: el proyecto manda sobre la empresa', review.policyOf({ reviewPolicy: 'manual' }, { reviewPolicy: 'auto' }) === 'auto' && review.policyOf({ reviewPolicy: 'auto-qa' }, {}) === 'auto-qa' && review.policyOf({}, null) === 'manual');

  console.log('Ficheros sensibles y utilidades (funciones puras)');
  check('workflows y Dockerfile son sensibles', review.sensitiveHits(['.github/workflows/ci.yml', 'src/a.js', 'Dockerfile'], '', review.SENSITIVE_DEFAULT).length === 2);
  check('server/access* es sensible', review.sensitiveHits(['server/access-gate.js'], '', review.SENSITIVE_DEFAULT).length === 1);
  check('package.json sin tocar dependencias no es sensible', review.sensitiveHits(['package.json'], '+  "version": "1.2.3"\n', review.SENSITIVE_DEFAULT).length === 0);
  check('package.json con una dependencia nueva sí', review.sensitiveHits(['package.json'], '+    "left-pad": "^1.3.0"\n', review.SENSITIVE_DEFAULT).length === 1);
  check('veredicto JSON al final del texto', review.parseVerdict('ok\n{"approve": false, "reasons": ["x"], "feedback": "arregla"}')?.feedback === 'arregla');
  check('checks declarados en la descripción', review.declaredChecks({ description: 'Pasa `node --check a.js` y `npm run lint`.' }).length >= 1);
  const pb = review.pendingBlock([{ id: '1', code: 'FT-9', title: 'x', status: 'review', reviewAt: Date.now() - 20 * 60000, dependsOn: [] }], Date.now(), 10);
  check('bloque «pendientes de revisión» para el Guía', /FT-9/.test(pb) && /20 min/.test(pb), pb);
} catch (e) { failed++; console.log('✗ excepción:', e.stack || e); }
console.log(failed ? `\n${failed} fallos` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
