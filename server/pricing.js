// Tabla de precios por modelo (FT-76), en US$ por millón de tokens. EDITABLE: crea `data/pricing.json` con
// { "<fragmento del id del modelo>": { "input": 3, "cacheRead": 0.3, "cacheWrite": 3.75, "output": 15 } } y se fusiona
// con esta tabla (gana lo más específico). Son tarifas de API públicas aproximadas: en suscripción NO se paga por token,
// pero sirven como unidad común para comparar agente vs interactivo (README «Observabilidad de costes»).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const DEFAULT_PRICES = {
  haiku: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  sonnet: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  opus: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  fable: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 },
  codex: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 },
};
const FALLBACK = DEFAULT_PRICES.sonnet;

function table() {
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pricing.json'), 'utf8')); } catch { /* sin personalizar */ }
  return { ...DEFAULT_PRICES, ...extra };
}

// Precio de un modelo por coincidencia de fragmento (el más largo gana). Desconocido → tarifa de Sonnet.
export function priceOf(model) {
  const m = String(model || '').toLowerCase(), t = table();
  const hit = Object.keys(t).filter((k) => m.includes(k.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return { ...FALLBACK, ...(hit ? t[hit] : {}), known: !!hit };
}

// Coste en US$ de un uso {input, cacheRead, cacheWrite, output} (input = tokens frescos, sin caché).
export function costOf(model, u) {
  const p = priceOf(model);
  return ((u.input || 0) * p.input + (u.cacheRead || 0) * p.cacheRead + (u.cacheWrite || 0) * p.cacheWrite + (u.output || 0) * p.output) / 1e6;
}

// Ahorro por caché: lo que habrían costado los tokens leídos de caché a precio de entrada normal, menos lo que costaron.
export const cacheSaving = (model, cacheRead) => { const p = priceOf(model); return ((cacheRead || 0) * (p.input - p.cacheRead)) / 1e6; };
