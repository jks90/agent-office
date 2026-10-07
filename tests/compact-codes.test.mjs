// FT-160 · compact (FT-63) y codes (códigos de tarea): funciones puras.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../server/compact.js';
import * as K from '../server/codes.js';

test('compact: ventana de contexto y fracción ocupada', () => {
  delete process.env.AO_CONTEXT_WINDOW;
  assert.equal(C.windowOf({}), 200_000);
  assert.equal(C.windowOf({}, 'sonnet[1m]'), 1_000_000);
  assert.equal(C.windowOf({ limit: 123 }), 123);
  assert.equal(C.contextShare({ used: 100_000 }, 'sonnet'), 0.5);
  assert.equal(C.contextShare({ ctx: 50_000 }, 'x'), 0.25);
  assert.equal(C.contextShare({}, 'x'), null); // el motor no informa
});

test('compact: umbral acepta fracción, porcentaje, 0 = apagado y topes', () => {
  assert.equal(C.threshold(undefined), C.DEFAULT_AT);
  assert.equal(C.threshold(''), C.DEFAULT_AT);
  assert.equal(C.threshold(62), 0.62);
  assert.equal(C.threshold(0.5), 0.5);
  assert.equal(C.threshold(0), 0);
  assert.equal(C.threshold('abc'), 0);
  assert.equal(C.threshold(99), 0.9);
  assert.equal(C.threshold(5), 0.3);
});

test('compact: reached y notesBlock', () => {
  assert.ok(C.reached({ used: 130_000 }, 'sonnet', 0.62));
  assert.ok(!C.reached({ used: 100_000 }, 'sonnet', 0.62));
  assert.ok(!C.reached({ used: 190_000 }, 'sonnet', 0)); // apagado
  assert.ok(!C.reached({}, 'sonnet', 0.62));
  assert.match(C.notesBlock('hecho X'), /hecho X/);
  assert.match(C.notesBlock(''), /cortar la sesión/);
  assert.ok(C.notesBlock('a'.repeat(20_000)).length < 13_000);
});

test('compact: bigTaskReason', () => {
  const items = (n) => Array.from({ length: n }, (_, i) => `- punto ${i}`).join('\n');
  assert.equal(C.bigTaskReason({ title: 'x', description: 'corta' }), null);
  assert.match(C.bigTaskReason({ description: items(6) }), /6 puntos/);
  assert.match(C.bigTaskReason({ description: 'haz a, y además b, y además c' }), /y además/);
  assert.match(C.bigTaskReason({ description: 'x'.repeat(2600) }), /muy larga/);
  assert.match(C.bigTaskReason({ description: items(3) }, { estimate: 2.5, capUsd: 3 }), /estimación/);
  assert.equal(C.bigTaskReason({ description: items(3) }, { estimate: 0.5 }), null);
});

test('codes: prefijos por defecto y normalizados', () => {
  assert.equal(K.defaultPrefix('flow-test'), 'FT');
  assert.equal(K.defaultPrefix('gestionlab'), 'GL');
  assert.equal(K.defaultPrefix('flow test'), 'FT');
  assert.equal(K.defaultPrefix(''), 'TK');
  assert.equal(K.normalizePrefix('ab-cd!efg'), 'ABCDE');
  assert.equal(K.prefixOf({ prefix: 'zz', name: 'otro' }), 'ZZ');
  assert.equal(K.prefixOf({ folder: 'agent-office' }), 'AO');
});

test('codes: codeIn, numberOf, titleWithCode y stripCode', () => {
  assert.equal(K.codeIn('[GL-07] algo'), 'GL-7');
  assert.equal(K.codeIn('nada'), null);
  assert.equal(K.codeIn('UH-1 y GL-2', 'GL'), 'GL-2');
  assert.equal(K.numberOf('FT-12'), 12);
  assert.equal(K.numberOf(null), 0);
  assert.equal(K.titleWithCode({ code: 'FT-1', title: 'Hacer' }), 'FT-1 · Hacer');
  assert.equal(K.titleWithCode({ code: 'FT-1', title: 'FT-1 Hacer' }), 'FT-1 Hacer');
  assert.equal(K.stripCode('FT-1 · Hacer', 'FT-1'), 'Hacer');
  assert.equal(K.stripCode('[FT-1]: Hacer', 'FT-1'), 'Hacer');
});

test('codes: assignCode correlativo, respeta el del título y no choca', () => {
  const p = { id: 'p', prefix: 'AB' };
  const tasks = [];
  const add = (title) => { const t = { projectId: 'p', title }; tasks.push(t); K.assignCode(tasks, p, t); return t.code; };
  assert.equal(add('uno'), 'AB-1');
  assert.equal(add('dos'), 'AB-2');
  assert.equal(add('AB-10 importada'), 'AB-10');
  assert.equal(add('AB-10 duplicada'), 'AB-11');   // el 10 ya está tomado
  assert.equal(add('tres'), 'AB-12');
  assert.equal(p.codeSeq, 12);
});

test('codes: migrate da código por orden de creación', () => {
  const state = { projects: [{ id: 'p', prefix: 'MG' }], tasks: [{ projectId: 'p', title: 'b', createdAt: 2 }, { projectId: 'p', title: 'a', createdAt: 1 }, { projectId: 'p', title: 'c', createdAt: 3, code: 'MG-9' }] };
  K.migrate(state);
  assert.equal(state.tasks[1].code, 'MG-10'); // 'c' ya tiene el 9 → nextNumber arranca en 10
  assert.equal(state.tasks[0].code, 'MG-11');
  assert.equal(state.tasks[2].code, 'MG-9');
});
