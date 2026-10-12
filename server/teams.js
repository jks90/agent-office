// 👥 Plantillas de equipo: un proyecto nuevo arranca con un equipo bien definido (roles, quién hace qué, skills) en un clic.
//   · De serie: templates/teams/<id>/{team.json, roles/*.md} + templates/skills/<nombre>/ (funcionan sin cuenta ni red).
//   · Del marketplace: paquete ao-pkg/1 de tipo «team» con los mismos ficheros (exportTeam / applyTeam con el paquete).
// Aplicar: instala los roles que falten (nunca pisa uno existente), las skills que trae y las sugeridas que ya estén en el PC,
// ficha primero a los del banquillo con ese rol y contrata el resto (tope de 8 mesas), da a cada agente las skills de su papel
// y añade el coordinador si la plantilla lo pide.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as team from './team.js';
import * as skills from './skills.js';
import { allRoles } from './roles.js';

const TPL = path.join(store.ROOT, 'templates');
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const okId = (s) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(s || ''));
const MAX_DESKS = 8;

function readTeamJson(text) {
  let t;
  try { t = JSON.parse(text); } catch { throw fail(422, 'team.json no es JSON válido'); }
  if (!Array.isArray(t.members) || !t.members.length || t.members.length > 12) throw fail(422, 'team.json: «members» debe tener entre 1 y 12 agentes');
  for (const m of t.members) if (!m || typeof m.name !== 'string' || !m.name.trim() || !okId(m.role)) throw fail(422, 'team.json: cada miembro necesita name y role');
  return t;
}

// ── Plantillas de serie ─────────────────────────────────────────────────────
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}
// Carga una plantilla de serie como «fuente»: { spec, roles: {id: texto}, skills: {nombre: [{path, buf, exec}]} }
function loadBuiltin(id) {
  if (!okId(id)) throw fail(400, 'Plantilla no válida');
  const dir = path.join(TPL, 'teams', id);
  if (!fs.existsSync(path.join(dir, 'team.json'))) throw fail(404, 'Plantilla no encontrada');
  const spec = readTeamJson(fs.readFileSync(path.join(dir, 'team.json'), 'utf8'));
  const roles = {};
  const rdir = path.join(dir, 'roles');
  if (fs.existsSync(rdir)) for (const f of fs.readdirSync(rdir).filter((x) => x.endsWith('.md'))) roles[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(rdir, f), 'utf8');
  const sk = {};
  for (const n of spec.skills || []) {
    const sdir = path.join(TPL, 'skills', n);
    if (!okId(n) || !fs.existsSync(path.join(sdir, 'SKILL.md'))) continue;
    sk[n] = walk(sdir).map((rel) => ({ path: rel, buf: fs.readFileSync(path.join(sdir, rel)), exec: !!(fs.statSync(path.join(sdir, rel)).mode & 0o111) }));
  }
  return { spec: { ...spec, id }, roles, skills: sk, origin: 'serie' };
}

