// 👔 Managers del proyecto: cada manager revisa a su equipo y el organigrama lo cuelga de él.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-managers-'));
const team = await import('../server/team.js');

const p = { team: ['coord', 'mb', 'berta', 'ciro', 'mr', 'saul'] };

test('managerOf: el manager de cada miembro; sin grupo, null', () => {
  const q = { ...p, managers: team.normalizeManagers(p, { mb: ['berta', 'ciro'], mr: ['saul'] }) };
  assert.equal(team.managerOf(q, 'berta'), 'mb');
  assert.equal(team.managerOf(q, 'saul'), 'mr');
  assert.equal(team.managerOf(q, 'coord'), null);
  assert.equal(team.managerOf(q, 'mb'), null, 'el manager no tiene manager');
  assert.equal(team.managerOf({ ...q, team: q.team.filter((x) => x !== 'mb') }, 'berta'), null, 'manager fuera del equipo: no cuenta');
});

test('normalizeManagers valida: fichados, un manager por miembro, sin cadenas', () => {
  assert.deepEqual(team.normalizeManagers(p, null), {});
  assert.deepEqual(team.normalizeManagers(p, { mb: ['berta', 'berta'] }), { mb: ['berta'] });
  assert.throws(() => team.normalizeManagers(p, { nadie: ['berta'] }), /fichado/);
  assert.throws(() => team.normalizeManagers(p, { mb: ['fuera'] }), /fichados/);
  assert.throws(() => team.normalizeManagers(p, { mb: ['berta'], mr: ['berta'] }), /un solo manager/);
  assert.throws(() => team.normalizeManagers(p, { mb: ['mr'], mr: ['saul'] }), /otro manager/);
  assert.throws(() => team.normalizeManagers(p, { mb: ['mb'] }), /otro manager/);
});
