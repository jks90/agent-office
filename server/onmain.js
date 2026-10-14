// FT-233: commit de las tareas `onMain` (p. ej. «Documentar X.Y.Z»): en cada repo se commitea SOLO lo que cambió el agente.
// Causa del fallo del 14-oct: `git.git()` hace trim() de la salida y se comía el espacio inicial de « M fichero», de modo que
// `slice(3)` recortaba la primera letra de la primera ruta, `git add` fallaba y no quedaba ningún commit. Ahora se lee
// `status --porcelain -z` (rutas literales, sin comillas ni octales) sin trim.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);

// Parsea la salida de `git status --porcelain -z`: «XY ruta\0»; en renombrados/copias sigue «origen\0» (se descarta).
export function parsePorcelainZ(out) {
  const parts = String(out).split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const st = e.slice(0, 2);
    files.push(e.slice(3));
    if (st[0] === 'R' || st[0] === 'C' || st[1] === 'R' || st[1] === 'C') i++;
  }
  return files;
}

async function statusZ(dir) {
  const { stdout } = await exec('git', ['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=all'], { maxBuffer: 50e6 });
  return parsePorcelainZ(stdout);
}

// Ficheros con cambios sin commitear por repo: {dir: [ruta…]} (null si no se pudo leer).
export async function dirtyMap(dirs) {
  const out = {};
  for (const d of dirs) { try { out[d] = await statusZ(d); } catch { out[d] = null; } }
  return out;
}

// Commitea en cada repo lo que no estaba sucio antes. Devuelve {lines, commits, left}:
//  - commits: [{repo, files, ok, error?}] (para persistir en la tarea)
//  - left: {repo: [ruta…]} lo que sigue sin commitear tras el intento (en todo el repo)
export async function commitOnMain(t, agent) {
  const lines = [], commits = [];
  const before = t.onMainBefore || {};
  const now = await dirtyMap(Object.keys(before));
  for (const [d, was] of Object.entries(before)) {
    if (!was || !now[d]) continue;
    const mine = now[d].filter((f) => !was.includes(f));
    if (!mine.length) continue;
    const repo = path.basename(d);
    try {
      await exec('git', ['-C', d, 'add', '--', ...mine], { maxBuffer: 50e6 });
      await exec('git', ['-C', d, '-c', `user.name=${agent.name} (AgentOffice)`, '-c', 'user.email=agentoffice@local', 'commit', '-q', '-m', `${t.code || t.id}: ${t.title}\n\nCo-Authored-By: AgentOffice <noreply@agentoffice.local>`], { maxBuffer: 50e6 });
      lines.push(`📝 Commit en ${repo}: ${mine.length} fichero(s)`);
      commits.push({ repo, files: mine.length, ok: true });
    } catch (e) {
      const error = String(e.stderr || e.message).trim().split('\n')[0];
      lines.push(`⚠ No pude commitear en ${repo}: ${error}`);
      commits.push({ repo, files: mine.length, ok: false, error });
    }
  }
  const after = await dirtyMap(Object.keys(before));
  const left = {};
  for (const [d, f] of Object.entries(after)) if (f?.length) left[path.basename(d)] = f;
  return { lines, commits, left };
}
