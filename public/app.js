const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { projects: [], agents: [], tasks: [], settings: {}, roles: {}, engines: [] };
let projectId = safeGet('ao:project');
let drawerAgent = null;
let openTaskId = null; // tarea abierta en el modal «Ver la tarea» (FT-2)
let hostCtx = null, ctxTimer = null, ctxSent = ""; // hostFeatures: lo que el flow-test que nos embebe sabe hacer (p. ej. 'settingsPanel', FT-42)
let hostFeatures = []; // publicación del contexto (FT-2)
const logs = new Map();
const activityByAgent = new Map(); // FT-68: Activity Stream por agente para la ficha operativa.
const statusSinceByAgent = new Map();
const activityLoaded = new Set();

import { Office } from './office3d.js';
import { dictationSupported, createDictation, insertAtCursor } from './dictation.js'; // dictado por voz (FT-43)
const office = new Office($('#office'), { onAgentClick: (id) => enterAgent(id), onFloorClick: (id) => enterFloor(id) }); // clic planta/agente → navegación continua (FT-47/FT-71)
window.aoOffice = office; // para QA: aoOffice.debugState() / setMode() (FT-46)

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

// Base de la app: '/' en solitario o '/agents/' cuando flow-test la proxea como plugin de la suite.
const BASE = new URL('.', location.href).pathname;
async function api(method, url, body) {
  const r = await fetch(BASE + url.replace(/^\//, ''), { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.gated === 'suite') { if (j.suite) S.suite = j.suite; renderSuite(); }
    toast(j.error || r.statusText, 'error');
    throw new Error(j.error);
  }
  return j;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3000);
}

// ── Tiempo real ─────────────────────────────────────────────────────────────
// El EventSource reconecta solo ante cortes de red, pero un error HTTP (p. ej. el 502 del proxy de flow-test mientras
// el servidor se reinicia) lo cierra para siempre: aquí se vuelve a abrir con espera creciente para que la vista no se
// quede congelada. Al reconectar llegan `state` y `logs` completos, así que no se pierde nada.
let esRetry = 1000;
let settingsEmbedOpened = false;
function connectEvents() {
  const es = new EventSource(BASE + 'events');
  es.addEventListener('open', () => { esRetry = 1000; });
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    if (!S.projects.some((p) => p.id === projectId)) projectId = S.projects[0]?.id ?? null;
    render();
    renderQuestions();
    if (!officeInit) { officeInit = true; if (activeTab === 'office') applyOfficeDefault(); } // FT-47
    if (SETTINGS_EMBED && !settingsEmbedOpened) { settingsEmbedOpened = true; openSettingsEmbed(); }
  });
  es.addEventListener('logs', (e) => {
    for (const [id, arr] of Object.entries(JSON.parse(e.data))) logs.set(id, arr);
    if (drawerAgent) renderLog();
  });
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    const arr = logs.get(entry.agentId) || [];
    arr.push(entry);
    if (arr.length > 400) arr.shift();
    logs.set(entry.agentId, arr);
    if (drawerAgent === entry.agentId) renderLog();
  });
  es.addEventListener('activity', (e) => {
    const ev = JSON.parse(e.data);
    rememberActivity(ev);
    if (drawerAgent === ev.agentId) renderDrawer();
  });
  // Órdenes del Guide Agent (FT-4): llegan por SSE `ui` (navegar, abrir tarea/agente, enseñar un flow en flow-test).
  es.addEventListener('ui', (e) => {
    const c = JSON.parse(e.data);
    if (c.client && c.client !== CLIENT_ID) return; // dirigida a otra pestaña
    if ($('#dialog').open && c.type !== 'flowtest.show') $('#dialog').close();
    // Con proyecto y vista Oficina se entra directo a su planta (FT-47); sin proyecto se respeta el modo que haya.
    if (c.type === 'navigate' && c.view === 'office') { showTab('office'); goProject(c.projectId); if (c.projectId && S.projects.some((p) => p.id === c.projectId)) setOfficeMode('floor'); }
    else if (c.type === 'navigate') { goProject(c.projectId); showTab(c.view); }
    else if (c.type === 'openTask') { const t = S.tasks.find((x) => x.id === c.taskId); if (t) { goProject(t.projectId); showTab('tasks'); openTask(t.id); } }
    else if (c.type === 'selectAgent') { showTab('agents'); openDrawer(c.agentId); }
    else if (c.type === 'flowtest.show') {
      const p = projectOfFlow(c.flow);   // el flow vive en la carpeta de un proyecto: la oficina pasa a su planta (FT-47)
      if (p) enterFloor(p.id);
      if (EMBEDDED) window.parent.postMessage({ type: 'agentoffice:navigate', flow: c.flow, node: c.node || undefined }, location.origin); // lo que escucha AgentsPanel.tsx (FT-3)
    }
  });
  es.addEventListener('error', () => {
    if (es.readyState !== EventSource.CLOSED) return; // CONNECTING: el navegador ya reintenta solo
    setTimeout(connectEvents, esRetry);
    esRetry = Math.min(esRetry * 2, 15000);
  });
}
connectEvents();

const project = () => S.projects.find((p) => p.id === projectId);
const team = () => { const ids = new Set(project()?.team || []); return S.agents.filter((a) => ids.has(a.id)); };
const bench = () => { const ids = new Set(project()?.team || []); return S.agents.filter((a) => !ids.has(a.id)); };
const projectsOf = (agentId) => S.projects.filter((p) => (p.team || []).includes(agentId) && p.id !== projectId).map((p) => p.name);
const tasks = () => S.tasks.filter((t) => t.projectId === projectId);
function goProject(id) { if (id && S.projects.some((p) => p.id === id) && id !== projectId) { projectId = id; safeSet('ao:project', id); closeDrawer(); } } // closeDrawer repinta
// Proyecto al que pertenece un flow del workspace: su carpeta de primer nivel (como en team.js: sin carpeta → «default»).
function projectOfFlow(flow) {
  if (!flow) return null;
  const parts = String(flow).replace(/^\.?\//, '').split('/').filter(Boolean);
  const folder = parts.length > 1 ? parts[0] : 'default';
  return S.projects.find((p) => p.folder === folder) || null;
}

// ── Edificio ↔ planta (FT-47) ───────────────────────────────────────────────
// La Oficina abre como EDIFICIO (una planta por proyecto con equipo, FT-46); un clic en una planta, el Guide o flow-test
// entran en la sala de ese proyecto (`floor`), y «🏢 Edificio» / Esc vuelven. El último modo se recuerda en el navegador.
let officeMode = safeGet('ao:officeMode') === 'floor' ? 'floor' : 'building';
let officeLevel = officeMode; // FT-71: building → floor → agent, publicado para el Guide.
let officeInit = false; // el modo por defecto se decide con el primer estado (hace falta saber cuántos proyectos tienen equipo)
const teamProjects = () => S.projects.filter((p) => (p.team || []).length);
function setOfficeMode(mode, { remember = true } = {}) {
  officeMode = mode === 'floor' ? 'floor' : 'building';
  officeLevel = officeMode;
  if (officeMode === 'building' && drawerAgent) { drawerAgent = null; $('#drawer').hidden = true; }
  if (remember) safeSet('ao:officeMode', officeMode);
  office.setMode(officeMode);
  renderOfficeFoot();
  publishContext();
}
function enterFloor(id) { goProject(id); setOfficeMode('floor'); }
function enterAgent(id) {
  const a = S.agents.find((x) => x.id === id);
  const p = S.projects.find((x) => (x.team || []).includes(id));
  if (p) goProject(p.id);
  if (!a) return;
  officeMode = 'floor';
  officeLevel = 'agent';
  safeSet('ao:officeMode', 'floor');
  office.focusAgent(id);
  openDrawer(id, { skipFocus: true });
  renderOfficeFoot();
  publishContext();
}
function leaveAgentLevel() {
  if (officeLevel !== 'agent') return false;
  officeLevel = 'floor';
  office.clearAgentFocus?.();
  closeDrawer({ keepOfficeLevel: true });
  $('#office').focus({ preventScroll: true });
  renderOfficeFoot();
  publishContext();
  return true;
}
// Al abrir la pestaña Oficina: con UN solo proyecto con equipo se entra directo a su planta; si no, el último modo (edificio de serie).
function applyOfficeDefault() {
  const tp = teamProjects();
  if (tp.length === 1) { goProject(tp[0].id); setOfficeMode('floor', { remember: false }); }
  else setOfficeMode(officeMode, { remember: false });
}
// Pie de la vista Oficina: miga «🏢 Edificio › proyecto» (el botón vuelve al edificio) y la línea de actividad.
function renderOfficeFoot() {
  const p = project();
  const a = S.agents.find((x) => x.id === drawerAgent);
  $('#office-crumb').innerHTML = officeLevel === 'agent'
    ? `<button class="small ghost" data-action="building" title="Volver al edificio">🏢 Edificio</button><span class="sep">›</span><button class="small ghost" data-action="office-floor" title="Volver a la planta (Esc)">${esc(p?.name || 'Planta')}</button><span class="sep">›</span><b>${esc(a?.name || 'Agente')}</b>`
    : officeMode === 'floor'
    ? `<button class="small ghost" data-action="building" title="Volver al edificio (Esc con la oficina enfocada)">🏢 Edificio</button><span class="sep">›</span><b>${esc(p?.name || '')}</b>`
    : '<span class="here">🏢 Edificio</span>';
  const live = $('#office-live');
  if (officeLevel === 'agent' && a) {
    live.textContent = `${a.name}: ${a.activity || statusMeta(a).label} · ficha operativa abierta`;
  } else if (officeMode === 'floor') {
    const working = team().filter((a) => a.status === 'working');
    live.textContent = working.length ? working.map((a) => `${a.name}: ${a.activity}`).join('  ·  ') : 'Nadie está trabajando ahora mismo';
  } else {
    const tp = teamProjects(), ids = new Set(tp.flatMap((x) => x.team));
    const working = S.agents.filter((a) => ids.has(a.id) && a.status === 'working').length;
    live.textContent = tp.length ? `${tp.length} proyecto${tp.length === 1 ? '' : 's'} con equipo · ${working} trabajando · clic en una planta para entrar` : 'Ningún proyecto tiene equipo todavía: ficha agentes en 👥 Agentes';
  }
}
// Esc con la oficina enfocada vuelve al edificio (si hay cajón abierto, lo cierra el atajo de siempre).
$('#office').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#dialog').open) return;
  if (leaveAgentLevel()) { e.stopPropagation(); return; }
  if (officeMode !== 'floor' || drawerAgent) return;
  e.stopPropagation();
  setOfficeMode('building');
});
// «Nació de: flow X · nodo Y» (FT-7): el contexto que el usuario tenía delante al pedir la tarea. El enlace pide a flow-test
// (flowtest.show) que lo enseñe; sin flow-test cae a la tarea/agente/vista de AgentOffice.
const bornFrom = (t) => {
  const c = t.context, h = c?.host;
  if (!c) return '';
  if (h?.flow || h?.filePath) {
    const name = h.flow || h.filePath;
    return `<a class="born" href="#" data-born="${esc(h.filePath || h.flow)}" data-born-node="${esc(h.node || '')}" title="Abrir en flow-test${h.consoleTail?.length ? ' · consola: ' + esc(h.consoleTail.slice(-3).join(' ⏎ ')) : ''}">↗ Nació de: flow ${esc(name)}${h.node ? ` · nodo ${esc(h.nodeLabel || h.node)}` : ''}</a>`;
  }
  const what = c.taskCode ? `tarea ${c.taskCode}` : c.agentId ? `agente ${S.agents.find((a) => a.id === c.agentId)?.name || c.agentId}` : c.view ? `vista ${c.view}` : '';
  return what ? `<span class="born" title="Contexto de AgentOffice al crearla">Nació de: ${esc(what)}</span>` : '';
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-born]');
  if (!a) return;
  e.preventDefault();
  fetch(BASE + 'api/guide/tool', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT_ID }, body: JSON.stringify({ name: 'flowtest.show', args: { flow: a.dataset.born, ...(a.dataset.bornNode ? { node: a.dataset.bornNode } : {}) } }) })
    .then(() => { if (!EMBEDDED) toast('Ábrelo desde flow-test (Config ▸ Agentes) para que lo enseñe'); }).catch(() => {});
});
const roleChip = (role) => `<span class="chip" style="--c:${S.roles[role]?.color}">${esc(S.roles[role]?.label || role)}</span>`;

// ── Guía 🧭 (FT-6) ──────────────────────────────────────────────────────────
// Chat con el Guide Agent (server/guide). Un solo estado `G` pintado en dos sitios: la vista «Guía» (con lista de chats)
// y un cajón flotante disponible en cualquier vista (Ctrl+G). La conversación va por POST /api/guide/chat (SSE); las
// confirmaciones de las tools salen por el modal de preguntas de siempre (snapshot SSE), no por aquí.
const EMBEDDED = window.self !== window.top; // antes que el Guía: guideRender → wakeSync → wakeNotify lo lee al arrancar (FT-38)
const SETTINGS_EMBED = EMBEDDED && new URLSearchParams(location.search).get('embed') === 'settings'; // FT-42: la vista «Ajustes» sola, para el panel tipo Cmd de flow-test
const G = { chats: [], chatId: null, messages: [], busy: false, panelOpen: false, loaded: false };
const guideRoots = []; // contenedores montados: { el, panel }
const GUIDE_HINTS = ['Créame una tarea para solucionar esto', '¿Cómo va?', '¿Qué está haciendo ahora mismo?', 'Enséñame lo que ha cambiado'];

function guideMount(el, panel) {
  if (guideRoots.some((r) => r.el === el)) return;
  el.innerHTML = `<div class="guide ${panel ? 'panel' : ''}">
    <div class="g-list" tabindex="0" title="↑/↓ cambian de chat · Supr borra · Ctrl+N nuevo"><div class="g-lhead"><button class="small" data-g="new" title="Nuevo chat (Ctrl+N)">＋<span class="g-lbl"> Nuevo chat</span></button><button class="ghost small g-fold" data-g="fold"></button></div><div class="g-chats"></div><button class="ghost small g-delall" data-g="delall">Borrar todos…</button></div>
    <div class="g-grip" title="Arrastra para ensanchar · doble clic = ancho por defecto"></div>
    <div class="g-main">
      <div class="g-head"><b class="g-title">🧭 Guía</b><button class="ghost small g-ear" data-g="ear" hidden></button><span class="g-pickbar"><select class="g-pick" title="Chats"></select><button class="ghost small" data-g="new">＋</button><button class="ghost small g-pdel" data-g="delcur" title="Borrar este chat">🗑</button></span>${panel ? '<button class="ghost small" data-g="close" title="Cerrar (Ctrl+G)">✕</button>' : ''}</div>
      <div class="g-msgs"></div>
      <div class="g-voice" hidden><span class="g-vtxt"></span><i class="g-vlevel"></i></div>
      <form class="g-form"><button type="button" class="ghost g-mic" data-g="mic" title="Mantén pulsado para hablar (o barra espaciadora con la caja vacía)">🎤</button><textarea rows="1" placeholder="Pídeme algo…" title="Intro envía · Mayús+Intro salto de línea · barra espaciadora con la caja vacía = hablar"></textarea><button class="g-send">Enviar</button><button type="button" class="ghost g-stop" data-g="stop" hidden>■ Parar</button></form>
    </div></div>`;
  guideRoots.push({ el, panel });
  const ta = el.querySelector('textarea');
  el.querySelector('form').onsubmit = (e) => { e.preventDefault(); const t = ta.value.trim(); if (t && !G.busy) { ta.value = ''; ta.style.height = ''; guideSend(t); } };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.querySelector('form').requestSubmit(); } });
  // Voz (FT-9): mantener 🎤, o la barra espaciadora con la caja vacía
  const mic = el.querySelector('.g-mic');
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) mic.addEventListener(ev, () => voiceHold(false));
  mic.addEventListener('pointerdown', (e) => { e.preventDefault(); voiceHold(true, el); });
  const spaceKey = (e) => e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
  ta.addEventListener('keydown', (e) => { if (spaceKey(e) && !ta.value.trim()) { e.preventDefault(); if (!e.repeat) voiceHold(true, el); } });
  ta.addEventListener('keyup', (e) => { if (e.key === ' ' && V.holding) { e.preventDefault(); voiceHold(false); } });
  mic.addEventListener('keydown', (e) => { if (spaceKey(e)) { e.preventDefault(); if (!e.repeat) voiceHold(true, el); } });
  mic.addEventListener('keyup', (e) => { if (e.key === ' ') voiceHold(false); });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g], [data-gchat], [data-gdel], [data-ghint]');
    if (!b) return;
    if (b.dataset.g === 'new') guideNew();
    else if (b.dataset.g === 'fold') guideFold();
    else if (b.dataset.g === 'delall') guideDeleteAll();
    else if (b.dataset.g === 'delcur') { if (G.chatId) guideDelete(G.chatId); }
    else if (b.dataset.gdel) guideDelete(b.dataset.gdel);
    else if (b.dataset.g === 'stop') guideStop();
    else if (b.dataset.g === 'close') guideToggle(false);
    else if (b.dataset.g === 'ear') wakeSet(false);
    else if (b.dataset.g === 'play') ttsSpeak(G.messages[b.dataset.i]?.text, Number(b.dataset.i));
    else if (b.dataset.gchat) guideOpen(b.dataset.gchat).then(() => el.querySelector('.g-chat.sel')?.focus()); // el pintado rehace la lista: se devuelve el foco para el teclado (FT-51)
    else if (b.dataset.ghint) { ta.value = b.dataset.ghint; ta.focus(); }
  });
  el.addEventListener('toggle', (e) => { const d = e.target.closest?.('.g-tool'); if (d && G.messages[d.dataset.i]) G.messages[d.dataset.i].open = d.open; }, true); // el pintado rehace el HTML: recordar qué tool call está desplegada
  // Lista de chats (FT-51): tirador (ratón y dedo) y teclado
  const grip = el.querySelector('.g-grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = GL.w;
    const move = (ev) => guideListWidth(w0 + ev.clientX - x0);
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); safeSet('ao:guideListW', String(GL.w)); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { guideListWidth(220); safeSet('ao:guideListW', '220'); });
  el.querySelector('.g-list').addEventListener('keydown', async (e) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'n') { e.preventDefault(); guideNew(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const i = G.chats.findIndex((c) => c.id === G.chatId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = G.chats[e.key === 'ArrowDown' ? Math.min(G.chats.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next && next.id !== G.chatId) await guideOpen(next.id);
      el.querySelector('.g-chat.sel')?.focus();
    } else if (e.key === 'Delete' && i >= 0) { e.preventDefault(); await guideDelete(G.chatId); el.querySelector('.g-list').focus(); }
  });
  el.querySelector('.g-pick')?.addEventListener('change', (e) => (e.target.value ? guideOpen(e.target.value) : guideNew()));
  guideRender();
}

function guideRender() {
  const fab = $('#guide-fab');
  fab.hidden = activeTab === 'guide' || G.panelOpen;
  fab.classList.toggle('busy', G.busy);
  for (const { el, panel } of guideRoots) {
    if (panel && $('#guide-panel').hidden) continue;
    const msgs = el.querySelector('.g-msgs');
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    msgs.innerHTML = G.messages.length ? G.messages.map((m, i) => guideMsg(m, i)).join('') + (G.busy ? '<div class="g-typing">🧭 trabajando…</div>' : '')
      : `<div class="g-empty"><h3>🧭 Guía</h3><p>Entiendo lo que estás viendo y puedo crear tareas, contarte cómo van, pararlas o enseñarte lo que han cambiado.</p><div class="g-hint">${GUIDE_HINTS.map((h) => `<button data-ghint="${esc(h)}">${esc(h)}</button>`).join('')}</div></div>`;
    if (atBottom || G.busy) msgs.scrollTop = msgs.scrollHeight;
    const cur = G.chats.find((c) => c.id === G.chatId);
    el.querySelector('.g-title').textContent = panel ? '🧭' : '🧭 ' + (cur?.title || 'Nuevo chat');
    const lock = (c) => c.busy || (G.busy && c.id === G.chatId); // un turno en curso no se borra
    el.querySelector('.g-chats').innerHTML = G.chats.map((c) => `<div class="g-row ${c.id === G.chatId ? 'sel' : ''}"><button class="g-chat ${c.id === G.chatId ? 'sel' : ''}" data-gchat="${c.id}" title="${esc(c.title)}${c.updatedAt ? ' · ' + esc(new Date(c.updatedAt).toLocaleString()) : ''}">${c.busy ? '⏳ ' : ''}${esc(c.title)}</button><button class="ghost g-del" data-gdel="${c.id}" ${lock(c) ? 'disabled' : ''} title="${lock(c) ? 'Hay un turno en curso: espera o pulsa «Parar»' : 'Borrar este chat'}">🗑</button></div>`).join('') || '<p class="muted small">Sin chats todavía</p>';
    el.querySelector('.g-list').classList.toggle('min', GL.min);
    const fold = el.querySelector('.g-fold');
    fold.textContent = GL.min ? '▶' : '◀'; fold.title = GL.min ? 'Expandir la lista' : 'Plegar la lista';
    el.querySelector('.g-delall').disabled = !G.chats.length;
    const pdel = el.querySelector('.g-pdel');
    pdel.disabled = !cur || lock(cur); pdel.title = cur && lock(cur) ? 'Hay un turno en curso: espera o pulsa «Parar»' : 'Borrar este chat';
    const pick = el.querySelector('.g-pick');
    if (pick) pick.innerHTML = `<option value="">＋ Nuevo chat</option>${G.chats.map((c) => `<option value="${c.id}" ${c.id === G.chatId ? 'selected' : ''}>${esc(c.title.slice(0, 40))}</option>`).join('')}`;
    el.querySelector('.g-send').hidden = G.busy;
    el.querySelector('.g-stop').hidden = !G.busy;
    el.querySelector('textarea').disabled = G.busy;
    const mic = el.querySelector('.g-mic'), vbar = el.querySelector('.g-voice'), mine = V.root === el && V.state !== 'idle';
    mic.disabled = G.busy || (V.state !== 'idle' && !mine);
    mic.classList.toggle('rec', mine && V.state === 'rec');
    vbar.hidden = !mine;
    vbar.firstChild.textContent = V.state === 'rec' ? '🔴 Te escucho… suelta para enviar (o corto solo tras un silencio)' : V.state === 'stt' ? '⏳ Transcribiendo… puedes seguir usando la aplicación' : '';
  }
  wakeSync(); // la escucha continua depende de G.busy y V.state (FT-36)
}

function guideMsg(m, i) {
  if (m.role === 'user') return `<div class="g-msg user">${esc(m.text)}</div>`;
  if (m.role === 'assistant') return `<div class="g-msg assistant">${md(m.text)}${ttsButton(i, m.text)}</div>`;
  if (m.role === 'meta') return `<div class="g-meta" title="${esc(m.provider || '')}">${esc(m.model || m.provider || '')}${m.costUsd != null ? ` · ≈ ${m.costUsd.toFixed(4)} $` : ''}${m.usage ? ` · ${m.usage.input + m.usage.cacheRead + m.usage.cacheWrite} tok entrada${m.usage.cacheRead ? ` (${m.usage.cacheRead} en caché)` : ''} / ${m.usage.output} salida` : ''}</div>`;
  if (m.role === 'error') return `<div class="g-msg error ${m.stopped ? 'stopped' : ''}">${m.stopped ? '■ ' : '⚠ '}${esc(m.text)}</div>`;
  const state = m.ok == null ? '<span class="st">⏳</span>' : m.ok ? '<span class="st ok">✓</span>' : '<span class="st bad">✗</span>';
  const args = Object.keys(m.args || {}).length ? JSON.stringify(m.args) : '';
  return `<details class="g-tool" data-i="${i}" ${m.open ? 'open' : ''}><summary>🔧 <b>${esc(m.name)}</b><span class="args">${esc(args.slice(0, 120))}</span>${state}</summary>
    <pre>${esc(JSON.stringify(m.args || {}, null, 1))}</pre>${m.result != null ? `<pre class="${m.ok ? '' : 'bad'}">${esc(m.result.slice(0, 4000))}</pre>` : ''}</details>`;
}

const guideGone = new Set(); // ids borrados: una carga de la lista en vuelo no los resucita (FT-51)
async function guideRefresh() { try { G.chats = (await api('GET', '/api/guide/chats')).filter((c) => !guideGone.has(c.id)); } catch { /* sin servidor */ } G.loaded = true; guideRender(); }
async function guideOpen(id) {
  if (G.busy) return toast('Espera a que el Guía termine o pulsa «Parar»');
  ttsStop(); G.chatId = id; safeSet('ao:guide-chat', id);
  try { G.messages = (await api('GET', `/api/guide/chats/${id}`)).messages; } catch { G.chatId = null; G.messages = []; }
  guideRender();
}
// Lista de chats (FT-51): ancho y plegado se recuerdan en localStorage
const GL = { w: 220, min: safeGet('ao:guideListMin') === '1' };
function guideListWidth(w) { GL.w = Math.max(160, Math.min(480, Math.round(w) || 220)); document.documentElement.style.setProperty('--g-list-w', GL.w + 'px'); }
guideListWidth(Number(safeGet('ao:guideListW')) || 220);
function guideFold() { GL.min = !GL.min; safeSet('ao:guideListMin', GL.min ? '1' : '0'); guideRender(); }
async function guideDelete(id) {
  const c = G.chats.find((x) => x.id === id);
  if (!c) return;
  if (c.busy || (G.busy && id === G.chatId)) return toast('Hay un turno en curso: espera o pulsa «Parar»');
  if (!confirm(`¿Borrar «${c.title}»?`)) return;
  try { await api('DELETE', `/api/guide/chats/${id}`); } catch (e) { return toast(e.message || 'No se pudo borrar', 'err'); }
  guideGone.add(id); G.chats = G.chats.filter((x) => x.id !== id);
  if (id === G.chatId) { ttsStop(); G.chatId = null; G.messages = []; safeSet('ao:guide-chat', ''); }
  guideRender();
}
async function guideDeleteAll() {
  const del = G.chats.filter((c) => !c.busy && !(G.busy && c.id === G.chatId));
  if (!del.length) return toast('No hay chats que se puedan borrar ahora');
  if (!confirm(`¿Borrar ${del.length === G.chats.length ? 'todos los chats' : `${del.length} chats (los que tienen un turno en curso se conservan)`}? No se puede deshacer.`)) return;
  for (const c of del) { try { await api('DELETE', `/api/guide/chats/${c.id}`); } catch { /* ya no existía */ } }
  const ids = new Set(del.map((c) => c.id));
  ids.forEach((i) => guideGone.add(i));
  G.chats = G.chats.filter((c) => !ids.has(c.id));
  if (ids.has(G.chatId)) { G.chatId = null; G.messages = []; safeSet('ao:guide-chat', ''); }
  guideRender();
}
function guideNew() { if (G.busy) return; ttsStop(); G.chatId = null; G.messages = []; safeSet('ao:guide-chat', ''); guideRender(); guideRoots.forEach((r) => r.el.querySelector('textarea').focus()); }
async function guideShow() {
  if (!T.info) ttsInfoLoad();
  guideMount($('#view-guide'), false);
  if (!G.loaded) { await guideRefresh(); const last = safeGet('ao:guide-chat'); if (last && !G.chatId && G.chats.some((c) => c.id === last)) await guideOpen(last); }
  guideRender();
  requestAnimationFrame(() => $('#view-guide textarea')?.focus());
}
function guideToggle(open = !G.panelOpen) {
  if (activeTab === 'guide') { $('#view-guide textarea')?.focus(); return; }
  G.panelOpen = open;
  if (!open) ttsStop();
  const p = $('#guide-panel');
  p.hidden = !open;
  if (open) { guideMount(p, true); guideShow().then(() => p.querySelector('textarea')?.focus()); }
  guideRender();
}
$('#guide-fab').addEventListener('click', (e) => { if (e.target.closest('.fab-ear')) wakeSet(false); else guideToggle(true); }); // la marca 👂 apaga la escucha (FT-36)
document.addEventListener('keydown', (e) => { if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); guideToggle(); } });

