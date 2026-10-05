const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { projects: [], agents: [], tasks: [], settings: {}, roles: {}, engines: [] };
let projectId = safeGet('ao:project');
let drawerAgent = null;
const logs = new Map();

const useLegacy = new URLSearchParams(location.search).get('r') === '2d' || safeGet('ao:renderer') === '2d';
const { Office } = await import(useLegacy ? './office.js' : './office3d.js');
const office = new Office($('#office'), { onAgentClick: (id) => openDrawer(id) });

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
const es = new EventSource('/events');
es.addEventListener('state', (e) => {
  S = JSON.parse(e.data);
  if (!S.projects.some((p) => p.id === projectId)) projectId = S.projects[0]?.id ?? null;
  render();
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

const project = () => S.projects.find((p) => p.id === projectId);
const team = () => S.agents.filter((a) => a.projectId === projectId);
const tasks = () => S.tasks.filter((t) => t.projectId === projectId);
const roleChip = (role) => `<span class="chip" style="--c:${S.roles[role]?.color}">${esc(S.roles[role]?.label || role)}</span>`;

// ── Pintado ─────────────────────────────────────────────────────────────────
function render() {
  const p = project();
  $('#project').innerHTML = S.projects.map((x) => `<option value="${x.id}" ${x.id === projectId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#repo').textContent = p ? (p.repoPath ? `📁 ${p.repoPath} · ${p.baseBranch}` : 'sin repositorio · solo motor demo') : '';
  const run = $('#run');
  run.textContent = p?.running ? '⏸ Parar el equipo' : '▶ Poner a trabajar';
  run.classList.toggle('on', !!p?.running);
  run.disabled = !p;

  office.update({ agents: team(), tasks: tasks(), roles: S.roles, title: p?.name || '', selected: drawerAgent });
  renderSuite();
  renderTeam();
  renderBoard();
  if (drawerAgent) renderDrawer();
}

function renderTeam() {
  $('#team').innerHTML = team().map((a) => `
    <div class="member ${a.id === drawerAgent ? 'sel' : ''}" style="--c:${S.roles[a.role]?.color}" data-agent="${a.id}">
      <div class="top">
        <span class="avatar">${esc(a.name).charAt(0).toUpperCase()}</span>
        <div class="member-main"><b>${esc(a.name)}</b><div class="act">${a.status === 'working' ? esc(a.activity) : 'En la zona de descanso ☕'}</div></div>
        <span class="eng">${esc(a.engine)}</span>
      </div>
      <div class="member-foot">${roleChip(a.role)}<span class="state ${a.status}"><span class="dot ${a.status}"></span>${a.status === 'working' ? 'Trabajando' : 'Descansando'}</span></div>
    </div>`).join('') || '<p class="empty">Sin agentes todavía. Contrata a alguien para empezar.</p>';
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
  ['todo', 'Por hacer', '#fde047'],
  ['doing', 'En curso', '#60a5fa'],
  ['review', 'Revisión', '#fb923c'],
  ['done', 'Hecho', '#4ade80'],
];

function renderBoard() {
  const list = tasks();
  $('#board').innerHTML = COLS.map(([st, label, c]) => {
    const items = list.filter((t) => t.status === st || (st === 'todo' && t.status === 'failed'))
      .sort((a, b) => (st === 'done' ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt));
    return `<div class="col" style="--c:${c}"><h4><span>${label}</span><span class="count">${items.length}</span></h4><div class="cards">${items.map(card).join('') || '<div class="empty">Nada por aquí</div>'}</div></div>`;
  }).join('');
}

function card(t) {
  const agent = S.agents.find((a) => a.id === t.agentId);
  const deps = t.dependsOn.map((d) => {
    const dt = S.tasks.find((x) => x.id === d);
    return `<span title="${esc(dt?.title)}">${dt?.status === 'done' ? '✓' : '⏳'}#${d}</span>`;
  }).join(' ');
  const acts = [];
  if (t.status === 'review') {
    acts.push(`<button class="small ghost" data-diff="${t.id}">Ver cambios</button>`);
    acts.push(`<button class="small ok" data-approve="${t.id}">✓ Aprobar${t.branch ? ' y fusionar' : ''}</button>`);
    acts.push(`<button class="small ghost" data-reject="${t.id}">↩ Devolver</button>`);
  }
  if (t.status === 'failed') acts.push(`<button class="small" data-reject="${t.id}">↻ Reintentar</button>`);
  if (['todo', 'failed', 'done'].includes(t.status)) acts.push(`<button class="small danger" data-del="${t.id}">Borrar</button>`);
  return `<div class="card ${t.status}" style="--c:${S.roles[t.role]?.color}">
    <div class="card-head">${roleChip(t.role)} <span class="task-id">#${t.id}</span>${t.kind === 'plan' ? ' <span>🗂 plan</span>' : ''}${t.attempts > 1 ? ` <span>intento ${t.attempts}</span>` : ''}</div>
    <div class="t">${esc(t.title)}</div>
    <div class="meta">${agent ? `<span>👤 ${esc(agent.name)}</span>` : ''}${deps ? `<span>depende de ${deps}</span>` : ''}${t.costUsd ? ` <span>💲${t.costUsd.toFixed(3)}</span>` : ''}</div>
    ${t.status === 'doing' && agent ? `<div class="live">● ${esc(agent.activity)}</div>` : ''}
    ${t.summary && t.status !== 'doing' ? `<div class="sum">${esc(t.summary)}</div>` : ''}
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
    ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
  </div>`;
}

// ── Panel del agente ───────────────────────────────────────────────────────
function openDrawer(id) {
  drawerAgent = id;
  $('#drawer').hidden = false;
  render();
  renderLog();
}
function closeDrawer() { drawerAgent = null; $('#drawer').hidden = true; render(); }

function renderDrawer() {
  const a = S.agents.find((x) => x.id === drawerAgent);
  if (!a) return closeDrawer();
  const task = S.tasks.find((t) => t.id === a.taskId);
  const d = $('#drawer');
  // Si ya está pintado, solo refrescamos lo que cambia (no perder el foco de los inputs).
  if (d.dataset.agent === a.id) {
    d.querySelector('[data-f=status]').innerHTML = a.status === 'working' ? `🟢 ${esc(a.activity)}` : '☕ descansando';
    d.querySelector('[data-f=task]').innerHTML = task ? `#${task.id} ${esc(task.title)}` : '—';
    d.querySelector('[data-stop]').hidden = a.status !== 'working';
    return;
  }
  d.dataset.agent = a.id;
  d.innerHTML = `
    <div class="head"><span class="avatar" style="--c:${S.roles[a.role]?.color}">${esc(a.name).charAt(0).toUpperCase()}</span><h2>${esc(a.name)}</h2>${roleChip(a.role)}<div class="spacer"></div><button class="ghost small" data-close>✕</button></div>
    <div class="grid">
      <span class="muted">Estado</span><span data-f="status"></span>
      <span class="muted">Tarea</span><span data-f="task"></span>
      <span class="muted">Motor</span>
      <select data-f="engine">${S.engines.map((e) => `<option ${e === a.engine ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <span class="muted">Modelo</span><input data-f="model" value="${esc(a.model)}" placeholder="por defecto del CLI (p. ej. sonnet, opus)" />
    </div>
    <div class="row" style="display:flex;gap:8px">
      <button class="danger small" data-stop="${a.id}">⏹ Parar</button>
      <div class="spacer"></div>
      <button class="danger small" data-fire="${a.id}">Despedir</button>
    </div>
    <div class="muted">Registro en vivo</div>
    <div id="log"></div>`;
  d.querySelector('[data-f=engine]').onchange = (e) => api('PATCH', `/api/agents/${a.id}`, { engine: e.target.value }).then(() => toast(`${a.name} usa ahora ${e.target.value}`));
  d.querySelector('[data-f=model]').onchange = (e) => api('PATCH', `/api/agents/${a.id}`, { model: e.target.value });
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
}
const buttons = (ok = 'Guardar') => `<div class="row"><button class="ghost" value="cancel">Cancelar</button>${ok ? `<button>${ok}</button>` : ''}</div>`;
const roleOptions = (sel, skipPo) => Object.entries(S.roles).filter(([k]) => !(skipPo && k === 'po'))
  .map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
const engineOptions = (sel) => S.engines.map((e) => `<option ${e === sel ? 'selected' : ''}>${e}</option>`).join('');

const actions = {
  'new-project': () => dialog(`
    <h3>Nuevo proyecto</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Repositorio git (opcional)</label><input name="repoPath" placeholder="~/dev/mi-proyecto" />
    <label>Motor del equipo</label><select name="engine">${engineOptions('demo')}</select>
    <p class="muted">Cada tarea se hace en un git worktree propio (rama <code>ao/&lt;tarea&gt;</code>); nada llega a tu rama hasta que apruebas. Sin repo solo funciona el motor <b>demo</b>.</p>
    ${buttons('Crear')}`, async (f) => {
    const p = await api('POST', '/api/projects', f);
    projectId = p.id;
    safeSet('ao:project', p.id);
  }),
  'toggle-run': () => api('POST', `/api/projects/${projectId}/run`, { running: !project()?.running }),
  hire: () => dialog(`
    <h3>Contratar agente</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Rol</label><select name="role">${roleOptions('back')}</select>
    <label>Motor</label><select name="engine">${engineOptions('demo')}</select>
    <label>Modelo (opcional)</label><input name="model" placeholder="por defecto del CLI" />
    ${buttons('Contratar')}`, (f) => api('POST', '/api/agents', { ...f, projectId })),
  'new-task': () => dialog(`
    <h3>Nueva tarea</h3>
    <label>Título</label><input name="title" required autofocus />
    <label>Descripción</label><textarea name="description" rows="4" placeholder="Qué hay que hacer y cómo saber que está bien"></textarea>
    <label>Rol</label><select name="role">${roleOptions('back', true)}</select>
    ${buttons('Crear')}`, (f) => api('POST', '/api/tasks', { ...f, projectId })),
  settings: () => dialog(`
    <h3>Ajustes</h3>
    <label>URL de flow-test (la suite; su MCP se usa para el QA)</label><input name="flowTestUrl" value="${esc(S.settings.flowTestUrl)}" placeholder="http://localhost:9998" />
    <label>Agentes trabajando a la vez (máx.)</label><input name="maxParallel" type="number" min="1" max="8" value="${S.settings.maxParallel}" />
    <hr style="border-color:var(--line);margin:16px 0" />
    <button type="button" class="danger small" data-delete-project>Borrar el proyecto «${esc(project()?.name)}»</button>
    ${buttons()}`, (f) => api('POST', '/api/settings', f)),
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, .member');
  if (!el) return;
  const d = el.dataset;
  if (d.action === 'suite') { S.suite = await api('GET', '/api/suite'); renderSuite(); return toast(S.suite.ok ? `flow-test OK · ${S.suite.plan || S.suite.mode}` : S.suite.reason, S.suite.ok ? '' : 'error'); }
  if (d.action) return actions[d.action]?.();
  if (d.agent) return openDrawer(d.agent);
  if (d.close !== undefined) return closeDrawer();
  if (d.stop) return api('POST', `/api/agents/${d.stop}/stop`);
  if (d.fire) {
    if (confirm('¿Despedir a este agente?')) { await api('DELETE', `/api/agents/${d.fire}`); closeDrawer(); }
    return;
  }
  if (d.approve) return api('POST', `/api/tasks/${d.approve}/approve`).then(() => toast('Tarea aprobada ✓'));
  if (d.del) { if (confirm('¿Borrar la tarea?')) api('DELETE', `/api/tasks/${d.del}`); return; }
  if (d.reject) {
    const t = S.tasks.find((x) => x.id === d.reject);
    return dialog(`
      <h3>${t.status === 'failed' ? 'Reintentar' : 'Devolver'} #${t.id}</h3>
      <p class="muted">${esc(t.title)}</p>
      <label>Comentarios para el agente (opcional)</label><textarea name="feedback" rows="4" autofocus></textarea>
      ${buttons(t.status === 'failed' ? 'Reintentar' : 'Devolver')}`, (f) => api('POST', `/api/tasks/${t.id}/reject`, f));
  }
  if (d.diff) {
    const { diff } = await api('GET', `/api/tasks/${d.diff}/diff`);
    const t = S.tasks.find((x) => x.id === d.diff);
    const html = esc(diff).split('\n').map((l) =>
      l.startsWith('+') && !l.startsWith('+++') ? `<span class="diff-add">${l}</span>`
        : l.startsWith('-') && !l.startsWith('---') ? `<span class="diff-del">${l}</span>`
          : l.startsWith('@@') ? `<span class="diff-hunk">${l}</span>` : l).join('\n');
    return dialog(`<h3>#${t.id} ${esc(t.title)}</h3>
      ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
      ${t.diffStat ? `<pre>${esc(t.diffStat)}</pre>` : ''}
      <pre>${html}</pre>${buttons(null)}`, null, 'wide');
  }
  if (d.deleteProject !== undefined) {
    if (confirm('¿Borrar el proyecto con su equipo y tareas? (no toca tu repositorio)')) {
      await api('DELETE', `/api/projects/${projectId}`);
      $('#dialog').close();
    }
  }
});

$('#project').onchange = (e) => { projectId = e.target.value; safeSet('ao:project', projectId); closeDrawer(); };
$('#goal-form').onsubmit = async (e) => {
  e.preventDefault();
  const goal = $('#goal').value.trim();
  if (!goal) return;
  await api('POST', `/api/projects/${projectId}/goal`, { goal });
  $('#goal').value = '';
  toast(project()?.running ? 'El PO se pone con ello' : 'Encargado. Pulsa «▶ Poner a trabajar» para empezar');
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerAgent && !$('#dialog').open) closeDrawer(); });
