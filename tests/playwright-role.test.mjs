// Navegante · capacidad «playwright» (Playwright MCP por npx con versión fijada).
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeScope } from '../server/engines/toolscope.js';
import { playwrightMcp, PW_MCP_VERSION } from '../server/browser/playwright-mcp.js';
import { ROLES } from '../server/roles.js';

test('playwright: el rol de serie «navegante» la lleva; en modo plan no', () => {
  assert.equal(ROLES.navegante.kind, 'docs');
  assert.equal(claudeScope({ kind: 'docs', roleId: 'navegante' }).playwright, true);
  assert.equal(claudeScope({ kind: 'docs', roleId: 'navegante', mode: 'plan' }).playwright, false);
  assert.equal(claudeScope({ kind: 'qa', roleId: 'qa' }).playwright, false);
});

test('playwright: otro rol la activa con `tools: …, playwright` sin que cuente como herramienta integrada', () => {
  const s = claudeScope({ kind: 'qa', roleId: 'mio', roleTools: ['Read', 'playwright'] });
  assert.equal(s.playwright, true);
  assert.deepEqual(s.builtin, ['Read']);
});

test('playwright: npx con la versión fijada, perfil propio y salida por tarea; AO_PLAYWRIGHT=off lo apaga', () => {
  const d = playwrightMcp({ task: 'FT-1' });
  assert.equal(d.type, 'stdio');
  assert.ok(d.args.includes(`@playwright/mcp@${PW_MCP_VERSION}`));
  assert.match(d.args[d.args.indexOf('--user-data-dir') + 1], /browser[\\/]pw-profile$/);
  assert.match(d.args[d.args.indexOf('--output-dir') + 1], /pw-output[\\/]FT-1$/);
  process.env.AO_PLAYWRIGHT = 'off';
  try { assert.equal(playwrightMcp(), null); } finally { delete process.env.AO_PLAYWRIGHT; }
});
