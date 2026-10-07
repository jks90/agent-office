// FT-160 · detector de atascos (server/stuck.js). Migrado de scripts/stuck-unit.mjs (FT-62).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, limits, nudgeText, DEFAULTS, NO_EDIT_CODEX } from '../server/stuck.js';
import { toolKey } from '../server/engines/describe.js';

let id = 0;
const run = (d, tool, key, ok = true) => { const callId = 'c' + ++id; const a = d.feed({ phase: 'started', callId, tool, key }); const b = d.feed({ phase: 'finished', callId, ok }); return a || b; };
const L = limits({});

test('limits: valores de serie, Codex con menos pasos y Ajustes', () => {
  assert.equal(L.repeat, DEFAULTS.repeat);
  assert.ok(limits({}, 'codex').noEdit <= NO_EDIT_CODEX);
  assert.equal(limits({}, 'codex').noEdit, Math.min(DEFAULTS.noEdit, NO_EDIT_CODEX));
  assert.match(nudgeText('x'), /^Nota del sistema de AgentOffice: x\./);
});

test('misma orden: sin señal a la 2.ª, señal a la 3.ª', () => {
  const d = createDetector({ limits: L });
  assert.ok(!run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls'));
  assert.match(run(d, 'Bash', 'ls'), /repite la orden «ls»/);
});

test('editar reinicia las repeticiones', () => {
  const d = createDetector({ limits: L });
  run(d, 'Read', '/a.js'); run(d, 'Read', '/a.js'); run(d, 'Edit', null);
  assert.ok(!run(d, 'Read', '/a.js'));
});

test('3.ª lectura del mismo fichero: señal', () => {
  const d = createDetector({ limits: L });
  run(d, 'Read', '/a.js'); run(d, 'Read', '/a.js');
  assert.match(run(d, 'Read', '/a.js'), /relee \/a\.js/);
});

test('tramos distintos del mismo fichero no cuentan; el mismo tramo 3 veces sí', () => {
  let d = createDetector({ limits: L });
  const tramos = [0, 200, 400].map((o) => run(d, 'Read', toolKey('Read', { file_path: '/big.js', offset: o, limit: 200 })));
  assert.ok(tramos.every((x) => !x));
  d = createDetector({ limits: L });
  const mismo = [1, 2, 3].map(() => run(d, 'Read', toolKey('Read', { file_path: '/big.js', offset: 200, limit: 200 })));
  assert.ok(!mismo[0] && !mismo[1]);
  assert.match(mismo[2], /relee \/big\.js @200\+200/);
});

test('4 errores seguidos: señal en el 4.º; un acierto corta la racha', () => {
  let d = createDetector({ limits: L });
  const errs = [1, 2, 3, 4].map(() => run(d, 'Grep', null, false));
  assert.ok(!errs[2]);
  assert.match(errs[3], /4 errores/);
  d = createDetector({ limits: L });
  run(d, 'Grep', null, false); run(d, 'Grep', null, false); run(d, 'Grep', null, true);
  assert.ok(!run(d, 'Grep', null, false));
});

test('e2e fallando igual 3 veces: señal', () => {
  const d = createDetector({ limits: L });
  const r = [1, 2, 3].map(() => run(d, 'Bash', 'node scripts/x-e2e.mjs', false));
  assert.match(r.find(Boolean), /falla igual por 3/);
});

test('pasos sin editar: señal solo en tareas de código', () => {
  let d = createDetector({ limits: L, isCode: true });
  let sig = null; for (let i = 0; i < 25 && !sig; i++) sig = run(d, 'Grep', null);
  assert.match(sig, /25 pasos/);
  d = createDetector({ limits: L, isCode: false });
  sig = null; for (let i = 0; i < 40; i++) sig = sig || run(d, 'Grep', null);
  assert.ok(!sig);
});

test('desactivado en Ajustes: nunca señal', () => {
  const d = createDetector({ limits: { ...L, enabled: false } });
  assert.ok(!run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls'));
});

test('tokens por turno: referencia, señal con el worktree igual y nada si cambió', async () => {
  let state = 'A', t = 0, r = null;
  const d = createDetector({ limits: L, probe: async () => state });
  for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000);
  assert.equal(r, null);
  for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000);
  assert.match(r, /100 k tokens por turno/);
  state = 'B';
  for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000);
  assert.equal(r, null);
});
