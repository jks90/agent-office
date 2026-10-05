// Integraciones deterministas del Guide (FT-10): IDE, git, filesystem, terminal y navegador. API/CLI antes que visión.
// Funciones puras que `tools.js` registra bajo la Policy Layer. Todo queda limitado a los repos del proyecto (y a los
// worktrees de sus tareas): nunca se sale de ahí, nunca se lee `.env`, `.git` ni `data/`, y no hay shell de por medio.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import * as store from '../store.js';
import * as team from '../team.js';
import * as git from '../git.js';
import { bashAllowed } from '../engines/allowlist.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
export const MAX_FILE = 200 * 1024; // tope de filesystem.read/write
const MAX_OUT = 20 * 1024;          // tope por flujo de terminal.execute / git
const EXEC_TIMEOUT = () => Number(process.env.AO_EXEC_TIMEOUT_MS) || 60_000; // 60 s (la variable solo existe para las pruebas)

// ── Resolución de repo / tarea → raíz de trabajo ────────────────────────────
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const projectOf = (t) => store.get().projects.find((p) => p.id === t.projectId);

// { project, repo, root, roots, task } — root = worktree de la tarea (si existe) o el repo; roots = todo lo permitido.
export function scopeOf({ repo: key, task: ref } = {}) {
  const s = store.get();
  let task = null, project = null, repo = null;
  if (ref) {
    task = s.tasks.find((t) => t.id === ref || (t.code && t.code === String(ref).toUpperCase()));
    if (!task) throw fail(404, `Tarea no encontrada: ${ref}`);
    project = projectOf(task);
    repo = project && team.repoOfTask(project, task);
  }
  if (key) {
    const hits = [];
    for (const p of s.projects) for (const r of p.repos || []) if (r.key === key || r.path === key) hits.push({ p, r });
    const mine = task ? hits.find((h) => h.p.id === task.projectId) : null;
    const uniq = new Set(hits.map((h) => h.r.path));
    if (!mine && !hits.length) throw fail(404, `Repo no encontrado en ningún proyecto: ${key}`);
    if (!mine && uniq.size > 1) throw fail(409, `El repo «${key}» es ambiguo (${[...uniq].join(', ')}); indica la tarea`);
    ({ p: project, r: repo } = mine || hits[0]);
  }
  if (!repo?.path) throw fail(400, 'Indica «repo» (clave de un repo del proyecto) o «task» (código de una tarea con repo)');
  const repoReal = realOr(repo.path);
  // Worktrees de las tareas de este repo: también son «el repo» para el Guide.
  const worktrees = s.tasks.filter((t) => t.projectId === project.id && team.repoOfTask(project, t)?.path === repo.path)
    .map((t) => git.worktreeDir(project, t)).filter((d) => fs.existsSync(d)).map(realOr);
  const own = task && git.worktreeDir(project, task);
  const root = own && fs.existsSync(own) ? realOr(own) : repoReal;
  return { project, repo, task, root, roots: [...new Set([repoReal, ...worktrees])] };
}

const FORBIDDEN_SEGMENTS = new Set(['.git']);
// Primer segmento «data» de la raíz = data/ de AgentOffice (state.json, auditoría, worktrees); `.env*` en cualquier sitio.
function forbidden(rel) {
  const seg = rel.split(path.sep).filter(Boolean);
  return seg.some((x) => FORBIDDEN_SEGMENTS.has(x) || x.startsWith('.env')) || seg[0] === 'data';
}

// Ruta absoluta dentro de un repo/worktree permitido; {abs, rel, root}. Resuelve symlinks (no vale colarse con un enlace).
export function safePath(scope, p) {
  if (!p || typeof p !== 'string' || p.includes('\0')) throw fail(400, 'Falta «path»');
  let abs = path.resolve(scope.root, p);
  let real = abs;
  // Para ficheros que aún no existen (write) se resuelve el directorio más cercano que sí existe.
  for (let d = abs, tail = ''; ; d = path.dirname(d)) {
    if (fs.existsSync(d)) { real = path.join(realOr(d), tail); break; }
    tail = path.join(path.basename(d), tail);
    if (d === path.dirname(d)) break;
  }
  const root = scope.roots.filter((r) => real === r || real.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (!root) throw fail(403, `«${p}» está fuera del repo/worktree permitido`);
  const rel = path.relative(root, real);
  if (forbidden(rel)) throw fail(403, `«${p}» no se puede tocar (.env, .git y data/ están vetados)`);
  return { abs: real, rel, root };
}

// ── filesystem ──────────────────────────────────────────────────────────────
export function fsRead({ repo, task, path: p }) {
  const sc = scopeOf({ repo, task });
  const { abs, rel } = safePath(sc, p);
  let st;
  try { st = fs.statSync(abs); } catch { throw fail(404, `No existe: ${p}`); }
  if (!st.isFile()) throw fail(400, `${p} no es un fichero`);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_FILE));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { path: rel, size: st.size, truncated: st.size > MAX_FILE, content: buf.toString('utf8') };
  } finally { fs.closeSync(fd); }
}

