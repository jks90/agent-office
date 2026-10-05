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
export const branchOf = (task) => task.branch || `ao/${task.code || task.id}`;

export async function createWorktree(project, repo, task) {
  const dir = worktreeDir(project, task);
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
  await exec('git', ['-C', dir, '-c', `user.name=${author}`, '-c', 'user.email=agent-office@local', 'commit', '-m', message]);
  return true;
}

export const diffStat = (repo, task) => git(repo.path, 'diff', '--stat', `${repo.baseBranch}...${task.branch}`);
export const diff = (repo, task) => git(repo.path, 'diff', `${repo.baseBranch}...${task.branch}`);

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

export async function cleanup(project, repo, task) {
  if (!repo?.path || !task.branch) return;
  try { await git(repo.path, 'worktree', 'remove', '--force', worktreeDir(project, task)); } catch { /* ya no está */ }
  try { await git(repo.path, 'branch', '-D', task.branch); } catch { /* ya no está */ }
}
