// FT-235 · Commit en cada repo de una tarea «onMain»: solo lo que cambió el agente (extraído de team.js sin cambiar su comportamiento).
import path from 'node:path';
import * as realGit from './git.js';

// 🚀 Ficheros con cambios sin commitear por repo: {dir: [ruta…]} (para commitear después solo lo nuevo de la tarea).
export async function dirtyMap(dirs, git = realGit) {
  const out = {};
  for (const d of dirs) { try { out[d] = (await git.git(d, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean).map((l) => l.slice(3)); } catch { out[d] = null; } }
  return out;
}

export async function commitOnMain(t, agent, git = realGit) {
  const lines = [];
  const now = await dirtyMap(Object.keys(t.onMainBefore), git);
  for (const [d, before] of Object.entries(t.onMainBefore)) {
    if (!before || !now[d]) continue;
    const mine = now[d].filter((f) => !before.includes(f) && !/^"?\.\.?\//.test(f));
    if (!mine.length) continue;
    try {
      await git.git(d, 'add', '--', ...mine.map((f) => f.replace(/^"|"$/g, '').split(' -> ').pop()));
      await git.git(d, '-c', `user.name=${agent.name} (AgentOffice)`, '-c', 'user.email=agentoffice@local', 'commit', '-q', '-m', `${t.code || t.id}: ${t.title}\n\nCo-Authored-By: AgentOffice <noreply@agentoffice.local>`);
      lines.push(`📝 Commit en ${path.basename(d)}: ${mine.length} fichero(s)`);
    } catch (e) { lines.push(`⚠ No pude commitear en ${path.basename(d)}: ${String(e.message).split('\n')[0]}`); }
  }
  return lines;
}
