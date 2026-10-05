// Catálogo central de skills y roles: <workspaceHostDir>/_agentes/{skills,roles}.
//   skills/<nombre> → enlace simbólico a la carpeta real de la skill (una skill existe en UN sitio; el catálogo la indexa).
//   roles/**/*.md   → roles del equipo (formato subagente de Claude Code; frontmatter `skills: a, b` = skills del rol).
// El inventario recorre los sitios donde este PC guarda skills (Claude Code, Codex, plugins, repos) para poder centralizarlas.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from './store.js';

const HOME = os.homedir();
const expand = (p) => String(p || '').trim().replace(/^~(?=\/|$)/, HOME);
export const catalogDir = () => {
  const s = store.get().settings;
  return expand(s.catalogDir || path.join(s.workspaceHostDir || path.join(HOME, 'JksDocs', 'workspace'), '_agentes'));
};
export const skillsDir = () => path.join(catalogDir(), 'skills');
export const rolesDir = () => path.join(catalogDir(), 'roles');
export function ensureCatalog() { fs.mkdirSync(skillsDir(), { recursive: true }); fs.mkdirSync(rolesDir(), { recursive: true }); }

export function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([\w-]+):\s*(.*)$/); if (mm) meta[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: m[2].trim() };
}

function readSkill(dir) {
  try {
    const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    return { name: meta.name || path.basename(dir), description: meta.description || '' };
  } catch { return null; }
}
const isSkillDir = (dir) => { try { return fs.statSync(path.join(dir, 'SKILL.md')).isFile(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => path.join(dir, e.name)); } catch { return []; } };

// Dónde buscar skills en este PC (fuentes conocidas) + repos de los proyectos.
function sources() {
  const out = [];
  out.push({ source: 'claude', label: 'Claude Code (~/.claude/skills)', dirs: subdirs(path.join(HOME, '.claude', 'skills')).filter((d) => path.basename(d) !== 'synced') });
  for (const acc of subdirs(path.join(HOME, '.claude', 'skills', 'synced'))) out.push({ source: 'claude-synced', label: 'Sincronizadas de claude.ai', dirs: subdirs(acc) });
  out.push({ source: 'codex', label: 'Codex (~/.codex/skills)', dirs: subdirs(path.join(HOME, '.codex', 'skills')) });
  out.push({ source: 'codex-system', label: 'Codex (de sistema)', dirs: subdirs(path.join(HOME, '.codex', 'skills', '.system')) });
  for (const mk of subdirs(path.join(HOME, '.claude', 'plugins', 'marketplaces'))) {
    out.push({ source: `plugin:${path.basename(mk)}`, label: `Plugin ${path.basename(mk)}`, dirs: subdirs(path.join(mk, 'skills')) });
    for (const pl of subdirs(path.join(mk, 'plugins'))) out.push({ source: `plugin:${path.basename(mk)}/${path.basename(pl)}`, label: `Plugin ${path.basename(mk)}/${path.basename(pl)}`, dirs: subdirs(path.join(pl, 'skills')) });
  }
  const repoDirs = new Set();
  for (const p of store.get().projects) for (const r of p.repos || []) repoDirs.add(r.path);
  for (const d of subdirs(path.join(HOME, 'dev'))) repoDirs.add(d);
  for (const repo of repoDirs) {
    const dirs = [...subdirs(path.join(repo, '.claude', 'skills')), ...subdirs(path.join(repo, 'skills'))].filter(isSkillDir);
    if (dirs.length) out.push({ source: `repo:${path.basename(repo)}`, label: `Repo ${path.basename(repo)}`, dirs });
  }
  return out;
}