export function listTemplates() {
  const dir = path.join(TPL, 'teams');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, 'team.json'))).map((id) => {
    try {
      const { spec, roles } = loadBuiltin(id);
      const labels = allRoles();
      return { id, name: spec.name, summary: spec.summary || '', icon: spec.icon || '👥', coordinator: spec.coordinator !== false,
        members: spec.members.map((m) => ({ name: m.name, role: m.role, label: labels[m.role]?.label || m.role })), newRoles: Object.keys(roles).filter((r) => !labels[r]), skills: spec.skills || [] };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

// Paquete del marketplace (ya validado por marketplace.validate) → misma «fuente» que una plantilla de serie.
export function sourceFromPackage(pkg) {
  const bytes = (f) => Buffer.from(f.content, 'base64');
  const tj = pkg.files.find((f) => f.path === 'team.json');
  if (!tj) throw fail(422, 'El paquete de equipo no trae team.json');
  const spec = readTeamJson(bytes(tj).toString('utf8'));
  const roles = {}, sk = {};
  for (const f of pkg.files) {
    let m = f.path.match(/^roles\/([\w-]+)\.md$/);
    if (m) { roles[m[1]] = bytes(f).toString('utf8'); continue; }
    m = f.path.match(/^skills\/([\w-]+)\/(.+)$/);
    if (m && okId(m[1])) (sk[m[1]] ||= []).push({ path: m[2], buf: bytes(f), exec: !!f.exec });
  }
  return { spec: { ...spec, id: pkg.name }, roles, skills: sk, origin: 'marketplace' };
}

// ── Aplicar a un proyecto ───────────────────────────────────────────────────
// deps = { expandText (marketplace: {{HOME}} → $HOME), inventory: () => skills.inventory() }
export function applyTeam(src, projectId, { confirmCode = false, expandText = (t) => t, org = '', coordinator = null } = {}) {
  const s = store.get();
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) throw fail(404, 'Proyecto no encontrado');
  const { spec } = src;
  const out = { template: spec.name || spec.id, rolesInstalled: [], rolesKept: [], skillsInstalled: [], skillsKept: [], suggested: { added: [], missing: [] }, hired: [], fromBench: [], benched: [], skipped: [], coordinator: false };

  // 1) Roles que no existen aquí (los existentes no se tocan: puede que los hayas afinado).
  const rolesBase = src.origin === 'serie' ? path.join(skills.rolesDir(), 'plantillas') : path.join(skills.rolesDir(), 'marketplace', String(org || 'public').toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'public');
  for (const [id, text] of Object.entries(src.roles)) {
    if (!okId(id)) continue;
    if (allRoles()[id]) { out.rolesKept.push(id); continue; }
    skills.ensureCatalog();
    fs.mkdirSync(rolesBase, { recursive: true });
    fs.writeFileSync(path.join(rolesBase, `${id}.md`), expandText(text));
    out.rolesInstalled.push(id);
  }
  for (const m of spec.members) if (!allRoles()[m.role]) throw fail(422, `El rol «${m.role}» no existe aquí y el equipo no lo trae`);

  // 2) Skills que trae (no se pisa una del catálogo con el mismo nombre).
  const hasCode = Object.values(src.skills).some((files) => files.some((f) => f.exec || /\.(sh|py|js|mjs|cjs|ts|rb|pl)$/i.test(f.path)));
  if (src.origin !== 'serie' && hasCode && !confirmCode) throw fail(409, 'El equipo trae skills con código ejecutable: confirma (🛡) para instalarlas', { needsConfirm: 'code', hasCode: true });
  const catalog = new Set(skills.listCatalog().map((x) => x.name));
  for (const [name, files] of Object.entries(src.skills)) {
    if (catalog.has(name)) { out.skillsKept.push(name); continue; }
    const dest = path.join(skills.skillsDir(), name);
    for (const f of files) {
      const to = path.resolve(dest, f.path);
      if (!to.startsWith(dest + path.sep)) throw fail(422, `Ruta fuera del destino: ${f.path}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const isText = !f.buf.includes(0);
      fs.writeFileSync(to, isText ? expandText(f.buf.toString('utf8')) : f.buf, f.exec ? { mode: 0o755 } : undefined);
    }
    catalog.add(name); out.skillsInstalled.push(name);
  }

  // 3) Skills sugeridas: si ya están en el PC (inventario) se pasan al catálogo; si no, se avisa.
  const suggested = [...new Set(Object.values(spec.suggestedSkills || {}).flat())];
  if (suggested.length) {
    const inv = skills.inventory();
    for (const n of suggested) {
      if (catalog.has(n)) { out.suggested.added.push(n); continue; }
      const found = inv.find((x) => x.name === n);
      if (!found) { out.suggested.missing.push(n); continue; }
      try { skills.centralize(found.dir, n); catalog.add(n); out.suggested.added.push(n); } catch { out.suggested.missing.push(n); }
    }
  }

  // 4) Plantilla: primero los del banquillo con ese rol; después, contratar. Sin pasar de 8 mesas.
  const inTeam = (a) => p.team.includes(a.id);
  const busyElsewhere = new Set(s.projects.flatMap((x) => x.team || []));
  for (const m of spec.members) {
    if (s.agents.some((a) => inTeam(a) && a.role === m.role && a.name === m.name)) { out.skipped.push(m.name); continue; }
    if (p.team.length >= MAX_DESKS) { out.benched.push(m.name); continue; }
    const bench = s.agents.find((a) => a.role === m.role && !busyElsewhere.has(a.id));
    let agent;
    if (bench) { team.setTeam(p.id, { add: [bench.id] }); busyElsewhere.add(bench.id); agent = bench; out.fromBench.push(`${bench.name} (${m.role})`); }
    else { agent = team.hire({ projectId: p.id, name: m.name, role: m.role, engine: 'auto' }); out.hired.push(`${agent.name} (${m.role})`); }
    const give = [...(spec.roleSkills?.[m.role] || []), ...(spec.suggestedSkills?.[m.role] || [])].filter((n) => catalog.has(n));
    if (give.length) agent.skills = [...new Set([...(agent.skills || []), ...give])];
  }

  // 5) Coordinador (si la plantilla lo pide y no hay ya uno).
  if ((coordinator ?? spec.coordinator !== false) && !s.agents.some((a) => inTeam(a) && allRoles()[a.role]?.kind === 'supervisor') && p.team.length < MAX_DESKS) {
    try { team.addSupervisorTo(p.id); out.coordinator = true; } catch { /* sin mesa o ya hay */ }
  }
  store.changed();
  return out;
}
export const applyBuiltin = (id, projectId, opts) => applyTeam(loadBuiltin(id), projectId, opts);

// ── Exportar el equipo de un proyecto (para el marketplace) ────────────────
// Devuelve { spec, roleIds (de catálogo), skillNames } y marketplace.exportPackage construye los ficheros.
export function teamSpecOf(projectId) {
  const s = store.get();
  const p = s.projects.find((x) => x.id === projectId || x.name === projectId);
  if (!p) throw fail(404, 'Proyecto no encontrado');
  const roles = allRoles();
  const members = s.agents.filter((a) => p.team.includes(a.id));
  if (!members.length) throw fail(400, 'El proyecto no tiene agentes en su plantilla');
  const plain = members.filter((a) => roles[a.role]?.kind !== 'supervisor');
  const roleIds = [...new Set(plain.map((a) => a.role))].filter((r) => roles[r]?.file); // los de serie ya existen en cualquier AgentOffice
  const skillNames = [...new Set([...roleIds.flatMap((r) => roles[r].skills || []), ...plain.flatMap((a) => a.skills || [])])];
  const roleSkills = {};
  for (const a of plain) if ((a.skills || []).length) roleSkills[a.role] = [...new Set([...(roleSkills[a.role] || []), ...a.skills])];
  const spec = { name: p.name, summary: `Equipo de «${p.name}»: ${plain.map((a) => `${a.name} (${roles[a.role]?.label || a.role})`).join(', ')}`,
    members: plain.map((a) => ({ name: a.name, role: a.role })), coordinator: members.some((a) => roles[a.role]?.kind === 'supervisor'), skills: skillNames, roleSkills,
    mcps: [...new Set(roleIds.flatMap((r) => roles[r].mcps || []))], scripts: [...new Set(roleIds.flatMap((r) => roles[r].scripts || []))] };
  return { project: p, spec, roleIds, skillNames };
}