export function fsWrite({ repo, task, path: p, content }) {
  if (typeof content !== 'string') throw fail(400, 'Falta «content»');
  if (Buffer.byteLength(content) > MAX_FILE) throw fail(413, `El contenido supera ${MAX_FILE / 1024} KB`);
  const sc = scopeOf({ repo, task });
  const { abs, rel } = safePath(sc, p);
  if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) throw fail(400, `${p} no es un fichero`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: rel, bytes: Buffer.byteLength(content), root: sc.root };
}

// ── git (reutiliza server/git.js) ───────────────────────────────────────────
const trim = (s, n = MAX_OUT * 5) => (s.length > n ? s.slice(0, n) + `\n… (recortado, ${s.length} car.)` : s);
async function branchIn(sc, branch) {
  if (!branch) return null;
  if (!/^[\w][\w./-]*$/.test(branch)) throw fail(400, `Rama no válida: ${branch}`);
  if (!(await git.branchExists(sc.repo, branch))) throw fail(404, `La rama ${branch} no existe en ${sc.repo.key} (si la tarea ya se fusionó, se borró)`);
  return branch;
}
// Si la rama tiene worktree (rama de una tarea) el estado se mira ahí; si no, en el repo.
function cwdFor(sc, branch) {
  const t = branch && store.get().tasks.find((x) => x.projectId === sc.project.id && git.branchOf(x) === branch);
  const d = t && git.worktreeDir(sc.project, t);
  return d && fs.existsSync(d) ? realOr(d) : realOr(sc.repo.path);
}

export async function gitStatus({ repo, branch }) {
  const sc = scopeOf({ repo });
  const b = await branchIn(sc, branch);
  const cwd = cwdFor(sc, b);
  return { repo: sc.repo.key, branch: b || await git.git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), cwd, status: await git.git(cwd, 'status', '--short', '--branch') };
}

export async function gitDiff({ repo, branch }) {
  const sc = scopeOf({ repo });
  const b = await branchIn(sc, branch);
  const range = b ? [`${sc.repo.baseBranch}...${b}`] : ['HEAD'];
  const cwd = realOr(sc.repo.path);
  const [stat, diff] = await Promise.all([git.git(cwd, 'diff', '--no-color', '--stat', ...range), git.git(cwd, 'diff', '--no-color', ...range)]);
  return { repo: sc.repo.key, range: range[0], stat, diff: trim(diff, MAX_FILE) };
}

export async function gitLog({ repo, branch, limit }) {
  const sc = scopeOf({ repo });
  const b = await branchIn(sc, branch);
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const out = await git.git(realOr(sc.repo.path), 'log', '--no-color', '--date=short', '--format=%h %ad %an %s', '-n', String(n), ...(b ? [b] : []));
  return { repo: sc.repo.key, branch: b, commits: out ? out.split('\n') : [] };
}

// Línea (1-based) del primer hunk de un fichero en la rama de la tarea (o en los cambios sin confirmar).
export async function firstHunkLine(sc, rel) {
  try {
    const b = sc.task && sc.task.branch && await git.branchExists(sc.repo, sc.task.branch) ? sc.task.branch : null;
    const out = await git.git(sc.root, 'diff', '--no-color', '-U0', ...(b ? [`${sc.repo.baseBranch}...${b}`] : ['HEAD']), '--', rel);
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(out);
    return m ? Math.max(1, Number(m[1])) : null;
  } catch { return null; }
}

