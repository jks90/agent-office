// Lista blanca de shell compartida (FT-10): la usa el motor Claude (--allowedTools) y terminal.execute del Guide.
// Sin rm, sudo, docker, ssh ni git push. Cada entrada es el patrón de `Bash(<patrón>)`: «x *» = x + argumentos, «x*» = prefijo, «x» = exacto.
export const BASH_RULES = [
  'npm *', 'npx *', 'node *', 'python3 *', 'curl *', 'timeout *',
  'ls *', 'cat *', 'head *', 'tail *', 'wc *', 'grep *', 'rg *', 'find *',
  'sed *', 'awk *', 'sort *', 'uniq *', 'cut *', 'tr *', 'xargs *', 'diff *',
  'du *', 'file *', 'stat *', 'date *', 'echo *', 'printf *', 'true', 'sleep *',
  'mkdir *', 'cp *', 'mv *', 'touch *', 'cd *', 'pwd',
  'git status*', 'git diff*', 'git log*', 'git show*', 'git add*', 'git commit*', 'git branch*',
  'git merge *', // FT-19: el agente resuelve los conflictos con la base en su worktree (sin rebase)
  'git rm *', 'git mv *', 'git restore *', // borrar/mover/deshacer ficheros del worktree (reversible por git; sin `rm` genérico)
  'mvn *', './mvnw *', 'gradle *', './gradlew *', 'make *', // compilar/probar proyectos Java y otros (GL-2: el agente no podía ejecutar Maven)
];
export const BASH_TOOLS = BASH_RULES.map((r) => `Bash(${r})`);

// ¿Encaja el comando (ya sin metacaracteres de shell) con alguna regla?
export function bashAllowed(cmd) {
  const c = String(cmd || '').trim();
  return BASH_RULES.some((r) => (r.endsWith('*') ? c.startsWith(r.slice(0, -1)) : c === r));
}