async function guideSend(text) {
  voiceSpeak(null); // callar lo que estuviera leyendo (FT-9)
  let said = '';
  G.busy = true;
  G.messages.push({ role: 'user', text });
  guideRender();
  const push = (m) => { G.messages.push(m); guideRender(); };
  try {
    const r = await fetch(BASE + 'api/guide/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT_ID }, body: JSON.stringify({ chatId: G.chatId, text }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); push({ role: 'error', text: j.error || r.statusText }); return; }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).match(/^data: (.*)$/m); buf = buf.slice(i + 2);
        if (!data) continue;
        const ev = JSON.parse(data[1]);
        if (ev.type === 'chat') { G.chatId = ev.chat.id; safeSet('ao:guide-chat', G.chatId); guideRefresh(); }
        else if (ev.type === 'text') { said += (said ? '\n' : '') + ev.text; push({ role: 'assistant', text: ev.text }); }
        else if (ev.type === 'tool_call') push({ role: 'tool', id: ev.id, name: ev.name, args: ev.args, ok: null, result: null });
        else if (ev.type === 'tool_result') { const m = G.messages.findLast((x) => x.role === 'tool' && x.id === ev.id); if (m) { m.ok = ev.ok; m.result = ev.result; } guideRender(); }
        else if (ev.type === 'done' && (ev.costUsd != null || ev.usage)) push({ role: 'meta', provider: ev.provider, model: ev.model, costUsd: ev.costUsd ?? null, usage: ev.usage || null });
        else if (ev.type === 'error') push({ role: 'error', text: ev.error, stopped: !!ev.stopped });
      }
    }
  } catch (e) { push({ role: 'error', text: 'Se cortó la conexión con el servidor: ' + e.message }); }
  finally { G.busy = false; guideRender(); guideRefresh(); voiceSpeak(said); }
}
function guideStop() { if (G.chatId) api('POST', '/api/guide/stop', { chatId: G.chatId }); }

// ── Voz del Guía 🎤 (FT-9) ───────────────────────────────────────────────────
// Push-to-talk: mantener 🎤 (o la barra espaciadora con la caja vacía) → MediaRecorder + VAD en el cliente → POST /api/guide/stt →
// el texto entra en la caja y se envía por el MISMO camino que el teclado (guideSend), salvo «revisar antes de enviar».
// La transcripción es una petición normal: la UI no se bloquea. TTS opcional con speechSynthesis (apagado por defecto).
const V = { state: 'idle', holding: false, wantStop: false, rec: null, root: null }; // state: idle | rec | stt
const VAD = { threshold: 0.02, silenceMs: 700, maxMs: 30000, minMs: 300 }; // RMS del AnalyserNode; corta tras 700 ms de silencio, tope 30 s
const voicePref = { review: () => safeGet('ao:voice-review') === '1', tts: () => safeGet('ao:voice-tts') === '1', wake: () => safeGet('ao:voice-wake') === '1' };

// Graba hasta stop() o hasta que el VAD vea silencio tras haber oído voz. → { stop, result: Promise<{blob, mime, spoke, ms}> }
// opts (escucha continua, FT-36): stream = micro ya abierto (no se cierra aquí) · maxMs = tope del segmento · gate = no graba
// nada hasta oír voz (el silencio no se captura); si se para antes de oírla, resuelve con spoke=false.
async function voiceRecord(onLevel, opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Este navegador no puede grabar audio (¿http sin localhost?)');
  const stream = opts.stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const maxMs = opts.maxMs || VAD.maxMs;
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const ac = new AudioContext(), an = ac.createAnalyser();
  an.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now();
  let spoke = false, lastVoice = t0, stopped = false, started = false, t1 = t0, resolve, timer;
  const result = new Promise((r) => { resolve = r; });
  const finish = () => { if (!opts.stream) stream.getTracks().forEach((t) => t.stop()); ac.close().catch(() => {}); resolve({ blob: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), mime: rec.mimeType || 'audio/webm', spoke, ms: performance.now() - t1 }); };
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); if (rec.state !== 'inactive') rec.stop(); else finish(); };
  rec.onstop = finish;
  timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const rms = Math.sqrt(sum / buf.length), now = performance.now();
    if (rms > VAD.threshold) { spoke = true; lastVoice = now; }
    if (opts.gate && !started) { if (!spoke) return; started = true; t1 = now; rec.start(); } // primera voz: empieza el segmento
    onLevel?.(rms);
    if ((spoke && now - lastVoice > VAD.silenceMs) || now - t1 > maxMs) stop();
  }, 50);
  if (!opts.gate) rec.start();
  return { stop, result };
}
const blobB64 = (blob) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = ko; r.readAsDataURL(blob); });
const voiceTranscribe = async (r) => api('POST', '/api/guide/stt', { audio: await blobB64(r.blob), mime: r.mime, lang: S.settings.sttLang || 'es' });
const voiceLevel = (rms) => guideRoots.forEach((r) => r.el.querySelector('.g-vlevel')?.style.setProperty('--lv', Math.min(1, rms * 8).toFixed(2)));

// on=true empieza a grabar en el chat `el`; on=false lo termina (soltar 🎤 / espacio) y manda el audio a transcribir.
async function voiceHold(on, el) {
  if (!on) { V.holding = false; V.wantStop = true; V.rec?.stop(); return; }
  if (V.state !== 'idle' || G.busy) return;
  V.holding = true; V.wantStop = false; V.state = 'rec'; V.root = el;
  voiceSpeak(null);
  guideRender();
  try { V.rec = await voiceRecord(voiceLevel); }
  catch (e) { V.state = 'idle'; V.holding = false; guideRender(); return toast(/Permission|NotAllowed/i.test(e.name + e.message) ? 'Sin permiso de micrófono: concédelo al sitio en el navegador' : 'No puedo usar el micrófono: ' + e.message, 'error'); }
  if (V.wantStop) V.rec.stop(); // soltó antes de que el navegador diera el micro
  const r = await V.rec.result;
  V.rec = null; V.holding = false;
  if (r.ms < VAD.minMs) { V.state = 'idle'; guideRender(); return; }
  V.state = 'stt'; guideRender();
  let text = '';
  try { text = (await voiceTranscribe(r)).text; } catch { /* api() ya mostró el toast */ V.state = 'idle'; guideRender(); return; }
  V.state = 'idle';
  guideRender();
  if (!text) return toast('No te he oído: prueba otra vez');
  voiceDeliver(text, V.root);
}
// El texto dictado entra en la caja y sigue el camino del teclado (o espera revisión). Lo comparten el push-to-talk y «oye guía».
function voiceDeliver(text, root) {
  const ta = root.querySelector('textarea');
  ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + text;
  ta.dispatchEvent(new Event('input'));
  if (voicePref.review() || G.busy) ta.focus(); // el usuario corrige y pulsa Intro
  else root.querySelector('form').requestSubmit();
}

// ── Escucha continua «oye guía» (FT-36) ──────────────────────────────────────
// Apagada por defecto (ao:voice-wake). Con ella activa el micro está abierto y el RMS se analiza en local; solo se graba un
// segmento cuando hay voz (corte por silencio o a 2,5 s) y SOLO ese segmento va a /api/guide/wake. El silencio no sale del navegador.
// Se pausa (y se sueltan las pistas del micro) con G.busy, V.state≠idle, speechSynthesis hablando o la pestaña oculta.
const W = { on: false, active: false, stream: null, rec: null, starting: false, timer: null, lastNotified: null };
const WAKE_MS = 2500;
const wakeWanted = () => W.on && !document.hidden && !G.busy && V.state === 'idle' && !ttsPlaying();

function wakeRender() {
  const txt = W.active ? '👂 Escuchando «oye guía»' : '👂 «oye guía» en pausa';
  const tip = (W.active ? 'El micrófono está abierto. ' : 'Micrófono cerrado mientras tanto. ') + 'Clic para apagar la escucha continua';
  guideRoots.forEach((r) => { const c = r.el.querySelector('.g-ear'); c.hidden = !W.on; c.textContent = txt; c.title = tip; c.classList.toggle('paused', !W.active); });
  const ear = $('#guide-fab .fab-ear');
  ear.hidden = !W.on; ear.classList.toggle('paused', !W.active); ear.title = tip;
  const box = document.querySelector('input[name=voiceWake]');
  if (box && !box.disabled) box.checked = W.on;
}
function wakeNotify() {
  if (W.lastNotified === W.active) return;
  W.lastNotified = W.active;
  if (EMBEDDED) { try { window.parent.postMessage({ type: 'agentoffice:listening', on: W.active }, location.origin); } catch { /* padre de otro origen */ } }
}
function wakeRelease() {
  W.stream?.getTracks().forEach((t) => t.stop()); // el piloto del navegador se apaga
  W.stream = null; W.rec?.stop(); W.rec = null; W.active = false;
}
function wakeSync() {
  if (!W.on) { wakeRelease(); clearInterval(W.timer); W.timer = null; }
  else {
    if (!W.timer) W.timer = setInterval(wakeSync, 500); // speechSynthesis no avisa de cuándo termina: se vigila
    if (!wakeWanted()) wakeRelease();
    else if (!W.stream && !W.starting) wakeStart();
  }
  wakeRender(); wakeNotify();
}
function wakeSet(on) {
  safeSet('ao:voice-wake', on ? '1' : '0');
  W.on = on;
  wakeSync();
}
async function wakeStart() {
  W.starting = true;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { W.starting = false; wakeSet(false); return toast(/Permission|NotAllowed/i.test(e.name + e.message) ? 'Sin permiso de micrófono: la escucha continua queda apagada' : 'No puedo usar el micrófono: ' + e.message, 'error'); }
  W.starting = false;
  if (!wakeWanted()) { stream.getTracks().forEach((t) => t.stop()); return wakeSync(); } // cambió el estado mientras el navegador pedía el micro
  W.stream = stream; W.active = true;
  wakeRender(); wakeNotify();
  while (W.stream === stream) {
    let r;
    try { W.rec = await voiceRecord(null, { stream, maxMs: WAKE_MS, gate: true }); r = await W.rec.result; } catch { break; }
    W.rec = null;
    if (W.stream === stream && r.spoke && r.ms >= VAD.minMs) wakeSend(r); // sin esperar: el siguiente segmento ya se vigila
  }
  if (W.stream === stream) wakeRelease(); // salió por un error del grabador
  wakeSync();
}
async function wakeSend(r) {
  let j;
  try {
    const res = await fetch(BASE + 'api/guide/wake', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT_ID }, body: JSON.stringify({ audio: await blobB64(r.blob), mime: r.mime, durationMs: Math.round(r.ms) }) });
    j = await res.json().catch(() => ({}));
    if (res.status === 503) { wakeSet(false); return toast('Escucha continua apagada: ' + (j.error || 'STT local no disponible'), 'error'); }
    if (!res.ok) return;
  } catch { return; } // un segmento perdido no merece un aviso
  if (!j.wake || G.busy || V.state !== 'idle') return;
  const root = guideRootEl();
  if (!root) return;
  if (j.rest) voiceDeliver(j.rest, root);
  else voiceHold(true, root); // «oye guía» a secas: grabación normal, la corta el VAD y va a /api/guide/stt como el push-to-talk
}
// Abre el Guía (panel o vista) y devuelve su contenedor.
function guideRootEl() {
  if (activeTab !== 'guide') guideToggle(true);
  return guideRoots.find((r) => r.panel === (activeTab !== 'guide'))?.el;
}
document.addEventListener('visibilitychange', wakeSync);

// ── Salida de voz del Guía 🔊 (FT-52) ─────────────────────────────────────────
// Botón ▶ en cada respuesta del Guía y casilla «Leer en voz alta»: POST /api/guide/tts → <audio> (voz local de piper por defecto).
// Si el proveedor del servidor falla o es «browser», cae a speechSynthesis eligiendo una voz femenina en español. Una sola reproducción
// a la vez; `ttsPlaying()` la expone a `wakeWanted()` para pausar la escucha continua mientras suena.
const T = { state: 'idle', key: null, audio: null, url: null, seq: 0, info: null }; // state: idle | loading | playing
const TTS_LANG = { es: 'es-ES', en: 'en-US', ca: 'ca-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', it: 'it-IT' };
const ttsPlaying = () => T.state !== 'idle' || !!(window.speechSynthesis && speechSynthesis.speaking);
// Texto plano de una respuesta: sin bloques de código, enlaces ni marcas de markdown.
const ttsPlain = (text) => String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_~#>]/g, '').replace(/\s+/g, ' ').trim();
const ttsInfoLoad = () => api('GET', '/api/guide/tts').then((i) => { T.info = i; guideRender(); }).catch(() => {});
// ¿Se puede leer? → '' si sí; si no, el motivo (tooltip del botón deshabilitado).
function ttsWhy() {
  if (!T.info) return '';
  const cur = T.info.providers.find((p) => p.name === T.info.provider);
  if (cur?.ok || window.speechSynthesis) return '';
  return `Voz no disponible: ${cur?.reason || 'sin proveedor TTS'}`;
}
function ttsButton(i, text) {
  if (!ttsPlain(text)) return '';
  const mine = T.key === i, why = ttsWhy();
  const [ic, tip] = why ? ['▶', why] : mine && T.state === 'loading' ? ['⏳', 'Preparando la voz… (pulsa para cancelar)'] : mine && T.state === 'playing' ? ['⏸', 'Parar'] : ['▶', 'Escuchar esta respuesta'];
  return `<button type="button" class="ghost small g-play ${mine && T.state !== 'idle' ? 'on' : ''}" data-g="play" data-i="${i}" title="${esc(tip)}" aria-label="${esc(tip)}" ${why ? 'disabled' : ''}>${ic}</button>`;
}
function ttsBrowserVoice(lang) {
  const fam = lang.slice(0, 2).toLowerCase();
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(fam));
  return vs.find((v) => /female|m[oó]nica|paulina|luc[ií]a|elvira|helena|laura|sabina|google espa/i.test(v.name)) || vs[0] || null;
}
function ttsStop() {
  T.seq++; // invalida peticiones en vuelo
  if (T.audio) { T.audio.pause(); T.audio.removeAttribute('src'); T.audio = null; }
  if (T.url) { URL.revokeObjectURL(T.url); T.url = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
  const was = T.state !== 'idle';
  T.state = 'idle'; T.key = null;
  if (was) guideRender();
}
function ttsBrowserSpeak(text, seq) {
  if (!window.speechSynthesis) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = TTS_LANG[S.settings.sttLang] || 'es-ES';
  const v = ttsBrowserVoice(u.lang);
  if (v) u.voice = v;
  u.rate = 1; u.pitch = 1;
  const end = () => { if (T.seq === seq) { T.state = 'idle'; T.key = null; guideRender(); } };
  u.onend = end; u.onerror = end;
  T.state = 'playing';
  speechSynthesis.speak(u);
  return true;
}
// Lee `text` (markdown) con la clave `key` (índice del mensaje o 'auto'); pulsar de nuevo la misma clave la para.
// opts.provider/opts.voice: la prueba de Ajustes usa lo del formulario sin guardar.
async function ttsSpeak(text, key, opts = {}) {
  const same = T.key === key && T.state !== 'idle';
  ttsStop();
  if (same) return;
  const plain = ttsPlain(text).slice(0, 4000);
  if (!plain) return;
  const seq = ++T.seq;
  T.key = key; T.state = 'loading'; guideRender();
  try {
    if ((opts.provider || T.info?.provider) === 'browser') { if (!ttsBrowserSpeak(plain, seq)) throw new Error('sin speechSynthesis'); guideRender(); return; }
    const r = await fetch(BASE + 'api/guide/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT_ID }, body: JSON.stringify({ text: plain, ...(opts.voice ? { voice: opts.voice } : {}), ...(opts.provider ? { provider: opts.provider } : {}) }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || r.statusText), { status: r.status }); }
    const blob = await r.blob();
    if (T.seq !== seq) return; // el usuario paró o cambió de chat mientras se sintetizaba
    T.url = URL.createObjectURL(blob);
    const a = T.audio = new Audio(T.url);
    const end = () => { if (T.audio === a) { T.state = 'idle'; T.key = null; T.audio = null; URL.revokeObjectURL(T.url); T.url = null; guideRender(); } };
    a.addEventListener('ended', end); a.addEventListener('error', end);
    await a.play();
    if (T.seq === seq) { T.state = 'playing'; guideRender(); }
  } catch (e) {
    if (T.seq !== seq) return;
    T.state = 'idle'; T.key = null;
    // respaldo: voz del navegador (el servidor no tiene proveedor o falló); el texto no sale del PC
    if (!opts.provider && window.speechSynthesis && ttsBrowserSpeak(plain, seq)) { T.key = key; guideRender(); return; }
    toast('No se pudo leer en voz alta: ' + e.message);
    guideRender();
  }
}
function voiceSpeak(text) {
  if (!text) return ttsStop();
  if (!voicePref.tts() || text.length > 320 || /```/.test(text) || V.state !== 'idle') return;
  ttsSpeak(text, 'auto');
}

// Ajustes ▸ «🔊 Voz del Guía»: voces del proveedor elegido en el formulario (sin guardar) y «Probar voz».
async function ttsFillSettings() {
  const sel = $('#tts-voice'), prov = document.querySelector('select[name=ttsProvider]');
  if (!sel || !prov) return;
  try {
    const i = await api('GET', '/api/guide/tts?provider=' + encodeURIComponent(prov.value));
    T.info = { ...i, provider: T.info?.provider || i.provider }; // lo guardado manda hasta que se pulse Guardar
    sel.innerHTML = i.voices.map((v) => `<option value="${esc(v.id)}" ${v.id === i.voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    const me = i.providers.find((p) => p.name === prov.value);
    $('#tts-info').innerHTML = `· ${me?.ok ? '<span class="ok">disponible</span>' : `<span class="bad">no disponible: ${esc(me?.reason || '')}</span>`}`;
  } catch { sel.innerHTML = '<option value="">—</option>'; }
}
document.addEventListener('change', (e) => { if (e.target.matches?.('select[name=ttsProvider]')) ttsFillSettings(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tts-test]');
  if (!b) return;
  const provider = document.querySelector('select[name=ttsProvider]')?.value, voice = $('#tts-voice')?.value;
  ttsSpeak('Hola, soy tu guía. Así sueno cuando te leo una respuesta.', 'test', { provider, voice });
});

// Ajustes ▸ «Probar micrófono»: graba (corta sola tras el silencio), enseña el nivel y la transcripción con su latencia.
let voiceTestRec = null;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-voice-test]');
  if (!b) return;
  if (voiceTestRec) return voiceTestRec.stop();
  const out = $('#voice-test');
  out.textContent = 'Pidiendo el micrófono…';
  try {
    voiceTestRec = await voiceRecord((rms) => { out.innerHTML = `🔴 Habla ahora… <i class="g-vlevel" style="--lv:${Math.min(1, rms * 8).toFixed(2)}"></i>`; });
    b.textContent = '■ Parar';
    const r = await voiceTestRec.result;
    voiceTestRec = null; b.textContent = '🎤 Probar micrófono';
    if (!r.spoke) { out.textContent = `No he oído voz por encima del umbral (${(r.ms / 1000).toFixed(1)} s grabados). Revisa el micrófono del sistema.`; return; }
    out.textContent = '⏳ Transcribiendo…';
    const t = await voiceTranscribe(r);
    out.innerHTML = `✓ <b>«${esc(t.text || '(vacío)')}»</b> <span class="muted">· ${esc(t.provider)} · ${t.ms} ms · audio ${(r.ms / 1000).toFixed(1)} s</span>`;
  } catch (err) { voiceTestRec = null; b.textContent = '🎤 Probar micrófono'; out.textContent = '✗ ' + (err.message || 'No se pudo grabar'); }
});

// ── Pintado ─────────────────────────────────────────────────────────────────
// Pestañas de administración (Oficina / Tareas / Agentes), recordadas por navegador.
let skillsData = null; // catálogo e inventario de skills (se carga al abrir Agentes)
let MODELS = { claude: [], codex: [], local: [] }; // modelos disponibles por motor (GET /api/engines/models)
let modelsAt = 0;
// Lista viva (FT-55): caché de 5 min en el cliente; `force` (botón ↻) o caducada → se vuelve a pedir. Si falla, se queda lo que hubiera.
const loadModels = (force) => (!force && Date.now() - modelsAt < 300000 ? Promise.resolve() : api('GET', '/api/engines/models').then((m) => { MODELS = m; modelsAt = Date.now(); }).catch(() => {}));
loadModels(true);
const MODEL_OF = { claude: /^(sonnet|opus|haiku|claude-)/i, codex: /^(gpt-|o[0-9]|codex)/i }; // espejo de team.js
const GROUP_LABEL = { claude: 'Claude', codex: 'Codex', local: 'Local' };
const AUTO_HINT = 'con motor automático, el modelo decide si va a Claude o a Codex';
// ÚNICO selector de modelo (FT-55): cajón, contratar, editar, roles y Ajustes. Grupos por motor (en «auto» salen los dos), no disponibles
// deshabilitados con su nota, valor actual siempre presente y «Otro…» (campo libre solo al elegirlo).
function modelSelect(name, engine, current) {
  const groups = engine === 'auto' ? ['claude', 'codex'] : engine === 'demo' ? [] : [engine];
  const known = groups.flatMap((g) => MODELS[g] || []).some((m) => m.id === current);
  const opt = (m) => `<option value="${esc(m.id)}" title="${esc(m.note || '')}" ${m.id === current ? 'selected' : ''} ${m.available === false ? 'disabled' : ''}>${esc(m.label)} · ${esc(m.id)}${m.available === false ? ' — ' + esc(m.note || 'no disponible') : m.note ? ' (' + esc(m.note) + ')' : ''}</option>`;
  return `<span class="model-pick" data-name="${esc(name)}" data-engine="${esc(engine)}"><span class="model-row"><select name="${esc(name)}" class="model-select">
    <option value="" ${!current ? 'selected' : ''}>por defecto del rol / motor</option>
    ${current && !known ? `<option value="${esc(current)}" selected>actual: ${esc(current)}</option>` : ''}
    ${groups.map((g) => `<optgroup label="${GROUP_LABEL[g] || esc(g)}">${(MODELS[g] || []).map(opt).join('')}</optgroup>`).join('')}
    <option value="__other">Otro… (escribir id)</option>
  </select><button type="button" class="ghost small model-refresh" title="Refrescar la lista de modelos" aria-label="Refrescar modelos">↻</button></span>
  <input name="${esc(name)}_other" class="model-other" placeholder="id del modelo" style="display:none" /><div class="muted model-hint">${engine === 'auto' ? AUTO_HINT : ''}</div></span>`;
}
// Valor actual de un .model-pick (el id elegido o el escrito en «Otro…»).
const modelPickValue = (w) => { const s = w.querySelector('.model-select').value; return s === '__other' ? w.querySelector('.model-other').value.trim() : s; };
// Repinta un selector (otro motor o lista refrescada) conservando el valor.
function repaintModel(w, engine, current) {
  const t = document.createElement('div');
  t.innerHTML = modelSelect(w.dataset.name, engine, current);
  w.replaceWith(t.firstElementChild);
}
// Validación de «Otro…»: sin espacios; aviso (no bloquea) si el motor no lo reconoce.
function checkModelOther(inp) {
  const w = inp.closest('.model-pick'), v = inp.value.trim(), eng = w.dataset.engine;
  inp.setCustomValidity(/\s/.test(v) ? 'El id del modelo no puede llevar espacios' : '');
  const ok = !v || (eng === 'auto' ? Object.values(MODEL_OF).some((re) => re.test(v)) : !MODEL_OF[eng] || MODEL_OF[eng].test(v));
  w.querySelector('.model-hint').textContent = !ok ? `⚠ «${v}» no parece un modelo de ${eng}: se usará el modelo por defecto del motor` : eng === 'auto' ? AUTO_HINT : '';
}
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.model-select');
  if (sel) { const other = sel.closest('.model-pick').querySelector('.model-other'); other.style.display = sel.value === '__other' ? '' : 'none'; if (sel.value === '__other') other.focus(); return; }
  const eng = e.target.closest('select[name=engine]');
  if (eng) { const w = eng.closest('form')?.querySelector('.model-pick'); if (w) repaintModel(w, eng.value, ''); }
});
document.addEventListener('input', (e) => { if (e.target.closest('.model-other')) checkModelOther(e.target); });
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.model-refresh');
  if (!b) return;
  b.disabled = true;
  await loadModels(true);
  document.querySelectorAll('.model-pick').forEach((w) => repaintModel(w, w.dataset.engine, modelPickValue(w)));
});
const pickModel = (f) => (f.model === '__other' ? (f.model_other || '').trim() : f.model || '');
const VIEW_PARAM = new URLSearchParams(location.search).get('view'); // ?view=guide (botón «Guía» de flow-test, FT-3)
let activeTab = ['office', 'tasks', 'agents', 'guide'].includes(VIEW_PARAM) ? VIEW_PARAM : safeGet('ao:tab') || 'office';
function showTab(tab) {
  const prev = activeTab;
  activeTab = tab;
  safeSet('ao:tab', tab);
  document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + tab; });
  if (tab === 'office') {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    if (prev !== 'office' && officeInit) applyOfficeDefault(); // al entrar en la pestaña: edificio, planta recordada o la única (FT-47)
  }
  if (tab === 'agents') renderSkills();
  if (tab === 'guide') guideShow(); else guideRender();
  publishContext();
}
$('#sidebar').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
// Secciones plegables de la pantalla Agentes (cabecera = plegar/desplegar; los botones de la cabecera siguen funcionando).
const collapsed = (() => { try { return JSON.parse(localStorage.getItem('ao:collapsed') || '{}'); } catch { return {}; } })();
const applyCollapsed = () => document.querySelectorAll('[data-section]').forEach((h) => h.classList.toggle('collapsed', !!collapsed[h.dataset.section]));
applyCollapsed();
document.addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, select')) return;
  const h = e.target.closest('[data-section]');
  if (h) { collapsed[h.dataset.section] = !collapsed[h.dataset.section]; safeSet('ao:collapsed', JSON.stringify(collapsed)); applyCollapsed(); return; }
  const box = e.target.closest('.skills-box h4');
  if (box) { box.parentElement.classList.toggle('collapsed'); return; }
  const g = e.target.closest('.skill-group');
  if (g) { g.classList.toggle('collapsed'); collapsed['skills:' + g.dataset.group] = g.classList.contains('collapsed'); safeSet('ao:collapsed', JSON.stringify(collapsed)); }
});
showTab(activeTab);
// Menú lateral plegable (solo iconos), recordado por navegador.
const setCollapsed = (c) => { $('#sidebar').classList.toggle('collapsed', c); safeSet('ao:sidebar', c ? 'collapsed' : 'open'); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); };
setCollapsed(safeGet('ao:sidebar') === 'collapsed');
$('#collapse').addEventListener('click', () => setCollapsed(!$('#sidebar').classList.contains('collapsed')));
// Embebido en el modal de flow-test: nuestra cabecera hace de cabecera del modal (título «Agentes», abrir en pestaña, cerrar).
if (EMBEDDED) {
  document.body.classList.add('embedded');
  $('#brand-name').textContent = 'Agentes · AgentOffice';
  $('#embed-open').href = location.href;
  const close = () => window.parent.postMessage({ type: 'agent-office', action: 'close' }, location.origin);
  $('#embed-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dialog').open && !drawerAgent) close(); });
}

