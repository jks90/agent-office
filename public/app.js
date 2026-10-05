const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { projects: [], agents: [], tasks: [], settings: {}, roles: {}, engines: [] };
let projectId = safeGet('ao:project');
let drawerAgent = null;
const logs = new Map();

import { Office } from './office3d.js';
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
const team = () => { const ids = new Set(project()?.team || []); return S.agents.filter((a) => ids.has(a.id)); };
const bench = () => { const ids = new Set(project()?.team || []); return S.agents.filter((a) => !ids.has(a.id)); };
const projectsOf = (agentId) => S.projects.filter((p) => (p.team || []).includes(agentId) && p.id !== projectId).map((p) => p.name);
const tasks = () => S.tasks.filter((t) => t.projectId === projectId);
const roleChip = (role) => `<span class="chip" style="--c:${S.roles[role]?.color}">${esc(S.roles[role]?.label || role)}</span>`;

// ── Pintado ─────────────────────────────────────────────────────────────────
// Pestañas de administración (Oficina / Tareas / Agentes), recordadas por navegador.
let skillsData = null; // catálogo e inventario de skills (se carga al abrir Agentes)
let MODELS = { claude: [], codex: [] }; // modelos disponibles por motor (GET /api/engines/models)
const loadModels = () => api('GET', '/api/engines/models').then((m) => { MODELS = m; }).catch(() => {});
loadModels();
// <select> de modelo: grupos por motor (en «auto» salen los dos), los no disponibles deshabilitados con su motivo, y «otro…» libre.
function modelSelect(name, engine, current) {
  const groups = engine === 'auto' ? ['claude', 'codex'] : engine === 'demo' ? [] : [engine];
  const known = groups.flatMap((g) => MODELS[g] || []).some((m) => m.id === current);
  return `<select name="${name}" class="model-select" data-engine="${engine}">
    <option value="" ${!current ? 'selected' : ''}>por defecto del rol / motor</option>
    ${groups.map((g) => `<optgroup label="${g === 'claude' ? 'Claude Code' : 'Codex'}">${(MODELS[g] || []).map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''} ${m.available ? '' : 'disabled'}>${esc(m.label)}${m.available ? (m.note ? ' (' + esc(m.note) + ')' : '') : ' — ' + esc(m.note || 'no disponible')}</option>`).join('')}</optgroup>`).join('')}
    <option value="__other" ${current && !known ? 'selected' : ''}>otro… (escribir id)</option>
  </select><input name="${name}_other" class="model-other" placeholder="id del modelo" value="${current && !known ? esc(current) : ''}" style="${current && !known ? '' : 'display:none'}" />`;
}
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.model-select');
  if (sel) { const other = sel.parentElement.querySelector('.model-other'); if (other) other.style.display = sel.value === '__other' ? '' : 'none'; return; }
  const eng = e.target.closest('select[name=engine]');
  if (eng) { const ms = eng.closest('form')?.querySelector('.model-select'); if (ms) ms.outerHTML = modelSelect(ms.name, eng.value, '').replace(/<input[^>]*>$/, ''); }
});
const pickModel = (f) => (f.model === '__other' ? (f.model_other || '').trim() : f.model || '');
let activeTab = safeGet('ao:tab') || 'office';
function showTab(tab) {
  activeTab = tab;
  safeSet('ao:tab', tab);
  document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + tab; });
  if (tab === 'office') requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  if (tab === 'agents') renderSkills();
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
const EMBEDDED = window.self !== window.top;
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

  office.update({ agents: team(), tasks: tasks(), roles: S.roles, title: p?.name || '', selected: drawerAgent });
  renderSuite();
  renderTeam();
  renderRepos();
  renderRoles();
  renderBoard();
  const ts = tasks();
  const working = team().filter((a) => a.status === 'working');
  $('#tab-tasks-count').textContent = ts.filter((t) => ['todo', 'doing', 'review'].includes(t.status)).length || '';
  $('#tab-agents-count').textContent = team().length || '';
  $('#tab-summary').innerHTML = `${ts.filter((t) => t.status === 'doing').length} en curso<br>${ts.filter((t) => t.status === 'review').length} por revisar<br>${working.length}/${team().length} agentes trabajando`;
  $('#office-live').textContent = working.length ? working.map((a) => `${a.name}: ${a.activity}`).join('  ·  ') : 'Nadie está trabajando ahora mismo';
  const b = p?.board;
  const pending = b ? ts.filter((t) => t.source?.kind !== b.kind && t.kind !== 'plan').length : 0;
  const job = b?.job;
  $('#board-chip').innerHTML = b
    ? `🔗 ${esc(BOARD_LABELS[b.kind] || b.kind)} · <a href="${esc(b.url || '#')}" target="_blank" rel="noopener">${esc(b.config.repo || b.config.boardId || b.config.projectKey || '')}</a> · ${b.syncedAt ? 'hace ' + ago(b.syncedAt) : 'sin sincronizar'}${pending ? ` · <span title="tareas sin tarjeta fuera">${pending} sin tarjeta</span>` : ''}${b.lastError ? ` <span class="bad" title="${esc(b.lastError)}">⚠</span>` : ''} ${job?.running ? `<span class="muted">⇪ ${job.done}/${job.total}${job.waitingUntil ? ' · esperando a GitHub' : ''}</span> <button class="small ghost" data-board-cancel>✕</button>` : `<button class="small" data-board-syncall title="Igualar los dos lados: trae y lleva los estados y crea fuera las tarjetas que falten">⇅ Sincronizar</button>`}`
    : `<button class="small ghost" data-action="settings" title="Conecta GitHub, Trello o Jira en Ajustes ▸ Tablero online">🔗 Conectar tablero…</button>`;
  if (drawerAgent) renderDrawer();
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
        <div class="member-main"><b>${esc(a.name)}</b><div class="act">${a.status === 'working' ? esc(a.activity) : 'En la zona de descanso ☕'}</div></div>
        <span class="eng">${esc(a.engine)}${a.engine === 'auto' && a.activeEngine ? ' → ' + esc(a.activeEngine) : ''}${a.model ? ' · ' + esc(a.model) : ''}</span>
      </div>
      <div class="member-foot">${roleChip(a.role)}<span class="state ${a.status}"><span class="dot ${a.status}"></span>${a.status === 'working' ? 'Trabajando' : 'Descansando'}</span></div>
      ${task ? `<div class="task">▶ #${task.id} ${esc(task.title)}</div>` : ''}
      <div class="meta"><span>${done} entregadas</span>${cost ? `<span>≈ ${cost.toFixed(2)} $</span>` : ''}${r?.custom ? `<span title="${esc(r.description || '')}">rol de fichero · ${esc(r.source)}</span>` : ''}</div>
      ${projectsOf(a.id).length ? `<div class="meta"><span>también en: ${projectsOf(a.id).map(esc).join(', ')}</span></div>` : ''}
      <div class="acts">
        <button class="small ghost" data-agent="${a.id}">Registro</button>
        <button class="small ghost" data-agent-edit="${a.id}" title="Nombre, rol, motor y modelo">✎ Editar</button>
        ${a.status === 'working' ? `<button class="small danger" data-stop="${a.id}">⏹ Parar</button>` : ''}
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
      <div class="top" data-agent="${a.id}"><span class="avatar">${esc(a.name).charAt(0).toUpperCase()}</span><div class="member-main"><b>${esc(a.name)}</b><div class="act">${a.status === 'working' ? esc(a.activity) : (projectsOf(a.id).length ? 'en ' + projectsOf(a.id).map(esc).join(', ') : 'disponible')}</div></div><span class="eng">${esc(a.engine)}${a.model ? ' · ' + esc(a.model) : ''}</span></div>
      <div class="member-foot">${roleChip(a.role)}<span class="state ${a.status}"><span class="dot ${a.status}"></span>${a.status === 'working' ? 'Trabajando' : 'Libre'}</span></div>
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
$('#task-filter').addEventListener('input', (e) => { taskFilter = e.target.value.trim().toLowerCase(); renderBoard(); });
function renderBoard() {
  const list = tasks().filter((t) => !taskFilter || `${t.id} ${t.title} ${t.role} ${t.repo || ''} ${t.description}`.toLowerCase().includes(taskFilter));
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
  if (t.status !== 'doing') acts.unshift(`<button class="small ghost" data-edit="${t.id}" title="Editar título, descripción, rol, repo y dependencias">✎</button>`);
  if (t.status === 'backlog') acts.push(`<button class="small" data-ready="${t.id}">→ Por hacer</button>`);
  if (t.status === 'todo') acts.push(`<button class="small ghost" data-park="${t.id}">← Backlog</button>`);
  if (['todo', 'failed', 'done'].includes(t.status)) acts.push(`<button class="small danger" data-del="${t.id}">Borrar</button>`);
  return `<div class="card ${t.status}" style="--c:${S.roles[t.role]?.color}">
    <div class="card-head">${roleChip(t.role)} <span class="task-id">#${t.id}</span>${(project()?.repos || []).length > 1 && (t.repo || t.branch) ? ` <span class="repo-chip">📁 ${esc(t.repo || '?')}</span>` : ''}${t.source?.flow ? ` <span title="Importada del tablero «${esc(t.source.flow)}» · columna ${esc(t.source.column)}">🗂</span>` : ''}${(t.feedbackImages?.length || t.files?.length) ? ` <span title="${esc([...(t.feedbackImages || []), ...(t.files || [])].map((f) => f.split('/').pop()).join(', '))}">📎${(t.feedbackImages?.length || 0) + (t.files?.length || 0)}</span>` : ''}${t.source?.url ? ` <a class="ext" href="${esc(t.source.url)}" target="_blank" rel="noopener" title="${esc(BOARD_LABELS[t.source.kind] || t.source.kind)} · ${esc(t.source.id)}${t.source.remoteStatus ? ' · fuera: ' + esc(t.source.remoteStatus) : ''}">🔗 ${esc(t.source.id)}</a>` : ''}${t.kind === 'plan' ? ' <span>🗂 plan</span>' : ''}${t.attempts > 1 ? ` <span>intento ${t.attempts}</span>` : ''}</div>
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
  .map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''} title="${esc(r.description || '')}">${esc(r.label)}${r.custom ? ` · ${esc(r.source)}` : ''}${r.kind === 'planner' ? ' (planifica)' : r.kind === 'qa' ? ' (QA)' : r.kind === 'docs' ? ' (documenta)' : ''}</option>`).join('');
