// FT-141 · Marketplace: exportar e importar paquetes «ao-pkg/1» de roles, skills y agentes.
// Paquete: { format, kind:'role'|'skill'|'agent', name, version, summary, author:{name}, files:[{path,content(base64),sha256}],
//            meta:{role?,engine?,model?,kindOfRole?,hasCode?}, memory?:{agent,project?} }  (tope 2 MB).
//   - scope 'team' (la organización): roles, skills y agentes completos CON memoria.
//   - scope 'public' (todas las organizaciones): solo roles y skills, NUNCA memoria ni agentes.
// Saneado: rutas del usuario → marcador {{HOME}} y escáner de secretos (bloquea la exportación y dice qué).
// Aquí no se habla con la nube: el paquete lo reenvía quien llame (flow-test hace de puerta).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as memory from './memory.js';
import * as team from './team.js';
import { allRoles, roleOf } from './roles.js';
import { skillsDir, rolesDir, ensureCatalog, parseFrontmatter } from './skills.js';

export const FORMAT = 'ao-pkg/1';
export const MAX_PKG = 2 * 1024 * 1024;
export const MAX_FILE = 512 * 1024;
const HOME_MARK = '{{HOME}}';
const SKIP_DIRS = new Set(['node_modules', '.git']);
const CODE_EXT = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl|ps1|bat|cmd)$/i;
const fail = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