// Catálogo central: [{ name, dir (enlace), target (real), description, broken }]
export function listCatalog() {
  ensureCatalog();
  return subdirs(skillsDir()).map((d) => {
    const target = real(d);
    const info = readSkill(d);
    return { name: path.basename(d), dir: d, target, description: info?.description || '', broken: !info, central: true };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Inventario del PC, marcando las que ya están en el catálogo (por ruta real).
export function inventory() {
  const central = new Map(listCatalog().map((s) => [s.target, s.name]));
  const seen = new Set();
  const out = [];
  for (const src of sources()) {
    for (const d of src.dirs) {
      if (!isSkillDir(d)) continue;
      const target = real(d);
      if (seen.has(target)) continue;
      seen.add(target);
      const info = readSkill(d);
      out.push({ name: info?.name || path.basename(d), dir: d, target, description: info?.description || '', source: src.source, sourceLabel: src.label, central: central.get(target) || null });
    }
  }
  return out;
}

export function centralize(dir, name) {
  ensureCatalog();
  const target = real(expand(dir));
  if (!isSkillDir(target)) throw Object.assign(new Error('Esa carpeta no tiene SKILL.md'), { status: 400 });
  const nm = String(name || readSkill(target)?.name || path.basename(target)).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const link = path.join(skillsDir(), nm);
  if (fs.existsSync(link) && real(link) !== target) throw Object.assign(new Error(`Ya hay una skill «${nm}» en el catálogo apuntando a otro sitio`), { status: 409 });
  if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
  return { name: nm, target };
}
export function uncentralize(name) {
  const link = path.join(skillsDir(), String(name).replace(/[^a-z0-9_-]+/gi, '-'));
  try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); else throw new Error('no es un enlace'); } catch (e) { throw Object.assign(new Error(`No pude quitar «${name}» del catálogo: ${e.message}`), { status: 400 }); }
}

// Leer / escribir el SKILL.md de una skill (del catálogo o del inventario; solo bajo $HOME) y crear skills en el catálogo.
const safeDir = (dir) => {
  const d = real(expand(dir));
  if (!d.startsWith(HOME + path.sep) || !isSkillDir(d)) throw Object.assign(new Error('Carpeta de skill no válida'), { status: 400 });
  return d;
};
export function readSkillFile(dir) {
  const d = safeDir(dir);
  const files = [];
  const walk = (base, rel = '') => { for (const e of fs.readdirSync(base, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { if (files.length < 200) walk(path.join(base, e.name), r); } else files.push(r); } };
  try { walk(d); } catch { /* parcial */ }
  return { dir: d, file: path.join(d, 'SKILL.md'), content: fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'), files: files.sort() };
}
export function writeSkillFile(dir, content) {
  const d = safeDir(dir);
  const text = String(content ?? '');
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) throw Object.assign(new Error('El SKILL.md debe empezar por el frontmatter (--- name / description ---)'), { status: 400 });
  const f = path.join(d, 'SKILL.md');
  fs.copyFileSync(f, f + '.bak');
  fs.writeFileSync(f, text.endsWith('\n') ? text : text + '\n');
  return readSkillFile(d);
}
export function createSkill({ name, description = '', body = '' }) {
  ensureCatalog();
  const nm = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!nm) throw Object.assign(new Error('La skill necesita un nombre'), { status: 400 });
  const d = path.join(skillsDir(), nm);
  if (fs.existsSync(d)) throw Object.assign(new Error(`Ya existe «${nm}» en el catálogo`), { status: 409 });
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${nm}\ndescription: ${String(description).replace(/\n/g, ' ').trim()}\n---\n\n${String(body).trim() || `# ${nm}\n\nInstrucciones de la skill.`}\n`);
  return { name: nm, dir: d };
}

import { execFileSync } from 'node:child_process';
const isTracked = (cwd, rel) => { try { execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', rel], { stdio: 'ignore' }); return true; } catch { return false; } };

// Enlazar las skills de un rol en el worktree del agente (.claude/skills/<nombre>) sin que entren en los commits.
export function linkSkillsInto(cwd, names) {
  const wanted = (names || []).filter(Boolean);
  if (!wanted.length) return [];
  const dest = path.join(cwd, '.claude', 'skills');
  fs.mkdirSync(dest, { recursive: true });
  const linked = [];
  for (const n of wanted) {
    const src = path.join(skillsDir(), n);
    if (!isSkillDir(src)) continue;
    const link = path.join(dest, n);
    // Si ya hay un enlace que resuelve al mismo sitio (p. ej. uno RASTREADO por git, relativo) se deja tal cual:
    // sustituirlo por uno absoluto lo cambiaba y acababa en el commit de la tarea (visto en FT-25).
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) continue;
      if (real(link) === real(src)) { linked.push(n); continue; }
      if (isTracked(cwd, path.join('.claude', 'skills', n))) continue; // rastreado y distinto: no se toca
      fs.unlinkSync(link);
    } catch { /* no existía */ }
    try { fs.symlinkSync(real(src), link, 'dir'); linked.push(n); } catch { /* sin permisos */ }
  }
  // Excluir del índice (sin tocar .gitignore del repo): .git/info/exclude del repo al que pertenece el worktree.
  try {
    const gitFile = path.join(cwd, '.git');
    const st = fs.statSync(gitFile);
    let gitDir = gitFile;
    if (st.isFile()) { const m = fs.readFileSync(gitFile, 'utf8').match(/gitdir:\s*(.+)/); if (m) gitDir = path.resolve(cwd, m[1].trim()); }
    const common = fs.existsSync(path.join(gitDir, 'commondir')) ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
    const excl = path.join(common, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    const lines = linked.map((n) => `.claude/skills/${n}`).filter((l) => !cur.split('\n').includes(l));
    if (lines.length) fs.appendFileSync(excl, (cur.endsWith('\n') || !cur ? '' : '\n') + '# AgentOffice: skills enlazadas al worktree\n' + lines.join('\n') + '\n');
  } catch { /* sin git: da igual */ }
  return linked;
}
