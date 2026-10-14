// FT-235 · Causa del fallo de FT-233 y escenario completo (principal + 2 onMainDirs, uno con ~) sobre server/onmain.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyMap, commitOnMain } from '../server/onmain.js';

const sh = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const NOASCII = '00 Flow-test — Manual.md';
function repo(d, files) {
  fs.mkdirSync(d, { recursive: true });
  sh(d, 'init', '-q');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  sh(d, 'add', '-A');
  sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
}

test('FT-235 causa: `status --porcelain` sin -z escapa en octal los nombres no ASCII (core.quotepath)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft235-q-'));
  repo(d, { 'a.txt': '1' });
  fs.writeFileSync(path.join(d, NOASCII), 'x');
  const out = sh(d, 'status', '--porcelain', '--untracked-files=all');
  assert.match(out, /\\342\\200\\224/); // «—» sale como \342\200\224 entre comillas: `git add` con eso falla
  assert.ok(!out.includes(NOASCII));
  fs.rmSync(d, { recursive: true, force: true });
});

test('FT-235: 3 repos (uno vía ~), no ASCII y renombrado → 3 commits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft235-'));
  const main = path.join(home, 'main'), a = path.join(home, 'a'), b = path.join(home, 'b');
  repo(main, { 'x.txt': '1', [NOASCII]: 'v1' });
  repo(a, { 'old name.txt': 'c' });
  repo(b, { 'y.txt': '1' });
  const dirs = [main, ...['~/a', '~/b'].map((d) => d.replace(/^~(?=\/|$)/, home))]; // como team.js
  const t = { code: 'FT-235', title: 'prueba', onMainBefore: await dirtyMap(dirs) };
  fs.writeFileSync(path.join(main, NOASCII), 'v2');
  sh(a, 'mv', 'old name.txt', 'ñandú nuevo.txt');
  fs.writeFileSync(path.join(b, 'z.txt'), 'n');
  const r = await commitOnMain(t, { name: 'Test' });
  assert.equal(r.commits.length, 3, JSON.stringify(r));
  for (const d of dirs) assert.equal(sh(d, 'status', '--porcelain').trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
