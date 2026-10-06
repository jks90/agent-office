#!/usr/bin/env node
// Mide el tamaño del PRIMER turno (cache_creation + cache_read + input del primer `assistant`) con el `claude` real,
// por rol y con/sin --tools (FT-59). Gasta unos céntimos (haiku, prompt mínimo, sin herramientas usadas):
//   node scripts/tools-scope-measure.mjs [roles...]      (por defecto: dev qa docs planner)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeScope } from '../server/engines/toolscope.js';
import { BASH_TOOLS } from '../server/engines/allowlist.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-measure-'));
const run = (extra) => new Promise((resolve) => {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...extra];
  const c = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  let first = null, buf = '';
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const ev = JSON.parse(l); if (ev.type === 'assistant' && !first) first = ev.message.usage; } catch { /* no JSON */ } } });
  c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Responde solo: ok' }] } }) + '\n');
  c.on('close', () => resolve(first));
  setTimeout(() => c.stdin.end(), 20_000);
});
const size = (u) => u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;

const roles = process.argv.slice(2).length ? process.argv.slice(2) : ['dev', 'qa', 'docs', 'planner'];
console.log('rol      | antes (sin --tools) | después (--tools) | ahorro');
for (const r of roles) {
  const mode = r === 'planner' ? 'plan' : 'work';
  const sc = claudeScope({ kind: r === 'planner' ? 'dev' : r, mode });
  const before = size(await run(['--allowedTools', ...BASH_TOOLS, 'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite']));
  const after = size(await run(['--tools', sc.builtin.join(','), '--allowedTools', ...sc.allowed]));
  console.log(`${r.padEnd(8)} | ${String(before).padStart(19)} | ${String(after).padStart(17)} | ${before && after ? Math.round((1 - after / before) * 100) + ' %' : '?'}`);
}
fs.rmSync(cwd, { recursive: true, force: true });