function render() {
  const p = project();
  const sorted = [...S.projects].sort((a, b) => (a.folder === 'default' ? -1 : b.folder === 'default' ? 1 : (a.folder || '~').localeCompare(b.folder || '~')));
  $('#project').innerHTML = sorted.map((x) => `<option value="${x.id}" ${x.id === projectId ? 'selected' : ''}>${x.folder ? '📁 ' : '• '}${esc(x.name)}${x.folder && x.folder !== x.name ? ` (${esc(x.folder)})` : ''}${x.flows != null ? ` · ${x.flows} flows` : ''}${x.orphan ? ' ⚠ sin carpeta' : ''}${!x.folder ? ' · manual' : ''}</option>`).join('');
  const repos = p?.repos || [];
  $('#repo').textContent = p ? (repos.length ? `📁 ${repos.map((r) => `${r.key} (${r.baseBranch})`).join(' · ')}` : 'sin repositorio · solo motor demo') : '';
  $('#repo').title = repos.map((r) => `${r.key}: ${r.path}`).join('\n');
  const run = $('#run');
  run.textContent = p?.running ? '⏸ Parar el equipo' : '▶ Poner a trabajar';
  run.classList.toggle('on', !!p?.running);
  run.disabled = !p;

  office.update({ agents: team(), tasks: tasks(), questions: S.questions || [], roles: S.roles, title: p?.name || '', selected: drawerAgent, projects: S.projects, allAgents: S.agents, allTasks: S.tasks, projectId }); // projects/allAgents/allTasks: modo edificio (FT-46); projectId: planta resaltada (FT-47)
  renderSuite();
  renderTeam();
  renderRepos();
  renderRoles();
  renderBoard();
  renderSummary();
  renderQuotaChip();
  const ts = tasks();
  const working = team().filter((a) => a.status === 'working');
  const paused = team().filter((a) => a.status === 'paused').length;
  $('#tab-tasks-count').textContent = ts.filter((t) => ['todo', 'doing', 'review'].includes(t.status)).length || '';
  $('#tab-agents-count').textContent = team().length || '';
  $('#tab-summary').innerHTML = `${ts.filter((t) => t.status === 'doing').length} en curso<br>${ts.filter((t) => t.status === 'review').length} por revisar<br>${working.length}/${team().length} agentes trabajando${paused ? ` · ${paused} en pausa` : ''}`;
  renderOfficeFoot();
  const b = p?.board;
  const pending = b ? ts.filter((t) => t.source?.kind !== b.kind && t.kind !== 'plan').length : 0;
  const job = b?.job;
  $('#board-chip').innerHTML = b
    ? `🔗 ${esc(BOARD_LABELS[b.kind] || b.kind)} · <a href="${esc(b.url || '#')}" target="_blank" rel="noopener">${esc(b.config.repo || b.config.boardId || b.config.projectKey || '')}</a> · ${b.syncedAt ? 'hace ' + ago(b.syncedAt) : 'sin sincronizar'}${pending ? ` · <span title="tareas sin tarjeta fuera">${pending} sin tarjeta</span>` : ''}${b.lastError ? ` <span class="bad" title="${esc(b.lastError)}">⚠</span>` : ''} ${job?.running ? `<span class="muted">⇪ ${job.done}/${job.total}${job.waitingUntil ? ' · esperando a GitHub' : ''}</span> <button class="small ghost" data-board-cancel>✕</button>` : `<button class="small" data-board-syncall title="Igualar los dos lados: trae y lleva los estados y crea fuera las tarjetas que falten">⇅ Sincronizar</button>`}`
    : `<button class="small ghost" data-action="settings" title="Conecta GitHub, Trello o Jira en Ajustes ▸ Tablero online">🔗 Conectar tablero…</button>`;
  if (drawerAgent) renderDrawer();
  refreshTaskWho(); // FT-50
  publishContext();
}

function renderTeam() {
  const ts = tasks();
  $('#team-summary').textContent = `${team().length} agentes · ${team().filter((a) => a.status === 'working').length} trabajando`;
  $('#team').innerHTML = team().map((a) => {
    const task = ts.find((t) => t.id === a.taskId);
    const done = ts.filter((t) => t.agentId === a.id && ['done', 'review'].includes(t.status)).length;
    const cost = ts.filter((t) => t.agentId === a.id).reduce((n, t) => n + (t.costUsd || 0), 0);
    const r = S.roles[a.role];
    return `
    <div class="member ${a.id === drawerAgent ? 'sel' : ''}" style="--c:${r?.color || '#999'}">
      <div class="top" data-agent="${a.id}">
        <span class="avatar">${esc(a.name).charAt(0).toUpperCase()}</span>
        <div class="member-main"><b>${esc(a.name)}</b><div class="act">${busy(a) ? esc(a.activity) : 'En la zona de descanso ☕'}</div></div>
        <span class="eng">${esc(a.engine)}${a.engine === 'auto' && a.activeEngine ? ' → ' + esc(a.activeEngine) : ''}${a.model ? ' · ' + esc(a.model) : ''}</span>
      </div>
      <div class="member-foot">${roleChip(a.role)}<span class="state ${a.status}"><span class="dot ${a.status}"></span>${a.status === 'paused' ? 'En pausa' : a.status === 'working' ? 'Trabajando' : 'Descansando'}</span></div>
      ${task ? `<div class="task">▶ ${esc(tcode(task))} ${esc(task.title)}</div>` : ''}
      <div class="meta"><span>${done} entregadas</span>${cost ? `<span>≈ ${cost.toFixed(2)} $</span>` : ''}${r?.custom ? `<span title="${esc(r.description || '')}">rol de fichero · ${esc(r.source)}</span>` : ''}</div>
      ${projectsOf(a.id).length ? `<div class="meta"><span>también en: ${projectsOf(a.id).map(esc).join(', ')}</span></div>` : ''}
      <div class="acts">
        <button class="small ghost" data-agent="${a.id}">Registro</button>
        <button class="small ghost" data-agent-edit="${a.id}" title="Nombre, rol, motor y modelo">✎ Editar</button>
        ${busy(a) ? `${controls(a)}<button class="small danger" data-stop="${a.id}">⏹ Parar</button>` : ''}
        <button class="small ghost" data-bench="${a.id}" title="Sale de la plantilla de este proyecto; sigue en la empresa">↓ Al banquillo</button>
      </div>
    </div>`;
  }).join('') || '<p class="empty">Sin plantilla. Ficha agentes del banquillo o contrata a alguien nuevo.</p>';
  renderBench();
}

function renderBench() {
  const list = bench();
  $('#bench-summary').textContent = `${list.length} en la empresa sin fichar aquí`;
  $('#bench').innerHTML = list.map((a) => {
    const r = S.roles[a.role];
    return `<div class="member bench" style="--c:${r?.color || '#999'}">
      <div class="top" data-agent="${a.id}"><span class="avatar">${esc(a.name).charAt(0).toUpperCase()}</span><div class="member-main"><b>${esc(a.name)}</b><div class="act">${busy(a) ? esc(a.activity) : (projectsOf(a.id).length ? 'en ' + projectsOf(a.id).map(esc).join(', ') : 'disponible')}</div></div><span class="eng">${esc(a.engine)}${a.model ? ' · ' + esc(a.model) : ''}</span></div>
      <div class="member-foot">${roleChip(a.role)}<span class="state ${a.status}"><span class="dot ${a.status}"></span>${a.status === 'paused' ? 'En pausa' : a.status === 'working' ? 'Trabajando' : 'Libre'}</span></div>
      <div class="acts"><button class="small" data-sign="${a.id}">↑ Fichar</button><button class="small ghost" data-agent-edit="${a.id}">✎</button><button class="small danger" data-fire="${a.id}" title="Baja definitiva de la empresa">Despedir</button></div>
    </div>`;
  }).join('') || '<p class="empty">Nadie en el banquillo: todos los agentes de la empresa están fichados aquí.</p>';
}

const short = (p) => String(p || '').replace(/^\/home\/[^/]+/, '~');
function renderRepos() {
  const repos = project()?.repos || [];
  $('#repos-summary').textContent = repos.length ? `${repos.length} repos · cada tarea trabaja en un worktree del repo que le toca` : 'sin repos: solo funciona el motor demo';
  $('#repos').innerHTML = repos.length ? `<table class="repos"><thead><tr><th>Clave</th><th>Ruta</th><th>Rama base</th><th>Roles que trabajan aquí</th><th></th></tr></thead><tbody>${repos.map((r) => `
    <tr>
      <td><code>${esc(r.key)}</code>${r.auto ? ' <span class="auto-chip" title="Deducido del enlace de la carpeta del proyecto en el hub">auto</span>' : ''}</td>
      <td class="muted">${esc(short(r.path))}</td>
      <td>${esc(r.baseBranch || '')}</td>
      <td>${(r.roles || []).length ? r.roles.map((x) => roleChip(x)).join(' ') : '<span class="muted">(los roles sin repo propio)</span>'}</td>
      <td style="white-space:nowrap"><button class="small ghost" data-repo-edit="${esc(r.key)}">✎</button> <button class="small danger" data-repo-del="${esc(r.key)}">✕</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="empty">Sin repositorios. Añade uno, o crea un enlace en la carpeta del proyecto del hub y pulsa ↻ Carpetas.</p>';
}

