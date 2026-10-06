#!/usr/bin/env node
// e2e de worktree y rama por CADA repo del proyecto (FT-44): proyecto de 2 repos git temporales y un `claude` falso (AO_CLAUDE_BIN)
// que escribe en el worktree de cada repo (o, según el título de la tarea, fuera de él, en el checkout principal). Sin dependencias nuevas.
//
//   node scripts/multirepo-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-multirepo-e2e-'));
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
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const mkRepo = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'valor: base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
};
const web = mkRepo('web'), api = mkRepo('api');

const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
// claude falso: saca del prompt la ruta del worktree de «api» y de su checkout principal; según el título escribe en uno u otro sitio.
const fs = require('node:fs'); const path = require('node:path');
let started = false;
process.stdin.on('data', (d) => {
  if (started) return; started = true;
  const prompt = d.toString();
  const code = (prompt.match(/Tarea ([A-Z0-9]+-\\d+):/) || [])[1] || 'X';
  const apiWt = (prompt.match(/«api»[^\\n]*?escribe SOLO en (\\S+) \\(checkout principal: (\\S+),/) || []);
  const put = (dir, f, txt) => fs.writeFileSync(path.join(dir, f), txt);
  put(process.cwd(), 'web-' + code + '.txt', code + '\\n');                              // siempre toca el repo principal
  if (/Tarea \\S+: Dos repos/.test(prompt)) put(apiWt[1], 'api-' + code + '.txt', code + '\\n');      // …y el worktree del otro repo
  if (/Tarea \\S+: Fuera/.test(prompt)) put(apiWt[2], 'leak-' + code + '.txt', code + '\\n');         // …o se salta el worktree y escribe en el checkout principal
  if (/Tarea \\S+: Choque/.test(prompt)) put(apiWt[1], 'shared.txt', 'valor: ' + code + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', tools: [], session_id: 's1' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: 'hecho', is_error: false, total_cost_usd: 0, session_id: 's1' }) + '\\n');
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
const waitFor = (id, pred, ms = 40_000) => until(async () => { const t = await taskById(id); return t && pred(t) ? t : null; }, ms);

try {
  if (!(await until(async () => { try { return (await get('/api/state')).ok; } catch { return false; } }, 10_000, 100))) throw new Error('El servidor no arrancó:\n' + serverLog);

  const P = (await post('/api/projects', { name: 'e2e-multi', repos: [{ key: 'web', path: web }, { key: 'api', path: api }], engine: 'claude' })).body;
  await post('/api/agents', { projectId: P.id, name: 'Rita', role: 'back', engine: 'claude' });
  // Una tarea cada vez: el guardarraíl compara el `git status` de los checkouts y otra tarea escribiendo a la vez daría falsos avisos.
  const runOne = async (title) => {
    const t = (await post('/api/tasks', { projectId: P.id, title, role: 'back', repo: 'web', description: 'e2e' })).body;
    await post(`/api/projects/${P.id}/run`, { running: true });
    const r = await waitFor(t.id, (x) => x.status === 'review' || x.status === 'failed');
    await post(`/api/projects/${P.id}/run`, { running: false });
    return r;
  };
  const wtRoot = path.join(dataDir, 'worktrees', P.id);

  section('Tarea que toca los dos repos');
  const a = await runOne('Dos repos');
  check('llega a revisión', a?.status === 'review', JSON.stringify([a?.status, a?.error]));
  check('task.repos trae web y api con rama ao/<código>, sha y diffStat', a && ['web', 'api'].every((k) => a.repos?.[k]?.branch === `ao/${a.code}` && a.repos[k].sha && /\.txt/.test(a.repos[k].diffStat)), JSON.stringify(a?.repos));
  check('branch/diffStat del repo principal se mantienen (aditivo)', a?.branch === `ao/${a.code}` && /web-/.test(a.diffStat));
  check('hay un worktree por repo', fs.existsSync(path.join(wtRoot, a.code)) && fs.existsSync(path.join(wtRoot, `${a.code}.api`)));
  check('el commit está en la rama de cada repo y los checkouts principales siguen limpios', /api-/.test(git(api, 'diff', '--name-only', `main...ao/${a.code}`)) && /web-/.test(git(web, 'diff', '--name-only', `main...ao/${a.code}`)) && !git(api, 'status', '--porcelain') && !git(web, 'status', '--porcelain'));
  check('sin aviso de escritura fuera del worktree', !a.outsideWrites);
  const d = (await get(`/api/tasks/${a.id}/diff`)).body.diff;
  check('el diff recorre los dos repos', /repo web/.test(d) && /repo api/.test(d) && /api-/.test(d) && /web-/.test(d));
  const mf = (await post('/api/guide/tool', { name: 'agent.getModifiedFiles', args: { code: a.code } })).body;
  check('agent.getModifiedFiles lista ficheros de ambos repos', (mf.files || []).some((f) => /^api:api-/.test(f)) && (mf.files || []).some((f) => /^web-/.test(f)) && !!mf.repos?.api, JSON.stringify(mf));
  const ar = (await post('/api/guide/tool', { name: 'agent.getArtifacts', args: { code: a.code } })).body;
  check('agent.getArtifacts trae commits por repo', ar.repos?.api?.commits?.length === 1 && ar.repos?.web?.commits?.length === 1, JSON.stringify(ar));
  check('aprobar fusiona los dos repos', (await post(`/api/tasks/${a.id}/approve`)).ok && fs.existsSync(path.join(web, `web-${a.code}.txt`)) && fs.existsSync(path.join(api, `api-${a.code}.txt`)));
  check('tras aprobar no quedan ramas ni worktrees', !git(api, 'branch', '--list', `ao/${a.code}`) && !git(web, 'branch', '--list', `ao/${a.code}`) && !fs.existsSync(path.join(wtRoot, `${a.code}.api`)) && !fs.existsSync(path.join(wtRoot, a.code)));

  section('Solo toca el repo principal: el otro se suelta');
  const b = await runOne('Solo web');
  check('t.repos solo trae web y el worktree/rama de api se quitó', b?.status === 'review' && Object.keys(b.repos || {}).join() === 'web' && !fs.existsSync(path.join(wtRoot, `${b.code}.api`)) && !git(api, 'branch', '--list', `ao/${b.code}`), JSON.stringify(b?.repos));
  check('aprobar fusiona solo web', (await post(`/api/tasks/${b.id}/approve`)).ok && fs.existsSync(path.join(web, `web-${b.code}.txt`)));

  section('Guardarraíl: escribe fuera de su worktree');
  const c = await runOne('Fuera del worktree');
  check('outsideWrites avisa del checkout principal de api', c?.outsideWrites?.length === 1 && c.outsideWrites[0].repo === 'api' && c.outsideWrites[0].files.some((f) => /leak-/.test(f)), JSON.stringify(c?.outsideWrites));
  check('lo escrito fuera sigue sin confirmar (no se fusiona)', /leak-/.test(git(api, 'status', '--porcelain')));
  check('agent.getArtifacts también lo muestra', !!(await post('/api/guide/tool', { name: 'agent.getArtifacts', args: { code: c.code } })).body.outsideWrites);
  fs.rmSync(path.join(api, `leak-${c.code}.txt`));
  await post(`/api/tasks/${c.id}/approve`);

  section('Conflicto en el segundo repo: se devuelve con el detalle de ese repo');
  const e = await runOne('Choque en api');
  check('llega a revisión con rama en api', e?.status === 'review' && !!e.repos?.api, JSON.stringify([e?.status, e?.repos]));
  fs.writeFileSync(path.join(api, 'shared.txt'), 'valor: otro\n'); git(api, 'commit', '-qam', 'cambio en la base');
  const ap = await post(`/api/tasks/${e.id}/approve`);
  const E = await taskById(e.id);
  check('aprobar da 409 y devuelve la tarea al agente con el repo api en el feedback', ap.status === 409 && E.status === 'todo' && /repo api/.test(E.feedback) && /shared\.txt/.test(E.feedback), JSON.stringify([ap.status, E.status, E.feedback]));
  check('no se fusionó nada en web (se comprueba todo antes de fusionar)', !fs.existsSync(path.join(web, `web-${e.code}.txt`)));
  const del = await call('DELETE', `/api/tasks/${e.id}`);
  check('borrar la tarea quita todos sus worktrees y ramas', del.ok && !fs.existsSync(path.join(wtRoot, `${e.code}.api`)) && !fs.existsSync(path.join(wtRoot, e.code)) && !git(api, 'branch', '--list', `ao/${e.code}`));
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}`);
  if (serverLog) console.log('--- log del servidor ---\n' + serverLog.slice(-2000));
}

console.log(`\n${failed ? '✗' : '✓'} ${passed} checks correctos, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
