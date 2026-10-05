// Git: un worktree + rama ao/<tarea> por tarea, para que los agentes no se pisen.
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
  return { repoPath: top, baseBranch: branch };
}

export const worktreeDir = (project, task) => path.join(DATA_DIR, 'worktrees', project.id, task.id);
export const branchOf = (task) => `ao/${task.id}`;

export async function createWorktree(project, task) {
  const repo = project.repoPath;
  const dir = worktreeDir(project, task);
  const branch = branchOf(task);
  await git(repo, 'worktree', 'prune');
  // Tarea devuelta: se sigue sobre su intento anterior en vez de empezar de cero.
  if (fs.existsSync(dir)) {
    try {
      await git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`);
      if ((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === branch) return { path: dir, branch, reused: true };
    } catch { /* worktree roto: se recrea abajo */ }
  }
  if (fs.existsSync(dir)) {
    try { await git(repo, 'worktree', 'remove', '--force', dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  try { await git(repo, 'branch', '-D', branch); } catch { /* no existía */ }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dir, project.baseBranch);
  return { path: dir, branch };
}

export async function commitAll(dir, message, author) {
  await git(dir, 'add', '-A');
  if (!(await git(dir, 'status', '--porcelain'))) return false;
  await exec('git', ['-C', dir, '-c', `user.name=${author}`, '-c', 'user.email=agent-office@local', 'commit', '-m', message]);
  return true;
}

export const diffStat = (project, task) => git(project.repoPath, 'diff', '--stat', `${project.baseBranch}...${task.branch}`);
export const diff = (project, task) => git(project.repoPath, 'diff', `${project.baseBranch}...${task.branch}`);

export async function merge(project, task) {
  const repo = project.repoPath;
  const current = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== project.baseBranch) {
    throw new Error(`El repo está en la rama «${current}»; cámbiate a «${project.baseBranch}» para fusionar.`);
  }
  if (await git(repo, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('El repo tiene cambios sin confirmar: guárdalos o descártalos antes de fusionar.');
  }
  try {
    await git(repo, 'merge', '--no-ff', '--no-edit', task.branch);
  } catch (e) {
    try { await git(repo, 'merge', '--abort'); } catch { /* nada que abortar */ }
    throw new Error(`Conflicto al fusionar ${task.branch}: ${e.stderr || e.message}`);
  }
}

export async function cleanup(project, task) {
  if (!project.repoPath || !task.branch) return;
  try { await git(project.repoPath, 'worktree', 'remove', '--force', worktreeDir(project, task)); } catch { /* ya no está */ }
  try { await git(project.repoPath, 'branch', '-D', task.branch); } catch { /* ya no está */ }
}