function renderRoles() {
  const roles = Object.entries(S.roles);
  $('#roles-summary').textContent = `${roles.filter(([, r]) => r.custom).length} del catálogo · ${roles.filter(([, r]) => !r.custom).length} de serie`;
  $('#roles').innerHTML = roles.map(([id, r]) => `
    <div class="role-card" style="--c:${r.color}">
      <b>${esc(r.label)}</b> <span class="muted">· ${r.kind === 'planner' ? 'planifica' : r.kind === 'qa' ? 'QA' : r.kind === 'docs' ? 'documenta' : 'desarrolla'}${r.model ? ' · ' + esc(r.model) : ''}${r.handles?.length ? ' · atiende ' + r.handles.join('/') : ''}</span>
      <div class="desc">${esc(r.description || r.system.slice(0, 160))}</div>
      ${r.skills?.length ? `<div class="sk">🧩 ${r.skills.map(esc).join(' · ')}</div>` : ''}
      <div class="src">${r.custom ? `📄 ${esc(r.file.replace(/^.*\/_agentes\/roles\//, 'catálogo/'))}` : 'de serie'}${team().some((a) => a.role === id) ? ' · en plantilla' : ''}</div>
      <div class="acts">${r.custom ? `<button class="small ghost" data-role-edit="${id}">✎ Editar</button><button class="small danger" data-role-del="${id}">✕</button>` : `<button class="small ghost" data-role-dup="${id}">Copiar al catálogo…</button>`}</div>
    </div>`).join('');
}

async function renderSkills(reload = false) {
  const el = $('#skills');
  if (!el) return;
  if (!skillsData || reload) { el.innerHTML = '<p class="muted">Inventariando…</p>'; try { skillsData = await api('GET', '/api/skills'); } catch { el.innerHTML = '<p class="bad">No se pudo leer el catálogo</p>'; return; } }
  const { catalog, inventory, catalogDir } = skillsData;
  $('#skills-summary').textContent = `${catalog.length} en el catálogo · ${inventory.length} encontradas en el PC · ${short(catalogDir)}/skills`;
  const groups = {};
  for (const s of inventory) (groups[s.sourceLabel] = groups[s.sourceLabel] || []).push(s);
  el.innerHTML = `<div class="skills-wrap">
    <div class="skills-box"><h4>Catálogo central (lo que pueden usar los roles)</h4>${catalog.length ? catalog.map((s) => `<div class="skill"><span class="nm">${esc(s.name)}</span><span class="ds" title="${esc(s.description)}">${esc(s.description)}</span><span class="src" title="${esc(s.target)}">${s.broken ? '⚠ roto' : '→ ' + esc(short(s.target))}</span><button class="small ghost" data-skill-edit="${esc(s.target)}" title="Editar SKILL.md">✎</button><button class="small danger" data-skill-del="${esc(s.name)}" title="Quitar del catálogo (no borra la skill)">✕</button></div>`).join('') : '<p class="muted">Vacío. Añade skills desde el inventario →</p>'}</div>
    <div class="skills-box"><h4>Inventario del PC</h4>${Object.entries(groups).map(([g, list]) => `<div class="muted skill-group ${collapsed['skills:' + g] === false ? '' : 'collapsed'}" data-group="${esc(g)}" style="margin:8px 0 4px;font-weight:600">${esc(g)} <span class="muted">(${list.length}${list.filter((s) => s.central).length ? ` · ${list.filter((s) => s.central).length} en catálogo` : ''})</span></div>${list.map((s) => `<div class="skill" data-group="${esc(g)}"><span class="nm">${esc(s.name)}</span><span class="ds" title="${esc(s.description)}">${esc(s.description)}</span><button class="small ghost" data-skill-edit="${esc(s.dir)}" title="Editar SKILL.md">✎</button>${s.central ? `<span class="src">✓ en catálogo${s.central !== s.name ? ' como ' + esc(s.central) : ''}</span>` : `<button class="small ghost" data-skill-add="${esc(s.dir)}" title="${esc(s.dir)}">→ Catálogo</button>`}</div>`).join('')}`).join('')}</div>
  </div>`;
}

async function editSkill(dir) {
  const r = await api('POST', '/api/skills/read', { dir });
  dialog(`
    <h3>✎ SKILL.md</h3>
    <p class="muted" style="margin:0 0 6px">${esc(short(r.file))}</p>
    <textarea name="content" class="code" spellcheck="false">${esc(r.content)}</textarea>
    ${r.files.length > 1 ? `<div class="files">Otros ficheros de la skill (solo lectura aquí): ${r.files.filter((f) => f !== 'SKILL.md').map(esc).join(' · ')}</div>` : ''}
    <p class="muted">Se guarda en el fichero real (copia previa en SKILL.md.bak).</p>
    ${buttons('Guardar')}`, async (f) => { await api('POST', '/api/skills/write', { dir, content: f.content }); toast('SKILL.md guardado'); renderSkills(true); }, 'wide');
}

async function saveRepos(repos) {
  await api('PATCH', `/api/projects/${projectId}`, { repos: repos.map((r) => ({ key: r.key, path: r.path, roles: r.roles || [] })) });
  toast('Repositorios guardados');
}
function editRepo(key) {
  const repos = project()?.repos || [];
  const r = repos.find((x) => x.key === key) || { key: '', path: '', roles: [] };
  dialog(`
    <h3>${key ? '✎ Repo «' + esc(key) + '»' : '＋ Añadir repositorio'}</h3>
    <label>Clave (corta, sin espacios)</label><input name="key" value="${esc(r.key)}" placeholder="servidor" required ${key ? '' : 'autofocus'} />
    <label>Ruta del repositorio git en esta máquina</label><input name="path" value="${esc(r.path)}" placeholder="~/dev/mi-proyecto" required />
    <label>Roles que trabajan en este repo (Ctrl+clic para varios; vacío = los roles sin repo propio)</label>
    <select name="roles" multiple class="tall">${Object.entries(S.roles).filter(([, x]) => x.kind !== 'planner').map(([id, x]) => `<option value="${id}" ${(r.roles || []).includes(id) ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
    ${r.auto ? '<p class="muted">Deducido del enlace del hub; al editarlo deja de ser automático.</p>' : ''}
    ${buttons('Guardar')}`, async (f) => {
    const roles = [...$('#dialog form').querySelector('[name=roles]').selectedOptions].map((o) => o.value);
    const next = repos.filter((x) => x.key !== key).map((x) => ({ key: x.key, path: x.path, roles: x.roles || [] }));
    next.push({ key: f.key.trim(), path: f.path.trim(), roles });
    await saveRepos(next);
  });
}

function editRole(id, duplicate = false) {
  const r = S.roles[id] || {};
  const rid = duplicate ? '' : id;
  const catalog = skillsData?.catalog || [];
  const mine = r.skills || [];
  dialog(`
    <h3>${rid ? '✎ Rol «' + esc(r.label) + '»' : '＋ Nuevo rol' + (duplicate ? ' (a partir de «' + esc(r.label) + '»)' : '')}</h3>
    <div class="grid2">
      <div><label>Identificador (sin espacios)</label><input name="id" value="${esc(rid)}" placeholder="unity-dev" ${rid ? 'readonly' : 'required autofocus'} /></div>
      <div><label>Tipo</label><select name="kind"><option value="dev" ${r.kind === 'dev' ? 'selected' : ''}>desarrolla</option><option value="qa" ${r.kind === 'qa' ? 'selected' : ''}>QA (MCP de flow-test)</option><option value="docs" ${r.kind === 'docs' ? 'selected' : ''}>documenta (MCP de flow-test)</option><option value="planner" ${r.kind === 'planner' ? 'selected' : ''}>planifica (PO)</option></select></div>
      <div><label>Modelo por defecto</label>${modelSelect('model', 'auto', r.model || '')}</div>
      <div><label>Modelo mínimo (cascada FT-60: no empezar más abajo)</label><input name="minModel" value="${esc(r.minModel || '')}" placeholder="vacío = empieza barato (p. ej. sonnet)" /></div>
      <div><label>Atiende tareas de rol (Ctrl+clic)</label><select name="handles" multiple>${['po', 'back', 'front', 'qa'].map((h) => `<option value="${h}" ${(r.handles || []).includes(h) ? 'selected' : ''}>${h}</option>`).join('')}</select></div>
    </div>
    <label>Descripción (una línea)</label><input name="description" value="${esc(r.description || '')}" />
    <label>Skills del catálogo que lleva (Ctrl+clic)</label>
    <select name="skills" multiple class="tall">${catalog.map((s) => `<option value="${esc(s.name)}" ${mine.includes(s.name) ? 'selected' : ''}>${esc(s.name)} — ${esc(s.description.slice(0, 80))}</option>`).join('') || '<option disabled>(catálogo vacío: añade skills abajo)</option>'}</select>
    <label>Prompt de sistema</label><textarea name="system" rows="12">${esc(r.system || '')}</textarea>
    <p class="muted">Se guarda como fichero .md en el catálogo central (${esc(short(skillsData?.catalogDir || '~/JksDocs/workspace/_agentes'))}/roles/).</p>
    ${buttons('Guardar')}`, async (f) => {
    const form = $('#dialog form');
    const pick = (n) => [...form.querySelector(`[name=${n}]`).selectedOptions].map((o) => o.value);
    await api('POST', '/api/roles', { ...f, model: pickModel(f), id: f.id || rid, handles: pick('handles'), skills: pick('skills'), file: rid ? r.file : null });
    toast('Rol guardado en el catálogo');
  });
}

// Candado de suite: chip en la cabecera y pantalla de bloqueo si flow-test no está o ha caducado.
const MODE_LABEL = { licensed: 'licencia', trial: 'prueba', linked: 'cuenta cloud', cloud: 'cloud', unverified: 'sin verificar', expired: 'caducado', revoked: 'revocado' };
function renderSuite() {
  const s = S.suite;
  const chip = $('#suite');
  if (!s) { chip.innerHTML = '<span class="dot"></span> flow-test · comprobando…'; chip.className = 'ghost suite'; return; }
  const plan = s.plan ? s.plan.toUpperCase() : '';
  chip.className = `ghost suite ${s.ok ? 'ok' : 'bad'}`;
  chip.innerHTML = `<span class="dot"></span> flow-test${s.ok ? ` · ${plan || MODE_LABEL[s.mode] || s.mode}${s.org ? ' · ' + esc(s.org) : ''}${s.mode === 'trial' && s.daysLeft != null ? ` · ${s.daysLeft} días` : ''}` : ' · sin conexión'}`;
  chip.title = s.ok ? `${s.url} · ${MODE_LABEL[s.mode] || s.mode}${s.plan ? ' · plan ' + s.plan : ''}` : s.reason;
  const lock = $('#suite-lock');
  lock.hidden = !!s.ok;
  if (!s.ok) {
    $('#lock-reason').textContent = s.reason || '';
    if (document.activeElement !== $('#lock-url')) $('#lock-url').value = S.settings.flowTestUrl || s.url || '';
  }
}
$('#lock-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#lock-url').value.trim();
  if (url) await api('POST', '/api/settings', { flowTestUrl: url });
  S.suite = await api('GET', '/api/suite');
  renderSuite();
  if (S.suite.ok) toast(`Conectado a flow-test (${S.suite.plan || S.suite.mode})`);
};

const COLS = [
  ['backlog', 'Backlog', '#94a3b8'],
  ['todo', 'Por hacer', '#fde047'],
  ['doing', 'En curso', '#60a5fa'],
  ['review', 'Revisión', '#fb923c'],
  ['done', 'Hecho', '#4ade80'],
];

let taskFilter = '';
$('#task-filter').addEventListener('input', (e) => { taskFilter = e.target.value.trim().toLowerCase(); renderBoard(); publishContext(); });
function renderBoard() {
  const list = tasks().filter((t) => !taskFilter || `${t.id} ${t.code || ''} ${t.title} ${t.role} ${t.repo || ''} ${t.description}`.toLowerCase().includes(taskFilter));
  $('#board').innerHTML = COLS.map(([st, label, c]) => {
    const items = list.filter((t) => t.status === st || (st === 'todo' && t.status === 'failed'))
      .sort((a, b) => (st === 'done' ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt));
    return `<div class="col" data-col="${st}" style="--c:${c}"><h4><span>${label}</span><span class="count">${items.length}</span></h4><div class="cards">${items.map(card).join('') || '<div class="empty">Nada por aquí</div>'}</div></div>`;
  }).join('');
}

// FT-27: arrastrar tarjetas entre columnas (delegación en #board: sobrevive a cada re-render por SSE).
// Solo Backlog ↔ Por hacer; cualquier otro destino muestra un aviso en vez de fallar callado.
const MOVABLE = ['backlog', 'todo', 'failed'];
const COL_NAME = Object.fromEntries(COLS.map(([st, label]) => [st, label]));
async function moveTask(id, status) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  if (t.status === status) return;
  if (!MOVABLE.includes(t.status)) return toast(`${tcode(t)} ${t.status === 'doing' ? 'está en curso: para al agente antes de moverla' : 'está en «' + (COL_NAME[t.status] || t.status) + '»: usa Aprobar / Devolver en la tarjeta'}`, 'error');
  if (!['backlog', 'todo'].includes(status)) return toast(`No se puede mover a «${COL_NAME[status]}» a mano: esa columna la gestiona el agente al ejecutar la tarea`, 'error');
  try { await api('PATCH', `/api/tasks/${id}`, { status }); toast(`${tcode(t)} → ${COL_NAME[status]}`); } catch { /* api() ya mostró el aviso */ }
}
let dragId = null;
$('#board').addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.card[data-task]'); if (!c) return;
  dragId = c.dataset.task; c.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
});
$('#board').addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.dragging,.drop-over').forEach((x) => x.classList.remove('dragging', 'drop-over')); });
$('#board').addEventListener('dragover', (e) => { const col = e.target.closest?.('.col'); if (!col || !dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop-over'); });
$('#board').addEventListener('dragleave', (e) => { const col = e.target.closest?.('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop-over'); });
$('#board').addEventListener('drop', (e) => {
  const col = e.target.closest?.('.col'); if (!col || !dragId) return;
  e.preventDefault(); const id = dragId; dragId = null; col.classList.remove('drop-over');
  moveTask(id, col.dataset.col);
});
// FT-19: estado de la rama en revisión respecto a la base (lo calcula el servidor): desfasada N commits / conflicto en ficheros.
const baseOf = (t) => { const rs = S.projects.find((p) => p.id === t.projectId)?.repos || []; return (rs.find((r) => r.key === t.repo) || rs[0])?.baseBranch || 'main'; };
const mergeChips = (t) => t.status !== 'review' || !t.branch ? '' : [
  (t.outsideWrites || []).length ? `<span class="merge-chip conflict" title="FT-44: cambios sin confirmar en el checkout principal de ${esc(t.outsideWrites.map((o) => o.repo).join(', '))}: no pasan por esta revisión">⚠ escribió fuera de su worktree</span>` : '',
  t.behind ? `<span class="merge-chip behind" title="A la rama le faltan ${t.behind} commits de ${esc(baseOf(t))}: «Actualizar con ${esc(baseOf(t))}» los trae (al aprobar se hace solo)">desfasada ${t.behind} commit${t.behind === 1 ? '' : 's'}</span>` : '',
  (t.conflicts || []).length ? `<span class="merge-chip conflict" title="${esc(t.conflicts.join('\n'))}">⚠ conflicto en ${esc(t.conflicts.slice(0, 2).join(', '))}${t.conflicts.length > 2 ? ` +${t.conflicts.length - 2}` : ''}</span>` : '',
].join(' ');
// FT-44: tarea con rama en varios repos → un diffStat por repo; escribir fuera del worktree → aviso para el humano.
const repoStats = (t) => Object.entries(t.repos || {}).filter(([, r]) => r.diffStat);
const diffStatsHtml = (t, cls = '') => repoStats(t).length > 1
  ? repoStats(t).map(([k, r]) => `<pre${cls}><b>📁 ${esc(k)}</b> · ${esc(r.branch || t.branch || '')}\n${esc(r.diffStat)}</pre>`).join('')
  : (t.diffStat ? `<pre${cls}>${esc(t.diffStat)}</pre>` : '');
const outsideWarn = (t) => (t.outsideWrites || []).length ? `<div class="task-sec outside-warn"><h4>⚠ Escribió fuera de su worktree</h4><p>Hay cambios sin confirmar en el checkout principal que no pasan por esta revisión (no se fusionarán con «Aprobar» y pueden estar sirviéndose ya):</p><ul>${t.outsideWrites.map((o) => `<li><code>${esc(o.repo)}</code> · ${esc(o.path)}<br>${o.files.map((f) => `<code>${esc(f)}</code>`).join(' · ')}</li>`).join('')}</ul></div>` : '';
const updateBtn = (t) => t.status === 'review' && t.branch && t.behind ? `<button class="small ghost" data-update="${t.id}" title="Fusiona ${esc(baseOf(t))} en la rama de la tarea; si choca, vuelve al agente con el conflicto">⬆ Actualizar con ${esc(baseOf(t))}</button>` : '';

// FT-50: quién hará la tarea. Fijo (el agente que la tiene o el asignado con «Asignar a…»), previsto (`plannedAgentId`, que el
// servidor calcula con la misma regla que el planificador) o aviso ámbar si nadie del equipo tiene el rol. El chip abre el
// cajón del agente (motor, modelo, registro) o, sin agente, «Contratar agente» con el rol ya elegido; el desplegable reasigna.
const UNSTARTED = ['backlog', 'todo', 'failed'];
const engineTag = (a) => `${a.engine}${a.engine === 'auto' && a.activeEngine ? '→' + a.activeEngine : ''}${a.model ? '/' + a.model : ''}`;
const assignable = (t) => team().filter((a) => a.role === t.role || (S.roles[a.role]?.handles || []).includes(t.role));
function whoRow(t) {
  const byId = (id) => id && S.agents.find((a) => a.id === id);
  const fixed = byId(t.agentId) || byId(t.assignedAgentId);
  const planned = !fixed && byId(t.plannedAgentId);
  const a = fixed || planned;
  const open = UNSTARTED.includes(t.status);
  const chip = a
    ? `<button type="button" class="who-chip${planned ? ' planned' : ''}" data-agent="${a.id}" title="${planned ? `Previsto: ${esc(a.name)} es el primer agente del equipo libre con ese rol (cambia con «Asignar a…»). ` : ''}Abrir a ${esc(a.name)} para configurarlo (motor, modelo) o ver su registro">👤 ${planned ? '<i>previsto:</i> ' : ''}${esc(a.name)} · <span class="eng-tag">${esc(engineTag(a))}</span></button>`
    : open ? `<button type="button" class="who-chip warn" data-hire-role="${esc(t.role)}" title="${esc(t.plannedReason || 'nadie del equipo tiene ese rol')}. Clic: contratar un agente con ese rol">⚠️ sin agente para este rol</button>` : '';
  if (!chip) return '';
  const opts = open ? assignable(t) : [];
  const pick = opts.length || t.assignedAgentId ? `<select class="who-pick" data-assign="${t.id}" title="Asignar a… fija quién hará la tarea (sin pasar por la regla del rol)"><option value="">Asignar a…</option>${opts.map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(engineTag(x))}</option>`).join('')}${t.assignedAgentId ? '<option value="__auto">(automático: por rol)</option>' : ''}</select>` : '';
  return `<div class="who">${chip}${pick}</div>`;
}
// El modal «Ver la tarea» no se repinta por SSE: solo se refresca su fila de agente al llegar un estado nuevo.
function refreshTaskWho() {
  const el = $('#dialog .task-who');
  const t = openTaskId && S.tasks.find((x) => x.id === openTaskId);
  if (el && t && $('#dialog').open) el.innerHTML = whoRow(t);
}

function card(t) {
  const agent = S.agents.find((a) => a.id === t.agentId);
  const deps = t.dependsOn.map((d) => {
    const dt = S.tasks.find((x) => x.id === d);
    return `<span title="${esc(dt?.title)}">${dt?.status === 'done' ? '✓' : '⏳'}${esc(dt ? tcode(dt) : '#' + d)}</span>`;
  }).join(' ');
  const acts = [];
  if (t.status === 'review') {
    acts.push(`<button class="small ghost" data-diff="${t.id}">Ver cambios</button>`);
    if (updateBtn(t)) acts.push(updateBtn(t));
    acts.push(`<button class="small ok" data-approve="${t.id}">✓ Aprobar${t.branch ? ' y fusionar' : ''}</button>`);
    acts.push(`<button class="small ghost" data-reject="${t.id}">↩ Devolver</button>`);
  }
  if (t.status === 'failed') acts.push(`<button class="small" data-reject="${t.id}">↻ Reintentar</button>`);
  if (t.status !== 'doing') acts.unshift(`<button class="small ghost" data-edit="${t.id}" title="Editar título, descripción, rol, repo y dependencias">✎</button>`);
  if (t.status === 'backlog') acts.push(`<button class="small" data-ready="${t.id}">→ Por hacer</button>`);
  if (t.status === 'todo') acts.push(`<button class="small ghost" data-park="${t.id}">← Backlog</button>`);
  if (t.status === 'failed') acts.push(`<button class="small ghost" data-park="${t.id}" title="Devolver al Backlog">← Backlog</button>`);
  if (['review', 'done'].includes(t.status)) acts.push(`<button class="small ghost" data-nomove="${t.id}" title="Mover a otra columna">⇄ Mover a…</button>`);
  if (['todo', 'failed', 'done'].includes(t.status)) acts.push(`<button class="small danger" data-del="${t.id}">Borrar</button>`);
  return `<div class="card ${t.status}" data-task="${t.id}" draggable="${['backlog', 'todo', 'failed'].includes(t.status)}" style="--c:${S.roles[t.role]?.color}">
    <div class="card-head">${roleChip(t.role)} <span class="task-id" title="Código de la tarea (rama ao/${t.code || t.id}; cítalo en commits y docs)">${esc(tcode(t))}</span>${(project()?.repos || []).length > 1 && (t.repo || t.branch) ? ` <span class="repo-chip">📁 ${esc(t.repo || '?')}</span>` : ''}${t.source?.flow ? ` <span title="Importada del tablero «${esc(t.source.flow)}» · columna ${esc(t.source.column)}">🗂</span>` : ''}${(t.feedbackImages?.length || t.files?.length) ? ` <span title="${esc([...(t.feedbackImages || []), ...(t.files || [])].map((f) => f.split('/').pop()).join(', '))}">📎${(t.feedbackImages?.length || 0) + (t.files?.length || 0)}</span>` : ''}${t.source?.url ? ` <a class="ext" href="${esc(t.source.url)}" target="_blank" rel="noopener" title="${esc(BOARD_LABELS[t.source.kind] || t.source.kind)} · ${esc(t.source.id)}${t.source.remoteStatus ? ' · fuera: ' + esc(t.source.remoteStatus) : ''}">🔗 ${esc(t.source.id)}</a>` : ''}${t.kind === 'plan' ? ' <span>🗂 plan</span>' : ''}${t.attempts > 1 ? ` <span>intento ${t.attempts}</span>` : ''}</div>
    <div class="t">${esc(t.title)}</div>
    ${whoRow(t)}
    ${t.context ? `<div class="meta">${bornFrom(t)}</div>` : ''}
    ${t.modelHistory?.length ? `<div class="meta"><span class="model-ladder" title="Cascada de modelos (FT-60): empieza barato y sube al devolverla o si falla${t.minModel ? '. Mínimo de la tarea: ' + esc(t.minModel) : ''}">🧠 ${esc(t.modelHistory.map((x) => x.model).filter((m, i, a) => m !== a[i - 1]).join(' → '))}</span></div>` : ''}
    ${deps || t.costUsd ? `<div class="meta">${deps ? `<span>depende de ${deps}</span>` : ''}${t.costUsd ? ` <span>💲${t.costUsd.toFixed(3)}</span>` : ''}</div>` : ''}
    ${t.status === 'doing' && agent ? `<div class="live">● ${esc(agent.activity)}</div>` : ''}
    ${t.status === 'todo' && t.quotaBlocked && t.activity ? `<div class="quota-hold">${esc(t.activity)}</div>` : ''}
    ${['todo', 'backlog'].includes(t.status) && S.costEstimates?.[t.role] != null ? `<div class="meta"><span class="cost-est" title="Estimación: mediana del coste de las últimas tareas hechas por el rol ${esc(t.role)}. Tope por intento: ${S.settings.maxTaskUsd || 3} $">≈ ${S.costEstimates[t.role].toFixed(2)} $</span></div>` : ''}
    ${t.quotaPaused && t.status === 'todo' ? `<div class="quota-hold">${esc(t.activity || '⏸ sin cuota')}${t.quotaPaused.resetsAt > Date.now() ? ` (en ${fmtLeft(t.quotaPaused.resetsAt)})` : ''} <button class="small ghost" data-resume-now="${t.id}" title="Ignorar la espera y relanzarla en el siguiente reparto">▶ Reanudar ya</button></div>` : ''}
    ${t.stuck && t.status === 'review' ? `<div class="quota-hold">⚠️ atascado: ${esc(t.stuck)}</div>` : ''}
    ${t.budgetHit && t.status === 'review' ? '<div class="quota-hold">⚠️ cortada por el tope de gasto: revisa y decide</div>' : ''}
    ${t.summary && t.status !== 'doing' ? `<div class="sum">${esc(t.summary)}</div>` : ''}
    ${mergeChips(t) ? `<div class="merge-row">${mergeChips(t)}</div>` : ''}
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
    <button class="small ghost expand" data-open="${t.id}">🔍 Ver la tarea</button>
    ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
  </div>`;
}

// ── Panel del agente (AgentDetailPanel, FT-68) ─────────────────────────────
const STATUS_META = {
  working: { label: 'Trabajando', color: '#34d399' },
  waiting: { label: 'Esperando', color: '#60a5fa' },
  reviewing: { label: 'Revisando', color: '#fbbf24' },
  blocked: { label: 'Bloqueado', color: '#f59e0b' },
  failed: { label: 'Fallido', color: '#f87171' },
  idle: { label: 'Descansando', color: '#94a3b8' },
  paused: { label: 'En pausa', color: '#fbbf24' },
};
const STATUS_EVENTS = {
  AgentStarted: 'working', AgentResumed: 'working', AgentProgress: 'working',
  AgentPaused: 'paused', AgentBlocked: 'blocked', AgentFailed: 'failed', AgentCompleted: 'idle',
};
function effectiveStatus(a) {
  const task = S.tasks.find((t) => t.id === a?.taskId);
  if (a?.status === 'working' && task?.status === 'review') return 'reviewing';
  if (a?.status === 'idle' && S.tasks.some((t) => t.agentId === a.id && t.status === 'failed')) return 'failed';
  return a?.status || 'idle';
}
function statusMeta(a) { return STATUS_META[effectiveStatus(a)] || STATUS_META.idle; }
function rememberActivity(ev) {
  if (!ev?.agentId) return;
  const arr = activityByAgent.get(ev.agentId) || [];
  if (!arr.some((x) => x.id === ev.id)) arr.push(ev);
  arr.sort((a, b) => a.ts - b.ts);
  if (arr.length > 80) arr.splice(0, arr.length - 80);
  activityByAgent.set(ev.agentId, arr);
  if (STATUS_EVENTS[ev.type]) statusSinceByAgent.set(ev.agentId, { status: STATUS_EVENTS[ev.type], ts: ev.ts });
}
async function loadAgentActivity(id) {
  if (activityLoaded.has(id)) return;
  activityLoaded.add(id);
  try {
    const events = await api('GET', `/api/events?agentId=${encodeURIComponent(id)}&limit=80`);
    events.forEach(rememberActivity);
    if (drawerAgent === id) renderDrawer();
  } catch { activityLoaded.delete(id); }
}
function statusSince(a) {
  const now = Date.now(), current = effectiveStatus(a);
  const events = activityByAgent.get(a.id) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const st = STATUS_EVENTS[events[i].type];
    if (st && (st === current || (current === 'reviewing' && st === 'working'))) return events[i].ts;
  }
  const cached = statusSinceByAgent.get(a.id);
  return cached?.ts || a.updatedAt || a.createdAt || now;
}
function durationSince(ts) {
  const s = Math.max(0, Math.floor((Date.now() - Number(ts || Date.now())) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function eventText(ev) {
  const d = ev.data || {};
  if (ev.type === 'AgentToolStarted') return `usando ${d.tool || 'herramienta'}${d.summary ? ': ' + d.summary : ''}`;
  if (ev.type === 'AgentToolFinished') return d.ok === false ? 'herramienta con error' : 'herramienta completada';
  if (ev.type === 'AgentProgress') return d.activity || 'actualizando progreso';
  if (ev.type === 'AgentFileModified') return `modificando ${d.path || 'fichero'}`;
  if (ev.type === 'AgentArtifactCreated') return d.kind === 'commit' ? `commit${d.sha ? ' ' + String(d.sha).slice(0, 7) : ''}${d.branch ? ' en ' + d.branch : ''}` : `creando ${d.kind || 'artefacto'}`;
  if (ev.type === 'AgentStarted') return `empezando ${ev.taskCode || 'tarea'}${d.engine ? ' con ' + d.engine : ''}`;
  if (ev.type === 'TaskAssigned') return `asignado a ${ev.taskCode || 'tarea'}`;
  if (ev.type === 'AgentPaused') return 'pausado';
  if (ev.type === 'AgentResumed') return 'reanudado';
  if (ev.type === 'AgentBlocked') return `bloqueado${d.reason ? ': ' + d.reason : ''}`;
  if (ev.type === 'AgentFailed') return `error: ${d.error || 'fallo del agente'}`;
  if (ev.type === 'AgentCompleted') return d.status === 'review' ? 'entregado a revisión' : 'tarea completada';
  if (ev.type === 'UserInstructionAdded') return d.kind === 'message' ? 'mensaje recibido del usuario' : 'instrucción añadida';
  return ev.type.replace(/^Agent/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}
function activeTool(a) {
  const events = activityByAgent.get(a.id) || [];
  const tool = [...events].reverse().find((e) => e.type === 'AgentToolStarted');
  const engine = a.activeEngine || a.engine || 'auto';
  return `${engine}${a.model ? ' · ' + a.model : ''}${tool ? ` · ${tool.data?.tool || 'herramienta'}${tool.data?.summary ? ' · ' + tool.data.summary : ''}` : ''}`;
}
function openDrawer(id, { skipFocus = false } = {}) {
  drawerAgent = id;
  $('#drawer').hidden = false;
  $('#drawer').setAttribute('role', 'dialog');
  $('#drawer').setAttribute('aria-modal', 'true');
  $('#drawer').tabIndex = -1;
  loadAgentActivity(id);
  if (!skipFocus && activeTab === 'office') {
    officeLevel = 'agent';
    officeMode = 'floor';
    office.focusAgent?.(id);
  }
  render();
  renderLog();
  requestAnimationFrame(() => $('#drawer')?.focus({ preventScroll: true }));
}
function closeDrawer({ keepOfficeLevel = false } = {}) {
  drawerAgent = null;
  $('#drawer').hidden = true;
  if (!keepOfficeLevel && officeLevel === 'agent') {
    officeLevel = 'floor';
    office.clearAgentFocus?.();
  }
  render();
}

// Control de workers (FT-5): pausar / reanudar / mensaje en caliente.
const busy = (a) => a.status === 'working' || a.status === 'paused';
const controls = (a) => `${a.status === 'paused' ? `<button class="small ok" data-resume="${a.id}" title="Reanudar (SIGCONT)">▶ Reanudar</button>` : `<button class="small ghost" data-pause="${a.id}" title="Pausar (SIGSTOP): congela al agente sin perder su trabajo">⏸ Pausar</button>`}<button class="small ghost" data-msg="${a.id}" title="Mandarle una instrucción en caliente">✉ Mensaje</button>`;
function messageDialog(agentId) {
  const a = S.agents.find((x) => x.id === agentId);
  if (!a) return;
  const t = S.tasks.find((x) => x.id === a.taskId);
  dialog(`
    <h3>✉ Mensaje a ${esc(a.name)}${t ? ` · ${esc(tcode(t))}` : ''}</h3>
    <p class="muted">${(a.activeEngine || a.engine) === 'claude' ? 'Llega a mitad de turno como instrucción prioritaria.' : 'Este motor no admite mensajes en caliente: se parará al agente y se reencolará la misma tarea (misma rama) con tu mensaje.'}</p>
    <label>Instrucción</label><textarea name="text" rows="4" required autofocus placeholder="p. ej. no toques server/index.js"></textarea>
    <label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0"><input type="checkbox" name="constraint" style="width:auto" /> Guardar como restricción de la tarea (se repite en cada ejecución, también tras Devolver)</label>
    ${buttons('Enviar')}`, async (f) => { const r = await api('POST', `/api/agents/${agentId}/message`, { text: f.text, constraint: !!f.constraint }); toast(r.delivered === 'live' ? 'Mensaje entregado al agente' : 'Tarea reencolada con tu mensaje'); });
}

function renderDrawer() {
  const a = S.agents.find((x) => x.id === drawerAgent);
  if (!a) return closeDrawer();
  const task = S.tasks.find((t) => t.id === a.taskId);
  const d = $('#drawer');
  const role = S.roles[a.role];
  const meta = statusMeta(a);
  const recent = (activityByAgent.get(a.id) || []).slice(-8).reverse();
  const controlsHtml = busy(a) ? controls(a) : `<button class="small ghost" data-msg="${a.id}" title="Mandarle una instrucción">✉ Mensaje</button>`;
  const taskHtml = task ? `<button class="linklike" data-open="${task.id}"><b>${esc(tcode(task))}</b> ${esc(task.title)}</button>` : '<span class="muted">Sin tarea activa</span>';
  const activityHtml = recent.length ? recent.map((ev) => `<li class="${ev.type === 'AgentFailed' ? 'bad' : ''}"><span>${esc(eventText(ev))}</span><time>${ago(ev.ts)}</time></li>`).join('') : '<li><span class="muted">Sin actividad reciente en el stream.</span></li>';
  // Si ya está pintado, solo refrescamos lo que cambia (no perder el foco de los inputs).
  if (d.dataset.agent === a.id) {
    d.querySelector('[data-f=status]').innerHTML = `<span class="dot" style="background:${meta.color};box-shadow:0 0 8px ${meta.color}"></span>${esc(meta.label)}<span class="muted">${durationSince(statusSince(a))}</span>`;
    d.querySelector('[data-f=activity]').innerHTML = activityHtml;
    d.querySelector('[data-f=tool]').textContent = activeTool(a);
    d.querySelector('[data-f=controls]').innerHTML = controlsHtml;
    d.querySelector('[data-f=task]').innerHTML = taskHtml;
    d.querySelector('[data-f=current]').textContent = a.activity || (effectiveStatus(a) === 'idle' ? 'Disponible' : meta.label);
    d.querySelector('[data-stop]').hidden = !busy(a);
    return;
  }
  d.dataset.agent = a.id;
  d.innerHTML = `
    <div class="agent-panel-head"><span class="avatar big" style="--c:${role?.color || '#999'}">${esc(a.name).charAt(0).toUpperCase()}</span><div><h2>${esc(a.name)}</h2><div>${roleChip(a.role)}</div></div><div class="spacer"></div><button class="ghost small" data-close aria-label="Cerrar ficha">✕</button></div>
    <div class="agent-status" data-f="status"></div>
    <div class="agent-current" data-f="current"></div>
    <section class="agent-panel-card">
      <h3>Tarea actual</h3>
      <div data-f="task"></div>
    </section>
    <section class="agent-panel-card">
      <h3>Herramienta activa</h3>
      <div class="tool-line" data-f="tool"></div>
    </section>
    <section class="agent-panel-card">
      <h3>Motor y modelo</h3>
      <div class="grid">
        <span class="muted">Motor</span>
        <select data-f="engine">${S.engines.map((e) => `<option ${e === a.engine ? 'selected' : ''}>${e}</option>`).join('')}</select>
        <span class="muted">Modelo</span><div data-f="modelbox">${modelSelect('model', a.engine, a.model || '')}</div>
      </div>
    </section>
    <section class="agent-panel-card">
      <h3>Actividad reciente</h3>
      <ul class="agent-activity" data-f="activity"></ul>
    </section>
    <details class="agent-panel-card agent-memory" data-memory>
      <summary><h3 style="display:inline">🧠 Memoria</h3> <span class="muted" data-mem-size></span></summary>
      <p class="muted">Lecciones que se le pasan en sus próximas tareas (las añade él al terminar y las correcciones de «Devolver»). Una por línea; bórrale lo que no valga. Tope ≈1 500 tokens por bloque.</p>
      <label>Suya</label><textarea rows="5" data-mem="agent" placeholder="(vacía)"></textarea>
      <label>De todo el proyecto</label><textarea rows="4" data-mem="project" placeholder="(vacía)"></textarea>
      <div class="row"><button class="small" data-mem-save>Guardar memoria</button></div>
    </details>
    <div class="agent-actions" data-f="controls"></div>
    <div class="agent-actions">
      ${task ? `<button class="small" data-open="${task.id}">Abrir tarea</button>` : ''}
      <button class="small ghost" data-log-focus>Ver log</button>
      <button class="small ghost" data-agent-edit="${a.id}">Reasignar / editar</button>
      <button class="danger small" data-stop="${a.id}">⏹ Parar</button>
    </div>
    <div class="muted">Registro en vivo</div>
    <div id="log"></div>`;
  // FT-75: memoria del agente y del proyecto (se carga al desplegar la sección)
  const memBox = d.querySelector('[data-memory]');
  const pid = S.projects.find((x) => (x.team || []).includes(a.id))?.id || projectId;
  const memLoad = async () => {
    const [ag, pr] = await Promise.all([api('GET', `/api/memory/${pid}?agent=${a.id}`), api('GET', `/api/memory/${pid}`)]);
    memBox.querySelector('[data-mem=agent]').value = ag.text; memBox.querySelector('[data-mem=project]').value = pr.text;
    memBox.querySelector('[data-mem-size]').textContent = `${Math.round((ag.text.length + pr.text.length) / 4)} tokens`;
  };
  memBox.addEventListener('toggle', () => { if (memBox.open) memLoad().catch(() => {}); });
  memBox.querySelector('[data-mem-save]').onclick = async () => {
    await api('PUT', `/api/memory/${pid}?agent=${a.id}`, { text: memBox.querySelector('[data-mem=agent]').value });
    await api('PUT', `/api/memory/${pid}`, { text: memBox.querySelector('[data-mem=project]').value });
    toast('Memoria guardada'); memLoad().catch(() => {});
  };
  d.querySelector('[data-f=engine]').onchange = (e) => {
    const box = d.querySelector('[data-f=modelbox] .model-pick');
    repaintModel(box, e.target.value, modelPickValue(box)); // FT-55: la lista de modelos sigue al motor elegido
    api('PATCH', `/api/agents/${a.id}`, { engine: e.target.value }).then(() => toast(`${a.name} usa ahora ${e.target.value}`));
  };
  // FT-55: guardar al elegir (en «Otro…», al confirmar el id escrito)
  const saveModel = (e) => {
    const w = e.target.closest('.model-pick');
    if (!w || e.target.closest('.model-refresh')) return;
    if (e.target.matches('.model-select') && e.target.value === '__other') return;
    const inp = w.querySelector('.model-other');
    if (e.target.matches('.model-other') && !inp.reportValidity()) return;
    const model = modelPickValue(w);
    api('PATCH', `/api/agents/${a.id}`, { model }).then(() => toast(model ? `${a.name} usa el modelo ${model}` : `${a.name}: modelo por defecto`));
  };
  d.querySelector('[data-f=modelbox]').addEventListener('change', saveModel);
  renderDrawer();
  renderLog();
}

function renderLog() {
  const el = $('#log');
  if (!el) return;
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = (logs.get(drawerAgent) || []).map((l) =>
    `<div class="log-line ${logKind(l.line)}"><span class="ts">${new Date(l.ts).toLocaleTimeString()}</span> ${esc(l.line)}</div>`).join('') || '<span class="muted">Aún no ha hecho nada.</span>';
  if (stick) el.scrollTop = el.scrollHeight;
}

function logKind(line) {
  const s = String(line ?? '').trim();
  if (/^(⚠|❌)/.test(s) || /\b(error|failed|fall[oó]|exception)\b/i.test(s)) return 'error';
  if (/^🔧/.test(s) || /\b(tool|herramienta|exec|command)\b/i.test(s)) return 'tool';
  if (/^💬/.test(s) || /\b(message|mensaje|assistant|user)\b/i.test(s)) return 'message';
  if (/^(✋|✅)/.test(s) || /\b(done|hecho|milestone|hito|aprob)/i.test(s)) return 'milestone';
  return '';
}

// ── Diálogos ───────────────────────────────────────────────────────────────
function dialog(html, onSubmit, cls = '') {
  const dlg = $('#dialog');
  dlg.className = cls;
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  const form = dlg.querySelector('form');
  form.onsubmit = async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    try { await onSubmit?.(Object.fromEntries(new FormData(form))); dlg.close(); } catch { /* el toast ya avisó */ }
  };
  dlg.showModal();
  if (Date.now() - modelsAt >= 300000) loadModels().then(() => dlg.querySelectorAll('.model-pick').forEach((w) => repaintModel(w, w.dataset.engine, modelPickValue(w)))); // lista viva (FT-55)
}
// Dictado por voz en campos del diálogo (FT-43): sin soporte el botón no se pinta; con él, un clic dicta y otro para.
// STT del servidor disponible (GET /api/guide/stt): el dictado prefiere ese camino (audio local) y deja la Web Speech API de respaldo.
let sttLocalOk = false;
const refreshSttLocal = () => api('GET', '/api/guide/stt').then((st) => { sttLocalOk = !!(st.providers || []).find((p) => p.name === st.provider)?.ok; ensureGoalMic(); }).catch(() => ensureGoalMic());
const dictationViaServer = () => sttLocalOk && safeGet('ao:dictation') !== 'browser';
const MIC_BTN = '<button type="button" class="mic-btn" data-mic title="Dictar por voz (clic para empezar, otro para parar)" aria-pressed="false">🎤</button>';
const micField = (field) => `<div class="mic-wrap">${field}${dictationSupported({ server: dictationViaServer() }) ? MIC_BTN : ''}</div>`;
// La barra «🎯 Objetivo para el PO» también se dicta: el botón se añade cuando se sabe si hay STT (del servidor o del navegador).
function ensureGoalMic() {
  const w = document.querySelector('#goal-form .mic-wrap');
  if (!w || w.querySelector('[data-mic]') || !dictationSupported({ server: dictationViaServer() })) return;
  w.insertAdjacentHTML('beforeend', MIC_BTN);
}
let dictation = null; // { btn, dict }: un solo dictado a la vez
function micStop() { dictation?.dict.stop(); }
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-mic]');
  if (!btn) return;
  const field = btn.closest('.mic-wrap').querySelector('input, textarea');
  if (dictation?.btn === btn) return micStop(); // segundo clic: parar
  micStop();
  const mark = (on) => { btn.classList.toggle('rec', on); btn.setAttribute('aria-pressed', on); btn.title = on ? 'Grabando… clic para parar' : 'Dictar por voz (clic para empezar, otro para parar)'; if (!on && dictation?.btn === btn) dictation = null; };
  const lang = ({ es: 'es-ES', en: 'en-US', ca: 'ca-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', it: 'it-IT' })[S.settings.sttLang] || navigator.language || 'es-ES';
  const server = dictationViaServer() ? { record: (o) => voiceRecord(null, o), transcribe: voiceTranscribe } : null; // audio al STT local del servidor
  const dict = createDictation({ lang, server, onText: (t) => insertAtCursor(field, t), onState: mark, onError: (m) => { btn.disabled = /permiso|permite/.test(m); toast(m, 'error'); } });
  dictation = { btn, dict };
  field.focus();
  dict.start();
});
document.addEventListener('close', (e) => { if (e.target.id === 'dialog') micStop(); }, true); // al cerrar el diálogo se corta el micro
const buttons = (ok = 'Guardar') => `<div class="row"><button class="ghost" value="cancel">Cancelar</button>${ok ? `<button>${ok}</button>` : ''}</div>`;
const roleOptions = (sel, skipPo) => Object.entries(S.roles).filter(([, r]) => !(skipPo && r.kind === 'planner'))
  .map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''} title="${esc(r.description || '')}">${esc(r.label)}${r.custom ? ` · ${esc(r.source)}` : ''}${r.kind === 'planner' ? ' (planifica)' : r.kind === 'qa' ? ' (QA)' : r.kind === 'docs' ? ' (documenta)' : ''}</option>`).join('');
const ENGINE_LABEL = { auto: 'automático (el que esté libre: Claude o Codex)', claude: 'Claude Code', codex: 'Codex', local: 'IA local (LM Studio / Ollama)', demo: 'demo (simulado)' };
const engineOptions = (sel) => S.engines.map((e) => `<option value="${e}" ${e === sel ? 'selected' : ''}>${ENGINE_LABEL[e] || e}</option>`).join('');

const actions = {
  'add-repo': () => editRepo(''),
  'new-role': () => editRole('', false),
  'reload-skills': () => renderSkills(true),
  'new-skill': () => dialog(`
    <h3>＋ Nueva skill en el catálogo</h3>
    <label>Nombre (sin espacios)</label><input name="name" placeholder="mi-skill" required autofocus />
    <label>Descripción (cuándo usarla; es lo que lee el modelo para decidir)</label><input name="description" />
    <label>Instrucciones (cuerpo del SKILL.md, Markdown)</label><textarea name="body" class="code" rows="10"># Mi skill

Pasos, convenciones y ejemplos…</textarea>
    ${buttons('Crear')}`, async (f) => { const r = await api('POST', '/api/skills/new', f); toast(`Skill «${r.name}» creada en el catálogo`); renderSkills(true); }),
  sync: async () => { const r = await api('POST', '/api/sync'); toast(`Carpetas de flow-test: ${r.folders.join(', ')}${r.created ? ` · ${r.created} proyecto(s) nuevo(s)` : ''}`); },
  'new-project': () => dialog(`
    <h3>Nuevo proyecto</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Repositorios git (opcional; uno por línea, <code>clave = ruta</code> o solo la ruta; <code>clave = ruta @ rol1,rol2</code> fija qué roles trabajan en ese repo)</label>
    <textarea name="repos" rows="3" placeholder="~/dev/mi-api @ back,qa&#10;~/dev/mi-web @ front"></textarea>
    <label>Motor del equipo</label><select name="engine">${engineOptions('auto')}</select>
    <p class="muted">Cada tarea se hace en un git worktree propio del repo que le toca (rama <code>ao/&lt;tarea&gt;</code>); nada llega a tu rama hasta que apruebas. Sin repo solo funciona el motor <b>demo</b>.</p>
    ${buttons('Crear')}`, async (f) => {
    const p = await api('POST', '/api/projects', { name: f.name, engine: f.engine, repos: parseRepos(f.repos) });
    projectId = p.id;
    safeSet('ao:project', p.id);
  }),
  quota: () => showTab('summary'), // FT-45: el chip de cuota abre el Resumen
  building: () => setOfficeMode('building'), // FT-47: «🏢 Edificio» en el pie de la Oficina
  'office-floor': () => leaveAgentLevel(), // FT-71: agente → planta sin saltar al edificio
  'toggle-run': () => api('POST', `/api/projects/${projectId}/run`, { running: !project()?.running }),
  hire: (role) => dialog(`
    <h3>Contratar agente</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Rol</label><select name="role">${roleOptions(S.roles[role] ? role : 'back')}</select>
    <label>Motor</label><select name="engine">${engineOptions('auto')}</select>
    <label>Modelo (opcional)</label>${modelSelect('model', 'auto', '')}
    ${buttons('Contratar')}`, (f) => api('POST', '/api/agents', { ...f, model: pickModel(f), projectId })),
  'new-task': () => { pendingAttachments = []; dialog(`
    <h3>Nueva tarea</h3>
    <label>Título <span class="muted">(con «Redactar con IA» puedes dejarlo vacío)</span></label>${micField('<input name="title" autofocus />')}
    <label>Descripción <span class="muted">(a mano, dictada con 🎤, o en bruto para que la IA la redacte)</span></label>${micField('<textarea name="description" rows="5" placeholder="Qué hay que hacer y cómo saber que está bien. Con ✨ basta con contarlo a tu manera: la IA lo convierte en una tarea completa."></textarea>')}
    ${attachArea()}
    <label>Para quién</label><select name="role">${whoOptions()}</select>
    ${(project()?.repos || []).length > 1 ? `<label>Repositorio</label><select name="repo"><option value="">(el que diga el rol)</option>${project().repos.map((r) => `<option value="${r.key}">${esc(r.key)} — ${esc(r.path)}</option>`).join('')}</select>` : ''}
    <label>Estado inicial</label><select name="status"><option value="todo">Por hacer (el equipo la coge en cuanto pueda)</option><option value="backlog">Backlog (esperar)</option></select>
    <div class="row"><button type="button" class="ghost" data-ai-draft title="Pasa tu texto y los adjuntos por la IA (Claude), que redacta título, descripción con criterios de «hecho cuando», rol y repo, y crea la tarea en Backlog para que la revises">✨ Redactar con IA y crear</button><div class="spacer"></div><button class="ghost" value="cancel">Cancelar</button><button>Crear</button></div>`, async (f) => {
    if (f.role === '__po') {
      const goal = [f.title, f.description].filter((x) => x?.trim()).join('\n\n');
      if (!goal.trim()) { toast('Cuenta qué quieres que se haga', 'error'); throw new Error('vacío'); }
      await api('POST', `/api/projects/${projectId}/goal`, { goal, title: f.title, attachments: pendingAttachments });
      toast('Encargado al PO: decidirá quién lo hace y creará la tarea');
      return;
    }
    if (!f.title?.trim()) { toast('Pon un título o usa «Redactar con IA»', 'error'); throw new Error('sin título'); }
    return api('POST', '/api/tasks', { ...f, projectId, attachments: pendingAttachments });
  }); },
  settings: () => dialog(`
    <h3>Ajustes</h3>
    <div class="section-title">🧠 Motores de IA — las inteligencias que llevan la empresa</div>
    <div id="engines" class="engines"><p class="muted">Comprobando cuentas…</p></div>
    <div id="local-ai" class="engines"></div>
    <div class="section-title">🧪 Suite</div>
    <label>URL de flow-test (la suite; su MCP se usa para el QA)</label><input name="flowTestUrl" value="${esc(S.settings.flowTestUrl)}" placeholder="http://localhost:9998" />
    <label>Carpeta del workspace de flow-test en esta máquina (para deducir los repos de cada proyecto por sus enlaces)</label><input name="workspaceHostDir" value="${esc(S.settings.workspaceHostDir || '')}" placeholder="~/JksDocs/workspace" />
    <label>Agentes trabajando a la vez (máx.)</label><input name="maxParallel" type="number" min="1" max="8" value="${S.settings.maxParallel}" />
    <div class="grid2"><div><label>Tope de gasto por tarea (US$, por intento; al pasarlo se corta)</label><input name="maxTaskUsd" type="number" min="0.5" max="50" step="0.5" value="${S.settings.maxTaskUsd || 3}" /></div>
    <div><label>Esfuerzo de los agentes (más = más tokens)</label><select name="agentEffort">${['low', 'medium', 'high'].map((v) => `<option value="${v}" ${(S.settings.agentEffort || 'medium') === v ? 'selected' : ''}>${({ low: 'bajo', medium: 'medio (recomendado)', high: 'alto' })[v]}</option>`).join('')}</select></div></div>
    <div class="grid2"><div><label>Escalera de modelos · Claude (de barato a caro, separados por coma; FT-60)</label><input name="ladder_claude" value="${esc((S.modelLadders?.claude || []).join(', '))}" placeholder="haiku, sonnet" /></div>
    <div><label>Escalera de modelos · Codex (el mini sale de models_cache.json)</label><input name="ladder_codex" value="${esc((S.modelLadders?.codex || []).join(', '))}" placeholder="gpt-5.5" /></div></div>
    <p class="muted">Cada tarea empieza en el primer peldaño y sube uno al devolverla desde revisión o si el agente falla (máx. 2 veces). Un modelo fijado en el agente o el rol no entra en la cascada.</p>
    <label>Objetivo de costes (FT-76): coste por tarea aprobada ≤ X % del interactivo</label><input name="costTargetPct" type="number" min="10" max="500" step="5" value="${S.settings.costTargetPct || 100}" />
    <label><input type="checkbox" name="cacheAffinity" ${S.settings.cacheAffinity !== false ? 'checked' : ''} /> Agrupar tareas del mismo repo y rol seguidas para aprovechar la caché del prompt (FT-64)</label>
    <label><input type="checkbox" name="stuckGuard" ${S.settings.stuckGuard !== false ? 'checked' : ''} /> Detectar agentes atascados: aviso y, si sigue, parar y pasar a Revisión (FT-62)</label>
    <div class="grid2"><div><label>Mismo comando/lectura (veces)</label><input name="stuckRepeat" type="number" min="2" max="20" value="${S.settings.stuckRepeat || 3}" /></div>
    <div><label>Errores de herramienta seguidos</label><input name="stuckErrors" type="number" min="2" max="30" value="${S.settings.stuckErrors || 4}" /></div>
    <div><label>Pasos sin editar (tareas de código)</label><input name="stuckNoEdit" type="number" min="5" max="200" value="${S.settings.stuckNoEdit || 25}" /></div>
    <div><label>Tokens por turno sin cambios en el worktree</label><input name="stuckTokens" type="number" min="5000" step="5000" value="${S.settings.stuckTokens || 80000}" /></div></div>
    <label title="FT-57 · Codex: se corta al llegar a estos tokens (0 = el equivalente al tope en US$)">Tope en tokens por intento (solo Codex; 0 = el equivalente al de US$)</label><input name="maxTaskTokens" type="number" min="0" step="100000" value="${S.settings.maxTaskTokens || 0}" />
    <label><input type="checkbox" name="agentMemory" ${S.settings.agentMemory !== false ? 'checked' : ''} /> Memoria de los agentes: lecciones de tareas anteriores en el prompt (FT-75; ≈1 500 tokens máx. por agente y por proyecto)</label>
    <label title="Codebase-Memory MCP (tree-sitter, local): el agente localiza funciones/clases con una consulta en vez de leer ficheros"><input type="checkbox" name="codeIndex" ${S.settings.codeIndex === true ? 'checked' : ''} ${S.codeIndexInstalled ? '' : 'disabled'} /> Índice de código por símbolos para Claude y Codex (FT-58)${S.codeIndexInstalled ? '' : ' — no instalado: ejecuta scripts/setup-code-index.sh'}</label>
    <label><input type="checkbox" name="quotaGuard" ${S.settings.quotaGuard !== false ? 'checked' : ''} /> Guardarraíl de cuota: no arrancar tareas con un motor cuya sesión de 5 h esté al ${97} % o más (FT-45)</label>
    <div class="section-title">🧭 Guía (FT-6)</div>
    <label>Proveedor del Guía (el LLM con el que conversa; los cuatro flujos funcionan igual con cualquiera) (FT-8)</label>
    <select name="guideProvider">${(S.guideProviders || []).map((p) => `<option value="${esc(p.id)}" ${(S.settings.guideProvider || 'claude-cli') === p.id ? 'selected' : ''}>${esc(p.label)}${p.ready ? '' : p.id === 'local-api' ? ' — sin configurar' : ' — sin clave API'}</option>`).join('')}</select>
    <label>Modelo con Claude Code (CLI)</label>${modelSelect('guideModel', 'claude', S.settings.guideModel || '')}
    ${(S.guideProviders || []).filter((p) => p.id !== 'claude-cli').map((p) => `<label>Modelo con ${esc(p.label)}</label><input name="gm_${esc(p.id)}" value="${esc(S.settings.guideModels?.[p.id] || '')}" placeholder="${esc(p.defaultModel)}" />`).join('')}
    <p class="muted">Las APIs usan la clave guardada en «Motores de IA» (Claude → Anthropic, Codex → OpenAI) o ANTHROPIC_API_KEY / OPENAI_API_KEY; URL base con ANTHROPIC_BASE_URL / OPENAI_BASE_URL. El coste por turno sale en el chat cuando el proveedor lo da.</p>
    <div class="section-title">🎤 Voz (FT-9)</div>
    <label>Transcripción (STT) <span id="stt-info" class="muted"></span></label>
    <select name="sttProvider"><option value="local-cmd" ${S.settings.sttProvider !== 'openai' ? 'selected' : ''}>Local · faster-whisper / AO_STT_CMD</option><option value="openai" ${S.settings.sttProvider === 'openai' ? 'selected' : ''}>OpenAI · /v1/audio/transcriptions</option></select>
    <label>Idioma hablado</label>
    <select name="sttLang">${[['es', 'Español'], ['en', 'English'], ['ca', 'Català'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['auto', 'Detectar']].map(([k, n]) => `<option value="${k}" ${(S.settings.sttLang || 'es') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label><input type="checkbox" name="voiceReview" ${voicePref.review() ? 'checked' : ''} /> Revisar antes de enviar (el texto dictado queda en la caja)</label>
    <label><input type="checkbox" name="voiceTts" ${voicePref.tts() ? 'checked' : ''} /> Leer en voz alta las respuestas cortas del Guía (solo en este navegador)</label>
    <div class="section-title">🔊 Voz del Guía (FT-52)</div>
    <label>Proveedor de voz <span id="tts-info" class="muted"></span></label>
    <select name="ttsProvider">${[['piper', 'Local · piper (sin nube, recomendado)'], ['openai', 'OpenAI · /v1/audio/speech (nube)'], ['browser', 'Navegador · speechSynthesis (respaldo)']].map(([k, n]) => `<option value="${k}" ${(S.settings.ttsProvider || 'piper') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label>Voz</label>
    <div style="display:flex;gap:8px;align-items:center"><select name="ttsVoice" id="tts-voice" style="flex:1"><option>Cargando…</option></select><button type="button" class="small" data-tts-test>🔊 Probar voz</button></div>
    <p class="muted">Con piper la voz se genera en este PC; la primera vez se descarga el modelo (~75 MB) de Hugging Face. Con OpenAI el texto de la respuesta sale a la nube. El botón ▶ de cada respuesta del Guía y la casilla «Leer en voz alta» usan esta voz.</p>
    <label><input type="checkbox" name="voiceWake" ${voicePref.wake() ? 'checked' : ''} /> Escucha continua (di «oye guía») <span id="wake-info" class="muted"></span></label>
    <p class="muted">Apagada de serie. Con ella activa el micrófono queda abierto y se analiza en este navegador; solo los segmentos con voz van al STT local (nunca a OpenAI) para detectar «oye guía», con un indicador 👂 siempre visible (FT-36).</p>
    <div style="display:flex;gap:8px;align-items:center"><button type="button" class="small" data-voice-test>🎤 Probar micrófono</button><span id="voice-test" class="muted"></span></div>
    <div class="section-title">🛡 Guide Agent — qué puede hacer sin preguntarte (FT-4)</div>
    <label>Acciones que ponen a trabajar o pausan al equipo (ejecutar)</label>
    <select name="guideExecute"><option value="auto" ${S.guidePolicy?.execute === 'auto' ? 'selected' : ''}>Automático</option><option value="confirm" ${S.guidePolicy?.execute === 'confirm' ? 'selected' : ''}>Pedir confirmación</option></select>
    <label>Acciones que crean o editan datos (escribir)</label>
    <select name="guideWrite"><option value="auto" ${S.guidePolicy?.write === 'auto' ? 'selected' : ''}>Automático</option><option value="confirm" ${S.guidePolicy?.write !== 'auto' ? 'selected' : ''}>Pedir confirmación</option></select>
    <p class="muted">Leer y navegar son siempre automáticos; las acciones irreversibles (borrar) siempre piden confirmación.</p>
    <label><input type="checkbox" name="guideInputFallback" ${S.guidePolicy?.guideInputFallback ? 'checked' : ''} /> Permitir ratón y teclado (último recurso)</label>
    <p class="muted">Entrada «ciega» del Guide cuando ni la API interna, ni ui.find/ui.act ni application.open bastan. Apagado de serie; las teclas destructivas siempre piden confirmación (FT-30, FT-32).${S.guidePolicy?.input && !S.guidePolicy.input.ok ? ` <span class="bad">Faltan herramientas: ${esc(S.guidePolicy.input.missing.join(', ') || 'xdotool (X11) / ydotool (Wayland)')}. Instálalas para que funcione.</span>` : ''}</p>
    <hr style="border-color:var(--line);margin:16px 0" />
    <div class="section-title">🔗 Tablero online del proyecto «${esc(project()?.name)}»</div>
    <div id="board-cfg" class="board-cfg"><p class="muted">Cargando…</p></div>
    <div class="section-title">📁 Proyecto</div>
    <label>Prefijo de los códigos de tarea del proyecto «${esc(project()?.name)}» (p. ej. <code>GL</code> → GL-1, GL-2…; las tareas ya numeradas no cambian)</label><input name="prefix" value="${esc(project()?.prefix || "")}" placeholder="${esc(project()?.prefixDefault || "")}" maxlength="5" style="text-transform:uppercase;width:120px" />
    <label>Repositorios del proyecto «${esc(project()?.name)}» (uno por línea: <code>clave = ruta @ roles</code>)</label>
    <textarea name="repos" rows="3">${esc((project()?.repos || []).map((r) => `${r.key} = ${r.path}${r.roles?.length ? ' @ ' + r.roles.join(',') : ''}`).join('\n'))}</textarea>
    <label>Importar un tablero de flow-test (notas = tarjetas; las columnas «En revisión»/«Hecho» conservan su estado, el resto entra en Backlog)</label>
    <div style="display:flex;gap:8px"><select name="importFlow" id="import-flow"><option value="">— elegir flow —</option></select><button type="button" class="small" data-import-flow>Importar</button></div>
    <hr style="border-color:var(--line);margin:16px 0" />
    <button type="button" class="danger small" data-delete-project>Borrar el proyecto «${esc(project()?.name)}»</button>
    ${buttons()}`, async (f) => {
    safeSet('ao:voice-review', f.voiceReview ? '1' : '0'); safeSet('ao:voice-tts', f.voiceTts ? '1' : '0'); (SETTINGS_EMBED ? safeSet('ao:voice-wake', f.voiceWake ? '1' : '0') : wakeSet(!!f.voiceWake)); // en el panel de flow-test no se abre el micro: el iframe principal lo recoge por el evento `storage`
    refreshSttLocal();
    ttsStop();
    await api('POST', '/api/settings', { ...f, quotaGuard: !!f.quotaGuard, stuckGuard: !!f.stuckGuard, cacheAffinity: !!f.cacheAffinity, agentMemory: !!f.agentMemory, modelLadder: { claude: f.ladder_claude || '', codex: f.ladder_codex || '' }, codeIndex: !!f.codeIndex, guideModel: pickModel({ model: f.guideModel, model_other: f.guideModel_other }), guideModels: Object.fromEntries((S.guideProviders || []).filter((p) => p.id !== 'claude-cli').map((p) => [p.id, f['gm_' + p.id] || ''])), guidePolicy: { execute: f.guideExecute, write: f.guideWrite }, guideInputFallback: !!f.guideInputFallback });
    ttsInfoLoad();
    const repos = parseRepos(f.repos);
    const cur = (project()?.repos || []).map((r) => `${r.key}=${r.path}@${(r.roles || []).join(',')}`).join('|');
    if (repos.map((r) => `${r.key}=${r.path}@${(r.roles || []).join(',')}`).join('|') !== cur) await api('PATCH', `/api/projects/${projectId}`, { repos });
    if ((f.prefix || '').toUpperCase() !== (project()?.prefix || '')) await api('PATCH', `/api/projects/${projectId}`, { prefix: f.prefix });
  }),
};
// Tras abrir Ajustes, rellenar el selector de flows con los del flow-test conectado.
const BOARD_LABELS = { github: 'GitHub Issues', trello: 'Trello', jira: 'Jira' };

// ── Resumen de la empresa ───────────────────────────────────────────────────
// Una tabla con TODOS los proyectos (no solo el seleccionado): encendido o parado, tareas por columna, equipo, quién
// trabaja en qué, libres, coste y última actividad. Se repinta con cada `state` del SSE, así que siempre está al día.
let sumShowEmpty = false;
// Consumo de tokens (FT-26): «48,2k tok»; la barra solo existe si el CLI informó la ventana de contexto (Claude); Codex no la da → «n/d».
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) : n >= 1e3 ? (n / 1e3).toFixed(1) : String(n)).replace('.', ',') + (n >= 1e6 ? 'M' : n >= 1e3 ? 'k' : '') + ' tok';
const fmtN = (n) => fmtTok(n).replace(' tok', '');
// % de la ventana de contexto que lleva usada la sesión del agente (null si el motor no informa el límite).
const usagePct = (u) => (u?.limit && u.used != null ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null);
const pctSev = (pct) => (pct == null ? '' : pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : '');
const engineModel = (a) => `${a.usage?.engine || a.activeEngine || a.engine || '?'}${a.model ? ` · ${a.model}` : ''}`;

// ── Modales del Resumen (FT-53): «Tokens por sesión» y «Equipo» ──────────────
// La tabla del Resumen queda en una línea por proyecto y el detalle vive aquí. Mientras un modal está abierto, cada
// `state` del SSE repinta solo su cuerpo (`[data-sum-body]`) sin cerrarlo ni perder el foco del botón pulsado.
let sumModal = null; // { kind: 'tokens' | 'team', projectId: id | '*' (todos los proyectos) }
// Datos de un proyecto para los modales: su equipo y sus tareas (y el coste acumulado por agente, sumando sus tareas).
function sumProjectData(p) {
  const team = (p.team || []).map((id) => S.agents.find((a) => a.id === id)).filter(Boolean);
  const ts = S.tasks.filter((t) => t.projectId === p.id);
  return { p, team, ts, costOf: (a) => ts.filter((t) => t.agentId === a.id).reduce((n, t) => n + (t.costUsd || 0), 0) };
}
const sumProjects = (pid) => (pid === '*' ? S.projects.filter((p) => (p.team || []).length) : S.projects.filter((p) => p.id === pid)).map(sumProjectData);
const byTotalDesc = (x, y) => (y.usage?.total ?? -1) - (x.usage?.total ?? -1);
// Fila de un agente en el modal de tokens: nombre, rol, motor/modelo, total, ↓↑⚡, barra con «quedan…», coste.
function tokensRow(a, costOf) {
  const u = a.usage, pct = usagePct(u);
  const cell = (v) => (u && Number.isFinite(u.total) ? `<td class="num">${fmtN(v)}</td>` : '<td class="num muted">n/d</td>');
  const bar = !u ? '<span class="muted" title="Aún sin cifras de esta sesión (o el motor no las informa)">sin sesión</span>'
    : pct == null ? '<span class="muted" title="El CLI no informa la ventana de contexto">límite n/d</span>'
      : `<span class="tokbar ${pctSev(pct)}"><i style="width:${pct}%"></i></span> <span class="muted">${pct} % · quedan ${fmtN(Math.max(0, u.limit - u.used))}</span>`;
  const cost = costOf(a) || u?.costUsd || 0;
  return `<tr class="${a.status === 'idle' ? 'old' : ''}" data-sum-agent="${a.id}">
    <td><b>${esc(a.name)}</b></td><td>${roleChip(a.role)}</td><td class="muted">${esc(engineModel(a))}</td>
    <td class="num tok">${u && Number.isFinite(u.total) ? fmtN(u.total) : '<span class="muted">n/d</span>'}</td>${cell(u?.input)}${cell(u?.output)}${cell(u?.cache)}
    <td class="ctx">${bar}</td><td class="num">${cost ? cost.toFixed(2) + ' $' : '·'}</td></tr>`;
}
const sumOf = (list, k) => list.reduce((n, a) => n + (a.usage?.[k] || 0), 0);
function tokensModalBody(pid) {
  const groups = sumProjects(pid);
  const agents = groups.flatMap((g) => g.team);
  const cost = groups.reduce((n, g) => n + g.team.reduce((m, a) => m + (g.costOf(a) || a.usage?.costUsd || 0), 0), 0);
  const accumulated = groups.reduce((n, g) => n + g.ts.reduce((m, t) => m + (t.usage?.total || 0), 0), 0);
  const rows = groups.map((g) => `${groups.length > 1 ? `<tr class="sum-group"><td colspan="9">${esc(g.p.name)} <span class="muted">· ${g.team.length} agente${g.team.length === 1 ? "" : "s"} · ${fmtTok(sumOf(g.team, 'total'))}</span></td></tr>` : ''}${[...g.team].sort(byTotalDesc).map((a) => tokensRow(a, g.costOf)).join('')}`).join('');
  return `<table class="repos sum-detail">
    <thead><tr><th>Agente</th><th>Rol</th><th>Motor · modelo</th><th class="num">Total</th><th class="num">↓ Entrada</th><th class="num">↑ Salida</th><th class="num">⚡ Caché</th><th>Contexto</th><th class="num">Coste</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="muted">Sin equipo</td></tr>'}</tbody>
    <tfoot><tr data-sum-totals><td colspan="3"><b>Total</b> <span class="muted">· ${agents.length} agentes</span></td><td class="num tok">${fmtN(sumOf(agents, 'total'))}</td><td class="num">${fmtN(sumOf(agents, 'input'))}</td><td class="num">${fmtN(sumOf(agents, 'output'))}</td><td class="num">${fmtN(sumOf(agents, 'cache'))}</td><td></td><td class="num">${cost ? cost.toFixed(2) + ' $' : '·'}</td></tr></tfoot>
  </table>
  <p class="muted sum-note">Cifras de la sesión actual de cada agente (se reinician con cada tarea). Acumulado de todas las tareas${pid === '*' ? '' : ' del proyecto'}, intentos incluidos: <b>${fmtTok(accumulated)}</b>.</p>`;
}
// El mismo contenido en texto plano, para pegarlo en un chat o un informe.
function tokensModalText(pid) {
  const groups = sumProjects(pid);
  const line = (a, g) => { const u = a.usage; return `  ${a.name} (${S.roles[a.role]?.label || a.role}, ${engineModel(a)}): ${u ? `${fmtTok(u.total)} · ↓${fmtN(u.input)} ↑${fmtN(u.output)} ⚡${fmtN(u.cache)}${usagePct(u) != null ? ` · contexto ${usagePct(u)} % (quedan ${fmtN(Math.max(0, u.limit - u.used))})` : ''}` : 'sin sesión'}${(g.costOf(a) || u?.costUsd) ? ` · ${(g.costOf(a) || u.costUsd).toFixed(2)} $` : ''}`; };
  const agents = groups.flatMap((g) => g.team);
  return [`Tokens por sesión · ${pid === '*' ? 'todos los proyectos' : groups[0]?.p.name || ''}`, ...groups.flatMap((g) => [`${g.p.name}:`, ...[...g.team].sort(byTotalDesc).map((a) => line(a, g))]),
    `Total: ${fmtTok(sumOf(agents, 'total'))} · ↓${fmtN(sumOf(agents, 'input'))} ↑${fmtN(sumOf(agents, 'output'))} ⚡${fmtN(sumOf(agents, 'cache'))}`].join('\n');
}
// Estado de un agente para el modal de equipo: 💤 libre / ⚙ trabajando en FT-xx / ⏸ pausado / ❓ esperando respuesta.
function agentState(a) {
  const t = S.tasks.find((x) => x.id === a.taskId);
  const asking = (S.questions || []).some((q) => q.agentId === a.id);
  const code = t ? esc(tcode(t)) : '';
  if (a.status === 'paused') return { icon: '⏸', label: `pausado${code ? ` en ${code}` : ''}`, cls: 'paused', t };
  if (asking) return { icon: '❓', label: `esperando respuesta${code ? ` (${code})` : ''}`, cls: 'asking', t };
  if (a.status === 'working') return { icon: '⚙', label: `trabajando en ${code || 'una tarea'}`, cls: 'working', t };
  return { icon: '💤', label: 'libre', cls: 'idle', t };
}
function teamModalBody(pid) {
  const groups = sumProjects(pid);
  const order = { asking: 0, working: 1, paused: 2, idle: 3 };
  const rows = groups.map((g) => `${groups.length > 1 ? `<tr class="sum-group"><td colspan="5">${esc(g.p.name)}</td></tr>` : ''}${g.team.map((a) => ({ a, s: agentState(a) })).sort((x, y) => order[x.s.cls] - order[y.s.cls] || x.a.name.localeCompare(y.a.name)).map(({ a, s }) => `
    <tr data-sum-agent="${a.id}"><td><span class="avatar xs" style="--c:${S.roles[a.role]?.color}">${esc(a.name).charAt(0).toUpperCase()}</span> <b>${esc(a.name)}</b> ${roleChip(a.role)}</td>
    <td class="sum-state ${s.cls}">${s.icon} ${s.label}</td><td class="muted sum-act" title="${esc(s.t?.title || '')}">${esc(a.status === 'idle' ? '' : a.activity || '')}${s.t ? `<div class="muted small">${esc(s.t.title.slice(0, 60))}${s.t.title.length > 60 ? '…' : ''}</div>` : ''}</td>
    <td class="muted">${esc(engineModel(a))}</td>
    <td class="sum-acts"><button type="button" class="small ghost" data-sum-open="${a.id}" title="Abrir el panel del agente (registro en vivo, motor, pausar…)">Abrir</button>${s.t ? `<button type="button" class="small ghost" data-sum-task="${s.t.id}" title="Abrir la tarea ${esc(tcode(s.t))}">Ir a la tarea</button>` : ''}</td></tr>`).join('')}`).join('');
  const all = groups.flatMap((g) => g.team), n = (cls) => all.filter((a) => agentState(a).cls === cls).length;
  return `<table class="repos sum-detail"><thead><tr><th>Agente</th><th>Estado</th><th>Actividad</th><th>Motor · modelo</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">Sin equipo</td></tr>'}</tbody>
    <tfoot><tr data-sum-totals><td colspan="5"><b>${all.length} agentes</b> <span class="muted">· ${n('working')} trabajando · ${n('idle')} libres${n('paused') ? ` · ${n('paused')} en pausa` : ''}${n('asking') ? ` · ${n('asking')} esperando respuesta` : ''}</span></td></tr></tfoot></table>`;
}
const sumModalTitle = (kind, pid) => `${kind === 'tokens' ? 'Tokens por sesión' : 'Equipo'} · ${pid === '*' ? 'todos los proyectos' : esc(S.projects.find((p) => p.id === pid)?.name || '')}`;
const sumModalBody = ({ kind, projectId: pid }) => (kind === 'tokens' ? tokensModalBody(pid) : teamModalBody(pid));
function openSumModal(kind, pid) {
  sumModal = { kind, projectId: pid };
  dialog(`<h3>${sumModalTitle(kind, pid)}</h3><div data-sum-body>${sumModalBody(sumModal)}</div>
    <div class="row">${kind === 'tokens' ? '<button type="button" class="ghost" data-sum-copy title="Copiar la tabla como texto">📋 Copiar como texto</button>' : ''}<div class="spacer"></div><button class="ghost" value="cancel" autofocus>Cerrar</button></div>`, null, 'summary-modal');
}
// Repinta el modal abierto con el estado nuevo (lo llama renderSummary en cada `state`). Conserva el foco por data-*.
function refreshSumModal() {
  const dlg = $('#dialog');
  if (!sumModal || !dlg.open || dlg.className !== 'summary-modal') return;
  const body = dlg.querySelector('[data-sum-body]');
  if (!body) return;
  const f = document.activeElement, key = f && body.contains(f) ? [...f.attributes].find((at) => at.name.startsWith('data-sum-')) : null;
  dlg.querySelector('h3').innerHTML = sumModalTitle(sumModal.kind, sumModal.projectId);
  body.innerHTML = sumModalBody(sumModal);
  if (key) body.querySelector(`[${key.name}="${key.value}"]`)?.focus();
}
$('#dialog').addEventListener('close', () => { sumModal = null; });
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-sum-open]'), task = e.target.closest('[data-sum-task]'), copy = e.target.closest('[data-sum-copy]');
  if (!open && !task && !copy) return;
  if (copy) { navigator.clipboard?.writeText(tokensModalText(sumModal?.projectId ?? '*')).then(() => toast('Tabla copiada'), () => toast('No se pudo copiar', 'error')); return; }
  sumModal = null;
  $('#dialog').close();
  if (open) { showTab('agents'); openDrawer(open.dataset.sumOpen); }
  else { const t = S.tasks.find((x) => x.id === task.dataset.sumTask); if (t) { goProject(t.projectId); showTab('tasks'); openTask(t.id); } }
});
// ── Cuota de las suscripciones (FT-45) ──────────────────────────────────────
// Llega en S.quota por el SSE (el servidor la refresca cada 60 s). Barras como las del /usage de Claude Code.
const QUOTA_NAME = { claude: 'Claude', codex: 'Codex' };
const fmtLeft = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${Math.round(m / 1440)} d`; };
const quotaSev = (w) => (w.percent >= 95 || w.severity === 'critical' ? 'bad' : w.percent >= 80 || w.severity === 'warning' ? 'warn' : '');
const quotaWorst = (q) => (q?.ok && q.windows?.length ? q.windows.reduce((a, b) => (b.percent > a.percent ? b : a)) : null);
function quotaCard(e) {
  const q = S.quota?.[e];
  if (!q) return `<div class="quota-card"><b>${QUOTA_NAME[e]}</b> <span class="muted">leyendo…</span></div>`;
  if (!q.ok) return `<div class="quota-card off"><b>${QUOTA_NAME[e]}</b> <span class="muted">sin dato · ${esc(q.reason || '')}</span></div>`;
  return `<div class="quota-card"><div class="quota-head"><b>${QUOTA_NAME[e]}</b>${q.plan ? ` <span class="chip" style="--c:#93c5fd">${esc(q.plan)}</span>` : ''}${q.limitReached ? ' <span class="chip" style="--c:#f87171">límite alcanzado</span>' : ''}</div>
    ${q.windows.map((w) => `<div class="quota-row" data-quota-win="${esc(e)}:${esc(w.id)}"><span class="ql">${esc(w.label)}</span><span class="tokbar ${quotaSev(w)}"><i style="width:${Math.min(100, w.percent)}%"></i></span><b class="${quotaSev(w)}">${w.percent} %</b><span class="muted">${w.resetsAt ? 'se reinicia en ' + fmtLeft(w.resetsAt) : ''}</span></div>`).join('') || '<span class="muted">sin ventanas</span>'}</div>`;
}
const quotaBlockHtml = () => `<div class="section-title" style="margin-top:14px">Cuota de la suscripción</div><div class="quota-cards" id="quota-cards">${['claude', 'codex'].map(quotaCard).join('')}</div>`;
function renderQuotaChip() {
  const el = $('#quota-chip');
  if (!el) return;
  const parts = ['claude', 'codex'].map((e) => ({ e, w: quotaWorst(S.quota?.[e]) })).filter((x) => x.w);
  el.hidden = !parts.length;
  if (!parts.length) return;
  const top = Math.max(...parts.map((x) => x.w.percent));
  el.className = `ghost quota-chip ${top >= 95 ? 'bad' : top >= 80 ? 'warn' : ''}`;
  el.textContent = parts.map((x) => `${QUOTA_NAME[x.e]} ${x.w.percent} %`).join(' · ');
  el.title = 'Cuota restante de las suscripciones (peor ventana de cada motor). Clic: abre el Resumen';
}
// Celdas de una línea del Resumen (FT-53); el detalle va en los modales «Ver» / «Ver equipo».
const sumBtn = (attr, id, label, tip) => `<button type="button" class="small ghost sum-view" ${attr}="${id}" title="${esc(tip)}">${label}</button>`;
function tokensCell(p, team, tokens) {
  const withUsage = team.filter((a) => a.usage && Number.isFinite(a.usage.total));
  if (!withUsage.length && !tokens) return '<span class="muted" title="Las cifras aparecen en cuanto alguien del equipo ejecute una tarea">sin sesiones aún</span>';
  const worst = Math.max(-1, ...withUsage.map((a) => usagePct(a.usage) ?? -1));
  const dot = worst >= 80 ? `<span class="tokdot ${worst >= 90 ? 'bad' : 'warn'}" title="Algún agente supera el 80 % de su ventana de contexto (${worst} %)" aria-label="contexto casi lleno"></span>` : '';
  const total = tokens || withUsage.reduce((n, a) => n + a.usage.total, 0);
  return `<span class="tok">${fmtTok(total)}</span>${dot} ${sumBtn('data-sum-tokens', p.id, 'Ver', 'Detalle de tokens por agente')}`;
}
function teamCell(p, team) {
  if (!team.length) return '<span class="muted">sin equipo</span>';
  const ini = team.slice(0, 3).map((a) => `<span class="avatar xs" style="--c:${S.roles[a.role]?.color}" title="${esc(a.name)}">${esc(a.name).charAt(0).toUpperCase()}</span>`).join('');
  return `<span class="avatars">${ini}</span>${team.length > 3 ? `<span class="muted">+${team.length - 3}</span> ` : ' '}${sumBtn('data-sum-team', p.id, `${team.length} agente${team.length === 1 ? '' : 's'}`, 'Ver equipo')}`;
}
function busyCell(busy) {
  if (!busy.length) return '<span class="muted">—</span>';
  const one = busy.length === 1 && busy[0].t ? ` <b>${esc(tcode(busy[0].t))}</b>` : '';
  return `<span class="dot ${busy[0].a.status}"></span>${busy.length} en curso${one}`;
}
const SUM_COLS = [['backlog', 'Backlog'], ['todo', 'Por hacer'], ['doing', 'En curso'], ['review', 'Revisión'], ['done', 'Hecho'], ['failed', 'Fallidas']];
// ── 💸 Costes (FT-76) ──────────────────────────────────────────────────────
// Datos de GET /api/costs; se piden al abrir la pestaña y cuando cambia el coste acumulado (llega por el SSE), sin polling.
let sumView = 'general', costsData = null, costsSig = '';
const usd = (n) => (n == null ? 'n/d' : n.toFixed(n < 1 ? 3 : 2) + ' $');
const CAUSES = [['arranque', 'Arranque', '#64748b'], ['lecturas', 'Lecturas', '#38bdf8'], ['comandos', 'Comandos', '#fbbf24'], ['imagenes', 'Imágenes', '#c084fc'], ['salida', 'Salida', '#34d399'], ['reintentos', 'Reintentos', '#f87171']];
const stackBar = (b) => !b || !b.total ? '' : `<div class="cost-stack" title="${esc(CAUSES.map(([k, l]) => `${l} ${usd(b[k])}`).join(' · '))}">${CAUSES.filter(([k]) => b[k] > 0).map(([k, l, c]) => `<i style="width:${(100 * b[k] / b.total).toFixed(1)}%;background:${c}" title="${l} ${usd(b[k])}"></i>`).join('')}</div>`;
const causeLegend = () => `<div class="cost-legend">${CAUSES.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
function spark(vals) {
  if (!vals?.length) return '';
  const max = Math.max(...vals) || 1, w = 160, h = 28;
  return `<svg class="cost-curve" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#38bdf8" stroke-width="1.5" points="${vals.map((v, i) => `${vals.length > 1 ? (i * w) / (vals.length - 1) : w / 2},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ')}"/></svg>`;
}
function costDetailHtml(d) {
  if (!d.telemetry) return `<span class="muted">Sin telemetría por turno (tarea anterior a FT-76). Coste total: ${usd(d.costUsd)}</span>`;
  const b = d.breakdown;
  return `<div>Total <b>${usd(d.costUsd)}</b> · intento aceptado (${d.attempts}º) ${usd(d.acceptedUsd)} · tirado ${usd(d.discardedUsd)} · ${d.turns} turnos · caché ${d.cachePct} % (ahorró ${usd(d.cacheSavedUsd)})</div>${stackBar(b)}${causeLegend()}
    <div class="muted">Contexto por turno (tokens) ${spark(d.curve)} ${d.curve.length ? fmtN(d.curve.at(-1)) : ''}</div>
    ${b.files.length ? `<table class="repos"><thead><tr><th>Ficheros que más costaron</th><th class="num">≈ $</th></tr></thead><tbody>${b.files.slice(0, 5).map((f) => `<tr><td><code>${esc(f.file)}</code></td><td class="num">${usd(f.usd)}</td></tr>`).join('')}</tbody></table>` : ''}
    <p class="muted" style="margin:4px 0 0">El reparto por causa es una atribución estimada (README «Observabilidad de costes»).</p>`;
}
const groupTable = (title, rows) => `<table class="repos"><thead><tr><th>${title}</th><th class="num">Aprobadas</th><th class="num">Coste</th><th class="num">$/aprobada</th><th class="num">1ª vez</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${r.tasks}</td><td class="num">${usd(r.costUsd)}</td><td class="num">${usd(r.perApprovedUsd)}</td><td class="num">${r.firstTryPct} %</td></tr>`).join('') || '<tr><td colspan="5" class="muted">sin tareas aprobadas</td></tr>'}</tbody></table>`;
function costsHtml(d) {
  if (!d) return '<p class="muted">Leyendo costes…</p>';
  const k = d.kpi, kp = (v, l, cls = '') => `<div class="kpi ${cls}"><b>${v}</b><span>${l}</span></div>`;
  const cmp = k.ratioLinePct ?? k.ratioPct;
  const tr = d.trend7d.map((x) => x.perApprovedUsd);
  return `<div class="summary-kpis">
      ${kp(usd(k.perApprovedUsd), `coste por tarea aprobada (${k.approved})`)}
      ${kp(k.interactiveUsd != null ? usd(k.interactiveUsd) : 'n/d', 'interactivo (línea base)')}
      ${kp(cmp != null ? cmp + ' %' : 'n/d', `agente vs interactivo · objetivo ≤ ${k.targetPct} %${k.ratioLinePct != null ? ' (por línea)' : ''}`, k.meetsTarget == null ? '' : k.meetsTarget ? 'on' : 'bad')}
      ${kp(k.firstTryPct != null ? k.firstTryPct + ' %' : 'n/d', 'aprobadas a la primera')}
      ${kp(usd(k.discardedUsd), 'gastado en intentos tirados', k.discardedUsd > 0 ? 'warn' : '')}${kp(usd(k.cacheSavedUsd), 'ahorro por caché')}
      <div class="kpi"><b>${spark(tr)}</b><span>tendencia 7 días ($/aprobada)</span></div>
    </div>
    ${d.recommendations.length ? `<div class="section-title">💡 Recomendaciones</div><ul class="cost-recs">${d.recommendations.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>` : ''}
    <div class="section-title">Objetivo semana a semana</div>
    ${d.weekly.length ? `<div class="cost-weeks">${d.weekly.map((w) => `<span class="chip" style="--c:${w.meetsTarget == null ? '#94a3b8' : w.meetsTarget ? '#34d399' : '#f87171'}" title="${w.approved} aprobadas · ${usd(w.perApprovedUsd)}">${esc(w.week)} · ${w.ratioPct != null ? w.ratioPct + ' %' : 'sin base'}</span>`).join(' ')}</div>` : '<span class="muted">sin tareas aprobadas</span>'}
    <div class="grid2" style="gap:14px"><div>${groupTable('Rol', d.byRole)}</div><div>${groupTable('Modelo', d.byModel)}</div><div>${groupTable('Motor', d.byEngine)}</div><div>${groupTable('Proyecto', d.byProject)}</div></div>
    <div class="section-title">Por tarea (desglose por causa)</div>${causeLegend()}
    <table class="repos"><thead><tr><th>Tarea</th><th>Estado</th><th class="num">Coste</th><th>Desglose</th><th class="num">Turnos</th><th class="num">Caché</th><th>Contexto</th></tr></thead><tbody>${d.tasks.slice(0, 40).map((t) => `<tr data-cost-task="${esc(t.taskId)}"><td><b>${esc(t.code || t.taskId)}</b> <span class="muted">${esc((t.title || '').slice(0, 40))}</span></td><td>${esc(t.status)}</td><td class="num">${usd(t.costUsd)}</td><td style="min-width:160px">${t.breakdown ? stackBar(t.breakdown) : '<span class="muted">sin telemetría</span>'}</td><td class="num">${t.turns || '·'}</td><td class="num">${t.telemetry ? t.cachePct + ' %' : '·'}</td><td>${t.curve ? spark(t.curve) : ''}</td></tr>`).join('')}</tbody></table>
    <p class="muted" style="margin:8px 2px">Línea base interactiva: ${d.baseline.length ? esc(d.baseline.map((b) => `${b.code} ${usd(b.costUsd)}`).join(' · ')) : 'sin importar (POST /api/costs/baseline con el transcript de Claude Code)'}. Export: <a href="/api/costs/export?format=csv" target="_blank">CSV</a> · <a href="/api/costs/export" target="_blank">JSON</a></p>`;
}
const sumTabs = () => `<div class="sum-tabs"><button class="small ${sumView === 'general' ? 'on' : 'ghost'}" data-sum-view="general">📋 General</button><button class="small ${sumView === 'costs' ? 'on' : 'ghost'}" data-sum-view="costs">💸 Costes</button></div>`;
function renderCosts(el) {
  const sig = S.tasks.map((t) => `${t.id}:${t.costUsd}:${t.status}`).join('|');
  if (sig !== costsSig) { costsSig = sig; api('GET', '/api/costs').then((d) => { costsData = d; if (sumView === 'costs') renderSummary(); }).catch(() => {}); }
  el.innerHTML = sumTabs() + costsHtml(costsData);
}

function renderSummary() {
  const el = $('#summary');
  if (!el) return;
  if (sumView === 'costs') return renderCosts(el);
  const all = S.tasks, agents = S.agents, qs = S.questions || [];
  const byId = (id) => agents.find((a) => a.id === id);
  const rows = [...S.projects].map((p) => {
    const ts = all.filter((t) => t.projectId === p.id);
    const team = (p.team || []).map(byId).filter(Boolean);
    const busy = team.filter((a) => a.status === 'working' || a.status === 'paused').map((a) => ({ a, t: ts.find((t) => t.id === a.taskId) || all.find((t) => t.id === a.taskId) }));
    const free = team.filter((a) => a.status === 'idle');
    const last = Math.max(0, ...ts.map((t) => t.updatedAt || 0));
    const cost = ts.reduce((n, t) => n + (t.costUsd || 0), 0);
    const open = qs.filter((q) => q.projectId === p.id).length;
    const tokens = ts.reduce((n, t) => n + (t.usage?.total || 0), 0);
    return { p, ts, team, busy, free, last, cost, open, tokens };
  }).sort((x, y) => (y.p.running - x.p.running) || (y.busy.length - x.busy.length) || (y.last - x.last));
  // Carpetas del workspace sin equipo ni tareas: plegadas en una línea (se despliegan con un clic)
  const idle = rows.filter((r) => !r.ts.length && !r.team.length && !r.p.running);
  const shown = sumShowEmpty ? rows : rows.filter((r) => !idle.includes(r));
  const n = (st) => all.filter((t) => t.status === st).length;
  const working = agents.filter((a) => a.status === 'working').length, paused = agents.filter((a) => a.status === 'paused').length;
  const kpi = (v, l, cls = '') => `<div class="kpi ${cls}"><b>${v}</b><span>${l}</span></div>`;
  el.innerHTML = sumTabs() + `
    <div class="summary-kpis">
      ${kpi(S.projects.filter((p) => p.running).length + '/' + S.projects.length, 'proyectos en marcha', 'on')}
      ${kpi(`${working}${paused ? ' +' + paused + '⏸' : ''}/${agents.length}`, 'agentes trabajando', working ? 'on' : '')}
      ${kpi(n('doing'), 'tareas en curso')}${kpi(n('review'), 'por revisar', n('review') ? 'warn' : '')}${kpi(n('todo'), 'por hacer')}${kpi(n('backlog'), 'en backlog')}
      ${n('failed') ? `<button class="kpi bad kpi-btn" data-sum-failed="all" title="Ver por qué fallaron"><b>${n('failed')}</b><span>fallidas · ver por qué</span></button>` : kpi(0, 'fallidas')}${kpi(qs.length, 'preguntas pendientes', qs.length ? 'warn' : '')}
      ${kpi((all.reduce((s, t) => s + (t.costUsd || 0), 0)).toFixed(2) + ' $', 'coste acumulado')}
    </div>
    ${quotaBlockHtml()}
    <table class="repos summary">
      <thead><tr><th>Proyecto</th><th>Estado</th>${SUM_COLS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th>Equipo</th><th>Trabajando en</th><th>Libres</th><th>Tokens por sesión</th><th class="num">Coste</th><th>Actividad</th></tr></thead>
      <tbody>${shown.map(({ p, ts, team, busy, free, last, cost, open, tokens }) => `
        <tr data-sum-project="${p.id}" class="${p.id === projectId ? 'sel' : ''}">
          <td><b>${esc(p.name)}</b>${p.folder && p.folder !== p.name ? ` <span class="muted">(${esc(p.folder)})</span>` : ''} <span class="muted">${esc(p.prefixDefault || '')}</span>${open ? ` <span title="preguntas pendientes">❓${open}</span>` : ''}</td>
          <td><button class="small ${p.running ? 'on' : 'ghost'}" data-sum-run="${p.id}" title="${p.running ? 'Parar el equipo' : 'Poner a trabajar'}">${p.running ? '🟢 En marcha' : '⏸ Parado'}</button></td>
          ${SUM_COLS.map(([st]) => { const c = ts.filter((t) => t.status === st).length; return st === 'failed' && c ? `<td class="num st-failed"><button class="linklike" data-sum-failed="${p.id}" title="Ver por qué fallaron">${c}</button></td>` : `<td class="num ${c ? 'st-' + st : 'zero'}">${c || '·'}</td>`; }).join('')}
          <td>${teamCell(p, team)}</td>
          <td>${busyCell(busy)}</td>
          <td>${free.length ? `<span title="${esc(free.map((a) => a.name).join(', '))}">${free.length} libre${free.length === 1 ? '' : 's'}</span>` : '<span class="muted">—</span>'}</td>
          <td>${tokensCell(p, team, tokens)}</td>
          <td class="num">${cost ? cost.toFixed(2) + ' $' : '·'}</td>
          <td class="muted">${last ? 'hace ' + ago(last) : '—'}</td>
        </tr>`).join('')}${idle.length ? `<tr class="idle-row"><td colspan="${SUM_COLS.length + 8}"><button class="small ghost" data-sum-empty>${sumShowEmpty ? '▾ Ocultar' : '▸ Mostrar'} ${idle.length} proyectos sin equipo ni tareas (${esc(idle.map((r) => r.p.name).join(', '))})</button></td></tr>` : ''}</tbody>${shown.length > 1 ? `<tfoot><tr class="sum-total"><td><b>Total</b></td><td></td><td colspan="${SUM_COLS.length + 3}"></td><td><span class="tok">${fmtTok(shown.reduce((n, r) => n + r.tokens, 0))}</span> ${sumBtn('data-sum-all', '*', 'Ver todos', 'Tokens de todos los agentes, agrupados por proyecto')}</td><td class="num">${shown.reduce((n, r) => n + r.cost, 0).toFixed(2)} $</td><td></td></tr></tfoot>` : ''}
    </table>
    <p class="muted" style="margin:8px 2px">Clic en una fila: abre sus tareas. Los datos llegan por SSE: la tabla se actualiza sola.</p>`;
  refreshSumModal();
  const sc = $('#tab-summary-count'); if (sc) sc.textContent = (all.filter((t) => t.status === 'review' && S.projects.find((p) => p.id === t.projectId)?.running).length + qs.length) || ''; // solo lo que pide acción: revisiones de proyectos en marcha + preguntas
}
document.addEventListener('click', async (e) => {
  const sv = e.target.closest('[data-sum-view]');
  if (sv) { sumView = sv.dataset.sumView; costsSig = ''; renderSummary(); return; }
  const ct = e.target.closest('[data-cost-task]');
  if (ct) { openTask(ct.dataset.costTask); return; }
  if (e.target.closest('[data-sum-empty]')) { sumShowEmpty = !sumShowEmpty; renderSummary(); return; }
  const vt = e.target.closest('[data-sum-tokens],[data-sum-team],[data-sum-all]');
  if (vt) { e.stopPropagation(); openSumModal(vt.dataset.sumTeam ? 'team' : 'tokens', vt.dataset.sumTokens || vt.dataset.sumTeam || vt.dataset.sumAll); return; }
  const fb = e.target.closest('[data-sum-failed]');
  if (fb) { e.stopPropagation(); failedDialog(fb.dataset.sumFailed === 'all' ? null : fb.dataset.sumFailed); return; }
  const run = e.target.closest('[data-sum-run]');
  if (run) { e.stopPropagation(); const p = S.projects.find((x) => x.id === run.dataset.sumRun); try { await api('POST', `/api/projects/${p.id}/run`, { running: !p.running }); toast(p.running ? `${p.name}: equipo parado` : `${p.name}: equipo en marcha`); } catch { /* el toast ya avisó */ } return; }
  const row = e.target.closest('tr[data-sum-project]');
  if (row) { projectId = row.dataset.sumProject; safeSet('ao:project', projectId); closeDrawer(); render(); showTab('tasks'); }
});

// ── Preguntas de los agentes ──────────────────────────────────────────────
// Un agente que necesita una decisión tuya la manda por `ao-ask`; llega en S.questions. Se abre un modal con las
// opciones (o respuesta libre); si lo cierras sin contestar queda un aviso fijo arriba para volver a abrirlo.
const qSnoozed = new Set();
let qOpen = null;
function renderQuestions() {
  const qs = S.questions || [];
  const bar = $('#questions-bar');
  if (bar) {
    bar.innerHTML = qs.map((q) => q.kind === 'confirm' ? `<button class="qbar" data-q="${q.id}">🛡 <b>Guide</b> pide confirmación: ${esc(q.question.slice(0, 90))} — <u>responder</u></button>` : `<button class="qbar" data-q="${q.id}">❓ <b>${esc(q.agentName)}</b> (${esc(q.taskCode || q.taskId)}) te pregunta: ${esc(q.question.slice(0, 90))}${q.question.length > 90 ? '…' : ''} — <u>responder</u></button>`).join('');
    bar.hidden = !qs.length;
  }
  if (qOpen && !qs.some((q) => q.id === qOpen)) { qOpen = null; if ($('#dialog').open && $('#dialog').className === 'question') $('#dialog').close(); }
  const next = qs.find((q) => !qSnoozed.has(q.id));
  if (next && !qOpen && !$('#dialog').open) openQuestion(next.id);
}
function openQuestion(id) {
  const q = (S.questions || []).find((x) => x.id === id);
  if (!q) return;
  const t = S.tasks.find((x) => x.id === q.taskId);
  qOpen = id;
  const confirm = q.kind === 'confirm'; // FT-4: confirmación del Guide (Sí/No, sin respuesta libre)
  dialog(`
    <div class="task-head"><b>${confirm ? '🛡 Guide · confirmación' : '❓ ' + esc(q.agentName)}</b> ${confirm ? '' : `<span>${esc(q.taskCode || q.taskId)}</span>`}${t ? ` <span class="muted">${esc(t.title.slice(0, 70))}</span>` : ''}<div class="spacer"></div><span class="muted">${new Date(q.createdAt).toLocaleTimeString()}</span></div>
    <h3 class="q-text">${esc(q.question)}</h3>
    ${q.context ? `<div class="q-context">${md(q.context)}</div>` : ''}
    ${q.options.length ? `<div class="q-opts">${q.options.map((o) => `<button type="button" class="q-opt" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
    ${q.allowCustom ? `<label>${q.options.length ? 'U otra respuesta' : 'Tu respuesta'}</label><textarea name="answer" rows="3" placeholder="Escribe la respuesta para el agente…" ${q.options.length ? '' : 'autofocus'}></textarea>` : ''}
    <div class="row"><button class="ghost" value="cancel">Más tarde</button>${q.allowCustom ? '<button>Responder</button>' : ''}</div>`,
    async (f) => { if (!f.answer?.trim()) throw new Error('vacía'); await api('POST', `/api/questions/${id}/answer`, { answer: f.answer }); qOpen = null; toast(`Respuesta enviada a ${q.agentName}`); }, 'question');
  publishContext();
  const dlg = $('#dialog');
  dlg.querySelectorAll('.q-opt').forEach((b) => { b.onclick = async () => { await api('POST', `/api/questions/${id}/answer`, { answer: b.dataset.answer }); qOpen = null; dlg.close(); toast(`Respuesta enviada a ${q.agentName}`); }; });
  dlg.addEventListener('close', () => { if (qOpen === id) { qSnoozed.add(id); qOpen = null; } }, { once: true });
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) { qSnoozed.delete(b.dataset.q); openQuestion(b.dataset.q); } });
// Código legible de la tarea (GL-7); las muy antiguas sin código enseñan el id.
const tcode = (t) => t?.code || ('#' + (t?.id || '?'));
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'un momento' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
let boardKinds = null;
function boardMsg(b) {
  const parts = [];
  if (b.job) parts.push((b.job.running ? '⇪ exportando ' : 'exportación ') + b.job.done + '/' + b.job.total + (b.job.failed ? ' · ' + b.job.failed + ' fallos (' + esc(b.job.lastError || '') + ')' : ''));
  parts.push(b.lastError ? '⚠ ' + esc(b.lastError) : esc(b.lastInfo || ''));
  return parts.filter(Boolean).join(' · ');
}
async function renderBoardCfg(kindOverride) {
  const el = $('#board-cfg');
  if (!el) return;
  boardKinds = boardKinds || await api('GET', '/api/boards/kinds');
  const b = await api('GET', `/api/projects/${projectId}/board`);
  const kind = kindOverride ?? b?.kind ?? '';
  const def = boardKinds.find((k) => k.id === kind);
  const cfg = b?.kind === kind ? b.config : {};
  const field = (f, val, secret) => `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>` + (f.options
    ? `<select name="${secret ? 's:' : 'c:'}${f.key}">${f.options.map((o) => `<option ${o === (val ?? f.default) ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input name="${secret ? 's:' : 'c:'}${f.key}" value="${esc(val ?? f.default ?? '')}" placeholder="${esc(f.placeholder || '')}" ${secret ? 'type="password" autocomplete="off"' : ''} />`);
  el.innerHTML = `
    <label>Tipo</label>
    <select id="board-kind"><option value="">— sin tablero online —</option>${boardKinds.map((k) => `<option value="${k.id}" ${k.id === kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select>
    ${def ? `<div class="grid2">${def.fields.map((f) => field(f, cfg[f.key])).join('')}${def.secretFields.map((f) => field(f, b?.kind === kind ? b.secrets?.[f.key] : '', true)).join('')}</div>
    ${def.id === 'github' ? '<p class="muted" style="margin:8px 0 0">Usa la sesión de <code>gh</code> de esta máquina. Estados: etiquetas <code>ao:todo</code>, <code>ao:doing</code>, <code>ao:review</code>; cerrada = hecho.</p>' : ''}
    <label class="check"><input type="checkbox" id="board-autosync" ${b?.kind === kind ? (b.autoSync ? 'checked' : '') : 'checked'} /> Sincronizar solo cada 5 min</label>
    <label class="check"><input type="checkbox" id="board-pushnew" ${b?.kind === kind ? (b.pushNew ? 'checked' : '') : 'checked'} /> Crear fuera las tareas nuevas del PO o a mano</label>
    <div class="acts">
      <button type="button" class="small" data-board-save>Guardar y probar</button>
      ${def.canCreateBoard && !cfg.project ? '<button type="button" class="small ghost" data-board-create title="Crea un GitHub Project nuevo con las columnas Backlog / Todo / In Progress / In Review / Done, lo enlaza al repo y lo deja configurado aquí">＋ Crear Project en GitHub</button>' : ''}
      ${b?.kind === kind ? `<button type="button" class="small ghost" data-board-sync>↻ Sincronizar ahora</button>${kind === 'github' && cfg.project ? '<button type="button" class="small ghost" data-board-align title="Renombra las columnas del Project a Backlog / Por hacer / En curso / Revisión / Hecho y recoloca las tareas sincronizadas">⇄ Columnas como aquí</button>' : ''}<button type="button" class="small ghost" data-board-export title="Crea una tarjeta por cada tarea que aún no tiene, en su columna">⇪ Exportar ${tasks().filter((t) => t.source?.kind !== kind && t.kind !== 'plan').length} tareas sin tarjeta</button><button type="button" class="small danger" data-board-off>Desconectar</button>` : ''}
      <span class="muted" id="board-msg">${b?.kind === kind ? boardMsg(b) : ''}</span>
    </div>` : ''}`;
  $('#board-kind').onchange = (e) => renderBoardCfg(e.target.value);
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-board-save],[data-board-sync],[data-board-off],[data-board-create],[data-board-align],[data-board-export],[data-board-syncall],[data-board-cancel]');
  if (!el) return;
  e.preventDefault();
  const d = el.dataset;
  try {
    if (d.boardSave !== undefined) {
      const kind = $('#board-kind').value;
      const config = {}, secrets = {};
      $('#board-cfg').querySelectorAll('[name]').forEach((i) => { const [t, k] = i.name.split(':'); (t === 's' ? secrets : config)[k] = i.value; });
      await api('POST', `/api/projects/${projectId}/board`, { kind, config, secrets, autoSync: $('#board-autosync')?.checked, pushNew: $('#board-pushnew')?.checked });
      const r = await api('POST', `/api/projects/${projectId}/board/test`);
      toast(`Conectado: ${r.info}`);
      renderBoardCfg();
    }
    if (d.boardCreate !== undefined) {
      const kind = $('#board-kind').value;
      const config = {}, secrets = {};
      $('#board-cfg').querySelectorAll('[name]').forEach((i) => { const [t, k] = i.name.split(':'); (t === 's' ? secrets : config)[k] = i.value; });
      if (!confirm(`Se creará un GitHub Project nuevo para ${config.repo || 'el repo'} con las cinco columnas y se enlazará al repositorio. ¿Seguimos?`)) return;
      const r = await api('POST', `/api/projects/${projectId}/board/create`, { kind, config, secrets });
      toast(r.info);
      renderBoardCfg();
    }
    if (d.boardSyncall !== undefined) {
      el.disabled = true;
      const r = await api('POST', `/api/projects/${projectId}/board/sync-all`);
      toast(`Sincronizado: ${r.total} tarjetas · ${r.created} nuevas aquí · ${r.pushed} estados enviados${r.exporting ? ` · exportando ${r.exporting} tarjetas en segundo plano` : ''}`);
    }
    if (d.boardCancel !== undefined) { await api('POST', `/api/projects/${projectId}/board/export/cancel`); toast('Exportación cancelada'); }
    if (d.boardAlign !== undefined) {
      if (!confirm('Se renombrarán las columnas del Project a Backlog / Por hacer / En curso / Revisión / Hecho (los items se recolocan después). ¿Seguimos?')) return;
      const r = await api('POST', `/api/projects/${projectId}/board/align`); toast(`Columnas alineadas · ${r.placed} tarjetas recolocadas`); renderBoardCfg();
    }
    if (d.boardExport !== undefined) {
      const n = tasks().filter((t) => t.source?.kind !== (project()?.board?.kind) && t.kind !== 'plan').length;
      if (!n) return toast('Todas las tareas tienen ya tarjeta');
      if (!confirm(`Se crearán ${n} tarjetas/issues en el tablero online (una por tarea sin tarjeta), en su columna. Tarda ~1 s por tarjeta. ¿Seguimos?`)) return;
      await api('POST', `/api/projects/${projectId}/board/export`); toast('Exportando en segundo plano…'); renderBoardCfg();
    }
    if (d.boardSync !== undefined) { const r = await api('POST', `/api/projects/${projectId}/board/sync`); toast(`Sincronizado: ${r.total} tarjetas · ${r.created} nuevas · ${r.updated} actualizadas · ${r.pushed} enviadas`); if ($('#board-cfg')) renderBoardCfg(); }
    if (d.boardOff !== undefined) { if (confirm('¿Desconectar el tablero online? Las tareas se quedan; dejan de sincronizarse.')) { await api('POST', `/api/projects/${projectId}/board`, { kind: '' }); renderBoardCfg(); } }
  } catch { /* toast */ }
});

let enginesTimer = null;
async function refreshEngines() {
  const el = $('#engines');
  if (!el || !el.isConnected) { clearInterval(enginesTimer); enginesTimer = null; return; }
  try { const st = await api('GET', '/api/engines'); renderEngines(st); renderLocal(st.local); } catch { /* el toast ya avisó */ }
}
const ENGINE_META = {
  claude: { name: 'Claude Code', vendor: 'Anthropic', oauthLabel: 'Entrar con Claude (suscripción)', consoleLabel: 'Entrar con Console (pago por uso)', keyHint: 'sk-ant-…' },
  codex: { name: 'Codex', vendor: 'OpenAI', oauthLabel: 'Entrar con ChatGPT', keyHint: 'sk-…' },
};
function renderEngines(st) {
  const el = $('#engines');
  if (!el) return;
  const keep = {}; // no perder lo que el usuario está escribiendo
  el.querySelectorAll('input').forEach((i) => { keep[i.dataset.keep] = i.value; });
  el.innerHTML = Object.entries(ENGINE_META).map(([id, m]) => {
    const s = st[id] || {};
    const l = s.login;
    let status, actions = '', flow = '';
    if (!s.installed) status = `<span class="bad">● CLI «${id}» no encontrado</span>`;
    else if (s.loggedIn) {
      const how = s.method === 'api-key' ? `clave API ${esc(s.apiKey || '')}` : s.method === 'claude.ai' ? `suscripción claude.ai${s.plan ? ' · ' + esc(s.plan.toUpperCase()) : ''}` : s.method === 'chatgpt' ? 'cuenta ChatGPT' : esc(s.method || 'sesión');
      status = `<span class="ok">● Conectado</span> · ${how}${s.account ? ' · ' + esc(s.account) : ''}${s.oauthAlso ? ' <span class="muted">(también hay sesión OAuth; manda la clave API)</span>' : ''}`;
      actions = `<button class="small ghost" data-eng-logout="${id}">Salir</button>`;
    } else status = `<span class="muted">○ Sin cuenta</span>${s.error ? ` <span class="bad">· ${esc(s.error)}</span>` : ''}`;
    if (s.installed && !l && !s.loggedIn) {
      actions = `<button class="small" data-eng-login="${id}:oauth">${m.oauthLabel}</button>` +
        (m.consoleLabel ? ` <button class="small ghost" data-eng-login="${id}:console">${m.consoleLabel}</button>` : '') +
        ` <button class="small ghost" data-eng-key="${id}">Usar clave API…</button>`;
    } else if (s.installed && !l && s.loggedIn && s.method !== 'api-key') {
      actions += ` <button class="small ghost" data-eng-key="${id}">Cambiar a clave API…</button>`;
    }
    if (l && !['done', 'cancelled'].includes(l.state)) {
      const step = id === 'codex'
        ? (l.url ? `<ol><li>Abre <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a> e inicia sesión.</li><li>Escribe este código: <b class="code">${esc(l.code || '…')}</b></li><li>Vuelve aquí: se conecta solo al terminar.</li></ol>` : '<p class="muted">Arrancando el login…</p>')
        : (l.url ? `<ol><li>Abre <a href="${esc(l.url)}" target="_blank" rel="noopener">la página de login de Anthropic</a> y autoriza.</li><li>Pega aquí el código que te da:</li></ol><div class="row"><input data-keep="code-${id}" id="code-${id}" placeholder="código de autorización" value="${esc(keep['code-' + id] || '')}" /><button class="small" data-eng-code="${id}">Conectar</button></div>` : '<p class="muted">Arrancando el login…</p>');
      flow = `<div class="login-flow">${l.state === 'verifying' ? '<p class="muted">Verificando el código…</p>' : step}${l.state === 'error' ? `<p class="bad">${esc(l.error || 'Error')}</p>` : ''}<button class="small danger" data-eng-cancel="${id}">Cancelar</button></div>`;
    }
    if (l?.state === 'done') flow = '<p class="ok">✓ Conectado</p>';
    return `<div class="engine"><div class="top"><b>${m.name}</b> <span class="muted">${m.vendor}</span><div class="spacer"></div>${actions}</div><div class="status">${status}</div>${flow}</div>`;
  }).join('');
}

// FT-54 · IA local: URL (preajustes LM Studio / Ollama), clave opcional, «Probar» (lista modelos) y modelo por defecto.
function renderLocal(l) {
  const el = $('#local-ai');
  if (!el || !l || el.contains(document.activeElement)) return; // no pisar lo que se está escribiendo
  const status = !l.baseUrl ? '<span class="muted">○ Sin configurar</span>' : l.loggedIn ? `<span class="ok">● Servidor responde</span> · ${esc(l.text)}` : `<span class="bad">● ${esc(l.text)}</span>${l.error ? ` <span class="muted">· ${esc(l.error)}</span>` : ''}`;
  el.innerHTML = `<div class="engine"><div class="top"><b>IA local</b> <span class="muted">LM Studio · Ollama · API compatible con OpenAI</span></div><div class="status">${status}${l.installed ? '' : ' <span class="bad">· falta el CLI codex (es quien ejecuta)</span>'}</div>
    <div class="row">${(l.presets || []).map((p) => `<button type="button" class="small ghost" data-local-preset="${esc(p.baseUrl)}">${esc(p.label)}</button>`).join('')}</div>
    <div class="row"><input id="local-url" placeholder="http://localhost:1234/v1" value="${esc(l.baseUrl)}" /><input id="local-key" type="password" placeholder="clave (opcional)${l.apiKey ? ' ' + esc(l.apiKey) : ''}" /><button type="button" class="small" data-local-probe>Probar</button></div>
    ${l.models?.length ? `<div class="row"><label>Modelo por defecto</label><select id="local-model">${l.models.map((m) => `<option value="${esc(m)}" ${m === l.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
    <label class="check"><input type="checkbox" id="local-auto" ${l.allowAuto ? 'checked' : ''}/> Permitir que el motor «automático» use la IA local (más lenta y menos capaz)</label>` : ''}</div>`;
}
document.addEventListener('click', async (e) => {
  const lp = e.target.closest('[data-local-preset]'), pr = e.target.closest('[data-local-probe]');
  if (lp) { $('#local-url').value = lp.dataset.localPreset; return; }
  if (!pr) return;
  pr.disabled = true;
  try {
    const r = await api('POST', '/api/engines/local/probe', { baseUrl: $('#local-url').value, apiKey: $('#local-key').value });
    toast(r.ok ? r.text : r.error, r.ok ? undefined : 'error');
    document.activeElement?.blur();
    await loadModels(); renderLocal(r.local);
  } catch { /* toast */ }
  pr.disabled = false;
});
document.addEventListener('change', async (e) => {
  if (!e.target.closest('#local-model,#local-auto')) return;
  try { const l = await api('POST', '/api/engines/local/settings', { model: $('#local-model').value, allowAuto: $('#local-auto').checked }); document.activeElement?.blur(); renderLocal(l); toast('IA local guardada'); } catch { /* toast */ }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-eng-login],[data-eng-key],[data-eng-code],[data-eng-cancel],[data-eng-logout]');
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.engLogin) { const [eng, mode] = d.engLogin.split(':'); await api('POST', `/api/engines/${eng}/login`, { mode }); }
    if (d.engKey) {
      const key = prompt(`Clave API de ${ENGINE_META[d.engKey].name} (${ENGINE_META[d.engKey].keyHint}). Se guarda en este equipo y no sale del servidor.`);
      if (key?.trim()) { await api('POST', `/api/engines/${d.engKey}/login`, { apiKey: key.trim() }); toast('Clave guardada'); }
    }
    if (d.engCode) { const code = $(`#code-${d.engCode}`)?.value.trim(); if (!code) return toast('Pega el código', 'error'); await api('POST', `/api/engines/${d.engCode}/code`, { code }); }
    if (d.engCancel) await api('POST', `/api/engines/${d.engCancel}/cancel`);
    if (d.engLogout) { if (confirm('¿Cerrar la sesión de este motor? Los agentes que lo usen dejarán de funcionar hasta volver a entrar.')) { await api('POST', `/api/engines/${d.engLogout}/logout`); toast('Sesión cerrada'); } }
  } catch { /* toast */ }
  refreshEngines();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="settings"]')) {
    setTimeout(ttsFillSettings, 50); // el diálogo se abre en otro manejador del mismo clic
    api('GET', '/api/guide/stt').then((st) => { const el = $('#stt-info'); if (el) el.innerHTML = st.providers.map((p) => `· ${esc(p.name)}: ${p.ok ? '<span class="ok">disponible</span>' : `<span class="bad" title="${esc(p.reason)}">no disponible</span>`}`).join(' ');
      const box = document.querySelector('input[name=voiceWake]');
      if (box && st.wake && !st.wake.ok) { box.disabled = true; box.checked = false; $('#wake-info').innerHTML = `<span class="bad">— no disponible: ${esc(st.wake.reason || 'sin STT local')}</span>`; } }).catch(() => {});
    setTimeout(() => { refreshEngines(); clearInterval(enginesTimer); enginesTimer = setInterval(refreshEngines, 2500); renderBoardCfg(); }, 50);
    api('GET', '/api/flows').then((flows) => {
      const sel = $('#import-flow');
      const folder = project()?.folder;
      const mine = (f) => folder === 'default' ? !f.path.includes('/') : folder ? f.path.startsWith(folder + '/') : false;
      const list = [...flows.filter(mine), ...flows.filter((f) => !mine(f))];
      if (sel) sel.innerHTML = '<option value="">— elegir flow —</option>' + list.map((f) => `<option value="${esc(f.path)}">${mine(f) ? '📁 ' : ''}${esc(f.name)} — ${esc(f.path)}</option>`).join('');
    }).catch(() => {});
  }
});

