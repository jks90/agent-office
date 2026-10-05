// Prueba end-to-end de las integraciones deterministas del Guide (FT-10): ide, git, filesystem, terminal y browser.
// Servidor temporal (AO_DATA_DIR), repo git de pega, `claude` falso que edita una línea y un IDE/navegador falsos que
// apuntan sus argumentos a un fichero. No gasta tokens.   node scripts/integrations-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-integ-'));
const dataDir = path.join(tmp, 'data');
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

const repo = path.join(tmp, 'repo');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: gitEnv }).trim();
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'src', 'app.txt'), Array.from({ length: 10 }, (_, i) => `linea ${i + 1}`).join('\n') + '\n');
fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=1\n');
fs.mkdirSync(path.join(repo, 'data')); fs.writeFileSync(path.join(repo, 'data', 'state.json'), '{}');
fs.writeFileSync(path.join(repo, '.gitignore'), '.env\ndata/\n');
git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
fs.writeFileSync(path.join(tmp, 'secreto-fuera.txt'), 'no deberías verme\n');

// `claude` falso: cambia la línea 7 de src/app.txt en su cwd (worktree) y responde.
const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
let started = false;
process.stdin.on('data', () => {
  if (started) return; started = true;
  const f = path.join(process.cwd(), 'src', 'app.txt');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('linea 7', 'linea 7 EDITADA'));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'result', result: 'Hecho: src/app.txt', is_error: false, total_cost_usd: 0, session_id: 's1' });
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
// IDE y navegador falsos: apuntan sus argumentos a un fichero.
const ideLog = path.join(tmp, 'ide.log'), browserLog = path.join(tmp, 'browser.log');
const fake = (file, log) => { fs.writeFileSync(file, `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 }); return file; };
const fakeIde = fake(path.join(tmp, 'fake-code'), ideLog), fakeBrowser = fake(path.join(tmp, 'fake-open'), browserLog);

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace') } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const envBase = { ...gitEnv, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_BROWSER_CMD: `${fakeBrowser} {url}` };
let server;
const start = (extra = {}) => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...envBase, ...extra } }); server.stdout.on('data', () => {}); server.stderr.on('data', () => {}); };
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);

async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = (p) => call('GET', p), post = (p, b = {}) => call('POST', p, b);
const tool = (name, args) => post('/api/guide/tool', { name, args });
const state = async () => (await get('/api/state')).body;
const sh = (c) => { try { return fs.readFileSync(c, 'utf8'); } catch { return ''; } };

try {
  start({ AO_IDE_CMD: `${fakeIde} --goto {path}:{line}` });
  if (!(await until(async () => { try { return (await get('/api/state')).status === 200; } catch { return false; } }, 10_000, 100))) throw new Error('El servidor no arrancó');
  const P = (await post('/api/projects', { name: 'integ', repoPath: repo, engine: 'claude' })).body;
  await post('/api/agents', { projectId: P.id, name: 'Fran', role: 'back', engine: 'claude' });
  const repoKey = (await state()).projects.find((p) => p.id === P.id).repos[0].key;
  const t = (await post('/api/tasks', { projectId: P.id, title: 'Edita app', role: 'back', description: 'e2e' })).body;
  await post(`/api/projects/${P.id}/run`, { running: true });
  const done = await until(async () => (await state()).tasks.find((x) => x.id === t.id && x.status === 'review'), 30_000);
  check('la tarea llega a review con su rama y worktree', !!done && !!done.branch, JSON.stringify(done && done.status));
  await post(`/api/projects/${P.id}/run`, { running: false });
  const code = t.code, branch = done?.branch;
  const wt = path.join(dataDir, 'worktrees', P.id, code);

  console.log('\n▸ ide.openFile');
  const mod = (await tool('agent.getModifiedFiles', { code })).body.files;
  check('getModifiedFiles lista src/app.txt', mod?.includes('src/app.txt'), JSON.stringify(mod));
  const o = await tool('ide.openFile', { path: mod[0], task: code });
  check('abre el fichero del worktree en la línea del primer hunk (7)', o.status === 200 && o.body.line === 7 && o.body.fromHunk === true, JSON.stringify(o.body));
  await until(() => sh(ideLog), 3000, 50);
  check('el IDE recibió «--goto <worktree>/src/app.txt:7»', sh(ideLog).trim() === `--goto ${path.join(wt, 'src', 'app.txt')}:7`, sh(ideLog));
  const o2 = await tool('ide.openFile', { path: 'src/app.txt', repo: repoKey, line: 3 });
  check('con repo y línea explícita abre el fichero del repo en esa línea', o2.status === 200 && o2.body.line === 3 && o2.body.opened === path.join(repo, 'src', 'app.txt'), JSON.stringify(o2.body));
  check('ide.openFile de un fichero inexistente → 404', (await tool('ide.openFile', { path: 'nada.txt', task: code })).status === 404);
  check('ide.openFile de un fichero fuera del repo → 403', (await tool('ide.openFile', { path: '../secreto-fuera.txt', repo: repoKey })).status === 403);

  console.log('\n▸ git');
  const st = (await tool('git.status', { repo: repoKey, branch })).body;
  check('git.status de la rama de la tarea (en su worktree)', st.status?.includes(branch) && st.cwd === fs.realpathSync(wt), JSON.stringify(st));
  const df = (await tool('git.diff', { repo: repoKey, branch })).body;
  check('git.diff base...rama trae el hunk y el stat', df.diff?.includes('+linea 7 EDITADA') && df.stat?.includes('src/app.txt'), JSON.stringify(df).slice(0, 200));
  const lg = (await tool('git.log', { repo: repoKey, branch })).body;
  check('git.log de la rama incluye el commit de la tarea', lg.commits?.length >= 2, JSON.stringify(lg));
  check('git.diff de una rama inexistente → 404', (await tool('git.diff', { repo: repoKey, branch: 'no-existe' })).status === 404);
  check('git.diff con rama «--output=x» → 400', (await tool('git.diff', { repo: repoKey, branch: '--output=x' })).status === 400);
  check('repo desconocido → 404', (await tool('git.status', { repo: 'no-es-un-repo' })).status === 404);

  console.log('\n▸ filesystem');
  const rd = (await tool('filesystem.read', { repo: repoKey, path: 'src/app.txt' })).body;
  check('filesystem.read lee un fichero del repo', rd.content?.startsWith('linea 1') && rd.truncated === false, JSON.stringify(rd).slice(0, 120));
  const rdT = (await tool('filesystem.read', { task: code, path: 'src/app.txt' })).body;
  check('con «task» lee la versión del worktree', rdT.content?.includes('linea 7 EDITADA'));
  check('filesystem.read fuera del repo (../) → 403', (await tool('filesystem.read', { repo: repoKey, path: '../secreto-fuera.txt' })).status === 403);
  check('filesystem.read con ruta absoluta fuera → 403', (await tool('filesystem.read', { repo: repoKey, path: path.join(tmp, 'secreto-fuera.txt') })).status === 403);
  check('filesystem.read de /etc/passwd → 403', (await tool('filesystem.read', { repo: repoKey, path: '/etc/passwd' })).status === 403);
  check('filesystem.read de .env → 403', (await tool('filesystem.read', { repo: repoKey, path: '.env' })).status === 403);
  check('filesystem.read de data/state.json → 403', (await tool('filesystem.read', { repo: repoKey, path: 'data/state.json' })).status === 403);
  check('filesystem.read de .git/config → 403', (await tool('filesystem.read', { repo: repoKey, path: '.git/config' })).status === 403);
  fs.symlinkSync(path.join(tmp, 'secreto-fuera.txt'), path.join(repo, 'enlace.txt'));
  check('filesystem.read por un symlink que sale del repo → 403', (await tool('filesystem.read', { repo: repoKey, path: 'enlace.txt' })).status === 403);
  fs.writeFileSync(path.join(repo, 'grande.txt'), 'x'.repeat(300 * 1024));
  const big = (await tool('filesystem.read', { repo: repoKey, path: 'grande.txt' })).body;
  check('filesystem.read recorta a 200 KB y lo avisa', big.truncated === true && big.content.length === 200 * 1024 && big.size === 300 * 1024);

  // write: pide confirmación (política por defecto)
  const pw = tool('filesystem.write', { repo: repoKey, path: 'nuevo/hola.txt', content: 'hola\n' });
  const q = await until(async () => (await get('/api/questions')).body.find((x) => x.kind === 'confirm'), 8000, 80);
  check('filesystem.write pide confirmación (política write)', !!q);
  if (q) await post(`/api/questions/${q.id}/answer`, { answer: 'No' });
  check('si la rechaza → 403 y no escribe', (await pw).status === 403 && !fs.existsSync(path.join(repo, 'nuevo', 'hola.txt')));
  await post('/api/settings', { guidePolicy: { write: 'auto' } });
  check('con write=auto escribe dentro del repo', (await tool('filesystem.write', { repo: repoKey, path: 'nuevo/hola.txt', content: 'hola\n' })).status === 200 && sh(path.join(repo, 'nuevo', 'hola.txt')) === 'hola\n');
  check('filesystem.write fuera del repo → 403', (await tool('filesystem.write', { repo: repoKey, path: '../fuera.txt', content: 'x' })).status === 403 && !fs.existsSync(path.join(tmp, 'fuera.txt')));
  check('filesystem.write sobre .env → 403', (await tool('filesystem.write', { repo: repoKey, path: '.env', content: 'x' })).status === 403 && sh(path.join(repo, '.env')) === 'SECRETO=1\n');

  console.log('\n▸ terminal.execute');
  const ex = (await tool('terminal.execute', { repo: repoKey, cmd: 'git status --short' })).body;
  check('un comando permitido se ejecuta (exitCode 0, salida)', ex.exitCode === 0 && ex.stdout.includes('nuevo/'), JSON.stringify(ex));
  const rm = await tool('terminal.execute', { repo: repoKey, cmd: 'rm -rf nuevo' });
  check('`rm -rf` lo rechaza la lista blanca (403) y no borra nada', rm.status === 403 && fs.existsSync(path.join(repo, 'nuevo')), JSON.stringify(rm.body));
  for (const c of ['sudo ls', 'git push origin main', 'ls ; rm -rf nuevo', 'ls && rm -rf nuevo', 'echo hola > x.txt', 'echo $(id)', 'cat `ls`', 'ls | xargs rm', 'xargs rm', 'find . -delete', 'find . -exec rm {} ;', 'cat .env', 'cat ../secreto-fuera.txt', 'cat /etc/passwd', 'cat data/state.json', 'docker ps', 'ssh localhost'])
    check(`rechaza «${c}»`, (await tool('terminal.execute', { repo: repoKey, cmd: c })).status === 403 && fs.existsSync(path.join(repo, 'nuevo')) && !fs.existsSync(path.join(repo, 'x.txt')));
  const big2 = (await tool('terminal.execute', { repo: repoKey, cmd: 'cat grande.txt' })).body;
  check('la salida larga se recorta', big2.stdout.length < 25_000 && big2.stdout.includes('recortado'), String(big2.stdout?.length));
  const fl = (await tool('terminal.execute', { repo: repoKey, cmd: 'ls no-existe.txt' })).body;
  check('un comando que falla devuelve su exitCode y stderr (no es error HTTP)', fl.exitCode !== 0 && fl.stderr.length > 0, JSON.stringify(fl));
  const wd = (await tool('terminal.execute', { task: code, cmd: 'cat src/app.txt' })).body;
  check('con «task» corre en el worktree', wd.cwd === fs.realpathSync(wt) && wd.stdout.includes('EDITADA'));
  // timeout: reinicio del servidor con 1 s
  server.kill('SIGTERM'); await sleep(300);
  start({ AO_IDE_CMD: `${fakeIde} --goto {path}:{line}`, AO_EXEC_TIMEOUT_MS: '1000' });
  await until(async () => { try { return (await get('/api/state')).status === 200; } catch { return false; } }, 10_000, 100);
  const t0 = Date.now();
  const sl = (await tool('terminal.execute', { repo: repoKey, cmd: 'sleep 20' })).body;
  check('el timeout mata el comando (timedOut)', sl.timedOut === true && Date.now() - t0 < 8000, JSON.stringify(sl));

  console.log('\n▸ browser.open');
  const b = await tool('browser.open', { url: 'https://example.com/a?b=1' });
  await until(() => sh(browserLog), 3000, 50);
  check('browser.open lanza el navegador con la URL', b.status === 200 && sh(browserLog).trim() === 'https://example.com/a?b=1', sh(browserLog));
  check('browser.open rechaza file:// y javascript:', (await tool('browser.open', { url: 'file:///etc/passwd' })).status === 400 && (await tool('browser.open', { url: 'javascript:alert(1)' })).status === 400);

  console.log('\n▸ sin IDE');
  server.kill('SIGTERM'); await sleep(300);
  start({ AO_IDE_CMD: 'ide-que-no-existe {path}:{line}' });
  await until(async () => { try { return (await get('/api/state')).status === 200; } catch { return false; } }, 10_000, 100);
  const noIde = await tool('ide.openFile', { path: 'src/app.txt', task: code });
  check('sin IDE → 503 con mensaje claro (el Guide cae a app.openArtifact)', noIde.status === 503 && /No hay IDE/.test(noIde.body.error), JSON.stringify(noIde.body));
  const audit = fs.readFileSync(path.join(dataDir, 'guide-audit.jsonl'), 'utf8');
  check('todo queda en la auditoría (incluidos los rechazos)', /"tool":"terminal.execute"/.test(audit) && /"result":"error"/.test(audit));
}
catch (e) { failed++; console.log(`\n✗ Error inesperado: ${e.stack || e}`); }
console.log(`\n${failed ? '✗' : '✓'} ${passed} checks correctos, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
