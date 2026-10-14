// Navegante · capacidad «playwright» (Playwright MCP por npx con versión fijada).
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeScope } from '../server/engines/toolscope.js';
import { playwrightMcp, PW_MCP_VERSION } from '../server/browser/playwright-mcp.js';
import { ROLES } from '../server/roles.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Datos en una carpeta temporal: un token real en data/ cambiaría el modo del Guía
process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pw-test-'));

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

test('playwright: npx con la versión fijada, perfil propio, ventana visible con escritorio y salida por tarea; AO_PLAYWRIGHT=off lo apaga', () => {
  const d = playwrightMcp({ task: 'FT-1' });
  assert.equal(d.type, 'stdio');
  assert.ok(d.args.includes(`@playwright/mcp@${PW_MCP_VERSION}`));
  assert.match(d.args[d.args.indexOf('--user-data-dir') + 1], /browser[\\/]pw-profile$/);
  assert.match(d.args[d.args.indexOf('--output-dir') + 1], /pw-output[\\/]FT-1$/);
  assert.equal(d.args.includes('--headless'), !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === 'linux');
  process.env.AO_PLAYWRIGHT = 'off';
  try { assert.equal(playwrightMcp(), null); } finally { delete process.env.AO_PLAYWRIGHT; }
});

test('playwright · Guía: con token, tu navegador; sin token, Chromium propio; otro proveedor u «off», sin navegador', async () => {
  const { guideUsesPlaywright } = await import('../server/browser/playwright-mcp.js');
  assert.equal(guideUsesPlaywright({ settings: {}, provider: 'claude-cli' }), 'own');
  assert.equal(guideUsesPlaywright({ settings: {}, provider: 'anthropic-api' }), false);
  assert.equal(guideUsesPlaywright({ settings: { guideBrowserEngine: 'off' }, provider: 'claude-cli' }), false);
  const { toolName } = await import('../server/guide/providers/claude-cli.js');
  assert.equal(toolName('mcp__playwright__browser_navigate'), 'browser_navigate');
  assert.equal(toolName('mcp__agentoffice__task_create'), 'task.create');
});

test('playwright · navegador externo: con token de la extensión el Guía usa TU navegador; el token no va en los argumentos', async () => {
  const m = await import('../server/browser/playwright-mcp.js');
  process.env.AO_PLAYWRIGHT_TOKEN = 'tok-123'; process.env.AO_EXTERNAL_BROWSER = '/usr/bin/brave-browser';
  try {
    assert.equal(m.guideUsesPlaywright({ settings: {} }), 'external');
    const d = m.playwrightMcp({ task: 'guia-g1', external: true });
    assert.deepEqual(d.args.slice(2, 5), ['--extension', '--executable-path', '/usr/bin/brave-browser']);
    assert.equal(d.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'tok-123');
    assert.ok(!d.args.join(' ').includes('tok-123'));
  } finally { delete process.env.AO_PLAYWRIGHT_TOKEN; delete process.env.AO_EXTERNAL_BROWSER; }
});

test('casilla «🌐 Navegador» del rol: añade y quita `browser` en `tools:` sin tocar lo demás (catálogo temporal)', async () => {
  const store = await import('../server/store.js');
  const cat = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cat-'));
  store.get().settings.catalogDir = cat;
  fs.mkdirSync(path.join(cat, 'roles'), { recursive: true });
  const file = path.join(cat, 'roles', 'mirol.md');
  fs.writeFileSync(file, '---\nname: mirol\nkind: dev\ntools: Read, Grep\nmodel: sonnet\n---\n\nPrompt del rol.\n');
  const { setRoleBrowser } = await import('../server/roles.js');
  setRoleBrowser('mirol', true);
  assert.match(fs.readFileSync(file, 'utf8'), /^tools: Read, Grep, browser$/m);
  assert.match(fs.readFileSync(file, 'utf8'), /Prompt del rol\./);
  setRoleBrowser('mirol', false);
  assert.match(fs.readFileSync(file, 'utf8'), /^tools: Read, Grep$/m);
  fs.writeFileSync(file, '---\nname: mirol\nkind: dev\n---\n\nPrompt.\n');
  setRoleBrowser('mirol', true);
  assert.match(fs.readFileSync(file, 'utf8'), /^tools: browser$/m); // solo browser: mantiene las herramientas de su tipo
  setRoleBrowser('mirol', false);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^tools:/m);
  assert.throws(() => setRoleBrowser('navegante', false), (e) => e.status === 403); // de serie
});
