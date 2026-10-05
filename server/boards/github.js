// Tablero GitHub (vía `gh`, ya autenticado en la máquina). Dos modos:
//   - Issues + etiquetas: backlog = abierta sin etiqueta ao:* · todo/doing/review = etiqueta ao:<estado> · done = cerrada.
//   - Issues + GitHub Project (v2): la columna es el campo «Status» del Project (nombres configurables); las issues
//     nuevas se añaden al Project. `createBoard` crea el Project con las 5 columnas si el repo no tiene uno
//     (necesita `gh auth refresh -s read:project,project`).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const gh = async (...args) => (await exec('gh', args, { maxBuffer: 20e6, timeout: 60000 })).stdout;

export const id = 'github';
export const label = 'GitHub Issues';
export const fields = [
  { key: 'repo', label: 'Repositorio (owner/nombre)', placeholder: 'jks90/unityhouse-servidor', required: true },
  { key: 'project', label: 'GitHub Project (número; vacío = solo etiquetas)', placeholder: '3' },
  { key: 'owner', label: 'Dueño del Project (vacío = el del repo)', placeholder: 'jks90' },
  { key: 'columns', label: 'Columnas del Project → (backlog, todo, doing, review, done)', placeholder: 'Backlog, Todo, In Progress, In Review, Done', default: 'Backlog, Todo, In Progress, In Review, Done' },
  { key: 'prefix', label: 'Prefijo de etiquetas de estado (modo sin Project)', placeholder: 'ao', default: 'ao' },
  { key: 'openDefault', label: 'Issue sin columna/etiqueta = ', default: 'backlog', options: ['backlog', 'todo'] },
];
export const canCreateBoard = true; // «Crear Project en GitHub» desde AgentOffice
const ALL = ['backlog', 'todo', 'doing', 'review', 'done'];
const ownerOf = (cfg) => cfg.owner || cfg.repo.split('/')[0];
const colNames = (cfg) => String(cfg.columns || fields[3].default).split(',').map((s) => s.trim());
const stateOfColumn = (cfg, name) => { const i = colNames(cfg).findIndex((n) => n.toLowerCase() === String(name || '').toLowerCase()); return i >= 0 ? ALL[i] : null; };

// Metadatos del Project (id, campo Status y sus opciones), cacheados 5 min.
const projCache = new Map();
async function projectInfo(cfg) {
  const key = `${ownerOf(cfg)}/${cfg.project}`;
  const c = projCache.get(key);
  if (c && Date.now() - c.at < 300000) return c.info;
  const view = JSON.parse(await gh('project', 'view', String(cfg.project), '--owner', ownerOf(cfg), '--format', 'json'));
  const fl = JSON.parse(await gh('project', 'field-list', String(cfg.project), '--owner', ownerOf(cfg), '--format', 'json', '--limit', '100'));
  const status = (fl.fields || []).find((f) => f.name.toLowerCase() === 'status' && f.type === 'ProjectV2SingleSelectField');
  if (!status) throw new Error('El Project no tiene un campo «Status» de selección única');
  const info = { id: view.id, number: view.number, title: view.title, url: view.url, statusFieldId: status.id, options: Object.fromEntries((status.options || []).map((o) => [o.name.toLowerCase(), { id: o.id, name: o.name }])) };
  projCache.set(key, { at: Date.now(), info });
  return info;
}
const projectItems = async (cfg) => (JSON.parse(await gh('project', 'item-list', String(cfg.project), '--owner', ownerOf(cfg), '--format', 'json', '--limit', '1000')).items || []);
// issue → item del Project, cacheado (listar todos los items en cada operación agotaba la cuota de GraphQL).
const itemCache = new Map();
async function findItem(cfg, issueNumber, { refresh = false } = {}) {
  const key = `${ownerOf(cfg)}/${cfg.project}`;
  let c = itemCache.get(key);
  if (!c || refresh || Date.now() - c.at > 600000) {
    const map = new Map();
    for (const it of await projectItems(cfg)) if (it.content?.type === 'Issue' && (!it.content.repository || it.content.repository.toLowerCase() === cfg.repo.toLowerCase())) map.set(String(it.content.number), it);
    c = { at: Date.now(), map }; itemCache.set(key, c);
  }
  return c.map.get(String(issueNumber)) || null;
}
const rememberItem = (cfg, issueNumber, item) => { const key = `${ownerOf(cfg)}/${cfg.project}`; const c = itemCache.get(key); if (c) c.map.set(String(issueNumber), item); };
export const secretFields = []; // usa la sesión de `gh`
const STATES = ['backlog', 'todo', 'doing', 'review'];
const lbl = (cfg, st) => `${cfg.prefix || 'ao'}:${st}`;

