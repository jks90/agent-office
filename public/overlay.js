// 🫧 Burbuja del agente: pinta los agentes que usan el navegador y sus preguntas (SSE /overlay/events).
// En la ventana Electron (window.aoOverlay) ajusta el tamaño de la ventana al contenido y se pone al frente con cada pregunta.
const root = document.getElementById('root');
const host = window.aoOverlay || null;
const drafts = new Map(); // respuesta libre a medio escribir, por pregunta (sobrevive a los repintados)
const busy = new Set(); // preguntas con la respuesta en camino
const errors = new Map();
let view = { agents: [], questions: [] };
let seen = new Set();
let had = false; // ya ha habido algún agente (al conectar puede llegar vacía un instante)

const COLORS = ['#5b8def', '#e0784f', '#3fae7c', '#a06be0', '#d9577a', '#2fa3b8', '#c49a2c', '#6f7bd9'];
const colorOf = (s) => COLORS[[...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn); else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
};

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

async function reply(q, answer) {
  answer = String(answer || '').trim();
  if (!answer || busy.has(q.id)) return;
  busy.add(q.id); errors.delete(q.id); render();
  try { await post(`/api/questions/${q.id}/answer`, { answer }); drafts.delete(q.id); }
  catch (e) { errors.set(q.id, e.message); }
  busy.delete(q.id); render();
}

async function hide() {
  try { await post('/api/overlay/dismiss'); } catch { /* AgentOffice caído: se cierra igual */ }
  host?.close();
}

function questionBox(q) {
  const dis = busy.has(q.id);
  const free = q.allowCustom ? el('form', { class: 'free', on: { submit: (e) => { e.preventDefault(); reply(q, drafts.get(q.id)); } } },
    el('input', { 'data-qid': q.id, placeholder: q.options.length ? 'Otra respuesta…' : 'Tu respuesta…', value: drafts.get(q.id) || '', disabled: dis, on: { input: (e) => drafts.set(q.id, e.target.value) } }),
    el('button', { class: 'send', type: 'submit', disabled: dis }, 'Enviar')) : null;
  return el('div', { class: 'q' },
    el('p', { class: 'q-text' }, q.kind === 'confirm' ? `🛡 ${q.question}` : `❓ ${q.question}`),
    q.context ? el('p', { class: 'q-ctx' }, q.context) : null,
    q.browser ? el('button', { class: 'go', disabled: dis, on: { click: () => post('/api/browser/focus').catch(() => {}) } }, '🌐 Ir al navegador') : null,
    el('div', { class: 'opts' }, q.options.map((o) => el('button', { class: 'opt', disabled: dis, on: { click: () => reply(q, o) } }, o))),
    free,
    errors.has(q.id) ? el('div', { class: 'err' }, errors.get(q.id)) : null);
}

function agentCard(a, qs) {
  return el('div', { class: `card${qs.length ? ' asking' : ''}` },
    el('div', { class: 'agent', title: 'Arrastra para mover' },
      el('div', { class: 'avatar', style: `background:${colorOf(a.name)}` }, a.key === 'guide' ? '🧭' : (a.name[0] || '?').toUpperCase()),
      el('div', { class: 'who' },
        el('div', { class: 'name' }, a.name, a.taskCode ? el('small', {}, ` · ${a.taskCode}`) : null),
        el('div', { class: 'doing' }, qs.length ? 'Te está preguntando…' : a.activity || '🌐 Usando el navegador')),
      el('button', { class: 'x', title: 'Ocultar hasta la próxima vez', on: { click: hide } }, '✕')),
    qs.map(questionBox));
}

function render() {
  // Conserva el foco y el cursor de la respuesta libre al repintar
  const act = document.activeElement?.dataset?.qid ? { id: document.activeElement.dataset.qid, s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd } : null;
  const byAgent = (k) => view.questions.filter((q) => (k === 'guide' ? q.kind === 'confirm' : q.agentId === k));
  root.replaceChildren(...view.agents.map((a) => agentCard(a, byAgent(a.key))));
  if (act) { const i = root.querySelector(`input[data-qid="${act.id}"]`); if (i) { i.focus(); try { i.setSelectionRange(act.s, act.e); } catch { /* */ } } }
  requestAnimationFrame(() => host?.resize(root.offsetWidth, root.offsetHeight));
}

function connect() {
  let lost = 0;
  const es = new EventSource('/overlay/events');
  es.addEventListener('overlay', (e) => {
    lost = 0;
    view = JSON.parse(e.data);
    const ids = new Set(view.questions.map((q) => q.id));
    if ([...ids].some((id) => !seen.has(id))) host?.attention(); // pregunta nueva: al frente
    seen = ids;
    for (const id of [...drafts.keys()]) if (!ids.has(id)) drafts.delete(id);
    if (view.agents.length) had = true;
    else if (had) { es.close(); host?.close(); return; } // nadie navega ya: AgentOffice la cierra, y si no, se cierra ella
    render();
  });
  // AgentOffice reiniciado o apagado: la ventana no se queda huérfana encima de todo
  es.onerror = () => { if (++lost >= 15) { es.close(); host?.close(); } };
}

connect();
// Abierta sin nadie a quien enseñar (el agente acabó mientras arrancaba Electron): no se queda invisible encima de todo
setTimeout(() => { if (!had) host?.close(); }, 15_000);
