// 🌿 Ramas visibles: base de las tareas vs rama del usuario en el checkout principal, cambio de base y aviso en el prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-branch-'));
process.env.AO_TEST_ALLOW_UNLINKED = '1';
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-branch-repo-'));
const g = (...a) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'uno');
g('branch', 'develop'); g('branch', 'ao/FT-1');

const store = await import('../server/store.js');
const team = await import('../server/team.js');
const git = await import('../server/git.js');
const p = await team.createProject({ name: 'Ramas', engine: 'demo', coordinator: false, defaultTeam: false, repos: [{ key: 'app', path: repoDir }] });
const repo = () => store.get().projects.find((x) => x.id === p.id).repos[0];
const waitLive = async (b) => { for (let i = 0; i < 40 && team.repoLiveOf(repoDir)?.branch !== b; i++) await new Promise((r) => setTimeout(r, 100)); };
test.after(() => { store.flush(); });

test('la base es la rama del checkout al crear el proyecto; las ramas ao/* no son candidatas', async () => {
  assert.equal(repo().baseBranch, 'main');
  const info = await team.repoBranches(p.id, 'app');
  assert.deepEqual(info.branches.sort(), ['develop', 'main']);
});

test('el usuario cambia de rama: se ve en vivo y el prompt del agente avisa, pero la base no cambia', async () => {
  g('checkout', '-q', 'develop');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'cambio\n');
  assert.deepEqual(await git.repoLive(repoDir), { branch: 'develop', dirty: 1 });
  await waitLive('develop');
  assert.equal(team.repoLiveOf(repoDir).branch, 'develop');
  assert.equal(repo().baseBranch, 'main');
  const line = team.baseLine(repo(), 'ao/FT-9');
  assert.match(line, /sale de «main» y se fusionará en «main»/);
  assert.match(line, /OJO: el usuario .* «develop»/);
});

test('cambiar la base a mano: solo ramas locales que existan y no ao/*; el prompt deja de avisar', async () => {
  await assert.rejects(team.setBaseBranch(p.id, 'app', 'no-existe'), (e) => e.status === 404);
  await assert.rejects(team.setBaseBranch(p.id, 'app', 'ao/FT-1'), (e) => e.status === 400);
  await team.setBaseBranch(p.id, 'app', 'develop');
  assert.equal(repo().baseBranch, 'develop');
  assert.doesNotMatch(team.baseLine(repo(), 'ao/FT-9'), /OJO/);
});
