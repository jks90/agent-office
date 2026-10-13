// El enlace node_modules que AgentOffice pone en cada worktree nunca entra en un commit, aunque el .gitignore diga «node_modules/»
// (con barra, que NO cubre enlaces): si entra, al fusionar sustituye la carpeta real del repo por un enlace a sí misma.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitnm-'));
const git = await import('../server/git.js');
const sh = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

test('linkNodeModules excluye el enlace y commitAll no lo commitea', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitnm-repo-'));
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  sh(repo, 'add', '-A'); sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitnm-wt-')), 'wt');
  sh(repo, 'worktree', 'add', '-q', '-b', 'ao/T-1', wt);
  git.linkNodeModules(repo, wt);
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  assert.equal(sh(wt, 'status', '--porcelain'), '', 'el enlace no aparece como fichero nuevo');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hola');
  const r = await git.commitAll(wt, 'cambio', 'Agente');
  assert.deepEqual(r.files, ['a.txt']);
  assert.equal(sh(wt, 'ls-files', 'node_modules'), '');
  git.linkNodeModules(repo, wt); // idempotente: no repite la línea del exclude
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.match(/^\/node_modules$/gm).length, 1);
});
