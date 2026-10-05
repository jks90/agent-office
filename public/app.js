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
const es = new EventSource(BASE + 'events');
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
  const repos = p?.repos || [];
  $('#repo').textContent = p ? (repos.length ? `📁 ${repos.map((r) => `${r.key} (${r.baseBranch})`).join(' · ')}` : 'sin repositorio · solo motor demo') : '';
  $('#repo').title = repos.map((r) => `${r.key}: ${r.path}`).join('\n');
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
  ['backlog', 'Backlog', '#94a3b8'],
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
  if (t.status === 'backlog') acts.push(`<button class="small" data-ready="${t.id}">→ Por hacer</button>`);
  if (t.status === 'todo') acts.push(`<button class="small ghost" data-park="${t.id}">← Backlog</button>`);
  if (['todo', 'failed', 'done'].includes(t.status)) acts.push(`<button class="small danger" data-del="${t.id}">Borrar</button>`);
  return `<div class="card ${t.status}" style="--c:${S.roles[t.role]?.color}">
    <div class="card-head">${roleChip(t.role)} <span class="task-id">#${t.id}</span>${(project()?.repos || []).length > 1 && (t.repo || t.branch) ? ` <span class="repo-chip">📁 ${esc(t.repo || '?')}</span>` : ''}${t.source ? ` <span title="Importada del tablero «${esc(t.source.flow)}» · columna ${esc(t.source.column)}">🗂</span>` : ''}${t.kind === 'plan' ? ' <span>🗂 plan</span>' : ''}${t.attempts > 1 ? ` <span>intento ${t.attempts}</span>` : ''}</div>
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
const roleOptions = (sel, skipPo) => Object.entries(S.roles).filter(([, r]) => !(skipPo && r.kind === 'planner'))
  .map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''} title="${esc(r.description || '')}">${esc(r.label)}${r.custom ? ` · ${esc(r.source)}` : ''}${r.kind === 'planner' ? ' (planifica)' : r.kind === 'qa' ? ' (QA)' : ''}</option>`).join('');
const engineOptions = (sel) => S.engines.map((e) => `<option ${e === sel ? 'selected' : ''}>${e}</option>`).join('');

const actions = {
  'new-project': () => dialog(`
    <h3>Nuevo proyecto</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Repositorios git (opcional; uno por línea, <code>clave = ruta</code> o solo la ruta; <code>clave = ruta @ rol1,rol2</code> fija qué roles trabajan en ese repo)</label>
    <textarea name="repos" rows="3" placeholder="~/dev/mi-api @ back,qa&#10;~/dev/mi-web @ front"></textarea>
    <label>Motor del equipo</label><select name="engine">${engineOptions('demo')}</select>
    <p class="muted">Cada tarea se hace en un git worktree propio del repo que le toca (rama <code>ao/&lt;tarea&gt;</code>); nada llega a tu rama hasta que apruebas. Sin repo solo funciona el motor <b>demo</b>.</p>
    ${buttons('Crear')}`, async (f) => {
    const p = await api('POST', '/api/projects', { name: f.name, engine: f.engine, repos: parseRepos(f.repos) });
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
    ${(project()?.repos || []).length > 1 ? `<label>Repositorio</label><select name="repo"><option value="">(el que diga el rol)</option>${project().repos.map((r) => `<option value="${r.key}">${esc(r.key)} — ${esc(r.path)}</option>`).join('')}</select>` : ''}
    <label>Estado inicial</label><select name="status"><option value="todo">Por hacer (el equipo la coge en cuanto pueda)</option><option value="backlog">Backlog (esperar)</option></select>
    ${buttons('Crear')}`, (f) => api('POST', '/api/tasks', { ...f, projectId })),
  settings: () => dialog(`
    <h3>Ajustes</h3>
    <div class="section-title">🧠 Motores de IA — las inteligencias que llevan la empresa</div>
    <div id="engines" class="engines"><p class="muted">Comprobando cuentas…</p></div>
    <div class="section-title">🧪 Suite</div>
    <label>URL de flow-test (la suite; su MCP se usa para el QA)</label><input name="flowTestUrl" value="${esc(S.settings.flowTestUrl)}" placeholder="http://localhost:9998" />
    <label>Agentes trabajando a la vez (máx.)</label><input name="maxParallel" type="number" min="1" max="8" value="${S.settings.maxParallel}" />
    <hr style="border-color:var(--line);margin:16px 0" />
    <label>Repositorios del proyecto «${esc(project()?.name)}» (uno por línea: <code>clave = ruta @ roles</code>)</label>
    <textarea name="repos" rows="3">${esc((project()?.repos || []).map((r) => `${r.key} = ${r.path}${r.roles?.length ? ' @ ' + r.roles.join(',') : ''}`).join('\n'))}</textarea>
    <label>Importar un tablero de flow-test (notas = tarjetas; las columnas «En revisión»/«Hecho» conservan su estado, el resto entra en Backlog)</label>
    <div style="display:flex;gap:8px"><select name="importFlow" id="import-flow"><option value="">— elegir flow —</option></select><button type="button" class="small" data-import-flow>Importar</button></div>
    <hr style="border-color:var(--line);margin:16px 0" />
    <button type="button" class="danger small" data-delete-project>Borrar el proyecto «${esc(project()?.name)}»</button>
    ${buttons()}`, async (f) => {
    await api('POST', '/api/settings', f);
    const repos = parseRepos(f.repos);
    const cur = (project()?.repos || []).map((r) => `${r.key}=${r.path}@${(r.roles || []).join(',')}`).join('|');
    if (repos.map((r) => `${r.key}=${r.path}@${(r.roles || []).join(',')}`).join('|') !== cur) await api('PATCH', `/api/projects/${projectId}`, { repos });
  }),
};
// Tras abrir Ajustes, rellenar el selector de flows con los del flow-test conectado.
let enginesTimer = null;
async function refreshEngines() {
  const el = $('#engines');
  if (!el || !el.isConnected) { clearInterval(enginesTimer); enginesTimer = null; return; }
  try { renderEngines(await api('GET', '/api/engines')); } catch { /* el toast ya avisó */ }
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
    setTimeout(() => { refreshEngines(); clearInterval(enginesTimer); enginesTimer = setInterval(refreshEngines, 2500); }, 50);
    api('GET', '/api/flows').then((flows) => {
      const sel = $('#import-flow');
      if (sel) sel.innerHTML = '<option value="">— elegir flow —</option>' + flows.map((f) => `<option value="${esc(f.path)}">${esc(f.name)} — ${esc(f.path)}</option>`).join('');
    }).catch(() => {});
  }
});

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
  if (d.ready) return api('PATCH', `/api/tasks/${d.ready}`, { status: 'todo' });
  if (d.park) return api('PATCH', `/api/tasks/${d.park}`, { status: 'backlog' });
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