export async function test(cfg) {
  const out = await gh('repo', 'view', cfg.repo, '--json', 'nameWithOwner,hasIssuesEnabled,url');
  const j = JSON.parse(out);
  if (!j.hasIssuesEnabled) throw new Error('El repositorio tiene las issues desactivadas');
  const n = JSON.parse(await gh('issue', 'list', '--repo', cfg.repo, '--state', 'all', '--limit', '1', '--json', 'number')).length;
  if (!cfg.project) return { ok: true, info: `${j.nameWithOwner} · issues activas${n ? '' : ' (todavía vacío)'} · modo etiquetas`, url: j.url + '/issues' };
  let p;
  try { p = await projectInfo(cfg); } catch (e) { throw new Error(/scope|read:project/i.test(e.stderr || e.message) ? 'gh no tiene permiso de Projects: ejecuta `gh auth refresh -s read:project,project`' : (e.stderr || e.message).trim()); }
  const missing = colNames(cfg).filter((nm) => !p.options[nm.toLowerCase()]);
  return { ok: true, info: `${j.nameWithOwner} · Project #${p.number} «${p.title}» · columnas: ${Object.values(p.options).map((o) => o.name).join(', ')}${missing.length ? ` · SIN correspondencia: ${missing.join(', ')}` : ''}`, url: p.url };
}

// Crear un GitHub Project para el repo con las 5 columnas de AgentOffice y enlazarlo. Devuelve la config a guardar.
export async function createBoard(cfg) {
  const owner = ownerOf(cfg);
  const title = cfg.title || `AgentOffice · ${cfg.repo.split('/')[1]}`;
  let created;
  try { created = JSON.parse(await gh('project', 'create', '--owner', owner, '--title', title, '--format', 'json')); }
  catch (e) { throw new Error(/scope|project/i.test(e.stderr || '') && /refresh/i.test(e.stderr || '') ? 'gh no tiene permiso de Projects: ejecuta `gh auth refresh -s read:project,project`' : (e.stderr || e.message).trim()); }
  const names = colNames(cfg);
  const fl = JSON.parse(await gh('project', 'field-list', String(created.number), '--owner', owner, '--format', 'json', '--limit', '100'));
  const status = (fl.fields || []).find((f) => f.name.toLowerCase() === 'status');
  if (status) {
    const colors = ['GRAY', 'YELLOW', 'BLUE', 'ORANGE', 'GREEN'];
    const opts = names.map((n, i) => `{name: ${JSON.stringify(n)}, color: ${colors[i] || 'GRAY'}, description: ""}`).join(', ');
    await gh('api', 'graphql', '-f', `query=mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(status.id)}, singleSelectOptions: [${opts}] }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`);
  }
  await gh('project', 'link', String(created.number), '--owner', owner, '--repo', cfg.repo).catch(() => {});
  projCache.clear();
  return { config: { ...cfg, project: String(created.number), owner }, url: created.url, info: `Project #${created.number} «${title}» creado con columnas ${names.join(', ')}` };
}

async function ensureLabels(cfg) {
  const colors = { backlog: 'c0c4cc', todo: 'fde047', doing: '60a5fa', review: 'fb923c' };
  for (const st of STATES) await gh('label', 'create', lbl(cfg, st), '--repo', cfg.repo, '--color', colors[st], '--description', `AgentOffice: ${st}`, '--force').catch(() => {});
}

// → [{ id, title, description, status, url, labels, updatedAt }]
export async function pull(cfg) {
  const list = JSON.parse(await gh('issue', 'list', '--repo', cfg.repo, '--state', 'all', '--limit', '500', '--json', 'number,title,body,labels,state,url,updatedAt'));
  const prefix = (cfg.prefix || 'ao') + ':';
  const byNumber = new Map();
  if (cfg.project) {
    for (const it of await projectItems(cfg)) {
      if (it.content?.type !== 'Issue') continue;
      if (it.content.repository && it.content.repository.toLowerCase() !== cfg.repo.toLowerCase()) continue;
      byNumber.set(String(it.content.number), stateOfColumn(cfg, it.status));
    }
  }
  return list.map((i) => {
    const names = (i.labels || []).map((l) => l.name);
    const fromProject = byNumber.get(String(i.number));
    const st = fromProject || (i.state === 'CLOSED' ? 'done' : (names.map((n) => n.startsWith(prefix) ? n.slice(prefix.length) : null).find((s) => STATES.includes(s)) || cfg.openDefault || 'backlog'));
    return { id: String(i.number), title: i.title, description: i.body || '', status: st, url: i.url, labels: names.filter((n) => !n.startsWith(prefix)), updatedAt: i.updatedAt };
  });
}

