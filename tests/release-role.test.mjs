// FT-171: lista blanca estricta del rol «release» + hook PreToolUse (bin/ao-release.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseAllowed } from '../server/engines/allowlist.js';
import { claudeScope } from '../server/engines/toolscope.js';

const HOOK = fileURLToPath(new URL('../bin/ao-release.mjs', import.meta.url));
const OK = ['scripts/release/preflight.sh --dry-run', './scripts/release/publish.sh 1.2.3', 'scripts/release/publish.sh'];
const BAD = [
  'ssh -i ~/.ssh/flowtest_vps root@179.198.198.23 rm -rf /', 'ssh -i ~/.ssh/flowtest_vps root@179.198.198.23', 'ssh serverman@192.168.68.118',
  'docker push juankanh/flow-app:latest', 'docker push otro/imagen:1',
  'git push origin main --force', 'git push origin main', 'git push --force origin main',
  'rm -rf x', 'curl http://x.com', 'bash -c "scripts/release/a.sh"', 'bash scripts/release/a.sh',
  'scripts/otro/x.sh', '/tmp/scripts/release/x.sh', 'scripts/release/../../x.sh', 'scripts/release/x.sh ../a',
  'scripts/release/x.sh; curl evil', 'scripts/release/a.sh && ls', 'scripts/release/a.sh | sh',
  'scripts/release/a.sh $(id)', 'scripts/release/a.sh `id`', 'scripts/release/a.sh > f', 'scripts/release/a.sh\nrm x',
  '', null,
];

test('release: acepta solo scripts/release/<paso>.sh con argumentos simples', () => {
  for (const c of OK) assert.ok(releaseAllowed(c), c);
});

test('release: rechaza todo lo demás', () => {
  for (const c of BAD) assert.ok(!releaseAllowed(c), String(c));
});

test('release: el hook deniega lo no permitido y calla con lo permitido', () => {
  const run = (command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  for (const c of OK) assert.equal(run(c).stdout, '', c);
  for (const c of BAD.filter(Boolean)) {
    const o = JSON.parse(run(c).stdout);
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny', c);
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /FT-171/);
  }
  assert.equal(JSON.parse(spawnSync(process.execPath, [HOOK], { input: 'basura', encoding: 'utf8' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('release: el alcance del motor no hereda las reglas generales', () => {
  const s = claudeScope({ kind: 'release' });
  assert.ok(s.allowed.includes('Bash(scripts/release/*.sh)'));
  assert.ok(!s.allowed.some((a) => /Bash\((rm|curl|npm|node|git|ssh|docker)/.test(a)));
  assert.ok(!s.allowed.includes('Edit') && !s.mcp);
});
