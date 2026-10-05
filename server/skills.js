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
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); else continue; } catch { /* no existía */ }
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
