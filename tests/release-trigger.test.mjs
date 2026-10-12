// FT-174 · disparo «Publicar X.Y.Z» (perfil de release): detecta lo publicable de flow-test, pregunta en 🔔 y, con ✅, encarga
// «Documentar X.Y.Z» + «Publicar X.Y.Z» (depende de la primera); se marca publicado cuando «Publicar» termina bien.
// Pregunta, agentes y tareas simulados: ninguna prueba publica de verdad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-reltrig-'));
const rt = await import('../server/release-trigger.js');

const FT = { repo: 'flow-test' };
const T = (id, title, status = 'done', extra = {}) => ({ id, title, status, role: 'back', kind: 'work', ...FT, ...extra });
const file = () => path.join(process.env.AO_DATA_DIR, 'release-trigger.json');
const reset = (published = []) => fs.writeFileSync(file(), JSON.stringify({ published, pending: [], lock: null, baselineAt: 1 })); // ya con punto de partida

// deps simuladas: `answer` es lo que "contesta" el usuario en 🔔
function mk(tasks, answer = 'yes', version = '5.24.0', { agents = true } = {}) {
  const c = { asks: [], notes: [], created: [], tasks, gate: null, pendingAsk: true };
  const deps = {
    repoKey: 'flow-test', docsDirs: ['/tmp/pub', '/tmp/docs'],
    tasks: () => c.tasks, version: () => version,
    createTask: (o) => { const t = { id: `R${c.created.length}`, ...o }; c.created.push(t); c.tasks.push(t); return t; },
    updateTask: (id, p) => Object.assign(c.tasks.find((t) => t.id === id), p),
    ask: async (text, id) => { c.asks.push({ text, id }); if (c.gate) await c.gate; return answer; },
    askPending: () => c.pendingAsk,
    notify: (t) => c.notes.push(t),
    agentFor: (kind) => (!agents ? null : kind === 'release' ? { id: 'A-rel', role: 'release' } : { id: 'A-doc', role: 'release-docs-flowtest' }),
  };
  return { c, deps };
}
const epic = () => [T('1', 'FT-E: a'), T('2', 'FT-E: b', 'discarded'), T('3', 'FT-E: c')];

test('la 1.ª vez fija el punto de partida: lo ya hecho no se propone', async () => {
  fs.rmSync(file(), { force: true });
  const { c, deps } = mk(epic());
  assert.equal((await rt.check(deps)).action, 'baseline');
  assert.equal((await rt.check(deps)).action, 'none');
  assert.equal(c.asks.length, 0);
});

test('épica completa → pregunta minor y ✅ encarga Documentar + Publicar (que depende de Documentar)', async () => {
  reset();
  const { c, deps } = mk(epic());
  const r = await rt.check(deps);
  assert.equal(r.action, 'dispatched'); assert.equal(r.version, '5.25.0');
  assert.equal(c.asks.length, 1); assert.match(c.asks[0].text, /^🚀 ¿Publico flow-test 5\.25\.0\? \(épica completa\): .*FT-E/);
  const [doc, pub] = c.created;
  assert.deepEqual([doc.title, doc.assignedAgentId, doc.onMain, doc.autoApprove], ['Documentar 5.25.0', 'A-doc', true, true]);
  assert.deepEqual(doc.onMainDirs, ['/tmp/pub', '/tmp/docs']);
  assert.deepEqual([pub.title, pub.assignedAgentId, pub.releaseVersion, pub.dependsOn], ['Publicar 5.25.0', 'A-rel', '5.25.0', [doc.id]]);
  assert.equal((await rt.check(deps)).action, 'busy', 'mientras se publica no se vuelve a preguntar');
  // «Publicar» termina bien → se marca publicado y no se vuelve a proponer
  pub.status = 'done';
  assert.equal((await rt.check(deps)).action, 'published');
  assert.match(c.notes.at(-1), /5\.25\.0 publicada/);
  assert.equal((await rt.check(deps)).action, 'none');
});

