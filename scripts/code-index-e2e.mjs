// e2e de FT-58 (índice de código) con binarios falsos: ensure() indexa una vez por HEAD y reindexa al cambiar;
// los motores claude y codex reciben el servidor MCP «code-index» (flags correctos).  Uso: node scripts/code-index-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ci-'));
process.env.AO_DATA_DIR = path.join(tmp, 'data');
const sh = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 }); return f; };
const log = path.join(tmp, 'calls.log');
process.env.AO_CODEINDEX_BIN = sh('cbm', `require('fs').appendFileSync(${JSON.stringify(log)}, 'index ' + process.env.CBM_CACHE_DIR + ' ' + process.argv.slice(2).join(' ') + '\\n');`);
const argsOf = (n) => sh(n, `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, n + '.args'))}, JSON.stringify(process.argv.slice(2))); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
process.env.AO_CLAUDE_BIN = argsOf('claude');
process.env.AO_CODEX_BIN = argsOf('codex');

const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.js'), 'x'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c1');

const ci = await import('../server/codeindex.js');
const claude = await import('../server/engines/claude.js');
const codex = await import('../server/engines/codex.js');
assert.ok(ci.available() && ci.enabled({ codeIndex: true }) && !ci.enabled({}), 'activación: solo con ajuste y binario');

const conn = await ci.ensure('repo', repo);
assert.equal(conn.env.CBM_CACHE_DIR, path.join(tmp, 'data', 'code-index', 'repo'));
await ci.ensure('repo', repo); // mismo HEAD → no reindexa
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'c2');
await ci.ensure('repo', repo); // HEAD nuevo → reindexa
const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
assert.equal(calls.length, 2, `2 indexados esperados, hubo ${calls.length}`);
assert.match(calls[0], /cli index_repository \{"repo_path":/);

const run = (engine, extra) => new Promise((resolve) => {
  const job = engine.start({ cwd: repo, prompt: 'p', system: 's', model: 'm', mode: 'work', codeIndex: conn, ...extra, onActivity() {}, onLog() {} });
  (job.done || job.promise || Promise.resolve()).then?.(resolve, resolve);
  setTimeout(resolve, 1500);
});
await run(claude);
const ca = JSON.parse(fs.readFileSync(path.join(tmp, 'claude.args'), 'utf8'));
const mcp = JSON.parse(ca[ca.indexOf('--mcp-config') + 1]);
assert.deepEqual(mcp.mcpServers['code-index'], { type: 'stdio', command: conn.command, args: [], env: conn.env });
assert.ok(ca.includes('--strict-mcp-config') && ca.includes('mcp__code-index'), 'claude: strict + allowedTools');
await run(codex);
const xa = JSON.parse(fs.readFileSync(path.join(tmp, 'codex.args'), 'utf8')).filter((_, i, a) => a[i - 1] === '-c');
assert.ok(xa.includes(`mcp_servers.code_index.command=${JSON.stringify(conn.command)}`) && xa.includes('mcp_servers.code_index.args=[]'), 'codex: -c command/args');
assert.ok(xa.some((v) => v.startsWith('mcp_servers.code_index.env={CBM_CACHE_DIR=')), 'codex: -c env');
console.log('OK code-index e2e (indexado por HEAD, claude y codex conectados)');
process.exit(0);
