// 🧰 Propuestas de los agentes (server/proposals.js): «NEGOCIO <skill>:» y «SCRIPT NUEVO:» del resumen → pendientes → aprobar
// (nota en <carpeta>/_skills/<skill>.md · script al catálogo y al rol) o descartar; y las notas entran en el prompt de la skill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prop-data-'));
const store = await import('../server/store.js');
const pr = await import('../server/proposals.js');
const toolkit = await import('../server/toolkit.js');
const { get } = store;

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prop-proj-'));
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prop-repo-'));
get().projects.push({ id: 'p1', name: 'Demo', folder: 'demo', repos: [{ key: 'api', path: repoDir, baseBranch: 'main' }] });
const project = get().projects[0];
const agent = { id: 'a1', name: 'Vera', role: 'qa-x' };
const SUMMARY = `Hecho: tests en verde.

NEGOCIO flows:
- Aquí los flows van en flows/api/ y usan {{apiBase}} del entorno «dev».
- El login devuelve el token en $.data.jwt, no en $.token.

NEGOCIO otra-skill:
- No la lleva: se ignora.

SCRIPT NUEVO: scripts/reset-db.sh — Vacía y siembra la BD de pruebas
LECCIONES:
- algo`;

test.after(() => store.flush());

test('parse saca los bloques y limpia el resumen', () => {
  const r = pr.parse(SUMMARY);
  assert.equal(r.business.length, 2);
  assert.deepEqual(r.business[0], { skill: 'flows', text: 'Aquí los flows van en flows/api/ y usan {{apiBase}} del entorno «dev».\nEl login devuelve el token en $.data.jwt, no en $.token.' });
  assert.deepEqual(r.scripts, [{ path: 'scripts/reset-db.sh', description: 'Vacía y siembra la BD de pruebas' }]);
  assert.doesNotMatch(r.summary, /NEGOCIO|SCRIPT NUEVO/);
  assert.match(r.summary, /Hecho: tests en verde/);
  assert.match(r.summary, /LECCIONES/, 'lo demás se queda');
  assert.deepEqual(pr.parse('SCRIPT NUEVO: ../fuera.sh — no').scripts, [], 'nada fuera del repo');
});

test('harvest: solo skills que lleva el agente y sin duplicar', () => {
  const t = { id: 't1', code: 'FT-1' };
  const r = pr.harvest({ project, task: t, agent, summary: SUMMARY, skillNames: ['flows'], repoKey: 'api' });
  assert.deepEqual(r.added.map((x) => x.kind).sort(), ['business', 'script']);
  assert.equal(get().proposals.length, 2);
  pr.harvest({ project, task: t, agent, summary: SUMMARY, skillNames: ['flows'], repoKey: 'api' });
  assert.equal(get().proposals.length, 2, 'las mismas no se repiten');
});

const roles = { 'qa-x': { source: 'catálogo', scripts: ['otro'] } };
const set = [];
const deps = { projectDir: () => projDir, repoOf: (p, k) => p.repos.find((r) => r.key === k), addScript: ({ name }) => ({ name }), roleOf: (id) => roles[id], setRoleTools: (id, kind, names) => set.push([id, kind, names]) };

test('aprobar NEGOCIO añade la nota y la nota entra en el prompt de la skill', () => {
  const b = get().proposals.find((x) => x.kind === 'business');
  const r = pr.accept(b.id, deps);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.equal(r.file, path.join(projDir, '_skills', 'flows.md'));
  assert.match(text, /^# Cómo se aplica la skill «flows»/);
  assert.match(text, /- El login devuelve el token en \$\.data\.jwt, no en \$\.token\. \(FT-1\)/);
  const notes = pr.notesOf(projDir, ['flows', 'nada']);
  assert.deepEqual(Object.keys(notes), ['flows']);
  const p = toolkit.promptBlock({ skills: [{ name: 'flows', description: 'Flows', dir: '/x', native: true }], mcps: [], scripts: [], business: notes });
  assert.match(p, /En este proyecto:\n {4}# Cómo se aplica/);
  assert.match(p, /\$\.data\.jwt/);
});

test('aprobar SCRIPT: 409 hasta que esté en la rama base; luego al catálogo y al rol', () => {
  const sc = get().proposals.find((x) => x.kind === 'script');
  assert.throws(() => pr.accept(sc.id, deps), (e) => e.status === 409 && /FT-1/.test(e.message));
  fs.mkdirSync(path.join(repoDir, 'scripts'));
  fs.writeFileSync(path.join(repoDir, 'scripts', 'reset-db.sh'), '# Vacía la BD\n');
  const r = pr.accept(sc.id, deps);
  assert.equal(r.script, 'reset-db');
  assert.equal(r.toRole, 'qa-x');
  assert.deepEqual(set.at(-1), ['qa-x', 'scripts', ['otro', 'reset-db']]);
  assert.equal(get().proposals.length, 0);
});

test('descartar', () => {
  pr.harvest({ project, task: { id: 't2', code: 'FT-2' }, agent, summary: 'SCRIPT NUEVO: scripts/x.sh — algo útil', repoKey: 'api' });
  const id = get().proposals[0].id;
  assert.deepEqual(pr.reject(id), { ok: true });
  assert.equal(get().proposals.length, 0);
  assert.throws(() => pr.reject(id), (e) => e.status === 404);
});
