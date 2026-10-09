// FT-174 · disparo «Publicar X.Y.Z». Telegram y run-all simulados: ninguna prueba publica de verdad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-reltrig-'));
const rt = await import('../server/release-trigger.js');

const T = (id, title, status = 'done', extra = {}) => ({ id, title, status, role: 'back', kind: 'work', ...extra });
const reset = () => fs.rmSync(path.join(process.env.AO_DATA_DIR, 'release-trigger.json'), { force: true });

// deps simuladas: `answer` es lo que "contesta" el usuario; cuenta preguntas y ejecuciones
function mk(tasks, answer = 'yes', version = '5.24.0') {
  const c = { asks: [], runs: [], created: [], tasks, gate: null };
  const deps = {
    tasks: () => c.tasks, version: () => version,
    createTask: (o) => { const t = { id: `R${c.created.length}`, ...o }; c.created.push(t); c.tasks.push(t); return t; },
    updateTask: (id, p) => Object.assign(c.tasks.find((t) => t.id === id), p),
    sendConfirm: async (text, id) => { c.asks.push({ text, id }); return 1; },
    waitConfirm: async () => { if (c.gate) await c.gate; return answer; },
    runAll: async (v) => { c.runs.push(v); if (c.hold) await c.hold; return { ok: true, out: '' }; },
  };
  return { c, deps };
}
const epic = () => [T('1', 'FT-E: a'), T('2', 'FT-E: b', 'discarded'), T('3', 'FT-E: c')];

test('épica completa → una pregunta minor y ✅ ejecuta un solo run-all', async () => {
  reset();
  const { c, deps } = mk(epic());
  const r = await rt.check(deps);
  assert.equal(r.action, 'published'); assert.equal(r.version, '5.25.0');
  assert.equal(c.asks.length, 1); assert.match(c.asks[0].text, /^🚀 ¿Publico la 5\.25\.0\? · épica completa · .*FT-E.* · ✅\/❌$/);
  assert.deepEqual(c.runs, ['5.25.0']);
  assert.equal(c.created[0].title, 'Publicar 5.25.0'); assert.equal(c.created[0].role, 'release'); assert.equal(c.created[0].status, 'done');
  assert.equal((await rt.check(deps)).action, 'none', 'lo publicado no se vuelve a proponer');
});

test('épica incompleta no dispara', async () => {
  reset();
  const { deps } = mk([T('1', 'FT-E: a'), T('2', 'FT-E: b', 'doing')]);
  assert.equal((await rt.check(deps)).action, 'none');
});

test('bug aprobado → pregunta patch', async () => {
  reset();
  const { c, deps } = mk([T('1', 'Fix: el panel no abre'), T('2', 'Mejora suelta')]);
  const r = await rt.check(deps);
  assert.equal(r.version, '5.24.1'); assert.match(c.asks[0].text, /· bugs ·/); assert.equal(c.runs.length, 1);
});

test('reporte 📮 cuenta como bug', () => {
  assert.equal(rt.detect([T('1', 'cosa rara', 'done', { source: { kind: 'report' } }), T('2', '📮 algo')]).length, 2);
});

test('épica + bug a la vez → UNA pregunta agrupada (minor)', async () => {
  reset();
  const { c, deps } = mk([...epic(), T('9', 'Regresión: x')]);
  await rt.check(deps);
  assert.equal(c.asks.length, 1); assert.match(c.asks[0].text, /5\.25\.0/); assert.match(c.asks[0].text, /épica \+ bugs/); assert.match(c.asks[0].text, /Regresión/);
});

test('dos disparos simultáneos → una sola pregunta', async () => {
  reset();
  let open; const { c, deps } = mk(epic()); c.gate = new Promise((r) => { open = r; });
  const a = rt.check(deps), b = rt.check(deps);
  assert.equal((await b).action, 'busy');
  open(); assert.equal((await a).action, 'published');
  assert.equal(c.asks.length, 1); assert.equal(c.runs.length, 1);
});

test('❌ no ejecuta y acumula para la siguiente propuesta', async () => {
  reset();
  const { c, deps } = mk(epic(), 'no');
  assert.equal((await rt.check(deps)).action, 'no');
  assert.equal(c.runs.length, 0); assert.equal(c.tasks.find((t) => t.role === 'release').status, 'backlog');
  assert.equal(rt.state().lock, null);
  // llega un bug: la siguiente pregunta incluye lo acumulado y reutiliza la tarea de publicación
  c.tasks.push(T('9', 'Bug: roto'));
  const r2 = await (async () => { deps.waitConfirm = async () => 'yes'; return rt.check(deps); })();
  assert.equal(r2.action, 'published'); assert.equal(c.created.length, 1);
  assert.match(c.asks[1].text, /Épica FT-E/); assert.match(c.asks[1].text, /Bug: roto/);
});

test('timeout no publica', async () => {
  reset();
  const { c, deps } = mk(epic(), 'timeout');
  assert.equal((await rt.check(deps)).action, 'timeout'); assert.equal(c.runs.length, 0);
});

test('sin Telegram (0 chats) no publica', async () => {
  reset();
  const { c, deps } = mk(epic()); deps.sendConfirm = async () => 0;
  assert.equal((await rt.check(deps)).action, 'no'); assert.equal(c.runs.length, 0);
});

test('segundo ✅ con una ejecución en curso → no lanza otra', async () => {
  reset();
  let end; const { c, deps } = mk(epic()); c.hold = new Promise((r) => { end = r; });
  const first = rt.check(deps);
  await new Promise((r) => setTimeout(r, 20));          // ya está en run-all
  assert.equal(c.runs.length, 1);
  const second = await rt.runRelease('5.25.0', rt.detect(c.tasks), deps);
  assert.equal(second.action, 'busy'); assert.equal(c.runs.length, 1);
  assert.equal((await rt.check(deps)).action, 'busy', 'ni una pregunta nueva mientras publica');
  end(); assert.equal((await first).action, 'published'); assert.equal(c.runs.length, 1);
});

test('run-all falla → no se marca publicado y se puede reintentar', async () => {
  reset();
  const { c, deps } = mk(epic()); deps.runAll = async () => ({ ok: false, out: 'boom' });
  assert.equal((await rt.check(deps)).action, 'failed');
  assert.equal(c.tasks.find((t) => t.role === 'release').status, 'backlog');
  assert.equal(rt.state().lock, null);
});

test('el mutex sobrevive a un reinicio (se relee de disco)', async () => {
  reset();
  assert.ok(rt.acquire('x', 'running'));
  const rt2 = await import('../server/release-trigger.js?reinicio');
  assert.equal(rt2.acquire('y', 'asking'), false);
  rt.release('x');
});
