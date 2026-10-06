#!/usr/bin/env node
// FT-67: pruebas Node del LayoutEngine puro de la oficina.
import assert from 'node:assert/strict';
import { layoutFloor, recommendedFloorSize, toVisualState } from '../public/office-layout.js';

const a = (id, role = 'back', extra = {}) => ({ id, name: id, role, status: 'idle', projectId: 'flowtest', ...extra });
const t = (id, extra = {}) => ({ id, title: `Tarea ${id}`, status: 'todo', projectId: 'flowtest', dependsOn: [], ...extra });

const baseTasks = [
  t('dep', { status: 'todo' }),
  t('w1', { status: 'doing', agentId: 'dev', updatedAt: 10 }),
  t('q1', { status: 'todo', agentId: 'wait', updatedAt: 20 }),
  t('r1', { status: 'review', agentId: 'rev', updatedAt: 30 }),
  t('f1', { status: 'failed', agentId: 'fail', updatedAt: 40 }),
  t('b1', { status: 'todo', agentId: 'block', quotaBlocked: true, updatedAt: 50 }),
  t('d1', { status: 'todo', agentId: 'deps', dependsOn: ['dep'], updatedAt: 60 }),
];

const visual = [
  toVisualState(a('dev', 'back', { status: 'working', taskId: 'w1', activity: 'implementando' }), baseTasks, []),
  toVisualState(a('wait', 'front', { taskId: 'q1' }), baseTasks, [{ id: 'ask1', agentId: 'wait' }]),
  toVisualState(a('rev', 'back'), baseTasks, []),
  toVisualState(a('fail', 'qa'), baseTasks, []),
  toVisualState(a('block', 'front'), baseTasks, []),
  toVisualState(a('deps', 'back'), baseTasks, []),
  toVisualState(a('idle', 'qa'), baseTasks, []),
];

assert.deepEqual(Object.fromEntries(visual.map((v) => [v.id, v.status])), {
  dev: 'working',
  wait: 'waiting',
  rev: 'reviewing',
  fail: 'failed',
  block: 'blocked',
  deps: 'blocked',
  idle: 'idle',
});
assert.equal(visual.find((v) => v.id === 'dev').taskTitle, 'Tarea w1');

const first = layoutFloor(visual, { capacity: { development: 2, review: 1, board: 1 } });
const second = layoutFloor(visual, { capacity: { development: 2, review: 1, board: 1 } }, first);
assert.deepEqual(second.slots.dev, first.slots.dev);
assert.deepEqual(second.slots.wait, first.slots.wait);

const reviewMove = layoutFloor(visual.map((v) => v.id === 'dev' ? { ...v, status: 'reviewing' } : v), { capacity: { development: 2, review: 1, board: 1 } }, first);
assert.equal(reviewMove.slots.dev.zone, 'review');
assert.notDeepEqual(reviewMove.slots.dev, first.slots.dev);

const failedMove = layoutFloor(visual.map((v) => v.id === 'idle' ? { ...v, status: 'failed', taskId: 'fx' } : v), { capacity: { review: 2 } }, first);
assert.equal(failedMove.slots.idle.zone, 'review');

const crowded = layoutFloor([
  a('d1'), a('d2'), a('d3'), a('d4'), a('d5'),
].map((agent) => toVisualState({ ...agent, status: 'working' }, [], [])), { capacity: { development: 2 } });
assert.ok(Object.values(crowded.slots).some((s) => s.zone === 'development' && s.module === 2));
assert.equal(crowded.modules.filter((m) => m.zone === 'development').length, 3);

assert.deepEqual(recommendedFloorSize(4), { kind: 'compact', rx: 8.2, rz: 5.7 });
assert.deepEqual(recommendedFloorSize(9), { kind: 'medium', rx: 10.2, rz: 7.2 });
assert.deepEqual(recommendedFloorSize(14), { kind: 'modular', rx: 11.4, rz: 8.0 });

console.log('FT-67 office-layout-test OK');
