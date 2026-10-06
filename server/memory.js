// FT-75 · Memoria rentable de los agentes: lecciones cortas por agente y por proyecto que se inyectan en el prompt de
// sus siguientes tareas para no redescubrir convenciones ni repetir errores ya corregidos. Diseñada para AHORRAR:
//   - sin llamadas extra al modelo (las lecciones salen del resumen final de la tarea y de los «Devolver»);
//   - tope por fichero (~1 500 tokens): al pasarse se descartan las más antiguas; deduplicadas;
//   - va en la parte estable del prompt (tras el briefing) → se lee de caché casi siempre;
//   - texto plano editable por el usuario; `settings.agentMemory === false` la apaga.
// Ficheros: data/memory/<projectId>/project.md y data/memory/<projectId>/agent-<agentId>.md (una lección por línea «- …»).
import fs from 'node:fs';
import path from 'node:path';
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
