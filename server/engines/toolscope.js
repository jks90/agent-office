// FT-59: herramientas acotadas por rol. Cada definición de herramienta viaja en CADA turno (el arranque pesaba ~31k tokens),
// así que el rol solo recibe las que usa. Valores por defecto por `kind`; el frontmatter `tools:` de un rol los sustituye
// (nombres de herramientas integradas de Claude: `tools: Read, Grep, Glob, Bash`; una entrada `Bash(patrón)` añade una regla de shell).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASH_RULES, RELEASE_RULES } from './allowlist.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const READ_SHELL = ['ls *', 'cat *', 'head *', 'tail *', 'wc *', 'grep *', 'rg *', 'find *', 'sed *', 'awk *', 'sort *', 'uniq *', 'cut *', 'tr *', 'diff *', 'du *', 'file *', 'stat *', 'pwd', 'git status*', 'git diff*', 'git log*', 'git show*'];
const PLAN_SHELL = ['ls *', 'cat *', 'head *', 'grep *', 'find *', 'wc *', 'sed *', 'git status*', 'git diff*', 'git log*'];
const TEST_SHELL = ['npm *', 'npx *', 'node *', 'python3 *', 'curl *', 'timeout *', 'mkdir *', 'cp *', 'touch *', 'sleep *', 'echo *', 'printf *', 'mvn *', './mvnw *', 'gradle *', './gradlew *', 'make *'];
// Resolver un choque con la base es parte del trabajo de CUALQUIER rol que confirma cambios (si no, la tarea vuelve en bucle)
const GIT_MERGE = ['git merge *', 'git add*', 'git commit*', 'git restore *', 'git checkout -- *'];
const ASK_RULE = `node ${path.join(ROOT, 'bin', 'ao-ask.mjs')} *`; // preguntar al cliente (bin/ao-ask.mjs)

// builtin: herramientas integradas que se ENVÍAN al modelo (--tools); bash: reglas de `Bash(...)` permitidas; mcp: flow-test por MCP.
const BY_KIND = {
  dev: { builtin: ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Bash'], bash: BASH_RULES, mcp: false }, // lo de siempre
  docs: { builtin: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], bash: [...READ_SHELL, ...GIT_MERGE, ASK_RULE], mcp: true },
  qa: { builtin: ['Read', 'Grep', 'Glob', 'Write', 'Bash'], bash: [...READ_SHELL, ...TEST_SHELL, ...GIT_MERGE, ASK_RULE], mcp: true }, // sin Edit; Write solo para scripts de prueba
  planner: { builtin: ['Read', 'Glob', 'Grep', 'Bash'], bash: [...PLAN_SHELL, ASK_RULE], mcp: false },
  // FT-122: supervisor. Solo lee, ejecuta checks y fusiona la base en la rama (resolver choques); sin Edit/Write: no toca código de producto
  supervisor: { builtin: ['Read', 'Glob', 'Grep', 'Bash'], bash: [...READ_SHELL, 'npm test*', 'npm run *', 'node --check *', 'node scripts/*', ...GIT_MERGE, ASK_RULE], mcp: false },
  // FT-171: release. Solo Bash con la lista blanca estricta de allowlist.js (RELEASE_RULES); ni Edit/Write ni MCP
  release: { builtin: ['Read', 'Glob', 'Grep', 'Bash'], bash: RELEASE_RULES, mcp: false },
};

// FT-115 · capacidad «browser»: tools browser.* del Guía por ao-mcp (Chromium dedicado). Solo estos roles; otro rol la activa con `tools: …, browser`.
export const BROWSER_ROLES = ['qa-suite', 'office-flowtest'];

// → { builtin (para --tools), allowed (para --allowedTools, sin MCP ni RTK), mcp, browser }
// WebFetch/WebSearch/NotebookEdit/Task no están en ningún valor por defecto: ni se envían ni se permiten.
export function claudeScope({ kind = 'dev', mode = 'work', roleTools = null, hasSkills = false, roleId = '' } = {}) {
  const k = mode === 'plan' ? 'planner' : (BY_KIND[kind] ? kind : 'dev');
  const base = BY_KIND[k];
  let builtin = [...base.builtin], bash = [...base.bash];
  const browser = mode !== 'plan' && (BROWSER_ROLES.includes(String(roleId)) || !!roleTools?.includes('browser'));
  if (roleTools?.length && mode !== 'plan') {
    const names = roleTools.filter((t) => !t.startsWith('Bash(') && t !== 'browser');
    if (names.length) builtin = names;
    bash = [...bash, ...roleTools.filter((t) => t.startsWith('Bash(')).map((t) => t.slice(5, -1))];
  }
  if (hasSkills && mode !== 'plan' && !builtin.includes('Skill')) builtin.push('Skill'); // las skills del rol se enlazan en el worktree (linkSkillsInto)
  const allowed = [...builtin.filter((t) => t !== 'Bash'), ...(builtin.includes('Bash') ? bash.map((r) => `Bash(${r})`) : [])];
  return { builtin, allowed: [...new Set(allowed)], mcp: base.mcp && mode !== 'plan', browser };
}

// Codex no tiene lista de herramientas por nombre: se apagan por -c las opcionales (web_search no la usa ningún rol;
// view_image solo hace falta con imágenes adjuntas o en roles que miran capturas).
export function codexScope({ kind = 'dev', mode = 'work', images = [] } = {}) {
  const c = ['tools.web_search=false'];
  if (!images.length && (mode === 'plan' || kind === 'docs' || kind === 'planner')) c.push('tools.view_image=false');
  return c;
}
