// FT-160 · revisión (server/review.js, puro) y unión de CHANGELOG al actualizar desde la base (server/git.js, git real en /tmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-review-data-'));
const R = await import('../server/review.js');
const G = await import('../server/git.js');

const T = (id, status, extra = {}) => ({ id, status, dependsOn: [], ...extra });

test('política: la del proyecto manda, luego la de Ajustes, si no manual', () => {
  assert.equal(R.policyOf({ reviewPolicy: 'auto' }, { reviewPolicy: 'auto-qa' }), 'auto-qa');
  assert.equal(R.policyOf({ reviewPolicy: 'auto' }, {}), 'auto');
  assert.equal(R.policyOf({ reviewPolicy: 'rara' }, { reviewPolicy: 'x' }), 'manual');
  assert.equal(R.policyOf(undefined), 'manual');
  assert.equal(R.nudgeMin({}), 10);
  assert.equal(R.nudgeMin({ reviewNudgeMin: '0' }), 0);
  assert.equal(R.nudgeMin({ reviewNudgeMin: -3 }), 10);
  assert.deepEqual(R.sensitiveList({}), R.SENSITIVE_DEFAULT);
  assert.deepEqual(R.sensitiveList({ reviewSensitive: ['a', ''] }), ['a']);
});

test('freno anti-bucle: tope de ciclos automáticos y espera en revisión', () => {
  assert.equal(R.MAX_AUTO_CYCLES, 3);
  assert.equal(R.waitingSince({ reviewAt: 5, updatedAt: 9 }), 5);
  assert.equal(R.waitingSince({ updatedAt: 9 }), 9);
});

test('veredicto: toma el último JSON con approve y sanea followups', () => {
  const v = R.parseVerdict('texto {"approve": false, "feedback": "viejo"}\nfin {"approve": true, "reasons": ["ok"], "followups": ["mejorar X", {"title": " Y ", "description": "d"}, {"title": " "}, 5], "pending": ["p"]}');
  assert.equal(v.approve, true);
  assert.deepEqual(v.reasons, ['ok']);
  assert.deepEqual(v.followups, [{ title: 'mejorar X', description: '' }, { title: 'Y', description: 'd' }]);
  assert.deepEqual(v.pending, ['p']);
});

test('veredicto: tope de followups, texto sin JSON, JSON sin approve', () => {
  const many = JSON.stringify({ approve: true, followups: Array.from({ length: 9 }, (_, i) => `f${i}`) });
  assert.equal(R.parseVerdict(many).followups.length, 5);
  assert.equal(R.parseVerdict('sin json'), null);
  assert.equal(R.parseVerdict('{"ok": 1}'), null);
  assert.equal(R.parseVerdict('{"approve": "si"}'), null);
  assert.equal(R.parseVerdict('{"approve": false, "feedback": "' + 'x'.repeat(5000) + '"}').feedback.length, 3000);
});

test('bloqueos y esperas entre tareas (dependsOn, descartadas)', () => {
  const tasks = [T('a', 'review', { code: 'FT-1', reviewAt: 0 }), T('b', 'todo', { code: 'FT-2', dependsOn: ['a'] }), T('c', 'discarded', { dependsOn: ['a'] }), T('d', 'done', { dependsOn: ['a'] })];
  assert.deepEqual(R.blocksOf(tasks, tasks[0]), [{ id: 'b', code: 'FT-2' }]); // las resueltas no bloquean
  assert.deepEqual(R.waitingOn(tasks, tasks[1]), [{ id: 'a', code: 'FT-1', status: 'review' }]);
  const dec = R.decorate(tasks);
  assert.equal(dec[0].reviewSince, 0 || dec[0].reviewSince);
  assert.equal(dec[0].blocks.length, 1);
  assert.equal(dec[1].waitingOn[0].id, 'a');
  assert.equal(dec[2].waitingOn, undefined);
});

test('pendingBlock: solo las que llevan más de minMin', () => {
  const now = 100 * 60_000;
  const tasks = [T('a', 'review', { code: 'FT-1', title: 'T', reviewAt: now - 30 * 60_000 }), T('b', 'review', { title: 'N', reviewAt: now - 60_000 }), T('c', 'todo', { dependsOn: ['a'], code: 'FT-3' })];
  const txt = R.pendingBlock(tasks, now, 10);
  assert.match(txt, /FT-1 «T» espera revisión desde hace 30 min; bloquea: FT-3/);
  assert.ok(!txt.includes('«N»'));
  assert.equal(R.pendingBlock(tasks, now, 999), '');
});

test('verificaciones declaradas y ficheros sensibles', () => {
  const c = R.declaredChecks({ checks: [' npm run lint '], description: 'Corre `node --check a.js` y `ls -la` (no es verificación) y `npm run test:unit`' });
  assert.deepEqual(c, ['npm run lint', 'node --check a.js', 'npm run test:unit']);
  const list = R.SENSITIVE_DEFAULT;
  assert.deepEqual(R.sensitiveHits(['Dockerfile', 'src/a.js'], '', list), ['Dockerfile']);
  assert.deepEqual(R.sensitiveHits(['package.json'], '+  "version": "1.0.1"', list), []);
  assert.deepEqual(R.sensitiveHits(['package.json'], '+  "foo": "^1.2.3"', list), ['package.json']);
});

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();

test('CHANGELOG: UNION_FILES reconoce historiales', () => {
  for (const f of ['CHANGELOG.md', 'docs/CHANGES-2.md', 'HISTORIAL.md']) assert.ok(G.UNION_FILES.test(f), f);
  for (const f of ['README.md', 'src/changelog.js', 'CHANGELOGS/x.txt']) assert.ok(!G.UNION_FILES.test(f), f);
});

test('CHANGELOG: un choque solo en el historial se une; otro fichero en conflicto aborta', async () => {
  const mk = (extra) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-union-'));
    sh(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Cambios\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
    sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base');
    sh(dir, 'checkout', '-qb', 'ao/x');
    fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- de la tarea\n');
    if (extra) fs.writeFileSync(path.join(dir, 'a.txt'), 'rama\n');
    sh(dir, 'commit', '-qam', 'rama');
    sh(dir, 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- de la base\n');
    if (extra) fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
    sh(dir, 'commit', '-qam', 'main');
    sh(dir, 'checkout', '-q', 'ao/x');
    return dir;
  };
  let dir = mk(false);
  const ok = await G.updateFromBase(dir, 'main');
  assert.deepEqual(ok, { conflicts: [], unioned: ['CHANGELOG.md'] });
  const txt = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.ok(txt.includes('- de la tarea') && txt.includes('- de la base') && !txt.includes('<<<<'));
  dir = mk(true);
  const bad = await G.updateFromBase(dir, 'main');
  assert.ok(bad.conflicts.includes('a.txt'));
  assert.equal(sh(dir, 'status', '--porcelain').trim(), ''); // merge abortado: worktree limpio
});
