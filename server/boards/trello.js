// Tablero Trello (REST, clave + token de https://trello.com/power-ups/admin). Columnas = listas, por nombre.
export const id = 'trello';
export const label = 'Trello';
export const fields = [
  { key: 'boardId', label: 'ID del tablero (de la URL trello.com/b/<id>/…)', placeholder: 'AbCdEfGh', required: true },
  { key: 'lists', label: 'Listas → estados (backlog, todo, doing, review, done)', placeholder: 'Backlog, Por hacer, En curso, En revisión, Hecho', default: 'Backlog, Por hacer, En curso, En revisión, Hecho' },
];
export const secretFields = [
  { key: 'key', label: 'API key' },
  { key: 'token', label: 'Token' },
];
const STATES = ['backlog', 'todo', 'doing', 'review', 'done'];
const api = async (cfg, sec, method, path, body) => {
  const u = new URL(`https://api.trello.com/1${path}`);
  u.searchParams.set('key', sec.key); u.searchParams.set('token', sec.token);
  const r = await fetch(u, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Trello ${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const listNames = (cfg) => String(cfg.lists || fields[1].default).split(',').map((s) => s.trim());
async function listMap(cfg, sec) {
  const lists = await api(cfg, sec, 'GET', `/boards/${cfg.boardId}/lists?fields=name`);
  const names = listNames(cfg);
  const byState = {}, byList = {};
  STATES.forEach((st, i) => { const l = lists.find((x) => x.name.toLowerCase() === (names[i] || '').toLowerCase()); if (l) { byState[st] = l.id; byList[l.id] = st; } });
  return { byState, byList, lists };
}
export async function test(cfg, sec) {
  const b = await api(cfg, sec, 'GET', `/boards/${cfg.boardId}?fields=name,url`);
  const { byState, lists } = await listMap(cfg, sec);
  const missing = STATES.filter((s) => !byState[s]);
  return { ok: true, info: `${b.name} · listas: ${lists.map((l) => l.name).join(', ')}${missing.length ? ` · SIN correspondencia: ${missing.join(', ')}` : ''}`, url: b.url };
}
export async function pull(cfg, sec) {
  const { byList } = await listMap(cfg, sec);
  const cards = await api(cfg, sec, 'GET', `/boards/${cfg.boardId}/cards?fields=name,desc,idList,url,labels,dateLastActivity`);
  return cards.filter((c) => byList[c.idList]).map((c) => ({ id: c.id, title: c.name, description: c.desc || '', status: byList[c.idList], url: c.url, labels: (c.labels || []).map((l) => l.name).filter(Boolean), updatedAt: c.dateLastActivity }));
}
export async function push(cfg, sec, remoteId, status, { comment } = {}) {
  const { byState } = await listMap(cfg, sec);
  if (byState[status]) await api(cfg, sec, 'PUT', `/cards/${remoteId}`, { idList: byState[status] });
  if (comment) await api(cfg, sec, 'POST', `/cards/${remoteId}/actions/comments?text=${encodeURIComponent(comment)}`);
}
export async function update(cfg, sec, remoteId, { title, description }) {
  const body = {};
  if (title) body.name = title;
  if (description !== undefined) body.desc = description || '';
  if (Object.keys(body).length) await api(cfg, sec, 'PUT', `/cards/${remoteId}`, body);
}
export async function create(cfg, sec, { title, description, status }) {
  const { byState } = await listMap(cfg, sec);
  const c = await api(cfg, sec, 'POST', '/cards', { idList: byState[status] || byState.backlog || byState.todo, name: title, desc: description || '' });
  return { id: c.id, url: c.url };
}