// «Para quién»: los agentes de la plantilla (por rol, sin el PO) y, si hay PO, «que lo decida el PO».
function whoOptions() {
  const planner = team().find((a) => S.roles[a.role]?.kind === 'planner');
  const byRole = new Map();
  for (const a of team()) { if (S.roles[a.role]?.kind === 'planner') continue; byRole.set(a.role, [...(byRole.get(a.role) || []), a.name]); }
  return (planner ? `<option value="__po">🗂 Que lo decida ${esc(planner.name)} (PO): él elige a quién y crea la tarea</option>` : '') +
    [...byRole].map(([role, names]) => `<option value="${role}">${esc(names.join(' / '))} — ${esc(S.roles[role]?.label || role)}</option>`).join('') +
    (!planner && !byRole.size ? '<option value="back">(sin plantilla: rol Backend)</option>' : '');
}

// Adjuntos de una tarea (imágenes y ficheros): se suben al servidor al elegirlos (o al pegar/arrastrar) y se guardan
// como rutas; las imágenes las ve el agente (codex --image / Read), el resto se citan en el prompt.
let pendingAttachments = [];
const attachArea = () => `<div class="attach" id="attach">📎 Adjuntos: <span class="pick" data-pick>elegir ficheros…</span>, arrastrar aquí o pegar una captura (Ctrl+V)<input type="file" multiple /><div class="chips"></div></div>`;
async function uploadFiles(fileList) {
  const files = [...fileList].slice(0, 10);
  if (!files.length) return;
  const toB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  const payload = [];
  for (const f of files) { if (f.size > 25e6) { toast(`${f.name}: demasiado grande (máx. 25 MB)`, 'error'); continue; } payload.push({ name: f.name || `captura-${Date.now()}.png`, data: await toB64(f) }); }
  const up = await api('POST', '/api/upload', { files: payload });
  pendingAttachments.push(...up);
  renderChips();
}
function renderChips() {
  const el = $('#attach .chips');
  if (el) el.innerHTML = pendingAttachments.map((a, i) => `<span class="chip-file">${/\.(png|jpe?g|webp|gif)$/i.test(a.name) ? '🖼' : '📄'} ${esc(a.name)} <span class="muted">${(a.size / 1024).toFixed(0)} KB</span><button type="button" data-unattach="${i}" title="Quitar">✕</button></span>`).join('');
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-pick]')) { $('#attach input[type=file]')?.click(); return; }
  const u = e.target.closest('[data-unattach]'); if (u) { pendingAttachments.splice(Number(u.dataset.unattach), 1); renderChips(); }
});
document.addEventListener('change', (e) => { if (e.target.matches('#attach input[type=file]')) uploadFiles(e.target.files).then(() => { e.target.value = ''; }); });
document.addEventListener('paste', (e) => { if (!$('#attach')) return; const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); uploadFiles(files); } });
document.addEventListener('dragover', (e) => { const a = e.target.closest?.('#attach'); if (a) { e.preventDefault(); a.classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { e.target.closest?.('#attach')?.classList.remove('drag'); });
document.addEventListener('drop', (e) => { const a = e.target.closest?.('#attach'); if (a) { e.preventDefault(); a.classList.remove('drag'); uploadFiles(e.dataTransfer.files); } });

// Editar un agente desde su tarjeta (nombre, rol, motor, modelo).
function editAgent(id) {
  const a = S.agents.find((x) => x.id === id);
  if (!a) return;
  dialog(`
    <h3>✎ ${esc(a.name)}</h3>
    <label>Nombre</label><input name="name" value="${esc(a.name)}" required autofocus />
    <label>Rol</label><select name="role">${roleOptions(a.role)}</select>
    <div class="grid2">
      <div><label>Motor</label><select name="engine">${engineOptions(a.engine)}</select></div>
      <div><label>Modelo</label>${modelSelect('model', a.engine, a.model || '')}</div>
    </div>
    ${a.status === 'working' ? '<p class="muted">Está trabajando: los cambios se aplican a partir de su siguiente tarea.</p>' : ''}
    ${buttons('Guardar')}`, async (f) => { await api('PATCH', `/api/agents/${id}`, { ...f, model: pickModel(f) }); toast('Agente actualizado'); });
}

// Markdown ligero y seguro para descripciones y resúmenes (escapa primero, luego formatea).
function md(src) {
  const lines = esc(src || '').split('\n');
  let out = '', inList = null, inCode = false;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (inList) { out += `</${inList}>`; inList = null; } };
  for (const raw of lines) {
    if (raw.startsWith('```')) { closeList(); inCode = !inCode; out += inCode ? '<pre>' : '</pre>'; continue; }
    if (inCode) { out += raw + '\n'; continue; }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    const ul = raw.match(/^\s*[-*•]\s+(.*)$/), ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) { const kind = ul ? 'ul' : 'ol'; if (inList !== kind) { closeList(); out += `<${kind}>`; inList = kind; } out += `<li>${inline((ul || ol)[1])}</li>`; continue; }
    closeList();
    if (!raw.trim()) continue;
    out += `<p>${inline(raw)}</p>`;
  }
  closeList();
  if (inCode) out += '</pre>';
  return out || '<p class="muted">(vacío)</p>';
}

