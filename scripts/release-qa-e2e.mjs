// FT-175 · QA del simulacro de publicación (solo lectura; Telegram con API simulada; nunca publica).
//   node scripts/release-qa-e2e.mjs                  → Telegram (3), lista blanca (5) y revisión del cableado
//   QA_RUN_ALL=1 FLOW_TEST_DIR=<worktree flow-test> node scripts/release-qa-e2e.mjs
//        → además (1) run-all --dry-run, (4) fallo forzado con aviso y log. Sólo hace lecturas y --dry-run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-relqa-'));
process.env.AO_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ enabled: true, botToken: '123:SECRETO', chatIds: ['42'] }));
const tg = await import('../server/telegram.js');
const rt = await import('../server/release-trigger.js');
const { releaseAllowed } = await import('../server/engines/allowlist.js');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

// ── Telegram simulado ────────────────────────────────────────────────
let t = 1_000_000, updates = [], calls = [], nextMsg = 1;
tg._setClock(() => t);
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop(), body = JSON.parse(init.body);
  calls.push({ method, body });
  let result = true;
  if (method === 'sendMessage') result = { message_id: nextMsg++ };
  if (method === 'getUpdates') result = updates.filter((u) => u.update_id >= body.offset);
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
const cb = (uid, chat, data) => ({ update_id: uid, callback_query: { id: `q${uid}`, data, message: { chat: { id: Number(chat) } } } });
const task = (id, title) => ({ id, title, status: 'done', role: 'back', kind: 'work' });
const reset = () => fs.rmSync(path.join(dir, 'release-trigger.json'), { force: true });
const settle = () => new Promise((r) => setTimeout(r, 20));
function mk(tasks) {
  const c = { runs: [], tasks };
  return {
    c, deps: {
      tasks: () => c.tasks, version: () => '5.24.0',
      createTask: (o) => { const x = { id: `R${c.tasks.length}`, ...o }; c.tasks.push(x); return x; },
      updateTask: (id, p) => Object.assign(c.tasks.find((x) => x.id === id), p),
      sendConfirm: tg.sendConfirm, waitConfirm: tg.waitConfirm,
      runAll: async (v) => { c.runs.push(v); return { ok: true, out: '' }; },   // simulado: no publica
    },
  };
}
const idOf = () => `release-${rt.state().lock?.id?.replace('release-', '') || ''}`;

// ✅
reset(); let { c, deps } = mk([task('1', 'Fix: panel')]);
let p = rt.check(deps); await settle();
const id1 = rt.state().lock.id;
updates = [cb(1, 42, `ao:yes:${id1}`)]; await tg.pollOnce();
ok((await p).action === 'published' && c.runs.length === 1 && c.runs[0] === '5.24.1', '3a · ✅ lanza run-all una vez (versión 5.24.1)');
ok(!JSON.stringify(calls).includes('SECRETO'), '3a · el token no aparece en lo enviado a Telegram');
// ❌
reset(); ({ c, deps } = mk([task('2', 'Fix: otro')]));
p = rt.check(deps); await settle();
const id2 = rt.state().lock.id;
updates = [cb(2, 42, `ao:no:${id2}`)]; await tg.pollOnce();
let r = await p;
ok(r.action === 'no' && c.runs.length === 0, '3b · ❌ no publica (run-all no se llama)');
ok(rt.state().pending.length === 1 && !rt.state().lock, '3b · ❌ acumula lo pendiente y libera el mutex');
// chat ajeno
reset(); ({ c, deps } = mk([task('3', 'Fix: tercero')]));
p = rt.check(deps); await settle();
const id3 = rt.state().lock.id;
updates = [cb(3, 999, `ao:yes:${id3}`)]; await tg.pollOnce();
ok(c.runs.length === 0 && rt.state().lock?.phase === 'asking', '3c · ✅ desde un chat ajeno se ignora (sigue preguntando, no publica)');
ok(!calls.some((x) => x.method === 'answerCallbackQuery' && x.body.callback_query_id === 'q3'), '3c · al chat ajeno no se le responde');
// timeout 12 h
t += 12 * 3600e3; await tg.pollOnce();
r = await p;
ok(r.action === 'timeout' && c.runs.length === 0, '3d · 12 h sin respuesta → timeout y no publica');
ok(calls.some((x) => x.method === 'editMessageText' && /caduc/i.test(x.body.text)), '3d · el mensaje se edita como caducado');