test('si «Publicar» falla, se libera y lo pendiente se vuelve a proponer', async () => {
  reset();
  const { c, deps } = mk(epic());
  await rt.check(deps);
  c.created[1].status = 'failed'; c.created[1].error = 'paso 04 falló\ndetalle';
  assert.equal((await rt.check(deps)).action, 'failed');
  assert.match(c.notes.at(-1), /paso 04 falló/);
  assert.equal((await rt.check(deps)).action, 'dispatched', 'vuelve a proponerse');
});

test('solo cuenta lo que toca flow-test (otros proyectos o solo agent-office no publican)', () => {
  const ts = [T('1', 'GL-X: a', 'done', { repo: 'app' }), T('2', 'GL-X: b', 'done', { repo: 'app' }), T('3', 'Bug: algo', 'done', { repo: 'agent-office' })];
  assert.deepEqual(rt.detect(ts), []);
  assert.equal(rt.detect([T('4', 'Bug: roto')]).length, 1);
});

test('épica por partes (epicParts): con todas resueltas y alguna en flow-test', () => {
  const parent = { id: 'E', code: 'FT-195', title: 'Visor CSV', status: 'done', kind: 'work', repo: 'flow-test', epicParts: ['p1', 'p2'] };
  const p1 = T('p1', 'FT-195.1 Servidor: x'), p2 = T('p2', 'FT-195.2 UI: y', 'doing');
  assert.deepEqual(rt.detect([parent, p1, p2]), [], 'una parte aún en curso');
  p2.status = 'done';
  const items = rt.detect([parent, p1, p2]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'epic'); assert.match(items[0].label, /FT-195 Visor CSV \(2 tareas\)/);
  assert.deepEqual(items[0].taskIds, ['E', 'p1', 'p2']);
  assert.deepEqual(rt.detect([parent, p1, p2], ['E', 'p1', 'p2']), [], 'ya publicada');
});

test('épica incompleta no dispara; bug aprobado → patch; reporte 📮 cuenta como bug', async () => {
  reset();
  assert.equal((await rt.check(mk([T('1', 'FT-E: a'), T('2', 'FT-E: b', 'doing')]).deps)).action, 'none');
  reset();
  const { c, deps } = mk([T('9', 'Bug: el login falla')]);
  assert.equal((await rt.check(deps)).version, '5.24.1');
  assert.match(c.asks[0].text, /\(bugs\)/);
  assert.ok(rt.isBug({ title: '📮 Reporte: no carga' }));
});

test('❌ no encarga nada y acumula; timeout tampoco', async () => {
  reset();
  const no = mk(epic(), 'no');
  assert.equal((await rt.check(no.deps)).action, 'no');
  assert.equal(no.c.created.length, 0);
  assert.equal(rt.state().pending.length, 1, 'queda acumulado para la siguiente propuesta');
  reset();
  assert.equal((await rt.check(mk(epic(), 'timeout').deps)).action, 'timeout');
});

test('sin agente de Release en el equipo → avisa y no encarga', async () => {
  reset();
  const { c, deps } = mk(epic(), 'yes', '5.24.0', { agents: false });
  assert.equal((await rt.check(deps)).action, 'no-agent');
  assert.equal(c.created.length, 0);
  assert.match(c.notes.at(-1), /agente de Release/);
});

test('dos ciclos a la vez → una sola pregunta; una pregunta perdida en un reinicio se vuelve a hacer', async () => {
  reset();
  const { c, deps } = mk(epic());
  let open; c.gate = new Promise((r) => { open = r; });
  const first = rt.check(deps);
  assert.equal((await rt.check(deps)).action, 'busy');
  open(); await first;
  assert.equal(c.asks.length, 1);
  // reinicio con una pregunta «asking» que ya no existe en 🔔
  reset(); fs.writeFileSync(file(), JSON.stringify({ published: [], pending: [], baselineAt: 1, lock: { id: 'release-5.25.0', phase: 'asking', at: Date.now() } }));
  const again = mk(epic()); again.c.pendingAsk = false;
  assert.equal((await rt.check(again.deps)).action, 'dispatched');
});
