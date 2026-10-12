// 🚀 Los campos de release (onMain, releaseVersion, autoApprove…) se ponen ANTES de que la tarea pueda arrancar: createTask llama
// a tick() y el planificador puede empezarla en ese mismo instante (antes, «Documentar X» acababa en un worktree).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-relct-'));
const store = await import('../server/store.js');
const team = await import('../server/team.js');
test.after(() => store.flush());

test('createTask aplica `extra` antes de anunciarla (TaskCreated ya lo ve)', async () => {
  store.get().projects.push({ id: 'p1', name: 'flowtest', folder: 'x', repos: [], team: [] });
  const seen = [];
  const events = await import('../server/events.js');
  const off = events.on?.('TaskCreated', (e) => seen.push(store.get().tasks.find((t) => t.id === e.taskId)?.onMain));
  const t = team.createTask({ projectId: 'p1', title: 'Documentar 9.9.9', role: 'back', status: 'backlog', extra: { onMain: true, onMainDirs: ['/tmp'], releaseVersion: undefined, autoApprove: true } });
  off?.();
  assert.equal(t.onMain, true); assert.deepEqual(t.onMainDirs, ['/tmp']); assert.equal(t.autoApprove, true);
  assert.ok(!('releaseVersion' in t), 'los undefined no se escriben');
  if (seen.length) assert.equal(seen[0], true, 'ya estaba al emitir TaskCreated');
  const u = team.createTask({ projectId: 'p1', title: 'x', role: 'back', status: 'backlog', extra: { id: 'pisado', status: 'done' } });
  assert.notEqual(u.id, 'pisado'); assert.equal(u.status, 'backlog', '`extra` no pisa campos propios de la tarea');
});
