// 🫧 Burbuja del agente: aparece cuando un agente usa Playwright, enseña sus preguntas y se va al acabar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.DISPLAY ||= ':99'; // hasDesktop(): la lógica no depende de que haya escritorio de verdad
const { createOverlay, isBrowserTool, hasDesktop } = await import('../server/browser/overlay.js');

function setup({ enabled = true } = {}) {
  let t = 1_000_000;
  const state = { agents: [{ id: 'a1', name: 'Berta', role: 'conciliador-bancos', taskId: 't1', activity: 'Abriendo Unicaja' }], tasks: [{ id: 't1', code: 'BA-5', status: 'doing' }] };
  const qs = [];
  const spawned = [];
  const spawn = (cmd, args) => { const c = new EventEmitter(); c.exitCode = null; c.args = args; c.kill = () => { c.killed = true; c.exitCode = 0; }; spawned.push(c); return c; };
  const o = createOverlay({ url: () => 'http://127.0.0.1:7420', getState: () => state, listQuestions: () => qs, spawn, now: () => t, enabled: () => enabled });
  return { o, state, qs, spawned, advance: (ms) => { t += ms; } };
}
const tool = (agentId, name, extra = {}) => ({ type: 'AgentToolStarted', agentId, taskId: 't1', taskCode: 'BA-5', data: { tool: name, summary: 'browser_navigate unicaja.es', ...extra } });

test('isBrowserTool reconoce Playwright (workers) y browser_* (Guía)', () => {
  assert.equal(isBrowserTool('mcp__playwright__browser_click'), true);
  assert.equal(isBrowserTool('browser_navigate'), true);
  assert.equal(isBrowserTool('Read'), false);
  assert.equal(isBrowserTool('mcp__flow-test__flow_run'), false);
  assert.equal(hasDesktop({}, 'linux'), false);
  assert.equal(hasDesktop({ DISPLAY: ':1' }, 'linux'), true);
});

test('una tool de Playwright lanza la burbuja; otras tools no', () => {
  const { o, spawned } = setup();
  o.onActivity(tool('a1', 'Read'));
  assert.equal(spawned.length, 0);
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.some((a) => /^electron@\d+\.\d+\.\d+$/.test(a)), 'Electron con versión fija');
  assert.deepEqual(o.view().agents.map((a) => [a.name, a.taskCode, a.activity]), [['Berta', 'BA-5', 'Abriendo Unicaja']]);
  o.onActivity(tool('a1', 'mcp__playwright__browser_click'));
  assert.equal(spawned.length, 1, 'no abre otra ventana');
});

test('enseña las preguntas del agente que navega (no las de otros)', () => {
  const { o, qs } = setup();
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  qs.push({ id: 'q1', agentId: 'a1', agentName: 'Berta', taskCode: 'BA-5', question: '¿Ya has entrado?', options: ['Listo', 'Cancelar'], allowCustom: false, browser: true });
  qs.push({ id: 'q2', agentId: 'otro', agentName: 'Marcos', question: '¿Nombre del campo?', options: [], allowCustom: true });
  o.sync();
  assert.deepEqual(o.view().questions.map((q) => [q.id, q.browser, q.options]), [['q1', true, ['Listo', 'Cancelar']]]);
});

test('una pregunta de login en el navegador mete a su agente aunque aún no haya usado Playwright', () => {
  const { o, qs, spawned } = setup();
  qs.push({ id: 'q1', agentId: 'a1', agentName: 'Berta', taskId: 't1', taskCode: 'BA-5', question: 'Haz login', options: ['Listo'], browser: true });
  o.sync();
  assert.equal(spawned.length, 1);
  assert.equal(o.view().questions.length, 1);
});

test('se cierra al acabar la tarea y tras IDLE sin navegar (salvo pregunta abierta)', () => {
  const { o, qs, spawned, state, advance } = setup();
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  qs.push({ id: 'q1', agentId: 'a1', question: '¿Sigo?', options: ['Sí'] });
  advance(10 * 60_000); o.sync();
  assert.equal(o.view().agents.length, 1, 'con una pregunta abierta no caduca');
  qs.length = 0; o.sync();
  assert.equal(o.view().agents.length, 0, 'sin pregunta y sin navegar: fuera');
  assert.equal(spawned[0].killed, true);

  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  assert.equal(spawned.length, 2);
  qs.push({ id: 'q2', agentId: 'a1', taskId: 't1', question: 'Haz login', options: ['Listo'], browser: true });
  state.tasks[0].status = 'review'; o.sync();
  assert.equal(spawned[1].killed, true, 'tarea fuera de «doing»: se cierra aunque quede una pregunta');
});

test('AgentCompleted la cierra; el ✕ del usuario (salida 0) no la reabre hasta la próxima sesión de navegador', () => {
  const { o, spawned } = setup();
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  spawned[0].emit('exit', 0, null); // ✕
  o.onActivity(tool('a1', 'mcp__playwright__browser_click'));
  assert.equal(spawned.length, 1, 'ocultada: no vuelve en esta sesión');
  o.onActivity({ type: 'AgentCompleted', agentId: 'a1' });
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  assert.equal(spawned.length, 2, 'nueva sesión de navegador: vuelve');
});

test('el Guía navegando enseña sus confirmaciones 🛡; apagada no lanza nada', () => {
  const { o, qs } = setup();
  o.touch('guide', { activity: '🌐 browser_navigate' });
  qs.push({ id: 'c1', kind: 'confirm', agentId: null, agentName: 'Guide', question: '¿Envío el formulario?', options: ['Sí', 'No'], allowCustom: false });
  o.sync();
  assert.deepEqual(o.view().agents.map((a) => a.name), ['Guía']);
  assert.deepEqual(o.view().questions.map((q) => q.kind), ['confirm']);

  const off = setup({ enabled: false });
  off.o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  assert.equal(off.spawned.length, 0);
});

test('Electron caído (salida ≠ 0) no se relanza en bucle', () => {
  const { o, spawned, advance } = setup();
  o.onActivity(tool('a1', 'mcp__playwright__browser_navigate'));
  spawned[0].emit('exit', 1, null);
  o.onActivity(tool('a1', 'mcp__playwright__browser_click'));
  assert.equal(spawned.length, 1);
  advance(6 * 60_000);
  o.onActivity(tool('a1', 'mcp__playwright__browser_click'));
  assert.equal(spawned.length, 2, 'pasados 5 min lo reintenta');
});