// ── Lanzar programas (IDE, navegador) ───────────────────────────────────────
// Trocea «code --goto {path}:{line}» respetando comillas; sin shell, así que {path} no se puede inyectar.
export function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(cmd));) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function onPath(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

function launch(cmdline, vars, what) {
  const argv = tokenize(cmdline).map((t) => t.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)));
  if (!argv.length) throw fail(500, `Comando de ${what} vacío`);
  if (!onPath(argv[0])) throw fail(503, `No hay ${what}: «${argv[0]}» no está en el PATH (se configura con AO_${what === 'IDE' ? 'IDE' : 'BROWSER'}_CMD)`);
  return new Promise((resolve, reject) => {
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    c.once('error', (e) => reject(fail(503, `No se pudo lanzar ${what}: ${e.message}`)));
    c.once('spawn', () => { c.unref(); resolve(argv); });
  });
}

export const ideCmd = () => process.env.AO_IDE_CMD || 'code --goto {path}:{line}';
export const browserCmd = () => process.env.AO_BROWSER_CMD || (process.platform === 'darwin' ? 'open {url}' : 'xdg-open {url}');

export async function ideOpenFile({ repo, task, path: p, line }) {
  const sc = scopeOf({ repo, task });
  const { abs, rel } = safePath(sc, p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw fail(404, `No existe: ${p}`);
  const n = Number.isInteger(line) && line > 0 ? line : (await firstHunkLine(sc, rel)) || 1;
  const argv = await launch(ideCmd(), { path: abs, line: n }, 'IDE');
  return { opened: abs, line: n, fromHunk: !(Number.isInteger(line) && line > 0), cmd: argv.join(' ') };
}

export async function browserOpen({ url }) {
  let u;
  try { u = new URL(url); } catch { throw fail(400, `URL no válida: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'Solo se abren URLs http(s)');
  const argv = await launch(browserCmd(), { url: u.href }, 'navegador');
  return { opened: u.href, cmd: argv[0] };
}

// ── terminal ────────────────────────────────────────────────────────────────
const META = /[;&|`$<>(){}\\\n\r]/; // sin shell no hacen falta, y así no hay encadenados ni sustituciones
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT / 2) + `\n… (recortado: ${s.length} car.) …\n` + s.slice(-MAX_OUT / 2) : s);

// Lanza el error si el comando no está en la lista blanca de los workers (engines/allowlist.js) o toca fuera del repo.
export function checkCommand(sc, cmd) {
  const c = String(cmd || '').trim();
  if (!c) throw fail(400, 'Falta «cmd»');
  if (META.test(c)) throw fail(403, 'Comando rechazado: nada de encadenados, redirecciones ni sustituciones (; & | ` $ < > ( ) { } \\)');
  if (!bashAllowed(c)) throw fail(403, `Comando rechazado por la lista blanca: «${c.split(/\s+/)[0]}» no está permitido (la misma que los workers: sin rm, sudo, docker, ssh ni git push)`);
  const argv = tokenize(c);
  if (argv[0] === 'xargs') { const rest = argv.slice(1).filter((a) => !a.startsWith('-')).join(' '); if (rest && !bashAllowed(rest)) throw fail(403, `Comando rechazado por la lista blanca: xargs ${rest.split(/\s+/)[0]}`); }
  if (argv[0] === 'find' && argv.some((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a))) throw fail(403, 'find con -exec/-delete rechazado');
  // Argumentos que son rutas: dentro del repo/worktree y fuera de .env, .git y data/.
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') && !a.includes('/')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) continue; // URLs (curl)
    if (a.startsWith('~')) throw fail(403, `Ruta fuera del repo: ${a}`);
    if (/^\.env/.test(path.basename(a)) || a.split('/').includes('.git')) throw fail(403, `«${a}» está vetado (.env, .git y data/)`);
    if (a.startsWith('/') || a.split('/').includes('..') || a === 'data' || a.startsWith('data/')) safePath(sc, a);
  }
  return argv;
}

export function terminalExecute({ repo, task, cmd }) {
  const sc = scopeOf({ repo, task });
  const argv = checkCommand(sc, cmd);
  const env = { ...process.env, BROWSER: 'true' };
  delete env.AO_TOKEN;
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd: sc.root, env, timeout: EXEC_TIMEOUT(), killSignal: 'SIGKILL', maxBuffer: 10e6 }, (err, stdout, stderr) => {
      const timedOut = !!err && (err.killed || err.signal === 'SIGKILL') && err.code == null;
      resolve({ cmd: String(cmd).trim(), cwd: sc.root, exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0, timedOut, ...(err && typeof err.code === 'string' ? { error: err.message } : {}), stdout: clip(String(stdout || '')), stderr: clip(String(stderr || '')) });
    });
  });
}
