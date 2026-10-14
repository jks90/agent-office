// 🚀 Publicación programada: detecta cambios desde el último «chore(release)», publica en bloque o no hace nada. Todo simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-schedrel-'));
const rt = await import('../server/release-trigger.js');
const gitRun = async (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-schedrel-repo-'));
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
const commit = (m) => g('commit', '-q', '--allow-empty', '-m', m);

const fakeDeps = (pending, extra = {}) => {
  const created = [];
  return { created, deps: {
    pending: async () => pending, version: () => '5.30.0', notify: () => {},
    agentFor: (k) => (k === 'release' ? { id: 'rafa', role: 'release' } : { id: 'dora', role: 'release-docs-flowtest' }),
    createTask: (o) => { created.push(o); return { id: `t${created.length}` }; }, ...extra,
  } };
};

test('pendingChanges: solo lo posterior al último chore(release); feat si hay alguno', async () => {
  commit('feat: viejo'); commit('chore(release): 5.30.0');
  let p = await rt.pendingChanges(repo, gitRun);
  assert.equal(p.commits.length, 0);
  assert.equal(p.since, 'chore(release): 5.30.0');
  commit('fix(run): parar');
  p = await rt.pendingChanges(repo, gitRun);
  assert.equal(p.commits.length, 1); assert.equal(p.feat, false);
  commit('feat(x): algo');
  p = await rt.pendingChanges(repo, gitRun);
  assert.equal(p.commits.length, 2); assert.equal(p.feat, true);
});

test('sin cambios: no encarga nada (y AgentOffice al día no se sube)', async () => {
  let pushed = false;
  const { created, deps } = fakeDeps({ commits: [], feat: false, since: 'chore(release): 5.30.0' }, { aoAhead: async () => 0, aoPublish: async () => { pushed = true; return { pushed: true }; } });
  const r = await rt.scheduledRelease(deps);
  assert.equal(r.flowTest.action, 'none');
  assert.deepEqual(r.agentOffice, { ahead: 0 });
  assert.equal(created.length, 0); assert.equal(pushed, false);
});

test('con cambios: patch con solo fixes, Documentar → Publicar sin preguntar; AgentOffice por delante se sube', async () => {
  const { created, deps } = fakeDeps({ commits: ['abc fix(run): parar'], feat: false, since: 'chore(release): 5.30.0' }, { aoAhead: async () => 3, aoPublish: async () => ({ pushed: true }) });
  const r = await rt.scheduledRelease(deps);
  assert.equal(r.flowTest.action, 'dispatched'); assert.equal(r.flowTest.version, '5.30.1');
  assert.deepEqual(created.map((t) => t.title), ['Documentar 5.30.1', 'Publicar 5.30.1']);
  assert.deepEqual(created[1].dependsOn, ['t1']);
  assert.equal(r.agentOffice.pushed, true);
  // con esa publicación en curso, otra vuelta no encarga otra
  const again = fakeDeps({ commits: ['abc fix'], feat: false, since: null });
  assert.equal((await rt.scheduledRelease(again.deps)).flowTest.action, 'busy');
  assert.equal(again.created.length, 0);
});
