// Policy Layer del Guide Agent (FT-4): decide si una tool se ejecuta sola o pide confirmación al usuario, y la audita.
//   read / navigate → siempre automáticas · execute / write → `settings.guidePolicy` ('auto'|'confirm', write=confirm por defecto)
//   irreversible → SIEMPRE confirmación (reutiliza questions.js, kind:'confirm': modal Sí/No con 🛡)
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as questions from '../questions.js';

export const POLICIES = ['read', 'navigate', 'execute', 'write', 'irreversible'];
const DEFAULTS = { execute: 'auto', write: 'confirm' };
const AUDIT_FILE = () => path.join(store.DATA_DIR, 'guide-audit.jsonl');
const MAX_AUDIT = 5 * 1024 * 1024;

export function getPolicy() {
  const g = store.get().settings.guidePolicy || {};
  return { execute: ['auto', 'confirm'].includes(g.execute) ? g.execute : DEFAULTS.execute, write: ['auto', 'confirm'].includes(g.write) ? g.write : DEFAULTS.write };
}

export function setPolicy(patch = {}) {
  const cur = getPolicy();
  for (const k of ['execute', 'write']) if (['auto', 'confirm'].includes(patch[k])) cur[k] = patch[k];
  store.get().settings.guidePolicy = cur;
  store.changed();
  return cur;
}

// 'auto' | 'confirm' para una política de tool.
export function modeOf(policy) {
  if (policy === 'irreversible') return 'confirm';
  if (policy === 'execute' || policy === 'write') return getPolicy()[policy];
  return 'auto';
}

// Args acortados para el audit y el modal: strings recortados, listas y objetos grandes resumidos.
export function summarize(v, depth = 0) {
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + `… (${v.length} car.)` : v;
  if (Array.isArray(v)) return depth > 2 ? `[${v.length}]` : v.slice(0, 10).map((x) => summarize(x, depth + 1)).concat(v.length > 10 ? [`… +${v.length - 10}`] : []);
  if (v && typeof v === 'object') return depth > 2 ? '{…}' : Object.fromEntries(Object.entries(v).slice(0, 20).map(([k, x]) => [k, summarize(x, depth + 1)]));
  return v;
}

// FT-22 · confirmOnce: tools `read` con `confirmOnce:true` piden confirmación la primera vez por sesión (clave = chatId del Guide
// o, por API/MCP, x-ao-client) y luego pasan solas. Solo en memoria: se olvida al reiniciar. Sin clave, se pregunta siempre.
const confirmedOnce = new Set();
const onceKey = (tool, ctx) => { const k = ctx?.chatId || ctx?.client; return k ? `${tool.name.split('.')[0]}:${k}` : null; };

// Pide confirmación si la política lo exige. Devuelve { mode, confirmed } (confirmed=null si no hizo falta).
export async function gate(tool, args, ctx = {}) {
  let mode = modeOf(tool.policy);
  const key = tool.confirmOnce ? onceKey(tool, ctx) : null;
  if (tool.confirmOnce && mode === 'auto' && !(key && confirmedOnce.has(key))) mode = 'confirmOnce';
  if (mode === 'auto') return { mode, confirmed: null };
  const detail = JSON.stringify(summarize(args), null, 2);
  const confirmed = await questions.confirm({
    question: `El Guide quiere ejecutar «${tool.name}» (${tool.policy}). ¿Lo permites?`,
    context: `${tool.description}\n\n\`\`\`json\n${detail}\n\`\`\``,
  });
  if (confirmed && mode === 'confirmOnce' && key) confirmedOnce.add(key);
  return { mode, confirmed };
}

export function audit(entry) {
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    try { if (fs.statSync(AUDIT_FILE()).size > MAX_AUDIT) fs.renameSync(AUDIT_FILE(), AUDIT_FILE() + '.1'); } catch { /* aún no existe */ }
    fs.appendFileSync(AUDIT_FILE(), JSON.stringify(entry) + '\n');
  } catch { /* la auditoría nunca debe tumbar la tool */ }
}
