// FT-235 · Reproduce el fallo de commitOnMain/dirtyMap: repos git temporales (nunca los reales) con ficheros no ASCII y un renombrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyMap, commitOnMain } from '../server/onmain-commit.js';

const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const NOASCII = '00 Flow-test — Manual.md';

function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q');
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'base');
}
const count = (d) => Number(sh(d, 'rev-list', '--count', 'HEAD').trim());

test('FT-235: commitOnMain hace 1 commit en cada repo (principal + 2 onMainDirs, uno con ~)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft235-'));
  const main = path.join(home, 'main'), a = path.join(home, 'a'), b = path.join(home, 'b');
  repo(main, { 'x.txt': '1', [NOASCII]: 'v1' });
  repo(a, { 'old name.txt': 'contenido de a' });
  repo(b, { 'y.txt': '1' });
  // Como team.js: las rutas con ~ se expanden antes de calcular onMainBefore
  const expand = (d) => d.replace(/^~(?=\/|$)/, home);
  const dirs = [main, ...['~/a', '~/b'].map(expand)];
  const onMainBefore = await dirtyMap(dirs);

  // Cambia el agente: modifica (no ASCII) en el principal, renombra en a, crea en b
  fs.writeFileSync(path.join(main, NOASCII), 'v2');
  sh(a, 'mv', 'old name.txt', 'ñandú nuevo.txt');
  fs.writeFileSync(path.join(b, 'z.txt'), 'nuevo');

  const lines = await commitOnMain({ code: 'FT-235', title: 'prueba', onMainBefore }, { name: 'Test' });
  assert.deepEqual(dirs.map(count), [2, 2, 2], lines.join('\n'));
  for (const d of dirs) assert.equal(sh(d, 'status', '--porcelain').trim(), '', `árbol limpio en ${d}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('FT-235: dirtyMap devuelve rutas literales (sin comillas/octal) y la primera línea " M" no pierde su primera letra', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft235-d-'));
  repo(dir, { 'abc.txt': '1', [NOASCII]: 'v1' });
  fs.writeFileSync(path.join(dir, 'abc.txt'), '2');
  fs.writeFileSync(path.join(dir, NOASCII), 'v2');
  const m = await dirtyMap([dir]);
  assert.deepEqual([...m[dir]].sort(), ['abc.txt', NOASCII].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
