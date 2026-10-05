// Tablero Jira Cloud (REST v3, email + API token de id.atlassian.com). Columnas = estados del flujo, por nombre.
export const id = 'jira';
export const label = 'Jira Cloud';
export const fields = [
  { key: 'baseUrl', label: 'URL de Jira', placeholder: 'https://miempresa.atlassian.net', required: true },
  { key: 'projectKey', label: 'Clave del proyecto', placeholder: 'UH', required: true },
  { key: 'statuses', label: 'Estados → (backlog, todo, doing, review, done)', placeholder: 'Backlog, To Do, In Progress, In Review, Done', default: 'Backlog, To Do, In Progress, In Review, Done' },
  { key: 'issueType', label: 'Tipo al crear', placeholder: 'Task', default: 'Task' },
];
export const secretFields = [
  { key: 'email', label: 'Email de Atlassian' },
  { key: 'token', label: 'API token' },
];
const STATES = ['backlog', 'todo', 'doing', 'review', 'done'];
const api = async (cfg, sec, method, path, body) => {
  const r = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/rest/api/3${path}`, {
    method, headers: { authorization: 'Basic ' + Buffer.from(`${sec.email}:${sec.token}`).toString('base64'), accept: 'application/json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Jira ${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const names = (cfg) => String(cfg.statuses || fields[2].default).split(',').map((s) => s.trim());
const stateOf = (cfg, statusName) => { const i = names(cfg).findIndex((n) => n.toLowerCase() === String(statusName).toLowerCase()); return i >= 0 ? STATES[i] : null; };
const adfText = (doc) => { const walk = (n) => n?.text || (n?.content || []).map(walk).join(n?.type === 'paragraph' ? '' : '\n'); return doc ? walk(doc).trim() : ''; };
const adf = (text) => ({ type: 'doc', version: 1, content: String(text || '').split('\n').map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })) });
export async function test(cfg, sec) {
  const p = await api(cfg, sec, 'GET', `/project/${cfg.projectKey}`);
  const st = await api(cfg, sec, 'GET', `/project/${cfg.projectKey}/statuses`);
  const all = [...new Set(st.flatMap((t) => t.statuses.map((s) => s.name)))];
  const missing = names(cfg).filter((n) => !all.some((a) => a.toLowerCase() === n.toLowerCase()));
  return { ok: true, info: `${p.name} · estados: ${all.join(', ')}${missing.length ? ` · SIN correspondencia: ${missing.join(', ')}` : ''}`, url: `${cfg.baseUrl}/browse/${cfg.projectKey}` };
}
export async function pull(cfg, sec) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const j = await api(cfg, sec, 'POST', '/search/jql', { jql: `project = ${cfg.projectKey} ORDER BY updated DESC`, maxResults: 100, startAt, fields: ['summary', 'description', 'status', 'labels', 'updated'] });
    for (const i of j.issues || []) {
      const status = stateOf(cfg, i.fields.status?.name);
      if (!status) continue;
      out.push({ id: i.key, title: i.fields.summary, description: adfText(i.fields.description), status, url: `${String(cfg.baseUrl).replace(/\/+$/, '')}/browse/${i.key}`, labels: i.fields.labels || [], updatedAt: i.fields.updated });
    }
    startAt += (j.issues || []).length;
    if (!j.issues?.length || startAt >= (j.total || 0)) break;
  }
  return out;
}
export async function push(cfg, sec, remoteId, status, { comment } = {}) {
  const target = names(cfg)[STATES.indexOf(status)];
  if (target) {
    const tr = await api(cfg, sec, 'GET', `/issue/${remoteId}/transitions`);
    const t = (tr.transitions || []).find((x) => x.to?.name?.toLowerCase() === target.toLowerCase() || x.name.toLowerCase() === target.toLowerCase());
    if (t) await api(cfg, sec, 'POST', `/issue/${remoteId}/transitions`, { transition: { id: t.id } });
  }
  if (comment) await api(cfg, sec, 'POST', `/issue/${remoteId}/comment`, { body: adf(comment) });
}
export async function update(cfg, sec, remoteId, { title, description }) {
  const fields = {};
  if (title) fields.summary = title;
  if (description !== undefined) fields.description = adf(description || '');
  if (Object.keys(fields).length) await api(cfg, sec, 'PUT', `/issue/${remoteId}`, { fields });
}
export async function create(cfg, sec, { title, description, status }) {
  const j = await api(cfg, sec, 'POST', '/issue', { fields: { project: { key: cfg.projectKey }, summary: title, description: adf(description || ''), issuetype: { name: cfg.issueType || 'Task' } } });
  if (status && status !== 'backlog') await push(cfg, sec, j.key, status).catch(() => {});
  return { id: j.key, url: `${String(cfg.baseUrl).replace(/\/+$/, '')}/browse/${j.key}` };
}