// Modal de una tarea: todo lo que va a hacer (o hizo), adjuntos, dependencias, revisión y acciones.
function openTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const agent = S.agents.find((a) => a.id === t.agentId);
  const repos = project()?.repos || [];
  const repoKey = t.repo || repos.find((r) => (r.roles || []).includes(t.role))?.key || repos[0]?.key || '';
  const deps = t.dependsOn.map((dId) => { const dt = S.tasks.find((x) => x.id === dId); return dt ? `<span>${dt.status === 'done' ? '✓' : '⏳'} ${esc(tcode(dt))} ${esc(dt.title.slice(0, 60))}</span>` : ''; }).join('');
  const dependents = S.tasks.filter((x) => x.dependsOn.includes(id)).map((x) => `<span>→ ${esc(tcode(x))} ${esc(x.title.slice(0, 60))}</span>`).join('');
  const att = [...(t.feedbackImages || []), ...(t.files || [])];
  const fileUrl = (f) => `${BASE}api/file?path=${encodeURIComponent(f)}`;
  // FT-28: miniatura con fallback (icono + nombre) si la imagen no carga
  const attachHtml = (f) => {
    const name = esc(f.split('/').pop());
    if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) return `<a href="${fileUrl(f)}" target="_blank" rel="noopener">📄 ${name}</a>`;
    return `<a class="thumb" href="${fileUrl(f)}" target="_blank" rel="noopener" title="${name}"><img src="${fileUrl(f)}" alt="${name}" onerror="this.parentNode.classList.add('broken');this.replaceWith('🖼 '+this.alt)" /></a>`;
  };
  const STATUS = { backlog: 'Backlog', todo: 'Por hacer', doing: 'En curso', review: 'En revisión', done: 'Hecha', failed: 'Fallida' };
  const acts = [];
  if (t.status === 'doing' && agent) acts.push(controls(agent));
  if (t.status !== 'doing') acts.push(`<button class="small ghost" data-edit="${t.id}">✎ Editar</button>`);
  if (t.status === 'backlog') acts.push(`<button class="small" data-ready="${t.id}">→ Por hacer</button>`);
  if (t.status === 'todo') acts.push(`<button class="small ghost" data-park="${t.id}">← Backlog</button>`);
  if (t.status === 'review') acts.push(`<button class="small ghost" data-diff="${t.id}">Ver cambios</button>${updateBtn(t)}<button class="small ok" data-approve="${t.id}">✓ Aprobar${t.branch ? ' y fusionar' : ''}</button><button class="small ghost" data-reject="${t.id}">↩ Devolver</button>`);
  if (t.status === 'failed') acts.push(`<button class="small" data-reject="${t.id}">↻ Reintentar</button>`);
  dialog(`
    <div class="task-head">${roleChip(t.role)} <b>${esc(tcode(t))}</b>${repoKey ? ` <span>📁 ${esc(repoKey)}</span>` : ''} <span class="st">${STATUS[t.status] || t.status}</span>${t.kind === 'plan' ? ' <span>🗂 plan</span>' : ''}${t.attempts > 1 ? ` <span>intento ${t.attempts}</span>` : ''}${t.costUsd ? ` <span>≈ ${t.costUsd.toFixed(2)} $</span>` : ''}${t.source?.url ? ` <a href="${esc(t.source.url)}" target="_blank" rel="noopener" style="color:#93c5fd">🔗 ${esc(BOARD_LABELS[t.source.kind] || t.source.kind)} ${esc(t.source.id)}</a>` : ''}<div class="spacer"></div><span>${new Date(t.createdAt).toLocaleString()}</span></div>
    <div class="task-title" tabindex="-1" autofocus>${esc(t.title)}</div>
    <div class="task-who">${whoRow(t)}</div>
    ${t.context ? `<div class="task-born">${bornFrom(t)}</div>` : ''}
    <div class="task-sec"><h4>${t.kind === 'plan' ? 'Encargo al PO' : 'Qué va a hacer'}</h4><div class="md">${md(t.description)}</div></div>
    ${att.length ? `<div class="task-sec"><h4>Adjuntos</h4><div class="task-attach">${att.map(attachHtml).join('')}</div></div>` : ''}
    ${(t.questions || []).length ? `<div class="task-sec task-qa"><h4>Conversación con el agente</h4>${t.questions.map((q) => `<div class="qa"><div class="q">❓ ${esc(q.question)}</div><div class="a">${q.answer == null ? '<span class="muted">sin respuesta (se decidió solo)</span>' : '💬 ' + esc(q.answer)}</div></div>`).join('')}</div>` : ''}
    ${deps || dependents ? `<div class="task-sec task-deps"><h4>Dependencias</h4>${deps ? `<div>Depende de: ${deps}</div>` : ''}${dependents ? `<div>Bloquea a: ${dependents}</div>` : ''}</div>` : ''}
    ${(t.constraints || []).length ? `<div class="task-sec constraints"><h4>Restricciones del cliente</h4><ul>${t.constraints.map((c) => `<li>${esc(c.text)} <small>· ${new Date(c.at).toLocaleString()} · ${esc(c.origin)}</small></li>`).join('')}</ul></div>` : ''}
    ${t.feedback ? `<div class="task-sec"><h4>Comentarios de revisión</h4><div class="md">${md(t.feedback)}</div></div>` : ''}
    ${t.summary ? `<div class="task-sec"><h4>Resumen del agente</h4><div class="md">${md(t.summary)}</div></div>` : ''}
    ${mergeChips(t) ? `<div class="task-sec"><h4>Estado frente a ${esc(baseOf(t))}</h4><div>${mergeChips(t)}</div>${(t.conflicts || []).length ? `<ul>${t.conflicts.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}</div>` : ''}
    ${outsideWarn(t)}
    ${t.diffStat || repoStats(t).length ? `<div class="task-sec"><h4>Cambios en la rama ${esc(t.branch || '')}${repoStats(t).length > 1 ? ` (${repoStats(t).length} repos)` : ''}</h4>${diffStatsHtml(t, ' class="md"')}</div>` : ''}
    ${t.error ? `<div class="task-sec"><h4>Error</h4><div class="md bad">${esc(t.error)}</div></div>` : ''}
    ${t.costUsd > 0 ? '<div class="task-sec" id="task-costs"><h4>💸 Coste (FT-76)</h4><span class="muted">leyendo…</span></div>' : ''}
    <div class="task-acts">${acts.join('')}<div class="spacer"></div><button class="ghost" value="cancel">Cerrar</button></div>`, null, 'task');
  openTaskId = id;
  if (t.costUsd > 0) api('GET', `/api/costs/${t.projectId}/${t.id}`).then((d) => { const el = $('#task-costs'); if (el) el.innerHTML = '<h4>💸 Coste (FT-76)</h4>' + costDetailHtml(d); }).catch(() => {});
  publishContext();
}

// Editar una tarea desde su tarjeta.
function editTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const others = tasks().filter((x) => x.id !== id && x.kind !== 'plan');
  const repos = project()?.repos || [];
  dialog(`
    <h3>✎ Tarea ${esc(tcode(t))}${t.source?.url ? ` · <a href="${esc(t.source.url)}" target="_blank" rel="noopener" style="font-size:13px;color:#93c5fd">${esc(BOARD_LABELS[t.source.kind] || t.source.kind)} ${esc(t.source.id)} ↗</a>` : ''}</h3>
    <label>Título</label><input name="title" value="${esc(t.title)}" required autofocus />
    <label>Descripción</label><textarea name="description" rows="6">${esc(t.description)}</textarea>
    <div class="grid2">
      <div><label>Rol</label><select name="role">${roleOptions(t.role, true)}</select></div>
      ${repos.length > 1 ? `<div><label>Repositorio</label><select name="repo"><option value="">(el que diga el rol)</option>${repos.map((r) => `<option value="${r.key}" ${r.key === t.repo ? 'selected' : ''}>${esc(r.key)}</option>`).join('')}</select></div>` : ''}
    </div>
    <label>Depende de (Ctrl+clic para varias)</label>
    <select name="dependsOn" multiple size="${Math.min(6, Math.max(2, others.length))}">${others.map((o) => `<option value="${o.id}" ${t.dependsOn.includes(o.id) ? 'selected' : ''}>${o.status === 'done' ? '✓' : '⏳'} ${esc(tcode(o))} · ${esc(o.title.slice(0, 70))}</option>`).join('')}</select>
    ${['backlog', 'todo', 'failed'].includes(t.status) ? `<label>Estado</label><select name="status"><option value="backlog" ${t.status === 'backlog' ? 'selected' : ''}>Backlog</option><option value="todo" ${t.status !== 'backlog' ? 'selected' : ''}>Por hacer</option></select>` : ''}
    ${t.source?.kind && t.source.kind !== 'flow' ? '<p class="muted">Título y descripción se actualizan también en el tablero online.</p>' : ''}
    ${buttons('Guardar')}`, async (f) => {
    const form = $('#dialog form');
    const dependsOn = [...form.querySelector('[name=dependsOn]').selectedOptions].map((o) => o.value);
    await api('PATCH', `/api/tasks/${id}`, { ...f, dependsOn });
    toast('Tarea actualizada');
  });
}

// «clave = ruta @ rol1,rol2» · «ruta @ roles» · «ruta» (la clave sale del nombre de la carpeta)
function parseRepos(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [left, rolesPart] = l.split('@').map((x) => x.trim());
    const m = left.match(/^([\w-]+)\s*=\s*(.+)$/);
    const path = (m ? m[2] : left).trim();
    return { key: m ? m[1] : path.replace(/\/+$/, '').split('/').pop(), path, roles: rolesPart ? rolesPart.split(',').map((r) => r.trim()).filter(Boolean) : [] };
  });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-agent]');
  if (el?.dataset.agentEdit) { editAgent(el.dataset.agentEdit); return; }
  if (!el) return;
  const d = el.dataset;
  if (d.action === 'suite') { S.suite = await api('GET', '/api/suite'); renderSuite(); return toast(S.suite.ok ? `flow-test OK · ${S.suite.plan || S.suite.mode}` : S.suite.reason, S.suite.ok ? '' : 'error'); }
  if (d.hireRole !== undefined) { if ($('#dialog').open) $('#dialog').close(); return actions.hire(d.hireRole); } // FT-50: chip ámbar de la tarjeta
  if (d.action) return actions[d.action]?.();
  if (d.agent) { if (el.closest('#dialog')) $('#dialog').close(); return openDrawer(d.agent); } // desde el modal de la tarea, el cajón queda detrás: se cierra antes (FT-50)
  if (d.close !== undefined) return closeDrawer();
  if (d.logFocus !== undefined) { $('#log')?.focus(); return; }
  if (d.stop) return api('POST', `/api/agents/${d.stop}/stop`);
  if (d.pause) return api('POST', `/api/agents/${d.pause}/pause`);
  if (d.resume) return api('POST', `/api/agents/${d.resume}/resume`);
  if (d.msg) return messageDialog(d.msg);
  if (d.fire) {
    if (confirm('¿Despedir a este agente de la empresa? (baja definitiva; para quitarlo solo de este proyecto usa «Al banquillo»)')) { await api('DELETE', `/api/agents/${d.fire}`); closeDrawer(); }
    return;
  }
  if (d.update) return api('POST', `/api/tasks/${d.update}/update-from-base`).then((r) => toast(r.message));
  if (d.approve) return api('POST', `/api/tasks/${d.approve}/approve`).then(() => toast('Tarea aprobada ✓'));
  if (d.open) return openTask(d.open);
  if (d.ready) return api('PATCH', `/api/tasks/${d.ready}`, { status: 'todo' });
  if (d.edit) return editTask(d.edit);
  if (d.aiDraft !== undefined) {
    const form = $('#dialog form');
    const text = [form.title?.value, form.description?.value].filter((x) => x?.trim()).join('\n\n');
    if (!text.trim() && !pendingAttachments.length) return toast('Cuenta qué quieres que se haga (o adjunta algo)', 'error');
    el.disabled = true; el.textContent = '✨ Redactando…';
    try {
      const draft = await api('POST', '/api/tasks/draft', { projectId, text, attachments: pendingAttachments });
      const t = await api('POST', '/api/tasks', { projectId, title: draft.title, description: draft.description, role: draft.role, repo: draft.repo, status: 'backlog', attachments: pendingAttachments });
      $('#dialog').close();
      toast(`Tarea ${tcode(t)} creada en Backlog por la IA (${draft.role}${draft.repo ? ' · ' + draft.repo : ''})${draft.costUsd ? ` · ≈ ${draft.costUsd.toFixed(2)} $` : ''}`);
    } catch { el.disabled = false; el.textContent = '✨ Redactar con IA y crear'; }
    return;
  }
  if (d.repoEdit !== undefined) return editRepo(d.repoEdit);
  if (d.bench) return api('PATCH', `/api/projects/${projectId}/team`, { remove: [d.bench] }).then(() => toast('Al banquillo'));
  if (d.sign) return api('PATCH', `/api/projects/${projectId}/team`, { add: [d.sign] }).then(() => toast('Fichado para este proyecto'));
  if (d.repoDel !== undefined) { if (confirm(`¿Quitar el repo «${d.repoDel}» del proyecto? (no toca el disco)`)) saveRepos((project()?.repos || []).filter((r) => r.key !== d.repoDel)); return; }
  if (d.roleEdit) return editRole(d.roleEdit);
  if (d.roleDup) return editRole(d.roleDup, true);
  if (d.roleDel) { if (confirm(`¿Borrar el rol «${d.roleDel}» del catálogo?`)) api('DELETE', `/api/roles/${d.roleDel}`).then(() => toast('Rol borrado')); return; }
  if (d.skillAdd) return api('POST', '/api/skills/centralize', { dir: d.skillAdd }).then((r) => { toast(`«${r.name}» en el catálogo`); renderSkills(true); });
  if (d.skillDel) return api('DELETE', `/api/skills/${d.skillDel}`).then(() => { toast('Quitada del catálogo'); renderSkills(true); });
  if (d.skillEdit) return editSkill(d.skillEdit);
  if (d.agentEdit) return editAgent(d.agentEdit);
  if (d.nomove) return moveTask(d.nomove, 'backlog');
  if (d.park) return api('PATCH', `/api/tasks/${d.park}`, { status: 'backlog' });
  if (d.del) { if (confirm('¿Borrar la tarea?')) api('DELETE', `/api/tasks/${d.del}`); return; }
  if (d.reject) {
    pendingAttachments = [];
    const t = S.tasks.find((x) => x.id === d.reject);
    return dialog(`
      <h3>${t.status === 'failed' ? 'Reintentar' : 'Devolver'} ${esc(tcode(t))}</h3>
      <p class="muted">${esc(t.title)}</p>
      <label>Comentarios para el agente (opcional)</label><textarea name="feedback" rows="4" autofocus></textarea>
      ${attachArea()}
      ${buttons(t.status === 'failed' ? 'Reintentar' : 'Devolver')}`, (f) => api('POST', `/api/tasks/${t.id}/reject`, { ...f, attachments: pendingAttachments }));
  }
  if (d.diff) {
    const { diff } = await api('GET', `/api/tasks/${d.diff}/diff`);
    const t = S.tasks.find((x) => x.id === d.diff);
    const html = esc(diff).split('\n').map((l) =>
      l.startsWith('+') && !l.startsWith('+++') ? `<span class="diff-add">${l}</span>`
        : l.startsWith('-') && !l.startsWith('---') ? `<span class="diff-del">${l}</span>`
          : l.startsWith('@@') ? `<span class="diff-hunk">${l}</span>` : l).join('\n');
    return dialog(`<h3>${esc(tcode(t))} ${esc(t.title)}</h3>
      ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
      ${outsideWarn(t)}
      ${diffStatsHtml(t)}
      <pre>${html}</pre>${buttons(null)}`, null, 'wide');
  }
  if (d.importFlow !== undefined) {
    const path = $('#import-flow')?.value;
    if (!path) return toast('Elige un flow', 'error');
    const r = await api('POST', `/api/projects/${projectId}/import-flow`, { path });
    return toast(`Tablero «${r.flowName}»: ${r.created} tarjetas nuevas, ${r.updated} actualizadas, ${r.skipped} ignoradas (columnas: ${r.columns.join(' · ')})`);
  }
  if (d.deleteProject !== undefined) {
    if (confirm('¿Borrar el proyecto con su equipo y tareas? (no toca tu repositorio)')) {
      await api('DELETE', `/api/projects/${projectId}`);
      $('#dialog').close();
    }
  }
});

// FT-50: «Asignar a…» en la tarjeta o en el modal de la tarea → fija el agente (o vuelve a la regla del rol); el chip se repinta por SSE.
document.addEventListener('change', async (e) => {
  const sel = e.target.closest?.('select[data-assign]');
  if (!sel || !sel.value) return;
  const v = sel.value, t = S.tasks.find((x) => x.id === sel.dataset.assign), a = S.agents.find((x) => x.id === v);
  sel.value = '';
  try { await api('POST', `/api/tasks/${sel.dataset.assign}/assign`, { agentId: v === '__auto' ? null : v }); toast(a ? `${tcode(t)} → la hará ${a.name}` : `${tcode(t)}: el agente vuelve a elegirse por rol`); } catch { /* api() ya avisó */ }
});
$('#project').onchange = (e) => { projectId = e.target.value; safeSet('ao:project', projectId); closeDrawer(); };
// Campo del objetivo compacto: una línea que crece con el texto; Enter encarga, Shift+Enter salta de línea.
$('#goal').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; });
$('#goal').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#goal-form').requestSubmit(); } });
$('#goal-form').onsubmit = async (e) => {
  e.preventDefault();
  const goal = $('#goal').value.trim();
  if (!goal) return;
  await api('POST', `/api/projects/${projectId}/goal`, { goal });
  $('#goal').value = ''; $('#goal').style.height = '';
  toast(project()?.running ? 'El PO se pone con ello' : 'Encargado. Pulsa «▶ Poner a trabajar» para empezar');
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerAgent && !$('#dialog').open) { if (activeTab === 'office') leaveAgentLevel(); else closeDrawer(); } });

// ── Contexto de la UI para el Guide Agent (FT-2) ────────────────────────────
// Publica lo que el usuario está viendo (POST /api/context, debounce 300 ms, solo si cambia). Estructurado, sin capturas.
// Id de pestaña en sessionStorage para distinguir clientes; `host` = contexto que flow-test manda por postMessage (FT-3).
const CLIENT_ID = (() => { try { return sessionStorage.getItem('ao:client') || (sessionStorage.setItem('ao:client', 'c_' + Math.random().toString(36).slice(2, 10)), sessionStorage.getItem('ao:client')); } catch { return 'c_' + Math.random().toString(36).slice(2, 10); } })();

const ctxKey = () => JSON.stringify({ view: activeTab, projectId, openTaskId, selectedAgentId: drawerAgent, taskFilter, questionOpen: qOpen, officeMode, officeLevel, host: hostCtx }); // officeLevel: edificio, planta o agente (FT-71)
function publishContext() {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    const key = ctxKey();
    if (key === ctxSent) return;
    ctxSent = key;
    fetch(BASE + 'api/context', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT_ID }, body: JSON.stringify({ ...JSON.parse(key), at: Date.now() }) }).catch(() => { ctxSent = ''; });
  }, 300);
}
$('#dialog').addEventListener('close', () => { openTaskId = null; publishContext(); });
$('#project').addEventListener('change', publishContext);
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent || window.parent === window || e.data?.type !== 'flowtest:context') return;
  // Forma real que manda AgentsPanel.tsx (FT-3): {activeTab{id,name,filePath,dirty}, focusedNode{id,name,kind,status}|null, selection[], consoleTail[], runStatus, sidePanel}.
  // Se aplana al `host` que leen context.js / task-context.js (FT-12 detectó que antes se leían campos que flow-test no manda).
  const d = e.data, tab = d.activeTab || null, fn = d.focusedNode || null;
  hostFeatures = Array.isArray(d.features) ? d.features.map(String) : [];
  hostCtx = {
    flow: d.flow ?? tab?.name ?? null, filePath: d.filePath ?? tab?.filePath ?? null, dirty: d.dirty ?? tab?.dirty ?? false,
    node: d.node ?? fn?.name ?? null, nodeId: fn?.id ?? null, nodeLabel: fn?.name ?? null, nodeKind: fn?.kind ?? null, nodeStatus: fn?.status ?? null,
    selection: Array.isArray(d.selection) ? d.selection.slice(0, 20) : [], consoleTail: Array.isArray(d.consoleTail) ? d.consoleTail.slice(-20) : [],
    running: d.running ?? (d.runStatus === 'running'), sidePanel: d.sidePanel ?? null,
  };
  publishContext();
});
publishContext();
refreshSttLocal(); // para saber si el dictado (FT-43) puede ir por el STT del servidor
if (voicePref.wake() && !SETTINGS_EMBED) wakeSet(true); // escucha continua recordada en este navegador (FT-36); con la casilla sin tocar nunca se pide el micro
if (EMBEDDED && !SETTINGS_EMBED) { try { window.parent.postMessage({ type: 'agentoffice:ready' }, location.origin); } catch { /* padre de otro origen */ } } // flow-test responde con su contexto (FT-3)

// ── Ajustes en el panel tipo Cmd de flow-test (FT-42) ───────────────────────
// Un único formulario (el de siempre, `actions.settings`): flow-test pinta el menú lateral con las secciones que publicamos
// aquí y nos dice cuál enseñar; los campos de las demás siguen en el formulario, así «Guardar» guarda todo a la vez.
const postParent = (msg) => { try { window.parent.postMessage(msg, location.origin); } catch { /* padre de otro origen */ } };
function openSettingsEmbed() {
  document.body.classList.add('settings-embed');
  document.querySelector('[data-action="settings"]').click(); // abre el diálogo y lanza los refrescos de motores/tablero/STT de siempre
  const form = $('#dialog form');
  const secs = [];
  let cur = null;
  for (const el of [...form.children]) {
    if (el.matches('h3')) { el.remove(); continue; }
    if (el.matches('.row')) break; // Guardar/Cancelar quedan fuera de las secciones
    if (el.matches('.section-title')) { cur = document.createElement('section'); cur.className = 'set-sec'; cur.dataset.sec = String(secs.length); secs.push(el.textContent.trim()); el.before(cur); }
    if (cur) cur.append(el);
  }
  const show = (i) => document.querySelectorAll('.set-sec').forEach((x) => { x.hidden = x.dataset.sec !== String(i); });
  show(0);
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'flowtest:settingsSection') return;
    show(Number(e.data.id) || 0);
  });
  document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); postParent({ type: 'agentoffice:settingsNav', dir: e.key === 'ArrowUp' ? -1 : 1 }); } });
  $('#dialog').addEventListener('close', () => postParent({ type: 'agentoffice:settingsClosed' }));
  postParent({ type: 'agentoffice:settingsSections', sections: secs.map((title, id) => ({ id, title })) });
}
// Dentro de flow-test el botón «Ajustes» abre el panel de flow-test, no el diálogo de aquí — SOLO si ese flow-test lo
// anuncia en su contexto (`features: ['settingsPanel']`, 5.19.3+); con uno más antiguo el diálogo propio sigue funcionando.
if (EMBEDDED && !SETTINGS_EMBED) {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="settings"]') || !hostFeatures.includes('settingsPanel')) return;
    e.stopImmediatePropagation(); e.preventDefault();
    postParent({ type: 'agentoffice:openSettings' });
  }, true);
  window.addEventListener('storage', (e) => { if (e.key === 'ao:voice-wake') wakeSet(e.newValue === '1'); });
}
// FT-66: «Reanudar ya» en una tarea pausada por falta de cuota
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-resume-now]');
  if (!b) return;
  e.stopPropagation();
  try { await api('POST', `/api/tasks/${b.dataset.resumeNow}/resume-now`); toast('Se relanza en el siguiente reparto'); } catch { /* api() ya avisa */ }
});

// Fallidas: lista con el motivo de cada una (clic en «N fallidas» del Resumen, global o por proyecto).
function failedDialog(pid) {
  const list = S.tasks.filter((t) => t.status === 'failed' && (!pid || t.projectId === pid)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const proj = (id) => S.projects.find((x) => x.id === id)?.name || id;
  const who = (t) => S.agents.find((a) => a.id === t.agentId)?.name || '';
  const why = (t) => { const e = String(t.error || '').trim(); if (!e) return 'Sin mensaje de error registrado.'; return /parado por el usuario/i.test(e) ? 'La paró una persona a mano (no es un error del agente). «Reintentar» la vuelve a poner en cola.' : e; };
  dialog(`<h3>❌ ${list.length} tarea${list.length === 1 ? '' : 's'} fallida${list.length === 1 ? '' : 's'}${pid ? ` · ${esc(proj(pid))}` : ''}</h3>
    ${list.length ? list.map((t) => `<div class="failed-item">
      <div><b>${esc(tcode(t))}</b> ${esc(t.title)}</div>
      <div class="muted">${pid ? '' : `${esc(proj(t.projectId))} · `}${who(t) ? `👤 ${esc(who(t))} · ` : ''}${t.updatedAt ? ago(t.updatedAt) : ''}${t.attempts ? ` · intento ${t.attempts}` : ''}${t.costUsd ? ` · ${t.costUsd.toFixed(2)} $` : ''}</div>
      <pre class="failed-why">${esc(why(t).slice(0, 1500))}</pre>
      <div class="row" style="justify-content:flex-start;gap:6px"><button type="button" class="small" data-reject="${t.id}">↻ Reintentar</button><button type="button" class="small ghost" data-open="${t.id}">🔍 Ver la tarea</button></div>
    </div>`).join('') : '<p class="muted">No hay tareas fallidas.</p>'}
    ${buttons('')}`, () => {}, 'wide');
}
