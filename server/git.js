// Git: un worktree + rama ao/<tarea> por tarea, en el repo del proyecto que le toque, para que los agentes no se pisen.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './store.js';

const exec = promisify(execFile);

export async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 50e6 });
  return stdout.trim();
}

export async function repoInfo(dir) {
  const top = await git(dir, 'rev-parse', '--show-toplevel');
  const branch = await git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
  return { path: top, baseBranch: branch };
}

// `repo` = { key, path, baseBranch } (uno de project.repos).
// Tareas anteriores a los códigos: su worktree/rama llevan el id y se siguen usando tal cual.
export const worktreeDir = (project, task) => { const legacy = path.join(DATA_DIR, 'worktrees', project.id, task.id); return (task.code && !fs.existsSync(legacy)) ? path.join(DATA_DIR, 'worktrees', project.id, task.code) : legacy; };
// FT-44: worktree de una tarea en un repo que NO es el principal: hermano del principal (`<código>.<repoKey>`; anidarlo dentro
// del principal lo ensuciaría con un directorio sin versionar que el autocommit recogería).
export const extraWorktreeDir = (project, task, repo) => path.join(DATA_DIR, 'worktrees', project.id, `${task.code || task.id}.${repo.key}`);
export const branchOf = (task) => task.branch || `ao/${task.code || task.id}`;

export async function createWorktree(project, repo, task, dir = worktreeDir(project, task)) {
  const branch = branchOf(task);
  await git(repo.path, 'worktree', 'prune');
  // Tarea devuelta: se sigue sobre su intento anterior en vez de empezar de cero.
  if (fs.existsSync(dir)) {
    try {
      await git(repo.path, 'rev-parse', '--verify', `refs/heads/${branch}`);
      if ((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === branch) { linkNodeModules(repo.path, dir); return { path: dir, branch, reused: true }; }
    } catch { /* worktree roto: se recrea abajo */ }
  }
  if (fs.existsSync(dir)) {
    try { await git(repo.path, 'worktree', 'remove', '--force', dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  try { await git(repo.path, 'branch', '-D', branch); } catch { /* no existía */ }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.path, 'worktree', 'add', '-b', branch, dir, repo.baseBranch);
  linkNodeModules(repo.path, dir);
  return { path: dir, branch };
}

// node_modules no está en git: el worktree lo enlaza al del repo para que los scripts del proyecto funcionen.
function linkNodeModules(repoPath, dir) {
  const src = path.join(repoPath, 'node_modules');
  const dest = path.join(dir, 'node_modules');
  if (fs.existsSync(src) && !fs.existsSync(dest)) { try { fs.symlinkSync(src, dest, 'dir'); } catch { /* sin enlace: el agente hará npm install */ } }
}

export async function commitAll(dir, message, author) {
  await git(dir, 'add', '-A');
  if (!(await git(dir, 'status', '--porcelain'))) return false;
  const files = (await git(dir, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean); // FT-1: ficheros del commit
  await exec('git', ['-C', dir, '-c', `user.name=${author}`, '-c', 'user.email=agent-office@local', 'commit', '-m', message]);
  const sha = await git(dir, 'rev-parse', '--short', 'HEAD');
  return { files, sha };
}

export const diffStat = (repo, task) => git(repo.path, 'diff', '--stat', `${repo.baseBranch}...${task.branch}`);
export const diff = (repo, task) => git(repo.path, 'diff', `${repo.baseBranch}...${task.branch}`);

export const branchExists = async (repo, branch) => { try { await git(repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; } };

// ── Fusión sin conflictos a mano (FT-19) ────────────────────────────────────
// Estado de la rama de la tarea respecto a la base: commits de la base que no tiene (behind) y rutas que chocarían al fusionar (conflicts).
// `merge-tree --write-tree` (git ≥ 2.38) no toca índice ni worktrees; en git antiguo se usa el `merge-tree` clásico (solo lectura también).
export async function mergeState(repo, task) {
  const key = `${await git(repo.path, 'rev-parse', repo.baseBranch)}..${await git(repo.path, 'rev-parse', `refs/heads/${task.branch}`)}`;
  const behind = Number(await git(repo.path, 'rev-list', '--count', `${task.branch}..${repo.baseBranch}`));
  return { key, behind, conflicts: behind ? await conflictsOf(repo.path, repo.baseBranch, task.branch) : [] };
}

async function conflictsOf(cwd, base, branch) {
  try {
    await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch);
    return [];
  } catch (e) {
    if (e.code === 1 && typeof e.stdout === 'string') return [...new Set(e.stdout.split('\n\n')[0].split('\n').slice(1).map((l) => l.trim()).filter(Boolean))].sort();
    // git < 2.38 (opción desconocida): merge-tree clásico contra el ancestro común; conflicto = sección con marcas «<<<<<<<»
    const mb = await git(cwd, 'merge-base', base, branch);
    const out = await git(cwd, 'merge-tree', mb, base, branch);
    const files = new Set();
    let file = null, sectionConflict = false;
    const close = () => { if (file && sectionConflict) files.add(file); };
    for (const l of out.split('\n')) {
      if (/^(changed|added|removed|merged) in /.test(l) || /^(added|removed) in (remote|local)/.test(l)) { close(); file = null; sectionConflict = false; continue; }
      const m = l.match(/^  (?:base|our|their)\s+\d+ [0-9a-f]+ (.+)$/);
      if (m) file = m[1];
      else if (l.startsWith('+<<<<<<<')) sectionConflict = true;
    }
    close();
    return [...files].sort();
  }
}

// Fusiona la base dentro de la rama, en el worktree de la tarea. → { conflicts: [] } si entró limpio (o ya estaba al día);
// con conflicto aborta el merge (el worktree queda como estaba) y devuelve las rutas en conflicto.
export async function updateFromBase(dir, base) {
  try {
    await exec('git', ['-C', dir, '-c', 'user.name=AgentOffice', '-c', 'user.email=agent-office@local', 'merge', '--no-edit', base], { maxBuffer: 50e6 });
    return { conflicts: [] };
  } catch (e) {
    const conflicts = (await git(dir, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
    try { await git(dir, 'merge', '--abort'); } catch { /* no había merge en curso */ }
    if (!conflicts.length) throw new Error(`No pude actualizar la rama con ${base}: ${e.stderr || e.message}`);
    return { conflicts };
  }
}

export async function merge(repo, task) {
  const current = await git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== repo.baseBranch) {
    throw new Error(`El repo ${repo.key} está en la rama «${current}»; cámbiate a «${repo.baseBranch}» para fusionar.`);
  }
  if (await git(repo.path, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error(`El repo ${repo.key} tiene cambios sin confirmar: guárdalos o descártalos antes de fusionar.`);
  }
  try {
    await git(repo.path, 'merge', '--no-ff', '--no-edit', task.branch);
  } catch (e) {
    try { await git(repo.path, 'merge', '--abort'); } catch { /* nada que abortar */ }
    throw new Error(`Conflicto al fusionar ${task.branch} en ${repo.key}: ${e.stderr || e.message}`);
  }
}

export async function cleanup(project, repo, task, dir = worktreeDir(project, task)) {
  if (!repo?.path || !task.branch) return;
  try { await git(repo.path, 'worktree', 'remove', '--force', dir); } catch { /* ya no está */ }
  try { await git(repo.path, 'branch', '-D', task.branch); } catch { /* ya no está */ }
}

// FT-44: líneas de `git status --porcelain` del checkout principal (guardarraíl «escribió fuera de su worktree»).
export const statusLines = async (dir) => { try { return (await git(dir, 'status', '--porcelain')).split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; } };
