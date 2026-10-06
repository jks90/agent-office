// FT-54 · Servidor de IA local (LM Studio / Ollama, API compatible con OpenAI): normaliza la URL base, lista sus modelos
// (`GET /v1/models`), comprueba si un modelo admite tool calls y guarda `settings.local = {baseUrl, model, allowAuto}`.
// La clave (opcional) NO va en `settings` (viaja por el snapshot SSE): se guarda en <data>/.ai-keys.json como `local` (auth.js).
import * as store from '../store.js';

export const PRESETS = [
  { id: 'lmstudio', label: 'LM Studio :1234', baseUrl: 'http://localhost:1234/v1' },
  { id: 'ollama', label: 'Ollama :11434', baseUrl: 'http://localhost:11434/v1' },
];
const TIMEOUT = 4000;

export const config = () => store.get().settings.local || null;
// «localhost:1234» → http://localhost:1234/v1 · sin barra final · si no trae ruta, se añade /v1
export function normBase(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  try { if (new URL(s).pathname === '/') s += '/v1'; } catch { return ''; }
  return s;
}
const hdrs = (key) => ({ accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) });
const getJson = async (url, key) => {
  const r = await fetch(url, { headers: hdrs(key), signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
};
const kindOf = (baseUrl) => (/:1234(\/|$)/.test(baseUrl) ? 'LM Studio' : /:11434(\/|$)/.test(baseUrl) ? 'Ollama' : 'IA local');

// {ok:true, kind, models:[id], text:'LM Studio · 3 modelos'} | {ok:false, error}
export async function probe(baseUrl, apiKey) {
  const base = normBase(baseUrl);
  if (!base) return { ok: false, error: 'URL no válida' };
  try {
    const j = await getJson(`${base}/models`, apiKey);
    const models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    const kind = kindOf(base);
    return { ok: true, baseUrl: base, kind, models, text: `${kind} · ${models.length} modelo${models.length === 1 ? '' : 's'}` };
  } catch (e) {
    const why = e.status === 401 || e.status === 403 ? 'el servidor pide clave (¿es correcta?)' : e.name === 'TimeoutError' ? 'sin respuesta (4 s)' : e.status ? e.message : 'no responde: ¿está abierto con el servidor activado?';
    return { ok: false, baseUrl: base, error: `${kindOf(base)}: ${why}` };
  }
}

// ¿Admite tool calls? true | false | null (no se sabe). LM Studio lo dice en su API nativa (`/api/v0/models`: capabilities
// «tool_use»); Ollama en `POST /api/show` (capabilities «tools»). Otro servidor → null y se intenta igualmente.
export async function toolSupport(baseUrl, model, apiKey) {
  const base = normBase(baseUrl);
  if (!base || !model) return null;
  const origin = new URL(base).origin;
  try {
    const j = await getJson(`${origin}/api/v0/models`, apiKey);
    const m = (j.data || []).find((x) => x.id === model);
    if (m && Array.isArray(m.capabilities)) return m.capabilities.includes('tool_use');
  } catch { /* no es LM Studio */ }
  try {
    const r = await fetch(`${origin}/api/show`, { method: 'POST', headers: { ...hdrs(apiKey), 'content-type': 'application/json' }, body: JSON.stringify({ model, name: model }), signal: AbortSignal.timeout(TIMEOUT) });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.capabilities)) return j.capabilities.includes('tools'); }
  } catch { /* no es Ollama */ }
  return null;
}
export const noToolsMessage = (model) => `el modelo ${model} no devuelve tool calls: elige uno con soporte de herramientas, p. ej. qwen2.5-coder, llama-3.x-instruct, devstral`;

// Guarda lo elegido en Ajustes (sin la clave). El modelo por defecto se conserva si el servidor aún lo lista.
export function save({ baseUrl, model, allowAuto, models }) {
  const st = store.get().settings;
  const next = { ...(st.local || {}) };
  if (baseUrl !== undefined) next.baseUrl = normBase(baseUrl);
  if (typeof model === 'string') next.model = model.trim();
  else if (models && (!next.model || !models.includes(next.model))) next.model = models[0] || '';
  if (typeof allowAuto === 'boolean') next.allowAuto = allowAuto;
  next.allowAuto = !!next.allowAuto; // apagado de serie: es más lento y menos capaz
  st.local = next;
  store.changed();
  return next;
}
