// FT-161 · hook PreToolUse bin/ao-nobg.mjs (FT-134): entrada JSON por stdin, decisión por stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ao-nobg.mjs');
const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 5000 });
const decision = (input) => { const r = run(input); assert.equal(r.status, 0, 'el hook nunca falla'); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null; };

test('run_in_background:true → deny con motivo y salida 0', () => {
  const d = decision(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm start &', run_in_background: true } }));
  assert.equal(d.hookEventName, 'PreToolUse');
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /FT-134/);
  assert.match(d.permissionDecisionReason, /primer plano/);
});

test('primer plano o sin la clave: no opina (stdout vacío)', () => {
  for (const ti of [{ command: 'ls' }, { command: 'ls', run_in_background: false }, {}]) {
    assert.equal(decision(JSON.stringify({ tool_name: 'Bash', tool_input: ti })), null);
  }
});

test('valores no estrictamente true no bloquean (cadena, 1, null)', () => {
  for (const v of ['true', 1, null, 'yes', [true]]) assert.equal(decision(JSON.stringify({ tool_input: { run_in_background: v } })), null, String(v));
});

test('entrada vacía, no JSON o con forma rara: no falla y no bloquea', () => {
  for (const raw of ['', '   ', 'no json', '{', '[]', '"x"', '123', '{"tool_input":null}', '{"tool_input":"x"}', '\u0000\u0001']) {
    assert.equal(decision(raw), null, JSON.stringify(raw));
  }
});

test('entrada JSON null: no debe fallar', { todo: 'BUG FT-161: ev=null y ev.tool_input lanza TypeError → exit 1 (debería salir 0 sin opinar)' }, () => {
  assert.equal(decision('null'), null);
});

test('JSON malicioso (__proto__) y entrada grande se tratan sin colgarse', () => {
  assert.equal(decision('{"tool_input":{"__proto__":{"run_in_background":true}}}'), null);
  assert.equal(decision(JSON.stringify({ tool_input: { command: 'x'.repeat(2_000_000) } })), null);
  const d = decision('{"tool_input":{"run_in_background":true,"command":"' + 'x'.repeat(100000) + '"}}');
  assert.equal(d.permissionDecision, 'deny');
});

test('aplica a cualquier herramienta, no solo a Bash', () => {
  assert.equal(decision(JSON.stringify({ tool_name: 'Task', tool_input: { run_in_background: true } })).permissionDecision, 'deny');
});
