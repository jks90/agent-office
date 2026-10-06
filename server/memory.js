// FT-75 · Memoria rentable de los agentes: lecciones cortas por agente y por proyecto que se inyectan en el prompt de
// sus siguientes tareas para no redescubrir convenciones ni repetir errores ya corregidos. Diseñada para AHORRAR:
//   - sin llamadas extra al modelo (las lecciones salen del resumen final de la tarea y de los «Devolver»);
//   - tope por fichero (~1 500 tokens): al pasarse se descartan las más antiguas; deduplicadas;
//   - va en la parte estable del prompt (tras el briefing) → se lee de caché casi siempre;
//   - texto plano editable por el usuario; `settings.agentMemory === false` la apaga.
// Ficheros: data/memory/<projectId>/project.md y data/memory/<projectId>/agent-<agentId>.md (una lección por línea «- …»).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './store.js';

export const MAX_CHARS = 6000;          // ≈1 500 tokens por fichero
const MAX_LESSON = 220;
const dir = (projectId) => path.join(DATA_DIR, 'memory', String(projectId).replace(/[^\w-]/g, ''));
const fileOf = (projectId, agentId) => path.join(dir(projectId), agentId ? `agent-${String(agentId).replace(/[^\w-]/g, '')}.md` : 'project.md');

export function read(projectId, agentId = null) {
  try { return fs.readFileSync(fileOf(projectId, agentId), 'utf8'); } catch { return ''; }
}
export function write(projectId, agentId, text) {
  const f = fileOf(projectId, agentId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, cap(String(text || '').replace(/\r/g, '')));
  return read(projectId, agentId);
}
// Recorta por arriba (las líneas más antiguas primero) hasta el tope.
function cap(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  while (lines.join('\n').length > MAX_CHARS && lines.length > 1) lines.shift();
  return lines.join('\n') + (lines.length ? '\n' : '');
}
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)\s*$/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// ¿Ya hay una lección casi igual? (mismas palabras significativas en ≥80 %)
function duplicate(existing, lesson) {
  const w = new Set(norm(lesson).split(' ').filter((x) => x.length > 3));
  if (!w.size) return true;
  return existing.split('\n').some((l) => { const v = new Set(norm(l).split(' ').filter((x) => x.length > 3)); let n = 0; for (const x of w) if (v.has(x)) n++; return n / w.size >= 0.8; });
}
export function addLesson(projectId, agentId, lesson, source = '') {
  const clean = String(lesson || '').replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim().slice(0, MAX_LESSON);
  if (clean.length < 12) return false;
  const cur = read(projectId, agentId);
  if (duplicate(cur, clean)) return false;
  write(projectId, agentId, `${cur}- ${clean}${source ? ` (${source})` : ''}\n`);
  return true;
}

// Bloque «LECCIONES:» del resumen final → lecciones del agente o, con «[proyecto]», del proyecto. Devuelve el resumen sin el bloque.
export function harvest(projectId, agentId, summary, source) {
  const m = String(summary || '').match(/\n?\**LECCIONES:?\**\s*\n((?:\s*[-*•].*\n?){1,4})/i);
  if (!m) return { summary, added: 0 };
  let added = 0;
  for (const line of m[1].split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2)) {
    const project = /^[-*•]\s*\[proyecto\]/i.test(line);
    if (addLesson(projectId, project ? null : agentId, line.replace(/^[-*•]\s*\[proyecto\]\s*/i, ''), source)) added++;
  }
  return { summary: String(summary).replace(m[0], '').trim(), added };
}

// Bloque para el prompt (vacío si no hay nada).
export function promptBlock(projectId, agentId) {
  const p = read(projectId).trim(), a = agentId ? read(projectId, agentId).trim() : '';
  if (!p && !a) return '';
  return ['', '## Memoria de tareas anteriores (si algo contradice el código actual, manda el código y dilo en tu resumen)',
    p ? `Del proyecto:\n${p}` : '', a ? `Tuya:\n${a}` : ''].filter(Boolean).join('\n') + '\n';
}
export const PROMPT_ASK = 'Si aprendiste algo NO obvio y reutilizable en este repo (una convención, una trampa, cómo se prueba algo), termina tu resumen con «LECCIONES:» y 1–2 viñetas de ≤160 caracteres; empieza la viñeta con «[proyecto]» si vale para todo el equipo. Si no hay nada nuevo, no pongas el bloque.';

