// FT-233: «Documentar X.Y.Z» commitea lo del agente en el repo principal y en los onMainDirs (nombres no ASCII, renombrados).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyMap, commitOnMain, parsePorcelainZ } from '../server/onmain.js';

const sh = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
function repo(root, name, files) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  sh(d, 'init', '-q');
  for (const [f, c] of Object.entries(files)) { fs.writeFileSync(path.join(d, f), c); }
  sh(d, 'add', '-A');
  sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return d;
}

test('parsePorcelainZ: renombrados y nombres con espacios/unicode', () => {
  assert.deepEqual(parsePorcelainZ(' M a b.md\0R  nuevo — x.md\0viejo.md\0?? z.md\0'), ['a b.md', 'nuevo — x.md', 'z.md']);
});

test('commitOnMain: 3 repos, tracked modificado primero, no ASCII y renombrado → 3 commits y nada sin commitear', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-onmain-'));
  const a = repo(root, 'flow-test', { 'README.md': 'a\n' });
  const b = repo(root, 'flow-test-public', { 'CHANGELOG.md': 'x\n', 'viejo.md': 'v\n' });
  const c = repo(root, 'JksDocs', { '00 Flow-test — Manual.md': 'm\n' });
  fs.writeFileSync(path.join(c, 'ya-sucio.md'), 'previo\n'); // sucio antes: no es de la tarea
  const t = { code: 'FT-231', title: 'Documentar 5.30.1', releaseOf: '5.30.1' };
  t.onMainBefore = await dirtyMap([a, b, c]);
  fs.writeFileSync(path.join(a, 'README.md'), 'a2\n');
  fs.writeFileSync(path.join(b, 'CHANGELOG.md'), 'x2\n');
  sh(b, 'mv', 'viejo.md', 'renombrado — ñ.md');
  fs.writeFileSync(path.join(c, '00 Flow-test — Manual.md'), 'm2\n');
  fs.writeFileSync(path.join(c, '01 Nuevo — ñandú.md'), 'n\n');
  const r = await commitOnMain(t, { name: 'Dora' });
  assert.equal(r.commits.length, 3, JSON.stringify(r));
  assert.ok(r.commits.every((x) => x.ok), JSON.stringify(r.commits));
  for (const d of [a, b, c]) assert.match(sh(d, 'log', '-1', '--format=%s'), /FT-231/);
  assert.deepEqual(r.left, { JksDocs: ['ya-sucio.md'] }); // solo lo que ya estaba sucio
});

test('commitOnMain: si git falla queda registrado y el resto sigue sin commitear (red de seguridad)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-onmain-'));
  const a = repo(root, 'r', { 'a.md': '1\n' });
  const t = { code: 'FT-231', title: 'x', onMainBefore: await dirtyMap([a]) };
  fs.writeFileSync(path.join(a, 'a.md'), '2\n');
  fs.writeFileSync(path.join(a, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = await commitOnMain(t, { name: 'Dora' });
  assert.equal(r.commits[0].ok, false);
  assert.deepEqual(r.left, { r: ['a.md'] });
});
