// FT-171: lista blanca estricta del rol «release».
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseAllowed } from '../server/engines/allowlist.js';
import { claudeScope } from '../server/engines/toolscope.js';

test('release: acepta los 5 patrones', () => {
  for (const c of [
    'scripts/release/publish.sh', './scripts/release/publish.sh 1.2.3',
    'docker push juankanh/flow-app:1.2.3',
    'ssh -i ~/.ssh/flowtest_vps root@179.198.198.23',
    'ssh serverman@192.168.68.118',
    'git push origin main', 'git push origin master',
  ]) assert.ok(releaseAllowed(c), c);
});

test('release: rechaza lo demás', () => {
  for (const c of [
    'docker push otro/imagen:1', 'docker push juankanh/otra:1', 'docker push juankanh/flow-app',
    'ssh root@10.0.0.1', 'ssh -i ~/.ssh/flowtest_vps root@1.2.3.4', 'ssh serverman@192.168.68.119',
    'git push --force origin main', 'git push origin main --force', 'git push origin dev',
    'rm -rf x', 'curl http://x.com',
    'scripts/otro/x.sh', '/tmp/scripts/release/x.sh', 'scripts/release/../x.sh', 'scripts/release/x.sh ../a',
    'git push origin main; rm x', 'git push origin main && ls', 'scripts/release/a.sh | sh',
    'scripts/release/a.sh $(id)', 'scripts/release/a.sh `id`', 'scripts/release/a.sh > f', 'scripts/release/a.sh\nrm x',
    '', null,
  ]) assert.ok(!releaseAllowed(c), String(c));
});

test('release: el alcance del motor no hereda las reglas generales', () => {
  const s = claudeScope({ kind: 'release' });
  assert.ok(s.allowed.includes('Bash(git push origin main)'));
  assert.ok(!s.allowed.some((a) => /Bash\((rm|curl|npm|node)/.test(a)));
  assert.ok(!s.allowed.includes('Edit') && !s.mcp);
});