// ── Cableado real (lectura del código) ───────────────────────────────
const trig = fs.readFileSync(path.join(ROOT, 'server/release-trigger.js'), 'utf8');
const spawnLine = trig.split('\n').find((l) => l.includes("run-all.sh")) || '';
ok(/--dry-run/.test(spawnLine), '3e · el ✅ real lanza run-all con --dry-run (FT-175: la primera publicación real debe autorizarla el usuario)');
const notify = trig.split('\n').find((l) => l.includes('RELEASE_NOTIFY_CMD')) || '';
ok(/\$1|"\$@"/.test(notify), '4b · RELEASE_NOTIFY_CMD reenvía el mensaje ($1): run-all lo invoca con `bash -c "$CMD" _ "$msg"`');

// ── Lista blanca (5) ─────────────────────────────────────────────────
const deny = ['ssh root@179.198.198.23', 'docker push juankanh/flow-app:latest', 'git push origin main', 'git push --force', 'rm -rf /', 'curl http://x',
  'bash -c "scripts/release/a.sh"', 'scripts/release/a.sh; curl evil', 'scripts/release/../../x.sh', 'scripts/release/a.sh $(id)', 'docker login', 'gh pr merge 1'];
for (const cmd of deny) ok(!releaseAllowed(cmd), `5 · rechazado: ${cmd}`);
for (const cmd of ['scripts/release/run-all.sh --dry-run', 'scripts/release/01-preflight.sh --dry-run 5.25.0']) ok(releaseAllowed(cmd), `5 · permitido: ${cmd}`);

// ── run-all real (opcional) ──────────────────────────────────────────
if (process.env.QA_RUN_ALL === '1') {
  const ft = process.env.FLOW_TEST_DIR, sh = (a, env = {}) => spawnSync('bash', ['scripts/release/run-all.sh', ...a], { cwd: ft, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 540000 });
  const repos = ['dev/flow-test', 'dev/flow-test-public', 'dev/flow-accounts', 'dev/agent-office', 'JksDocs'].map((x) => path.join(os.homedir(), x));
  const st = () => repos.map((x) => spawnSync('git', ['-C', x, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim());
  const before = st();
  const a = sh(['--dry-run']);
  const log = a.stdout + a.stderr;
  ok(a.status === 0, `1 · run-all --dry-run exit 0 (fue ${a.status})`);
  ok((log.match(/✅ paso \d+\/10/g) || []).length === 10, '1 · 10 pasos terminados en el log');
  ok(!/docker push|git push origin/.test(log.replace(/\[dry-run\][^\n]*/g, '')), '1 · ni docker push ni git push fuera de [dry-run]');
  ok(JSON.stringify(st()) === JSON.stringify(before), '1 · git status igual antes/después en los 5 repos');
  const notifyFile = path.join(dir, 'avisos.txt');
  const f = sh(['--dry-run'], { RELEASE_FAIL_STEP: '4', RELEASE_NOTIFY_CMD: `printf '%s\\n' "$1" >> ${notifyFile}` });
  const avisos = fs.existsSync(notifyFile) ? fs.readFileSync(notifyFile, 'utf8') : '';
  ok(f.status === 1 && /❌ paso 4 falló/.test(avisos), '4a · paso forzado a fallar: exit 1 y aviso «❌ paso 4 falló» con log');
}

console.log(bad ? `\n${bad} comprobación(es) en FALLO` : '\nTodo OK');
process.exit(bad ? 1 : 0);