// Renombrar las opciones de «Status» del Project a las columnas de AgentOffice (reemplaza la lista:
// los items pierden su valor, por eso el llamador vuelve a colocar cada tarea después).
export async function alignColumns(cfg, names) {
  const p = await projectInfo(cfg);
  const colors = ['GRAY', 'YELLOW', 'BLUE', 'ORANGE', 'GREEN'];
  const opts = names.map((n, i) => `{name: ${JSON.stringify(n)}, color: ${colors[i] || 'GRAY'}, description: ""}`).join(', ');
  await gh('api', 'graphql', '-f', `query=mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(p.statusFieldId)}, singleSelectOptions: [${opts}] }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`);
  projCache.clear();
  return { config: { ...cfg, columns: names.join(', ') } };
}

// Mover la issue a la columna del Project (añadiéndola si no estaba).
async function setProjectColumn(cfg, issueNumber, status) {
  const p = await projectInfo(cfg);
  const opt = p.options[colNames(cfg)[ALL.indexOf(status)]?.toLowerCase()];
  if (!opt) return;
  let item = await findItem(cfg, issueNumber);
  if (!item) {
    const url = `https://github.com/${cfg.repo}/issues/${issueNumber}`;
    item = JSON.parse(await gh('project', 'item-add', String(cfg.project), '--owner', ownerOf(cfg), '--url', url, '--format', 'json'));
    rememberItem(cfg, issueNumber, item);
  }
  await gh('project', 'item-edit', '--id', item.id, '--project-id', p.id, '--field-id', p.statusFieldId, '--single-select-option-id', opt.id);
}

export async function push(cfg, remoteId, status, { comment } = {}) {
  if (cfg.project) {
    await setProjectColumn(cfg, remoteId, status);
    if (status === 'done') await gh('issue', 'close', remoteId, '--repo', cfg.repo).catch(() => {});
    else await gh('issue', 'reopen', remoteId, '--repo', cfg.repo).catch(() => {});
    if (comment) await gh('issue', 'comment', remoteId, '--repo', cfg.repo, '--body', comment).catch(() => {});
    return;
  }
  await ensureLabels(cfg);
  const args = ['issue', 'edit', remoteId, '--repo', cfg.repo];
  for (const st of STATES) args.push('--remove-label', lbl(cfg, st));
  if (STATES.includes(status) && !(status === 'backlog' && (cfg.openDefault || 'backlog') === 'backlog')) args.push('--add-label', lbl(cfg, status));
  await gh(...args).catch((e) => { if (!/not found|no labels/i.test(e.stderr || '')) throw e; });
  if (status === 'done') await gh('issue', 'close', remoteId, '--repo', cfg.repo).catch(() => {});
  else await gh('issue', 'reopen', remoteId, '--repo', cfg.repo).catch(() => {});
  if (comment) await gh('issue', 'comment', remoteId, '--repo', cfg.repo, '--body', comment).catch(() => {});
}

export async function update(cfg, remoteId, { title, description }) {
  const args = ['issue', 'edit', remoteId, '--repo', cfg.repo];
  if (title) args.push('--title', title);
  if (description !== undefined) args.push('--body', description || '');
  if (args.length > 5) await gh(...args);
}

export async function create(cfg, { title, description, status }) {
  if (!cfg.project) await ensureLabels(cfg);
  const args = ['issue', 'create', '--repo', cfg.repo, '--title', title, '--body', description || '(creada desde AgentOffice)'];
  if (!cfg.project && STATES.includes(status) && status !== 'backlog') args.push('--label', lbl(cfg, status));
  const url = (await gh(...args)).trim().split('\n').pop();
  const m = url.match(/\/issues\/(\d+)/);
  const id = m ? m[1] : url;
  if (cfg.project && m) await setProjectColumn(cfg, id, status || 'backlog').catch(() => {});
  return { id, url };
}
