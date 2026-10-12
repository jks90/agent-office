// 🧰 Lo que proponen los agentes para que el equipo mejore solo (con tu visto bueno):
//   · «NEGOCIO <skill>:» → cómo se aplica una skill genérica en ESTE proyecto. Al aprobar se añade a
//     <carpeta del proyecto en el workspace>/_skills/<skill>.md, que el agente recibe en el prompt junto a la skill.
//   · «SCRIPT NUEVO: scripts/x — qué hace» → un script reutilizable que el agente dejó en el repo. Al aprobar (ya fusionado
//     en la rama base) entra en el catálogo y se asigna al rol del agente: la siguiente vez no se reinventa.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';

const MAX_NOTE = 1500; // por skill y proyecto en el prompt (≈375 tokens)
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n = 400) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Lo que se pide al agente (parte estable del prompt: el mismo texto siempre).
export const PROMPT_ASK = 'Para que el equipo mejore: si descubriste cómo se aplica una de tus skills en ESTE proyecto (algo que la skill genérica no dice), termina tu resumen con «NEGOCIO <nombre-de-la-skill>:» y 1–2 viñetas. Si escribiste o repetiste una secuencia de comandos que servirá en otras tareas, guárdala como script en scripts/ del repo (primera línea: un comentario con qué hace) y añade «SCRIPT NUEVO: scripts/<fichero> — qué hace». Si no hay nada de esto, no pongas nada.';

// Saca los bloques del resumen (y los quita del texto que se enseña).
export function parse(summary) {
  let text = String(summary || '');
  const business = [], scripts = [];
  const reB = /\n?\**NEGOCIO\s+([\w.-]+)\**:?\**\s*\n((?:[ \t]*[-*•].*(?:\n|$)){1,4})/gi;
  for (const m of text.matchAll(reB)) {
    const bullets = m[2].split('\n').map((l) => l.trim().replace(/^[-*•]\s*/, '')).filter((l) => l.length >= 8).slice(0, 2);
    if (bullets.length) business.push({ skill: m[1], text: bullets.map((b) => clean(b, 300)).join('\n') });
  }
  text = text.replace(reB, '\n');
  const reS = /^[ \t]*[-*•]?\s*\**SCRIPT NUEVO\**:?\s*`?([\w./-]+)`?\s*[—–-]+\s*(.+)$/gim;
  for (const m of text.matchAll(reS)) {
    const rel = m[1].replace(/^\.?\//, '');
    if (!rel.includes('..') && !path.isAbsolute(rel)) scripts.push({ path: rel, description: clean(m[2], 300) });
  }
  text = text.replace(reS, '').replace(/\n{3,}/g, '\n\n').trim();
  return { summary: text, business, scripts };
}

const list = () => (store.get().proposals ||= []);

// Guarda las propuestas de una tarea (sin duplicar las que ya están pendientes con el mismo contenido).
export function harvest({ project, task, agent, summary, skillNames = [], repoKey = null }) {
  const r = parse(summary);
  const out = [];
  const base = { projectId: project.id, taskId: task.id, code: task.code || task.id, agentId: agent.id, agentName: agent.name, role: agent.role, createdAt: Date.now() };
  for (const b of r.business) {
    if (!skillNames.includes(b.skill)) continue; // solo de skills que el agente lleva
    if (list().some((x) => x.kind === 'business' && x.projectId === project.id && x.skill === b.skill && x.text === b.text)) continue;
    out.push({ id: store.newId(), kind: 'business', skill: b.skill, text: b.text, ...base });
  }
  for (const s of r.scripts) {
    if (list().some((x) => x.kind === 'script' && x.projectId === project.id && x.path === s.path)) continue;
    out.push({ id: store.newId(), kind: 'script', path: s.path, description: s.description, repoKey, ...base });
  }
  if (out.length) { list().push(...out); store.changed(); }
  return { summary: r.summary, added: out };
}

// ── Notas de negocio por skill y proyecto ───────────────────────────────────
export const notesDir = (projectDir) => path.join(projectDir, '_skills');
export function notesOf(projectDir, skillNames) {
  const out = {};
  if (!projectDir) return out;
  for (const n of skillNames) {
    try { const t = fs.readFileSync(path.join(notesDir(projectDir), `${n}.md`), 'utf8').trim(); if (t) out[n] = t.length > MAX_NOTE ? t.slice(0, MAX_NOTE) + '…' : t; } catch { /* sin notas */ }
  }
  return out;
}
function appendNote(projectDir, skill, text, source) {
  const dir = notesDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${skill}.md`);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Cómo se aplica la skill «${skill}» en este proyecto\n\nNotas que el agente recibe junto a la skill. Edítalas a mano cuando quieras.\n\n`;
  fs.writeFileSync(file, `${cur.replace(/\s*$/, /\n- /.test(cur) ? '\n' : '\n\n')}${text.split('\n').map((l) => `- ${l}`).join('\n')} (${source})\n`);
  return file;
}

// ── Aprobar / descartar ─────────────────────────────────────────────────────
// deps = { projectDir(p), repoOf(p, key), addScript({path,name,description}), roleOf(id), setRoleTools(id, kind, names) }
export function accept(id, deps) {
  const s = store.get();
  const pr = list().find((x) => x.id === id) || (() => { throw fail(404, 'Propuesta no encontrada'); })();
  const p = s.projects.find((x) => x.id === pr.projectId) || (() => { throw fail(404, 'El proyecto ya no existe'); })();
  let result;
  if (pr.kind === 'business') {
    const dir = deps.projectDir(p);
    if (!dir) throw fail(400, `El proyecto «${p.name}» no tiene carpeta en el workspace: no hay dónde guardar la nota`);
    result = { file: appendNote(dir, pr.skill, pr.text, pr.code) };
  } else {
    const repo = deps.repoOf(p, pr.repoKey);
    if (!repo) throw fail(400, 'El proyecto no tiene ese repo');
    const abs = path.join(repo.path, pr.path);
    if (!fs.existsSync(abs)) throw fail(409, `Aún no está en ${repo.baseBranch || 'la rama base'}: apruébalo cuando se fusione ${pr.code}`);
    const name = path.basename(pr.path).replace(/\.[^.]+$/, '');
    const added = deps.addScript({ path: abs, name, description: pr.description });
    const role = deps.roleOf(pr.role);
    let toRole = false;
    if (role?.source === 'catálogo' && !(role.scripts || []).includes(added.name)) { deps.setRoleTools(pr.role, 'scripts', [...(role.scripts || []), added.name]); toRole = true; }
    result = { script: added.name, toRole: toRole ? pr.role : null };
  }
  s.proposals = list().filter((x) => x.id !== id);
  store.changed();
  return { ok: true, ...result };
}
export function reject(id) {
  const s = store.get();
  if (!list().some((x) => x.id === id)) throw fail(404, 'Propuesta no encontrada');
  s.proposals = list().filter((x) => x.id !== id);
  store.changed();
  return { ok: true };
}
