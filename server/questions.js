// Preguntas de los agentes al usuario: un agente que necesita una decisión del cliente (no se resuelve leyendo
// el código) lanza `bin/ao-ask.mjs`, que registra la pregunta aquí y espera la respuesta. La UI recibe la pregunta
// por SSE (va en el snapshot como `questions`), enseña un modal con las opciones (o respuesta libre) y la respuesta
// vuelve al comando, que la imprime para que el agente siga. Cada pregunta y su respuesta quedan en `task.questions`
// (se ven en el modal de la tarea y se repiten al agente si vuelve a intentarla, para que no pregunte dos veces).
import * as store from './store.js';
import * as events from './events.js';

const pending = new Map(); // id → { id, taskId, agentId, projectId, question, options, allowCustom, createdAt, waiters[] }
const MAX_OPEN_PER_TASK = 1;
const fail = (status, msg) => Object.assign(new Error(msg), { status });

export const list = () => [...pending.values()].map(({ waiters, ...q }) => q);

export function ask({ taskId, question, options = [], allowCustom = true, context = '' }) {
  const s = store.get();
  const t = s.tasks.find((x) => x.id === taskId || x.code === String(taskId || '').toUpperCase());
  if (!t) throw fail(404, 'Tarea no encontrada');
  if (t.status !== 'doing') throw fail(409, 'La tarea no está en curso');
  if (!String(question || '').trim()) throw fail(400, 'Falta la pregunta');
  if ([...pending.values()].filter((q) => q.taskId === t.id).length >= MAX_OPEN_PER_TASK) throw fail(429, 'Ya hay una pregunta pendiente de esta tarea: espera la respuesta');
  const agent = s.agents.find((a) => a.id === t.agentId);
  const q = {
    id: store.newId(), taskId: t.id, taskCode: t.code, agentId: t.agentId, agentName: agent?.name || '?', projectId: t.projectId,
    question: String(question).trim().slice(0, 2000), options: options.map((o) => String(o).trim().slice(0, 300)).filter(Boolean).slice(0, 8),
    allowCustom: allowCustom !== false, context: String(context || '').trim().slice(0, 4000), createdAt: Date.now(), waiters: [],
  };
  pending.set(q.id, q);
  if (agent) { agent.activity = `❓ Esperando tu respuesta: ${q.question.slice(0, 80)}`; }
  store.log(t.agentId, `❓ ${t.code || t.id} pregunta: ${q.question}${q.options.length ? ` [${q.options.join(' / ')}]` : ''}`);
  events.emit('AgentBlocked', events.ctxOf(t, agent), { questionId: q.id, question: q.question, options: q.options });
  store.changed();
  return { id: q.id };
}

// Espera (long-poll) hasta `ms`: { status: 'answered', answer } | { status: 'pending' } | { status: 'cancelled' }
export function wait(id, ms = 50_000) {
  const q = pending.get(id);
  if (!q) {
    const t = store.get().tasks.find((x) => (x.questions || []).some((qq) => qq.id === id));
    const done = t?.questions.find((qq) => qq.id === id);
    return Promise.resolve(done ? (done.answer == null ? { status: 'cancelled' } : { status: 'answered', answer: done.answer }) : { status: 'cancelled' });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { q.waiters = q.waiters.filter((w) => w !== resolve); resolve({ status: 'pending' }); }, ms);
    q.waiters.push((r) => { clearTimeout(timer); resolve(r); });
  });
}

function settle(q, answer) {
  pending.delete(q.id);
  const s = store.get();
  const t = s.tasks.find((x) => x.id === q.taskId);
  if (t) { (t.questions ||= []).push({ id: q.id, question: q.question, options: q.options, answer, askedAt: q.createdAt, answeredAt: Date.now() }); t.updatedAt = Date.now(); }
  const agent = s.agents.find((a) => a.id === q.agentId);
  if (agent?.taskId === q.taskId) agent.activity = answer == null ? 'Sigue trabajando' : `💬 Respondido: ${String(answer).slice(0, 60)} · sigue trabajando`;
  const ctx = { projectId: q.projectId, taskId: q.taskId, taskCode: q.taskCode, agentId: q.agentId };
  if (answer != null) events.emit('UserInstructionAdded', ctx, { kind: 'answer', questionId: q.id, text: String(answer).slice(0, 500) });
  if (agent?.taskId === q.taskId) events.emit('AgentResumed', ctx, { reason: answer == null ? 'question-cancelled' : 'answered', questionId: q.id });
  const res = answer == null ? { status: 'cancelled' } : { status: 'answered', answer };
  for (const w of q.waiters) w(res);
  q.waiters = [];
  store.changed();
}

export function answer(id, text) {
  const q = pending.get(id);
  if (!q) throw fail(404, 'Esa pregunta ya no está pendiente');
  const a = String(text ?? '').trim();
  if (!a) throw fail(400, 'La respuesta está vacía');
  store.log(q.agentId, `💬 Tu respuesta a ${q.taskCode || q.taskId}: ${a}`);
  settle(q, a.slice(0, 4000));
  return { ok: true };
}

// La tarea termina o se para: lo que quedara pendiente se cancela (el comando del agente lo ve como «sin respuesta»).
export function cancelForTask(taskId) {
  for (const q of [...pending.values()]) if (q.taskId === taskId) settle(q, null);
}
