// FT-60 · Cascada de modelos con escalado. Lógica PURA (sin store): `team.js` la enruta.
// La tarea empieza en el peldaño más barato de la escalera de su motor y sube solo si algo sale mal
// (devolverla desde revisión, error del agente, rechazo de la revisión automática). Nunca más de MAX_ESCALATIONS.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ESCALATIONS = 2;
export const MODEL_OF = { claude: /^(sonnet|opus|haiku|claude-)/i, codex: /^(gpt-|o[0-9]|codex)/i };
export const TOP = { claude: 'sonnet', codex: 'gpt-5.5' }; // modelo «de siempre» de cada motor (opus solo a mano); en Codex, solo si no se sabe cuál tiene la cuenta

// Modelos de Codex que tu cuenta tiene ahora (los visibles de ~/.codex/models_cache.json, sin los de revisión), o null si no se sabe.
// OpenAI retira modelos: uno de la escalera que ya no está («not supported when using Codex with a ChatGPT account») se descarta.
export function codexModels(home = process.env.HOME) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    const list = cache.models || cache.data || cache;
    const slugs = (Array.isArray(list) ? list : []).filter((m) => m && typeof m === 'object' && m.visibility !== 'hide').map((m) => m.slug).filter(Boolean).filter((x) => !/review/i.test(x));
    return slugs.length ? slugs : null;
  } catch { return null; }
}
// Modelo principal de Codex: el `model` de ~/.codex/config.toml (el que usa el CLI), si la cuenta lo tiene; si no, el primero de la cuenta.
export function codexTopModel(home = process.env.HOME) {
  const avail = codexModels(home);
  let conf = null;
  try { conf = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null; } catch { /* sin config */ }
  if (conf && (!avail || avail.includes(conf))) return conf;
  return avail?.[0] || TOP.codex;
}
// Modelo barato de Codex: el mini/rápido que liste ~/.codex/models_cache.json (si no hay ninguno, la escalera tiene un solo peldaño).
export function codexCheapModel(home = process.env.HOME) {
  const top = codexTopModel(home);
  return (codexModels(home) || []).find((s) => /mini|nano|spark|fast/i.test(s) && s !== top) || null;
}

const clean = (v, engineId) => (Array.isArray(v) ? v : String(v || '').split(/[,>→\s]+/)).map((x) => String(x).trim()).filter((x) => x && MODEL_OF[engineId]?.test(x));
// Escalera efectiva de un motor: la de Ajustes (settings.modelLadder[motor]) o la de serie. En Codex, sin los modelos retirados.
export function ladderFor(engineId, settings = {}, home) {
  let custom = clean(settings.modelLadder?.[engineId], engineId);
  if (engineId === 'codex') { const avail = codexModels(home); if (avail) custom = custom.filter((m) => avail.includes(m)); }
  if (custom.length) return custom;
  if (engineId === 'claude') return ['haiku', TOP.claude];
  if (engineId === 'codex') { const top = codexTopModel(home), c = codexCheapModel(home); return c ? [c, top] : [top]; }
  return [];
}
export const ladders = (settings, home) => ({ claude: ladderFor('claude', settings, home), codex: ladderFor('codex', settings, home) });
export const normalizeLadder = clean;

// Elige el modelo del intento. `floor` = minModel de la tarea o del rol; `plan` = tarea de planificación (empieza arriba).
// `all` = escaleras de los dos motores (un minModel «sonnet» en Codex vale como «el 2.º peldaño»).
export function pick(engineId, ladder, { floor = '', plan = false, escalations = 0, all = {} } = {}) {
  if (!ladder.length) return null;
  const last = ladder.length - 1;
  let start = plan ? last : 0, why = plan ? 'plan' : 'barato';
  if (floor) {
    let i = ladder.indexOf(floor);
    if (i < 0) for (const l of Object.values(all)) { const j = l.indexOf(floor); if (j >= 0) { i = Math.min(j, last); break; } }
    if (i < 0) { // fuera de la escalera (p. ej. opus): se usa tal cual si es de este motor; si no, el techo
      return { model: MODEL_OF[engineId]?.test(floor) ? floor : ladder[last], level: last, why: 'minModel' };
    }
    if (i > start) { start = i; why = 'minModel'; }
  }
  const esc = Math.max(0, Math.min(MAX_ESCALATIONS, escalations | 0));
  const level = Math.min(last, start + esc);
  return { model: ladder[level], level, why: esc && level > start ? 'escalada' : why };
}

// «haiku → sonnet»: historial sin repetidos consecutivos.
export const historyText = (h = []) => h.map((x) => x.model).filter((m, i, a) => m && m !== a[i - 1]).join(' → ');
