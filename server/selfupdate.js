// Autoactualización: AgentOffice se pone al día solo con su repo de GitHub, sin botón.
// Cada AO_UPDATE_MIN minutos (15 por defecto; AO_AUTOUPDATE=off lo apaga): `git fetch`; si va por detrás de su rama remota,
// el árbol está limpio, el avance es fast-forward y no hay ningún agente trabajando ni revisando → `git pull --ff-only`,
// aviso por Telegram y salida con código 75 para que lo relance quien lo vigila (systemd con Restart=on-failure, o
// `npm start`, que usa bin/ao-run.mjs). Con cambios locales o ramas divergentes (p. ej. la máquina donde se fusionan
// tareas del propio AgentOffice) no toca nada: lo deja anotado en GET /api/version.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, get } from './store.js';
import * as telegram from './telegram.js';

const run = promisify(execFile);
export const RESTART_CODE = 75;
const ENABLED = process.env.AO_AUTOUPDATE !== 'off';
const EVERY_MS = Math.max(5, Number(process.env.AO_UPDATE_MIN) || 15) * 60e3;

const git = async (...args) => (await run('git', args, { cwd: ROOT, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

export const state = { enabled: ENABLED, sha: null, branch: null, upstream: null, behind: 0, ahead: 0, checkedAt: null, skipped: null, error: null, updatedFrom: null };

/** Nadie trabajando ni revisando: actualizar ahora no corta nada. */
export const idle = (s = get()) => !s.agents.some((a) => a.status && a.status !== 'idle') && !s.tasks.some((t) => t.reviewing);

export async function check({ apply = true } = {}) {
  state.checkedAt = Date.now(); state.error = null; state.skipped = null;
  try {
    state.sha = await git('rev-parse', '--short', 'HEAD');
    state.branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    try { state.upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); } catch { state.upstream = null; state.skipped = 'la rama no sigue a ninguna remota'; return state; }
    await git('fetch', '--quiet', state.upstream.split('/')[0]);
    const [ahead, behind] = (await git('rev-list', '--left-right', '--count', `HEAD...${state.upstream}`)).split(/\s+/).map(Number);
    Object.assign(state, { ahead, behind });
    if (!behind) return state;
    if (ahead) { state.skipped = `la rama local tiene ${ahead} commit(s) que no están en ${state.upstream}`; return state; }
    if (await git('status', '--porcelain', '--untracked-files=no')) { state.skipped = 'hay cambios locales sin confirmar'; return state; }
    if (!apply) return state;
    if (!idle()) { state.skipped = 'hay agentes trabajando: se actualiza cuando queden libres'; return state; }
    const log = await git('log', '--format=• %s', `HEAD..${state.upstream}`);
    const from = state.sha;
    await git('merge', '--ff-only', state.upstream);
    state.updatedFrom = from;
    const to = await git('rev-parse', '--short', 'HEAD');
    console.log(`⬆ AgentOffice actualizado ${from} → ${to} (${behind} cambio(s)); reinicio`);
    await telegram.send(`⬆ <b>AgentOffice actualizado</b> ${from} → ${to}\n${log.split('\n').slice(0, 8).join('\n').replace(/[<>&]/g, '')}${behind > 8 ? `\n… y ${behind - 8} más` : ''}`).catch(() => {});
    setTimeout(() => process.exit(RESTART_CODE), 500);
  } catch (e) {
    state.error = String(e.stderr || e.message || e).trim().slice(0, 300);
  }
  return state;
}

if (ENABLED) {
  setTimeout(() => { check().catch(() => {}); }, 60e3).unref(); // primera comprobación al minuto de arrancar
  setInterval(() => { check().catch(() => {}); }, EVERY_MS).unref();
}