// ── Memoria de Claude Code del repo ─────────────────────────────────────────
// La auto-memoria que Claude Code guarda por proyecto en ~/.claude/projects/<ruta codificada>/memory/: MEMORY.md (índice,
// una línea por memoria) + un .md por memoria con frontmatter. Los agentes trabajan en worktrees (otra ruta) y no la cargan
// solos: aquí se localiza la del repo principal para verla/editarla en la UI y pasar el ÍNDICE en la parte estable del prompt
// (el detalle lo lee el agente bajo demanda; su carpeta va en --add-dir). Si el repo no tiene, se busca en sus carpetas padre
// (p. ej. MundoAbierto/servidor → MundoAbierto) sin subir hasta el home.
export const CLAUDE_INDEX_MAX = 8000; // ≈2 000 tokens de índice en el prompt como mucho
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const encodeRepo = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
const hasIndex = (d) => { try { return fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf8').trim().length > 0; } catch { return false; } };

export function claudeDir(repoPath) {
  if (!repoPath) return null;
  const home = os.homedir();
  for (let d = path.resolve(repoPath); d.startsWith(home + path.sep); d = path.dirname(d)) {
    const m = path.join(claudeRoot(), encodeRepo(d), 'memory');
    if (hasIndex(m)) return m;
  }
  return path.join(claudeRoot(), encodeRepo(repoPath), 'memory'); // aún sin memoria: aquí la crearía Claude Code
}

const safeName = (n) => { const b = path.basename(String(n || '')); if (!/^[\w.\-]+\.md$/.test(b)) throw Object.assign(new Error('Nombre de memoria no válido (solo *.md)'), { status: 400 }); return b; };
function frontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  const get = (k) => m?.[1].match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1].replace(/^["']|["']$/g, '').trim() || '';
  return { name: get('name'), description: get('description'), type: get('type') };
}

export function claudeList(repoPath) {
  const dir = claudeDir(repoPath);
  if (!dir) return null;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* sin carpeta todavía */ }
  const index = names.includes('MEMORY.md') ? fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8') : '';
  const files = names.filter((f) => f !== 'MEMORY.md').sort().map((f) => {
    const full = path.join(dir, f), st = fs.statSync(full);
    return { file: f, size: st.size, mtime: st.mtimeMs, inIndex: index.includes(`](${f})`), ...frontmatter(fs.readFileSync(full, 'utf8')) };
  });
  return { dir, inherited: !dir.endsWith(encodeRepo(repoPath) + path.sep + 'memory'), index, indexSize: index.length, files };
}
export function claudeRead(repoPath, name) {
  const dir = claudeDir(repoPath), f = safeName(name);
  try { return { file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }; } catch { return { file: f, text: '' }; }
}
export function claudeWrite(repoPath, name, text) {
  const dir = claudeDir(repoPath), f = safeName(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, f), String(text ?? '').replace(/\r/g, ''));
  return claudeRead(repoPath, f);
}
// Borra una memoria y su línea del índice.
export function claudeDelete(repoPath, name) {
  const dir = claudeDir(repoPath), f = safeName(name);
  if (f === 'MEMORY.md') throw Object.assign(new Error('El índice no se borra; vacíalo si quieres'), { status: 400 });
  fs.rmSync(path.join(dir, f), { force: true });
  const idx = path.join(dir, 'MEMORY.md');
  try { fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').split('\n').filter((l) => !l.includes(`](${f})`)).join('\n')); } catch { /* sin índice */ }
  return { ok: true };
}

// Bloque para el prompt con el índice (vacío si el repo no tiene memoria).
export function claudePromptBlock(repoPath) {
  const dir = claudeDir(repoPath);
  if (!dir || !hasIndex(dir)) return '';
  let idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim();
  if (idx.length > CLAUDE_INDEX_MAX) idx = idx.slice(0, CLAUDE_INDEX_MAX).replace(/\n[^\n]*$/, '') + '\n- (índice recortado)';
  return ['', `## Memoria del proyecto (de las sesiones de Claude Code del usuario en este repo; puede estar desfasada: si choca con el código, manda el código)`,
    `Cada línea apunta a un fichero de ${dir}/ — léelo con Read SOLO si toca a tu tarea. No edites esa carpeta.`, idx, ''].join('\n');
}
