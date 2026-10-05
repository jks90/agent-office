#!/usr/bin/env node
// e2e de la fusión sin conflictos a mano (FT-19): comprobación previa (behind/conflicts), «Actualizar con main»,
// devolución al agente con el feedback del conflicto, auto-actualización al aprobar y eventos. Sin dependencias nuevas.
//
//   node scripts/merge-e2e.mjs
//
// Arranca `server/index.js` con AO_DATA_DIR/HOME temporales, un flow-test de pega y un `claude` falso (AO_CLAUDE_BIN) que
// edita ficheros reales de su worktree: las tareas «Compartida…» cambian la MISMA línea de shared.txt; las «Aparte…» crean su fichero.
// Si el prompt trae el feedback de conflicto («Tu rama choca con…») el falso hace `git merge main` y resuelve conservando los dos lados.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-merge-e2e-'));
const dataDir = path.join(tmp, 'data');
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 40_000, step = 150) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

const GIT_ENV = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' };
const repo = path.join(tmp, 'repo');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), '# repo e2e\n');
fs.writeFileSync(path.join(repo, 'shared.txt'), 'cabecera\nvalor: base\npie\n');
git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');

const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
// claude falso (stream-json): según el prompt edita shared.txt (misma línea en todas las tareas «Compartida»), crea su fichero («Aparte»)
// o, si trae el feedback de conflicto, hace \`git merge main\` y resuelve conservando lo de ambos lados.
const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
let started = false;
process.stdin.on('data', (d) => {
  if (started) return; started = true;
  const prompt = d.toString();
  const code = (prompt.match(/Tarea ([A-Z0-9]+-\\d+):/) || [])[1] || 'X';
  const sh = (...a) => { try { return execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return String(e.stdout || ''); } };
  let msg;
  if (prompt.includes('Tu rama choca con')) {
    sh('merge', 'main');
    const f = path.join(process.cwd(), 'shared.txt');
    const resolved = fs.readFileSync(f, 'utf8').split('\\n').filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\\n');
    fs.writeFileSync(f, resolved);
    sh('add', '-A'); sh('commit', '--no-edit');
    msg = 'Conflicto resuelto conservando ambos lados';
  } else if (/Compartida/.test(prompt)) {
    const f = path.join(process.cwd(), 'shared.txt');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^valor: .*$/m, 'valor: ' + code));
    msg = 'Cambio la línea de shared.txt';
  } else {
    fs.writeFileSync(path.join(process.cwd(), 'solo-' + code + '.txt'), code + '\\n');
    msg = 'Creo mi fichero';
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'fake', tools: [], session_id: 's1' });
  out({ type: 'result', result: msg, is_error: false, total_cost_usd: 0, session_id: 's1' });
});
process.stdin.on('end', () => process.exit(0));
`);
fs.chmodSync(fakeClaude, 0o755);

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 6, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...GIT_ENV, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);
const state = async () => (await get('/api/state')).body;
const taskById = async (id) => (await state()).tasks.find((t) => t.id === id);
const events = async (id) => (await get(`/api/events?taskId=${id}`)).body;
const waitFor = (id, pred, ms = 40_000) => until(async () => { const t = await taskById(id); return t && pred(t) ? t : null; }, ms);
const inReview = (id) => waitFor(id, (t) => t.status === 'review' || t.status === 'failed');

try {
  if (!(await until(async () => { try { return (await get('/api/state')).ok; } catch { return false; } }, 10_000, 100))) throw new Error('El servidor no arrancó:\n' + serverLog);

  const P = (await post('/api/projects', { name: 'e2e-merge', repoPath: repo, engine: 'claude' })).body;
  for (const n of ['Rita', 'Raul', 'Rosa', 'Rufo']) await post('/api/agents', { projectId: P.id, name: n, role: 'back', engine: 'claude' });
  const mk = async (title) => (await post('/api/tasks', { projectId: P.id, title, role: 'back', description: 'e2e' })).body;
  const t1 = await mk('Compartida uno');
  const t2 = await mk('Compartida dos');
  const t3 = await mk('Aparte tres');   // sin conflicto: «Actualizar con main» + aprobar
  const t5 = await mk('Aparte cinco');  // sin conflicto: se actualiza sola al aprobar
  const t6 = await mk('Compartida seis'); // choca: aprobar la devuelve al agente

  section('Las tareas terminan en revisión con su rama');
  await post(`/api/projects/${P.id}/run`, { running: true });
  const done = await Promise.all([t1, t2, t3, t5, t6].map((t) => inReview(t.id)));
  check('las cinco tareas llegan a «review» con rama propia', done.every((t) => t?.status === 'review' && t.branch === `ao/${t.code}`), JSON.stringify(done.map((t) => [t?.code, t?.status, t?.error])));
  check('recién hechas (la base no avanzó) ninguna está desfasada ni en conflicto', (await Promise.all(done.map((t) => taskById(t.id)))).every((t) => !t.behind && !(t.conflicts || []).length));
  await post(`/api/projects/${P.id}/run`, { running: false });

  section('Comprobación previa: desfasada / conflicto');
  check('aprobar la primera fusiona (rama al día: sin actualización previa)', (await post(`/api/tasks/${t1.id}/approve`)).ok);
  const stale = await until(async () => { const s = (await state()).tasks; const a = s.find((t) => t.id === t2.id); const b = s.find((t) => t.id === t3.id); return a?.behind > 0 && b?.behind > 0 ? { a, b, s } : null; }, 20_000);
  check('las demás pasan a «desfasada N commits» (campo behind: commit de la 1 + el de fusión)', !!stale, JSON.stringify((await state()).tasks.map((t) => [t.code, t.behind, t.conflicts])));
  const T2 = await taskById(t2.id), T3 = await taskById(t3.id), T6 = await taskById(t6.id);
  check('la que edita la misma línea trae conflicts=[shared.txt] (solo rutas)', JSON.stringify(T2.conflicts) === '["shared.txt"]' && JSON.stringify(T6.conflicts) === '["shared.txt"]', JSON.stringify([T2.conflicts, T6.conflicts]));
  check('la que toca otros ficheros está desfasada pero sin conflictos', T3.behind > 0 && T3.conflicts.length === 0, JSON.stringify([T3.behind, T3.conflicts]));
  check('el estado de la rama se calculó sin tocar la base ni los worktrees (main sigue en la fusión de la 1)', git(repo, 'log', '--oneline', 'main').split('\n').length === 3);

  section('«Actualizar con main» sin conflicto (task.updateFromBase del Guide)');
  const upd = await post('/api/guide/tool', { name: 'task.updateFromBase', args: { code: t3.code } }, { 'x-ao-client': 'e2e' });
  check('la tool task.updateFromBase (execute) actualiza la rama y no devuelve la tarea', upd.ok && upd.body.updated === true && upd.body.returned === false, JSON.stringify(upd.body));
  const T3b = await taskById(t3.id);
  check('queda en revisión, al día, sin conflictos y con diffStat recalculado', T3b.status === 'review' && T3b.behind === 0 && !T3b.conflicts.length && /solo-/.test(T3b.diffStat), JSON.stringify([T3b.status, T3b.behind, T3b.diffStat]));
  check('evento TaskUpdatedFromBase en el Activity Stream', (await events(t3.id)).some((e) => e.type === 'TaskUpdatedFromBase' && e.data.behind > 0));
  check('aprobar la actualizada fusiona', (await post(`/api/tasks/${t3.id}/approve`)).ok && (await taskById(t3.id)).status === 'done');

  section('Aprobar una desfasada sin conflicto la actualiza sola');
  check('la 5 sigue desfasada y sin conflicto antes de aprobar', await until(async () => { const t = await taskById(t5.id); return t.behind > 0 && !t.conflicts.length; }, 20_000));
  check('aprobarla la actualiza y la fusiona sin intervención', (await post(`/api/tasks/${t5.id}/approve`)).ok && (await taskById(t5.id)).status === 'done');
  check('TaskUpdatedFromBase también en la 5', (await events(t5.id)).some((e) => e.type === 'TaskUpdatedFromBase'));
  check('main tiene los ficheros de las tareas fusionadas', ['solo-' + t3.code + '.txt', 'solo-' + t5.code + '.txt'].every((f) => fs.existsSync(path.join(repo, f))));

  section('Conflicto: «Actualizar con main» devuelve la tarea al agente con el feedback');
  const T2c = await waitFor(t2.id, (t) => t.status === 'review' && t.behind > 0 && t.conflicts.length === 1, 20_000);
  check('la 2 aparece con «⚠ conflicto en shared.txt» (behind y conflicts) tras las fusiones', !!T2c, JSON.stringify(await taskById(t2.id)));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('la UI pinta los chips «desfasada N commit» y «⚠ conflicto en …» y el botón de actualizar', /desfasada \$\{t\.behind\}/.test(html) && /⚠ conflicto en/.test(html) && /data-update/.test(html));
  await post(`/api/projects/${P.id}/run`, { running: true }); // el agente la recogerá en cuanto vuelva a «todo»
  const ret = await post(`/api/tasks/${t2.id}/update-from-base`);
  check('POST update-from-base responde que la devolvió al agente', ret.ok && ret.body.returned === true && ret.body.updated === false, JSON.stringify(ret.body));
  const T2r = await taskById(t2.id);
  check('feedback automático con el fichero, `git merge main` y qué hacer', /Tu rama choca con main en: shared\.txt; haz `git merge main`/.test(T2r.feedback || '') && /conservando lo de ambos lados/.test(T2r.feedback), T2r.feedback);
  check('el worktree no quedó con un merge a medias (se abortó)', !fs.existsSync(path.join(git(repo, 'rev-parse', '--git-common-dir').replace(/^\.git$/, path.join(repo, '.git')), 'worktrees', t2.code, 'MERGE_HEAD')));
  check('eventos TaskConflict (con los ficheros) y TaskReviewed rejected', (await events(t2.id)).some((e) => e.type === 'TaskConflict' && e.data.files.includes('shared.txt')) && (await events(t2.id)).some((e) => e.type === 'TaskReviewed' && e.data.decision === 'rejected'));
  const back = await inReview(t2.id);
  check('el agente (falso) resuelve y la tarea vuelve a revisión al día y sin conflictos', back?.status === 'review' && back.behind === 0 && !back.conflicts.length && back.attempts === 2, JSON.stringify([back?.status, back?.behind, back?.conflicts, back?.error]));
  check('la resolución conservó lo de ambos lados', (() => { const f = git(repo, 'show', `${back.branch}:shared.txt`); return f.includes(`valor: ${t1.code}`) && f.includes(`valor: ${t2.code}`) && !f.includes('<<<<'); })());
  check('aprobarla fusiona limpia', (await post(`/api/tasks/${t2.id}/approve`)).ok && (await taskById(t2.id)).status === 'done');
  check('main contiene los dos valores y ningún marcador', (() => { const f = fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'); return f.includes(`valor: ${t1.code}`) && f.includes(`valor: ${t2.code}`) && !f.includes('<<<<'); })());

  section('Aprobar una que choca no fusiona: se devuelve sola');
  await post(`/api/projects/${P.id}/run`, { running: false });
  await waitFor(t6.id, (t) => t.conflicts?.length === 1, 20_000);
  const ap = await post(`/api/tasks/${t6.id}/approve`);
  const T6b = await taskById(t6.id);
  check('approve → 409 con el motivo y la tarea devuelta a «todo»', ap.status === 409 && /choca con main en shared\.txt/.test(ap.body.error) && T6b.status === 'todo', JSON.stringify([ap.status, ap.body, T6b.status]));
  check('main no cambió por el intento (sin merge del 6)', !git(repo, 'log', '--oneline', 'main').includes(t6.code));

  section('Reintento sobre una rama ya existente cuyo base avanzó');
  await post(`/api/projects/${P.id}/run`, { running: true });
  const back6 = await inReview(t6.id);
  check('arranca (reutiliza la rama), el feedback ya trae el conflicto y el falso lo resuelve', back6?.status === 'review' && back6.behind === 0 && !back6.conflicts.length, JSON.stringify([back6?.status, back6?.behind, back6?.error]));
  check('aprobarla fusiona', (await post(`/api/tasks/${t6.id}/approve`)).ok && (await taskById(t6.id)).status === 'done');
  await post(`/api/projects/${P.id}/run`, { running: false });
  check('la allowlist del agente incluye git merge (y no git rebase)', await import(path.join(ROOT, 'server/engines/allowlist.js')).then((m) => m.bashAllowed('git merge main') && !m.bashAllowed('git rebase --abort')));
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}`);
  if (serverLog) console.log('--- log del servidor ---\n' + serverLog.slice(-2000));
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} checks correctos, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