// Mismos patrones que usa flow-test (ai-tools.js) más los habituales de claves privadas y tokens.
const SECRETS = [
  ['clave sk-', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['clave Anthropic', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['token GitHub', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['token Slack', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ['clave AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['clave Google', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['clave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ['contraseña/token asignado', /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[^\s"'<>{}$]{12,}/i],
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
const isText = (buf) => !buf.subarray(0, 8192).includes(0);

// ── Saneado ────────────────────────────────────────────────────────────────
export function sanitizeText(text) {
  const home = os.homedir();
  return String(text)
    .split(home).join(HOME_MARK)
    .replace(/\/home\/[^/\s"'`]+/g, HOME_MARK).replace(/\/Users\/[^/\s"'`]+/g, HOME_MARK)
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, HOME_MARK);
}
const expandText = (text) => String(text).split(HOME_MARK).join(os.homedir());

// Devuelve [{where, kind}] (nunca el valor del secreto).
export function scanSecrets(items) {
  const out = [];
  for (const { where, text } of items) {
    for (const [kind, re] of SECRETS) if (re.test(text)) out.push({ where, kind });
  }
  return out;
}
function assertClean(items) {
  const found = scanSecrets(items);
  if (found.length) throw fail(422, `Publicación bloqueada: posibles secretos (${found.map((f) => `${f.kind} en ${f.where}`).join('; ')}). Quítalos y vuelve a exportar.`, { findings: found });
}

// ── Exportar ───────────────────────────────────────────────────────────────
const author = () => ({ name: String(store.get().settings.authorName || os.userInfo().username || 'anónimo') });
const b64file = (p, buf, extra = {}) => ({ path: p, content: buf.toString('base64'), sha256: sha(buf), ...extra });
const textFile = (p, text) => b64file(p, Buffer.from(sanitizeText(text), 'utf8'));

function walk(root, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function roleFiles(id) {
  const r = roleOf(id);
  if (!r) throw fail(404, 'Rol no encontrado');
  if (!r.file) return { role: r, files: [] }; // rol de serie: viaja solo su nombre
  return { role: r, files: [textFile(`roles/${path.basename(r.file)}`, fs.readFileSync(r.file, 'utf8'))] };
}

function skillFiles(name) {
  const dir = path.join(skillsDir(), name);
  let real;
  try { real = fs.realpathSync(dir); } catch { throw fail(404, 'Skill no encontrada en el catálogo'); }
  const files = [];
  const skipped = [];
  for (const rel of walk(real)) {
    const full = path.join(real, rel);
    const st = fs.statSync(full);
    if (st.size > MAX_FILE) { skipped.push(rel); continue; }
    const buf = fs.readFileSync(full);
    const exec = !!(st.mode & 0o111);
    files.push(isText(buf) ? { ...textFile(rel, buf.toString('utf8')), ...(exec ? { exec } : {}) } : b64file(rel, buf, exec ? { exec } : {}));
  }
  if (!files.some((f) => f.path === 'SKILL.md')) throw fail(400, 'La skill no tiene SKILL.md');
  return { files, skipped };
}

const hasCode = (files) => files.some((f) => f.exec || (CODE_EXT.test(f.path) && !/^roles\//.test(f.path)));

export function exportPackage(kind, id, scope = 'public', opts = {}) {
  if (!['role', 'skill', 'agent'].includes(kind)) throw fail(400, 'Tipo desconocido (role|skill|agent)');
  if (!['team', 'public'].includes(scope)) throw fail(400, 'Ámbito desconocido (team|public)');
  if (kind === 'agent' && scope !== 'team') throw fail(400, 'Los agentes (con estado y memoria) solo se comparten dentro del equipo');
  let files = []; let meta = {}; let name; let summary = ''; let version = '1.0.0'; let mem;

  if (kind === 'role') {
    const { role, files: f } = roleFiles(id);
    if (!f.length) throw fail(400, 'Los roles de serie no se exportan');
    files = f; name = slug(id); summary = role.description || '';
    meta = { role: name, kindOfRole: role.kind, ...(role.model ? { model: role.model } : {}) };
    version = parseFrontmatter(fs.readFileSync(role.file, 'utf8')).meta.version || version;
  } else if (kind === 'skill') {
    const s = skillFiles(id);
    files = s.files; name = slug(id);
    const fm = parseFrontmatter(Buffer.from(files.find((f) => f.path === 'SKILL.md').content, 'base64').toString('utf8')).meta;
    summary = fm.description || ''; version = fm.version || version;
    meta = { hasCode: hasCode(files), ...(s.skipped.length ? { skipped: s.skipped } : {}) };
  } else {
    const a = store.get().agents.find((x) => x.id === id || x.name === id);
    if (!a) throw fail(404, 'Agente no encontrado');
    const { role, files: f } = roleFiles(a.role);
    files = f; name = slug(a.name) || a.id; summary = `${a.name} · ${role.label || a.role}`;
    meta = { role: a.role, engine: a.engine, model: a.model || '', kindOfRole: role.kind, agentName: a.name };
    const pid = opts.projectId || store.get().projects.find((p) => p.team.includes(a.id))?.id
      || store.get().projects.find((p) => memory.read(p.id, a.id))?.id;
    mem = { agent: pid ? memory.read(pid, a.id) : '' };
    if (pid && opts.includeProject !== false) { const pm = memory.read(pid, null); if (pm) mem.project = pm; }
    mem.agent = sanitizeText(mem.agent); if (mem.project) mem.project = sanitizeText(mem.project);
  }

  // Escáner: sobre el contenido ya saneado de todos los ficheros y la memoria.
  assertClean([
    ...files.filter((f) => isText(Buffer.from(f.content, 'base64'))).map((f) => ({ where: f.path, text: Buffer.from(f.content, 'base64').toString('utf8') })),
    ...(mem ? Object.entries(mem).map(([k, v]) => ({ where: `memoria/${k}`, text: v })) : []),
    { where: 'resumen', text: summary },
  ]);

  const pkg = { format: FORMAT, kind, name, version: opts.version || version, summary: summary.slice(0, 300), author: author(), files, meta };
  if (scope === 'team' && mem) pkg.memory = mem; // en public NUNCA va memoria
  const size = Buffer.byteLength(JSON.stringify(pkg));
  if (size > MAX_PKG) throw fail(413, `El paquete pesa ${(size / 1024 / 1024).toFixed(1)} MB (máximo 2 MB)`);
  return pkg;
}

// ── Importar ───────────────────────────────────────────────────────────────
const registryFile = () => path.join(store.DATA_DIR, 'marketplace-installed.json');
export function installed() { try { return JSON.parse(fs.readFileSync(registryFile(), 'utf8')); } catch { return {}; } }
function record(key, entry) {
  const reg = installed(); reg[key] = { ...entry, installedAt: Date.now() };
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(reg, null, 1));
}

export const MAX_FILES = 200;
const okName = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(n) && n !== '.' && n !== '..';
// Ruta relativa segura dentro de un paquete: sin absolutas, «..», «\» ni bytes nulos.
const safeRel = (p) => typeof p === 'string' && !!p && !path.isAbsolute(p) && !p.includes('\\') && !p.includes('\0') && !p.split('/').some((x) => x === '..' || x === '');
// ¿dest queda dentro de root? (comprobación léxica, sin seguir enlaces)
const inside = (root, dest) => path.resolve(dest).startsWith(path.resolve(root) + path.sep);
// Rechaza si dest o algún directorio entre base y dest es un enlace simbólico.
function assertNoLink(base, dest) {
  const stop = path.resolve(base);
  let cur = path.resolve(dest);
  while (cur.startsWith(stop + path.sep)) {
    let st = null; try { st = fs.lstatSync(cur); } catch { /* no existe: bien */ }
    if (st?.isSymbolicLink()) throw fail(422, `Destino con enlace simbólico: ${path.relative(stop, cur)}`);
    cur = path.dirname(cur);
  }
}

export function validate(pkg) {
  if (!pkg || pkg.format !== FORMAT) throw fail(400, `Formato no soportado (se espera ${FORMAT})`);
  if (!['role', 'skill', 'agent'].includes(pkg.kind)) throw fail(400, 'Tipo de paquete desconocido');
  if (!okName(pkg.name)) throw fail(422, 'Nombre de paquete no válido');
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version || ''))) throw fail(400, 'Versión no válida (semver)');
  if (Buffer.byteLength(JSON.stringify(pkg)) > MAX_PKG) throw fail(413, 'El paquete supera los 2 MB');
  if (!Array.isArray(pkg.files)) throw fail(400, 'El paquete no trae ficheros');
  if (pkg.files.length > MAX_FILES) throw fail(422, `Demasiados ficheros (máximo ${MAX_FILES})`);
  const seen = new Set();
  // Todo se valida ANTES de escribir nada: un solo fallo rechaza el paquete entero.
  for (const f of pkg.files) {
    if (!f || !safeRel(f.path)) throw fail(422, `Ruta no permitida en el paquete: ${f?.path}`);
    if (seen.has(f.path)) throw fail(422, `Fichero repetido en el paquete: ${f.path}`);
    seen.add(f.path);
    if (typeof f.content !== 'string') throw fail(422, `Contenido no válido en ${f.path}`);
    const buf = Buffer.from(f.content, 'base64');
    if (buf.length > MAX_FILE) throw fail(422, `${f.path} pesa más de 512 KB`);
    if (sha(buf) !== f.sha256) throw fail(422, `sha256 no coincide en ${f.path}: paquete corrupto o alterado`);
  }
  return pkg;
}

const orgDir = (org) => {
  if (org == null || org === '') return 'public';
  // FT-144: la nube manda el NOMBRE de la org («Mi Empresa»), no el slug: se normaliza a carpeta segura (sin «..» ni «/»).
  const dir = String(org).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 64);
  if (!okName(dir)) throw fail(422, 'Organización no válida');
  return dir;
};
const roleTarget = (pkg, org) => path.join(rolesDir(), 'marketplace', orgDir(org), `${pkg.name}.md`);
const skillTarget = (pkg) => path.join(skillsDir(), pkg.name);
const bytes = (f) => Buffer.from(f.content, 'base64');

// Qué pasaría al instalar (para que la UI pida confirmaciones antes de escribir nada).
export function inspect(pkg, opts = {}) {
  validate(pkg);
  const key = `${pkg.kind}:${pkg.name}`;
  const prev = installed()[key] || null;
  let target = null; let exists = false;
  if (pkg.kind === 'role') { target = roleTarget(pkg, opts.org); exists = fs.existsSync(target); }
  else if (pkg.kind === 'skill') { target = skillTarget(pkg); exists = fs.existsSync(target) || isLink(target); }
  const text = pkg.files.filter((f) => isText(bytes(f))).map((f) => ({ where: f.path, text: bytes(f).toString('utf8') }));
  return {
    kind: pkg.kind, name: pkg.name, version: pkg.version, target, exists, installedVersion: prev?.version || null,
    hasCode: !!pkg.meta?.hasCode || (pkg.kind === 'skill' && hasCode(pkg.files)),
    hasMemory: !!pkg.memory, secrets: scanSecrets(text),
  };
}
const isLink = (p) => { try { return !!fs.lstatSync(p); } catch { return false; } };

function writeFiles(root, files, rewrite = true) {
  for (const f of files) {
    const dest = path.resolve(root, f.path);
    if (!inside(root, dest)) throw fail(422, `Ruta fuera del destino: ${f.path}`);
    assertNoLink(root, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = bytes(f);
    fs.writeFileSync(dest, rewrite && isText(buf) ? expandText(buf.toString('utf8')) : buf, f.exec ? { mode: 0o755 } : undefined);
  }
}

function installRole(pkg, org, overwrite, files = pkg.files) {
  const f = files.find((x) => x.path.startsWith('roles/') && x.path.endsWith('.md'));
  if (!f) throw fail(400, 'El paquete no trae el .md del rol');
  if (!okName(pkg.name)) throw fail(422, 'Nombre de rol no válido');
  const target = roleTarget(pkg, org);
  if (!inside(path.join(rolesDir(), 'marketplace'), target)) throw fail(422, 'Destino fuera del catálogo');
  assertNoLink(rolesDir(), target);
  if (fs.existsSync(target) && !overwrite) throw fail(409, `Ya existe el rol ${path.relative(rolesDir(), target)}: confirma para sobrescribirlo`, { needsConfirm: 'overwrite', target });
  ensureCatalog();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expandText(bytes(f).toString('utf8')));
  return target;
}

export function importPackage(pkg, opts = {}) {
  const info = inspect(pkg, opts);
  if (info.secrets.length) throw fail(422, `Paquete rechazado: contiene posibles secretos (${info.secrets.map((s) => `${s.kind} en ${s.where}`).join('; ')})`, { findings: info.secrets });
  const key = `${pkg.kind}:${pkg.name}`;
  const base = { version: pkg.version, org: orgDir(opts.org), scope: opts.scope || (pkg.memory ? 'team' : 'public'), marketId: opts.marketId || null };

  if (pkg.kind === 'role') {
    const target = installRole(pkg, opts.org, !!opts.overwrite);
    record(key, { ...base, target });
    store.changed();
    return { kind: 'role', name: pkg.name, version: pkg.version, target };
  }

  if (pkg.kind === 'skill') {
    if (info.hasCode && !opts.confirmCode) throw fail(409, 'Esta skill trae código ejecutable: confirma (🛡) para instalarla', { needsConfirm: 'code', hasCode: true });
    const target = skillTarget(pkg);
    if (!inside(skillsDir(), target)) throw fail(422, 'Destino fuera del catálogo');
    assertNoLink(skillsDir(), target);
    if (info.exists && !opts.overwrite) throw fail(409, `Ya existe la skill ${pkg.name}: confirma para sobrescribirla`, { needsConfirm: 'overwrite', target });
    ensureCatalog();
    if (info.exists) fs.rmSync(target, { recursive: true, force: true }); // un enlace se quita sin tocar su destino
    writeFiles(target, pkg.files);
    record(key, { ...base, target, hasCode: info.hasCode });
    return { kind: 'skill', name: pkg.name, version: pkg.version, target, hasCode: info.hasCode };
  }

  // agente: rol (si falta) + agente en el banquillo + memoria en el proyecto elegido
  const roleId = pkg.meta?.role;
  if (!roleId) throw fail(400, 'El paquete de agente no indica su rol');
  if (pkg.memory && !opts.projectId) throw fail(400, 'Elige el proyecto donde guardar la memoria del agente', { needsConfirm: 'project' });
  if (opts.projectId && !store.get().projects.some((p) => p.id === opts.projectId)) throw fail(404, 'Proyecto no encontrado');
  let roleTargetPath = null;
  if (!allRoles()[roleId]) {
    if (!pkg.files.length) throw fail(400, `El rol «${roleId}» no existe aquí y el paquete no lo trae`);
    roleTargetPath = installRole({ ...pkg, name: slug(roleId) }, opts.org, false);
  }
  const agent = team.hire({ projectId: null, name: opts.agentName || pkg.meta.agentName || pkg.name, role: roleId, engine: pkg.meta.engine, model: pkg.meta.model });
  if (pkg.memory) {
    if (pkg.memory.agent) memory.write(opts.projectId, agent.id, expandText(pkg.memory.agent));
    if (pkg.memory.project && (!memory.read(opts.projectId, null) || opts.overwrite)) memory.write(opts.projectId, null, expandText(pkg.memory.project));
  }
  record(`agent:${agent.id}`, { ...base, name: pkg.name, agentId: agent.id, role: roleId });
  return { kind: 'agent', name: pkg.name, version: pkg.version, agent, roleInstalled: roleTargetPath, memoryProject: pkg.memory ? opts.projectId : null };
}
