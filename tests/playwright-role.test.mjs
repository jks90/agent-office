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

test('playwright · Guía: claude-cli + navegador dedicado; con la extensión, otro proveedor o guideBrowserEngine=ao, browser.* de siempre', async () => {
  const { guideUsesPlaywright } = await import('../server/browser/playwright-mcp.js');
  assert.equal(guideUsesPlaywright({ settings: {}, mode: 'dedicated', provider: 'claude-cli' }), true);
  assert.equal(guideUsesPlaywright({ settings: {}, mode: 'extension', provider: 'claude-cli' }), false);
  assert.equal(guideUsesPlaywright({ settings: {}, mode: 'dedicated', provider: 'anthropic-api' }), false);
  assert.equal(guideUsesPlaywright({ settings: { guideBrowserEngine: 'ao' }, mode: 'dedicated', provider: 'claude-cli' }), false);
});

test('playwright · Guía: se engancha al CDP de AgentOffice y sus tools se ven como browser_x', async () => {
  const d = playwrightMcp({ task: 'guia-g_1', cdpEndpoint: 'http://127.0.0.1:7420/api/browser/cdp' });
  assert.equal(d.args[d.args.indexOf('--cdp-endpoint') + 1], 'http://127.0.0.1:7420/api/browser/cdp');
  assert.ok(!d.args.includes('--user-data-dir'));
  const { toolName } = await import('../server/guide/providers/claude-cli.js');
  assert.equal(toolName('mcp__playwright__browser_navigate'), 'browser_navigate');
  assert.equal(toolName('mcp__agentoffice__task_create'), 'task.create');
});