const ENGINE_LABEL = { auto: 'automático (el que esté libre: Claude o Codex)', claude: 'Claude Code', codex: 'Codex', demo: 'demo (simulado)' };
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
  'toggle-run': () => api('POST', `/api/projects/${projectId}/run`, { running: !project()?.running }),
  hire: () => dialog(`
    <h3>Contratar agente</h3>
    <label>Nombre</label><input name="name" required autofocus />
    <label>Rol</label><select name="role">${roleOptions('back')}</select>
    <label>Motor</label><select name="engine">${engineOptions('auto')}</select>
    <label>Modelo (opcional)</label>${modelSelect('model', 'auto', '')}
    ${buttons('Contratar')}`, (f) => api('POST', '/api/agents', { ...f, model: pickModel(f), projectId })),
  'new-task': () => { pendingAttachments = []; dialog(`
    <h3>Nueva tarea</h3>
    <label>Título <span class="muted">(con «Redactar con IA» puedes dejarlo vacío)</span></label><input name="title" autofocus />
    <label>Descripción <span class="muted">(a mano, o en bruto para que la IA la redacte)</span></label><textarea name="description" rows="5" placeholder="Qué hay que hacer y cómo saber que está bien. Con ✨ basta con contarlo a tu manera: la IA lo convierte en una tarea completa."></textarea>
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
    <div class="section-title">🧪 Suite</div>
    <label>URL de flow-test (la suite; su MCP se usa para el QA)</label><input name="flowTestUrl" value="${esc(S.settings.flowTestUrl)}" placeholder="http://localhost:9998" />
    <label>Carpeta del workspace de flow-test en esta máquina (para deducir los repos de cada proyecto por sus enlaces)</label><input name="workspaceHostDir" value="${esc(S.settings.workspaceHostDir || '')}" placeholder="~/JksDocs/workspace" />
    <label>Agentes trabajando a la vez (máx.)</label><input name="maxParallel" type="number" min="1" max="8" value="${S.settings.maxParallel}" />
    <hr style="border-color:var(--line);margin:16px 0" />
    <div class="section-title">🔗 Tablero online del proyecto «${esc(project()?.name)}»</div>
    <div id="board-cfg" class="board-cfg"><p class="muted">Cargando…</p></div>
    <div class="section-title">📁 Proyecto</div>
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
const BOARD_LABELS = { github: 'GitHub Issues', trello: 'Trello', jira: 'Jira' };
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

// Editar una tarea desde su tarjeta.
function editTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const others = tasks().filter((x) => x.id !== id && x.kind !== 'plan');
  const repos = project()?.repos || [];
  dialog(`
    <h3>✎ Tarea #${t.id}${t.source?.url ? ` · <a href="${esc(t.source.url)}" target="_blank" rel="noopener" style="font-size:13px;color:#93c5fd">${esc(BOARD_LABELS[t.source.kind] || t.source.kind)} ${esc(t.source.id)} ↗</a>` : ''}</h3>
    <label>Título</label><input name="title" value="${esc(t.title)}" required autofocus />
    <label>Descripción</label><textarea name="description" rows="6">${esc(t.description)}</textarea>
    <div class="grid2">
      <div><label>Rol</label><select name="role">${roleOptions(t.role, true)}</select></div>
      ${repos.length > 1 ? `<div><label>Repositorio</label><select name="repo"><option value="">(el que diga el rol)</option>${repos.map((r) => `<option value="${r.key}" ${r.key === t.repo ? 'selected' : ''}>${esc(r.key)}</option>`).join('')}</select></div>` : ''}
    </div>
    <label>Depende de (Ctrl+clic para varias)</label>
    <select name="dependsOn" multiple size="${Math.min(6, Math.max(2, others.length))}">${others.map((o) => `<option value="${o.id}" ${t.dependsOn.includes(o.id) ? 'selected' : ''}>${o.status === 'done' ? '✓' : '⏳'} #${o.id} · ${esc(o.title.slice(0, 70))}</option>`).join('')}</select>
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
  if (d.action) return actions[d.action]?.();
  if (d.agent) return openDrawer(d.agent);
  if (d.close !== undefined) return closeDrawer();
  if (d.stop) return api('POST', `/api/agents/${d.stop}/stop`);
  if (d.fire) {
    if (confirm('¿Despedir a este agente de la empresa? (baja definitiva; para quitarlo solo de este proyecto usa «Al banquillo»)')) { await api('DELETE', `/api/agents/${d.fire}`); closeDrawer(); }
    return;
  }
  if (d.approve) return api('POST', `/api/tasks/${d.approve}/approve`).then(() => toast('Tarea aprobada ✓'));
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
      toast(`Tarea #${t.id} creada en Backlog por la IA (${draft.role}${draft.repo ? ' · ' + draft.repo : ''})${draft.costUsd ? ` · ≈ ${draft.costUsd.toFixed(2)} $` : ''}`);
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
  if (d.park) return api('PATCH', `/api/tasks/${d.park}`, { status: 'backlog' });
  if (d.del) { if (confirm('¿Borrar la tarea?')) api('DELETE', `/api/tasks/${d.del}`); return; }
  if (d.reject) {
    pendingAttachments = [];
    const t = S.tasks.find((x) => x.id === d.reject);
    return dialog(`
      <h3>${t.status === 'failed' ? 'Reintentar' : 'Devolver'} #${t.id}</h3>
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
