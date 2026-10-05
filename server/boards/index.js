// Tableros online por proyecto (GitHub Issues · Trello · Jira): sincronización bidireccional.
//   pull: cada tarjeta remota → tarea con source {kind, id, url}; título/descripción mandan desde fuera;
//         el estado remoto se aplica salvo que la tarea cambiara aquí después de la última sincronización.
//   push: cuando una tarea cambia de estado en AgentOffice (o el PO crea una) se refleja fuera.
// Config pública en project.board; credenciales en <data>/.boards.json (0600), nunca salen por la API.
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as github from './github.js';
import * as trello from './trello.js';
import * as jira from './jira.js';

export const KINDS = { github, trello, jira };
export const STATUSES = ['backlog', 'todo', 'doing', 'review', 'done'];
const SECRETS = () => path.join(store.DATA_DIR, '.boards.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(SECRETS(), 'utf8')) || {}; } catch { return {}; } };
const writeSecrets = (s) => { fs.mkdirSync(store.DATA_DIR, { recursive: true }); fs.writeFileSync(SECRETS(), JSON.stringify(s, null, 2), { mode: 0o600 }); };
const fail = (status, message) => Object.assign(new Error(message), { status });

export const describe = () => Object.values(KINDS).map((k) => ({ id: k.id, label: k.label, fields: k.fields, secretFields: k.secretFields, canCreateBoard: !!k.canCreateBoard }));

// Crear el tablero remoto (p. ej. un GitHub Project con las 5 columnas) y guardar la config resultante.
export async function createBoard(project, { kind, config = {}, secrets = {} }) {
  const k = KINDS[kind];
  if (!k?.createBoard) throw fail(400, 'Ese tipo de tablero no se puede crear desde aquí');
  const cfg = {};
  for (const f of k.fields) cfg[f.key] = String(config[f.key] ?? '').trim() || f.default || '';
  let r;
  try { r = await (k.secretFields.length ? k.createBoard(cfg, secrets) : k.createBoard(cfg)); } catch (e) { throw fail(502, e.message); }
  const saved = saveBoard(project, { kind, config: r.config, secrets, autoSync: true, pushNew: true });
  project.board.url = r.url; project.board.lastInfo = r.info; store.changed();
  return { ...saved, info: r.info, url: r.url };
}

export function publicBoard(project) {
  const b = project.board;
  if (!b) return null;
  const sec = readSecrets()[project.id] || {};
  const kind = KINDS[b.kind];
  return { ...b, secrets: Object.fromEntries((kind?.secretFields || []).map((f) => [f.key, sec[f.key] ? `…${String(sec[f.key]).slice(-4)}` : null])) };
}

export function saveBoard(project, { kind, config = {}, secrets = {}, autoSync = true, pushNew = true }) {
  if (!kind) { delete project.board; const s = readSecrets(); delete s[project.id]; writeSecrets(s); store.changed(); return null; }
  if (!KINDS[kind]) throw fail(400, 'Tipo de tablero desconocido');
  const cfg = {};
  for (const f of KINDS[kind].fields) { const v = String(config[f.key] ?? '').trim(); if (f.required && !v) throw fail(400, `Falta «${f.label}»`); cfg[f.key] = v || f.default || ''; }
  const s = readSecrets();
  const prev = s[project.id] || {};
  const next = { ...prev };
  for (const f of KINDS[kind].secretFields) { const v = String(secrets[f.key] ?? '').trim(); if (v && !v.startsWith('…')) next[f.key] = v; }
  for (const f of KINDS[kind].secretFields) if (!next[f.key]) throw fail(400, `Falta «${f.label}»`);
  s[project.id] = next; writeSecrets(s);
  project.board = { kind, config: cfg, autoSync: !!autoSync, pushNew: !!pushNew, syncedAt: project.board?.syncedAt || null, lastError: null, lastInfo: project.board?.lastInfo || null };
  store.changed();
  return publicBoard(project);
}

const ctx = (project) => { const b = project.board; if (!b) throw fail(400, 'El proyecto no tiene tablero online'); return { kind: KINDS[b.kind], cfg: b.config, sec: readSecrets()[project.id] || {} }; };
const call = (k, fn, cfg, sec, ...a) => (k.secretFields.length ? k[fn](cfg, sec, ...a) : k[fn](cfg, ...a));

export async function testBoard(project) {
  const { kind, cfg, sec } = ctx(project);
  try { const r = await call(kind, 'test', cfg, sec); project.board.lastInfo = r.info; project.board.lastError = null; project.board.url = r.url; store.changed(); return r; }
  catch (e) { project.board.lastError = e.message; store.changed(); throw fail(502, e.message); }
}

// Heurística de rol por etiquetas o texto (misma idea que la importación de flows).
const ROLE_BY_LABEL = { back: 'back', backend: 'back', api: 'back', front: 'front', frontend: 'front', ui: 'front', unity: 'front', qa: 'qa', test: 'qa', po: 'po', design: 'po', diseño: 'po' };
const guessRole = (card, roles) => {
  for (const l of card.labels || []) { const r = ROLE_BY_LABEL[String(l).toLowerCase()]; if (r && roles[r]) return r; }
  const t = `${card.title} ${card.description}`;
  if (/\b(qa|prueba|test)/i.test(card.title)) return 'qa';
  if (/\b(unity|juego|ui|pantalla|frontend|front)\b/i.test(t)) return 'front';
  return 'back';
};

export async function syncBoard(project, { createTask, roles }) {
  const { kind, cfg, sec } = ctx(project);
  const s = store.get();
  let cards;
  try { cards = await call(kind, 'pull', cfg, sec); }
  catch (e) { project.board.lastError = e.message; store.changed(); throw fail(502, e.message); }
  const since = project.board.syncedAt || 0;
  const mine = s.tasks.filter((t) => t.projectId === project.id && t.source?.kind === kind.id);
  const byId = new Map(mine.map((t) => [t.source.id, t]));
  let created = 0, updated = 0, pushed = 0;
  for (const c of cards) {
    const t = byId.get(c.id);
    if (!t) {
      createTask({ projectId: project.id, title: c.title, description: c.description, role: guessRole(c, roles), status: c.status, source: { kind: kind.id, id: c.id, url: c.url, remoteStatus: c.status } });
      created++;
      continue;
    }
    // Editada aquí después de la última sincronización → gana lo local hasta la siguiente (el índice remoto
    // puede ir unos segundos por detrás de lo que acabamos de enviar); si no, título y descripción mandan desde fuera.
    const editedLocally = t.updatedAt > since;
    let touched = false;
    if (!editedLocally && (t.title !== c.title || t.description !== c.description)) { t.title = c.title; t.description = c.description; touched = true; }
    t.source = { ...t.source, url: c.url, remoteStatus: c.status };
    const localStatusChanged = editedLocally && t.status !== t.source.pushedStatus;
    if (c.status !== t.status) {
      if (localStatusChanged && t.status !== 'doing') { await pushStatus(project, t).then(() => pushed++).catch(() => {}); }
      else if (!editedLocally && !['doing'].includes(t.status) && ['backlog', 'todo', 'review', 'done'].includes(c.status) && !t.branch) { t.status = c.status; touched = true; }
    }
    if (touched) { t.updatedAt = Date.now(); updated++; }
  }
  project.board.syncedAt = Date.now(); project.board.lastError = null;
  store.changed();
  return { created, updated, pushed, total: cards.length };
}

// Reflejar fuera un cambio de estado hecho aquí (best-effort: nunca bloquea el flujo del equipo).
export async function pushStatus(project, task, comment) {
  if (!project?.board || task.source?.kind !== project.board.kind) return;
  const { kind, cfg, sec } = ctx(project);
  const remote = task.status === 'failed' ? 'todo' : task.status;
  if (!STATUSES.includes(remote)) return;
  await call(kind, 'push', cfg, sec, task.source.id, remote, { comment });
  task.source.pushedStatus = task.status;
  store.changed();
}
export function pushStatusSoon(project, task, comment) { pushStatus(project, task, comment).catch((e) => { if (project.board) { project.board.lastError = `push #${task.id}: ${e.message}`; store.changed(); } }); }

// Igualar el tablero remoto al de AgentOffice: (a) columnas con nuestros nombres (si el conector lo permite),
// (b) una tarjeta por cada tarea que no tenga, en su columna. Corre en segundo plano con progreso en project.board.job.
export const AO_COLUMNS = ['Backlog', 'Por hacer', 'En curso', 'Revisión', 'Hecho'];
export async function alignColumns(project) {
  const { kind, cfg, sec } = ctx(project);
  if (!kind.alignColumns) throw fail(400, 'Este tablero no permite renombrar columnas desde aquí');
  let r;
  try { r = await (kind.secretFields.length ? kind.alignColumns(cfg, sec, AO_COLUMNS) : kind.alignColumns(cfg, AO_COLUMNS)); } catch (e) { throw fail(502, e.message); }
  project.board.config = r.config;
  // Recolocar lo que ya estaba sincronizado (el reemplazo de opciones vacía el valor de cada item).
  const mine = store.get().tasks.filter((t) => t.projectId === project.id && t.source?.kind === kind.id);
  let placed = 0;
  for (const t of mine) { await pushStatus(project, t).then(() => placed++).catch(() => {}); }
  store.changed();
  return { columns: AO_COLUMNS, placed };
}

export function exportAll(project) {
  const { kind, cfg, sec } = ctx(project);
  if (project.board.job?.running) throw fail(409, 'Ya hay una exportación en marcha');
  // Sin tarjeta en ESTE tablero (las importadas de un flow también se exportan; conservan su enlace al flow).
  const pending = store.get().tasks.filter((t) => t.projectId === project.id && t.source?.kind !== kind.id && t.kind !== 'plan');
  const job = { running: true, total: pending.length, done: 0, failed: 0, startedAt: Date.now(), lastError: null };
  project.board.job = job; store.changed();
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const t of pending) {
      let attempt = 0;
      for (;;) {
        try {
          const r = await call(kind, 'create', cfg, sec, { title: t.title, description: t.description, status: t.status === 'failed' ? 'todo' : t.status });
          t.source = { ...(t.source || {}), kind: kind.id, id: r.id, url: r.url, remoteStatus: t.status, pushedStatus: t.status };
          job.done++;
          break;
        } catch (e) {
          const msg = String(e.stderr || e.message || '');
          if (/rate limit|secondary rate|abuse|429|retry later/i.test(msg) && attempt < 6) {
            attempt++;
            const wait = Math.min(15 * 60000, 60000 * 2 ** (attempt - 1)); // 1, 2, 4, 8, 15, 15 min
            job.waitingUntil = Date.now() + wait; job.lastError = `GitHub frena (rate limit): reintento en ${Math.round(wait / 60000)} min`; store.changed();
            await sleep(wait); job.waitingUntil = null;
            continue;
          }
          job.failed++; job.lastError = `«${t.title.slice(0, 60)}»: ${msg.slice(0, 200)}`;
          break;
        }
      }
      store.changed();
      await sleep(1500); // ritmo suave: GitHub limita la creación de contenido
    }
    job.running = false; job.finishedAt = Date.now(); store.changed();
  })();
  return job;
}

// Título/descripción editados aquí → fuera (si no, el siguiente pull los pisaría).
export function pushContentSoon(project, task) {
  if (!project?.board || task.source?.kind !== project.board.kind) return;
  const { kind, cfg, sec } = ctx(project);
  if (!kind.update) return;
  call(kind, 'update', cfg, sec, task.source.id, { title: task.title, description: task.description })
    .catch((e) => { project.board.lastError = `editar #${task.id}: ${e.message}`; store.changed(); });
}

// Tarea nueva creada aquí (PO o a mano) → tarjeta fuera, si el tablero lo pide.
export async function createRemote(project, task) {
  if (!project?.board?.pushNew || task.source?.kind === project.board.kind || task.kind === 'plan') return;
  const { kind, cfg, sec } = ctx(project);
  try {
    const r = await call(kind, 'create', cfg, sec, { title: task.title, description: task.description, status: task.status });
    task.source = { ...(task.source || {}), kind: kind.id, id: r.id, url: r.url, remoteStatus: task.status, pushedStatus: task.status };
    store.changed();
  } catch (e) { project.board.lastError = `crear «${task.title}»: ${e.message}`; store.changed(); }
}
