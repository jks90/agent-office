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
  // FT-30 · guideInputFallback: interruptor del fallback de ratón/teclado (false de serie)
  return { execute: ['auto', 'confirm'].includes(g.execute) ? g.execute : DEFAULTS.execute, write: ['auto', 'confirm'].includes(g.write) ? g.write : DEFAULTS.write, guideInputFallback: store.get().settings.guideInputFallback === true,
    always: alwaysList() };
}

// «Sí, siempre»: tools (execute/write, nunca irreversibles) que el usuario ya permitió para siempre. settings.guideAlwaysAllow.
const alwaysList = () => (Array.isArray(store.get().settings.guideAlwaysAllow) ? store.get().settings.guideAlwaysAllow.map(String) : []);
export function setAlways(name, on) {
  const cur = new Set(alwaysList());
  if (on) cur.add(String(name)); else cur.delete(String(name));
  store.get().settings.guideAlwaysAllow = [...cur].sort();
  store.changed();
  return getPolicy();
}

export function setPolicy(patch = {}) {
  const cur = getPolicy();
  for (const k of ['execute', 'write']) if (['auto', 'confirm'].includes(patch[k])) cur[k] = patch[k];
  if (Array.isArray(patch.always)) { store.get().settings.guideAlwaysAllow = [...new Set(patch.always.map(String))].sort(); }
  const { guideInputFallback, always, ...modes } = cur;
  store.get().settings.guidePolicy = modes;
  if (typeof patch.guideInputFallback === 'boolean') store.get().settings.guideInputFallback = patch.guideInputFallback;
  store.changed();
  return getPolicy();
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
  if (mode === 'confirm' && tool.policy !== 'irreversible' && alwaysList().includes(tool.name)) return { mode: 'always', confirmed: null }; // «Sí, siempre»
  if (mode === 'auto') return { mode, confirmed: null };
  const detail = JSON.stringify(summarize(ctx.modalArgs ?? args), null, 2); // FT-137: modalArgs = args ya enmascarados (contraseñas)
  // FT-29 · ctx.modalContext: contexto extra que aporta la tool (p. ej. app, control y acción de ui.act)
  const extra = ctx.modalContext ? `${ctx.modalContext}\n\n` : '';
  // Las irreversibles preguntan SIEMPRE; el resto ofrece además «Sí, siempre» (deja de preguntar por esa tool; se quita en Ajustes ▸ Guía)
  const canAlways = tool.policy !== 'irreversible' && mode === 'confirm';
  const answer = await questions.choose({
    question: ctx.modalQuestion || `El Guide quiere ejecutar «${tool.name}» (${tool.policy}). ¿Lo permites?`,
    context: `${extra}${tool.description}\n\n\`\`\`json\n${detail}\n\`\`\``,
    options: canAlways ? ['Sí', 'Sí, siempre', 'No'] : ['Sí', 'No'],
  });
  if (answer === 'Sí, siempre') setAlways(tool.name, true);
  const confirmed = answer === 'Sí' || answer === 'Sí, siempre';
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
