// Tablero GitHub Issues (vía `gh`, ya autenticado en la máquina). Columnas = etiquetas `ao:<estado>` + abierto/cerrado:
//   backlog = abierta sin etiqueta ao:* (o ao:backlog) · todo/doing/review = etiqueta ao:todo|ao:doing|ao:review · done = cerrada.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const gh = async (...args) => (await exec('gh', args, { maxBuffer: 20e6, timeout: 60000 })).stdout;

export const id = 'github';
export const label = 'GitHub Issues';
export const fields = [
  { key: 'repo', label: 'Repositorio (owner/nombre)', placeholder: 'jks90/unityhouse-servidor', required: true },
  { key: 'prefix', label: 'Prefijo de etiquetas de estado', placeholder: 'ao', default: 'ao' },
  { key: 'openDefault', label: 'Issue abierta sin etiqueta de estado = ', default: 'backlog', options: ['backlog', 'todo'] },
];
export const secretFields = []; // usa la sesión de `gh`
const STATES = ['backlog', 'todo', 'doing', 'review'];
const lbl = (cfg, st) => `${cfg.prefix || 'ao'}:${st}`;

export async function test(cfg) {
  const out = await gh('repo', 'view', cfg.repo, '--json', 'nameWithOwner,hasIssuesEnabled,url');
  const j = JSON.parse(out);
  if (!j.hasIssuesEnabled) throw new Error('El repositorio tiene las issues desactivadas');
  const n = JSON.parse(await gh('issue', 'list', '--repo', cfg.repo, '--state', 'all', '--limit', '1', '--json', 'number')).length;
  return { ok: true, info: `${j.nameWithOwner} · issues activas${n ? '' : ' (todavía vacío)'}`, url: j.url + '/issues' };
}

async function ensureLabels(cfg) {
  const colors = { backlog: 'c0c4cc', todo: 'fde047', doing: '60a5fa', review: 'fb923c' };
  for (const st of STATES) await gh('label', 'create', lbl(cfg, st), '--repo', cfg.repo, '--color', colors[st], '--description', `AgentOffice: ${st}`, '--force').catch(() => {});
}

// → [{ id, title, description, status, url, labels, updatedAt }]
export async function pull(cfg) {
  const list = JSON.parse(await gh('issue', 'list', '--repo', cfg.repo, '--state', 'all', '--limit', '500', '--json', 'number,title,body,labels,state,url,updatedAt'));
  const prefix = (cfg.prefix || 'ao') + ':';
  return list.map((i) => {
    const names = (i.labels || []).map((l) => l.name);
    const st = i.state === 'CLOSED' ? 'done' : (names.map((n) => n.startsWith(prefix) ? n.slice(prefix.length) : null).find((s) => STATES.includes(s)) || cfg.openDefault || 'backlog');
    return { id: String(i.number), title: i.title, description: i.body || '', status: st, url: i.url, labels: names.filter((n) => !n.startsWith(prefix)), updatedAt: i.updatedAt };
  });
}

export async function push(cfg, remoteId, status, { comment } = {}) {
  await ensureLabels(cfg);
  const args = ['issue', 'edit', remoteId, '--repo', cfg.repo];
  for (const st of STATES) args.push('--remove-label', lbl(cfg, st));
  if (STATES.includes(status) && !(status === 'backlog' && (cfg.openDefault || 'backlog') === 'backlog')) args.push('--add-label', lbl(cfg, status));
  await gh(...args).catch((e) => { if (!/not found|no labels/i.test(e.stderr || '')) throw e; });
  if (status === 'done') await gh('issue', 'close', remoteId, '--repo', cfg.repo).catch(() => {});
  else await gh('issue', 'reopen', remoteId, '--repo', cfg.repo).catch(() => {});
  if (comment) await gh('issue', 'comment', remoteId, '--repo', cfg.repo, '--body', comment).catch(() => {});
}

export async function create(cfg, { title, description, status }) {
  await ensureLabels(cfg);
  const args = ['issue', 'create', '--repo', cfg.repo, '--title', title, '--body', description || '(creada desde AgentOffice)'];
  if (STATES.includes(status) && status !== 'backlog') args.push('--label', lbl(cfg, status));
  const url = (await gh(...args)).trim().split('\n').pop();
  const m = url.match(/\/issues\/(\d+)/);
  return { id: m ? m[1] : url, url };
}
