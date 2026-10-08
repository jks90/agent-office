// FT-155 · casos REALES del histórico de flowtest que el clasificador de devoluciones (scores.classifyReject) clasificaba mal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReject } from '../server/scores.js';

test('FT-141: «8/8 … pero hay un AGUJERO DE SEGURIDAD» es seguridad, no informe-falso', () => {
  assert.equal(classifyReject('buen trabajo (8/8, saneado, sha), pero hay un AGUJERO DE SEGURIDAD que bloquea: path traversal'), 'seguridad');
});
test('FT-119: «dice 248/248 en verde, pero esas son las suites de los desarrolladores» sigue siendo informe-falso', () => {
  assert.equal(classifyReject('Tu informe dice 248/248 en verde, pero esas son las suites de los desarrolladores. La tuya FALLA 15 de 18'), 'informe-falso');
  assert.equal(classifyReject('El informe dice 248/248 pero en realidad falla 15/18; informe falso'), 'informe-falso');
});
test('FT-120: «tu versión tenía errores» (README) es informe-falso', () => {
  assert.equal(classifyReject('Tu versión tenía errores: navigate NO pide confirmación'), 'informe-falso');
});
test('FT-134: «hasDeliverable da falso» (código) no es informe-falso', () => {
  assert.notEqual(classifyReject('2. hasDeliverable da falso en las tareas de qa/docs que escriben fuera del repo'), 'informe-falso');
});
test('FT-144: .env.test con ADMIN_TOKEN versionado es seguridad', () => {
  assert.equal(classifyReject('tu commit mete .env.test con los MISMOS ADMIN_TOKEN y SESSION_SECRET del .env real'), 'seguridad');
});
test('FT-144: el corte por atasco no es sin-entregable', () => {
  assert.equal(classifyReject('Supervisor: el sistema te cortó por «atasco» (≈122 k tokens por turno sin cambios en el worktree)'), 'otro');
});
test('FT-133: bench en segundo plano sin fichero es sin-entregable', () => {
  assert.equal(classifyReject('DEVUELTA sin entregable. Lanzaste el bench en segundo plano'), 'sin-entregable');
});
