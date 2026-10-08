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

// RTK (rtk-ai/rtk): su hook PreToolUse reescribe `git status` → `rtk git status`, `cat f` → `rtk read f`… para comprimir
// la salida. El permiso se comprueba sobre el comando reescrito, así que se permiten SOLO los equivalentes de reglas de
// arriba (nunca `rtk run`/`rtk err`, que ejecutan cualquier cosa). Solo para el motor Claude cuando RTK está instalado.
export const RTK_RULES = [
  'rtk git status*', 'rtk git diff*', 'rtk git log*', 'rtk git show*', 'rtk git add*', 'rtk git commit*', 'rtk git branch*',
  'rtk grep *', 'rtk rg *', 'rtk ls*', 'rtk tree*', 'rtk find *', 'rtk read *', 'rtk diff *',
  'rtk lint*', 'rtk tsc*', 'rtk npm *', 'rtk mvn *', 'rtk gradle *', 'rtk gain*',
];

// FT-57: ¿es el comando reescrito por RTK uno de los equivalentes permitidos? Sin metacaracteres de shell (encadenar, redirigir, sustituir).
export const rtkAllowed = (cmd) => {
  const c = String(cmd || '').trim();
  if (/[;&|<>`$\n]/.test(c)) return false;
  return RTK_RULES.some((r) => (r.endsWith('*') ? c.startsWith(r.slice(0, -1)) : c === r));
};

// FT-171 · rol «release»: lista blanca estricta, SIN las reglas generales de BASH_RULES. Solo estos 5 patrones.
// Los scripts/release/*.sh solo existen en flow-test (el rol vive en ese proyecto). Argumentos: caracteres simples, sin «..».
const ARG = String.raw`[\w@%+=:,./-]+`;
export const RELEASE_RULES = [
  'scripts/release/*.sh', './scripts/release/*.sh', 'docker push juankanh/flow-app:*',
  'ssh -i ~/.ssh/flowtest_vps root@179.198.198.23', 'ssh serverman@192.168.68.118',
  'git push origin main', 'git push origin master',
];
const RELEASE_RES = [
  new RegExp(String.raw`^(\./)?scripts/release/[\w.-]+\.sh( ${ARG})*$`),
  /^docker push juankanh\/flow-app:\w[\w.-]*$/,
  /^ssh -i ~\/\.ssh\/flowtest_vps root@179\.198\.198\.23$/,
  /^ssh serverman@192\.168\.68\.118$/,
  /^git push origin (main|master)$/,
];
// ¿Es el comando EXACTAMENTE uno de los permitidos al rol release? Rechaza encadenados, sustituciones, redirecciones y «..».
export function releaseAllowed(cmd) {
  const c = String(cmd || '').trim();
  if (!c || /[;&|<>`$()\\*?{}!'"\n\r]/.test(c) || c.includes('..')) return false;
  return RELEASE_RES.some((re) => re.test(c));
}

// ¿Encaja el comando (ya sin metacaracteres de shell) con alguna regla?
export function bashAllowed(cmd) {
  const c = String(cmd || '').trim();
  return BASH_RULES.some((r) => (r.endsWith('*') ? c.startsWith(r.slice(0, -1)) : c === r));
}
