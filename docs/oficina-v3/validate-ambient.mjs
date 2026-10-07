// FT-147: validate design references, episode accounting and layout-relative anchors.
// Run: node docs/oficina-v3/validate-ambient.mjs (no server or dependencies).
import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const ambient = read('ambient-contract.json');
const geometry = read(ambient.geometry);
assert.equal(ambient.task, 'FT-147');
assert.equal(ambient.status, 'design-only');
assert.equal(ambient.identity.affectsTasksEventsCostsTeamCounts, false);
assert.deepEqual(ambient.scheduler.bands.map((b) => b.maxCharacters), [3, 2, 1]);
assert.equal(new Set(ambient.catalog.map((e) => e.id)).size, ambient.catalog.length);

for (const layout of geometry.layouts) {
  const resolved = new Map();
  const resolving = new Set();
  function resolve(id) {
    if (resolved.has(id)) return resolved.get(id);
    assert(!resolving.has(id), `cyclic binding: ${id}`);
    const binding = ambient.bindings[id];
    assert(binding, `missing binding: ${id}`);
    resolving.add(id);
    const base = binding.node ? resolve(binding.node)
      : binding.anchor ? layout.anchors.find((a) => a.id === binding.anchor)
        : layout.routes[binding.route]?.[binding.index];
    assert(base, `${layout.id}: missing source for ${id}`);
    const p = { x: base.x + (binding.offset?.x || 0), z: base.z + (binding.offset?.z || 0) };
    assert(Number.isFinite(p.x) && Number.isFinite(p.z));
    const epsilon = 1e-8; // v3 boundary may be 14.600000000000001 for a 14.6u floor.
    assert(p.x >= -epsilon && p.x <= layout.floor.rx + epsilon && p.z >= -epsilon && p.z <= layout.floor.rz + epsilon,
      `${layout.id}: out of floor: ${id}`);
    if (binding.footprint) {
      const { w, d } = binding.footprint;
      assert(p.x - w / 2 >= 0 && p.x + w / 2 <= layout.floor.rx);
      assert(p.z - d / 2 >= 0 && p.z + d / 2 <= layout.floor.rz);
    }
    resolving.delete(id);
    resolved.set(id, p);
    return p;
  }
  Object.keys(ambient.bindings).forEach(resolve);
  for (const [id, path] of Object.entries(ambient.paths)) {
    assert(path.length >= 2, `short path: ${id}`);
    path.forEach(resolve);
  }
  // The cleaner must follow the east spine, not cut diagonally through the Kanban.
  const loop = ambient.paths['cleaning-loop'].map(resolve);
  for (let i = 1; i < loop.length; i++) {
    assert(Math.abs(loop[i].x - loop[i - 1].x) < 1e-8 || Math.abs(loop[i].z - loop[i - 1].z) < 1e-8);
  }
  assert.notEqual(ambient.bindings['visitor-seat'].anchor, 'idle-seat-0');
  console.log(`✓ ${layout.id}: ${resolved.size} bindings, all paths in floor bounds`);
}

for (const episode of ambient.catalog) {
  assert(episode.characters >= 1 && episode.characters <= 3);
  assert((episode.quietCharacters || episode.characters) <= 3);
  assert(episode.basePeriodSeconds >= episode.nominalDurationSeconds);
  let duration = 0;
  for (const phase of episode.phases) {
    duration += phase.seconds ?? phase.secondsEach * phase.nodes.length;
    for (const path of [...(phase.paths || []), ...(phase.path ? [phase.path] : [])]) {
      assert(ambient.paths[path], `missing phase path: ${path}`);
    }
    for (const node of [...(phase.nodes || []), ...(phase.node ? [phase.node] : [])]) {
      assert(ambient.bindings[node], `missing phase node: ${node}`);
    }
  }
  assert.equal(duration, episode.nominalDurationSeconds, `${episode.id}: phase durations`);
  console.log(`✓ ${episode.id}: ${duration}s nominal; character budget ≤3`);
}
console.log('FT-147 design references pass; actual GLB collision sweeps remain implementation acceptance.');
