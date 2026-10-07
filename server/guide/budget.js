// FT-132 · Coste estimado de una petición del Guía y tope para las tareas abiertas con navegador.
// Los proveedores por CLI solo dan el coste real al final del turno: durante él se estima con los tokens (USD por millón).
const PRICES = [
  [/opus/i, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/haiku/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/./, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }], // sonnet y resto
];
export function estimateCost(model, u = {}) {
  const p = PRICES.find(([re]) => re.test(String(model || '')))[1];
  return ((u.input || 0) * p.input + (u.output || 0) * p.output + (u.cacheRead || 0) * p.cacheRead + (u.cacheWrite || 0) * p.cacheWrite) / 1e6;
}
// settings.guideBrowserMaxUsd: 1 $ por defecto; 0 desactiva el tope
export function maxUsd(settings = {}) {
  const v = settings.guideBrowserMaxUsd;
  return v == null || Number.isNaN(Number(v)) ? 1 : Math.max(0, Number(v));
}
// Suma tokens de un mapa id-de-mensaje → usage de la API de Anthropic (stream-json del CLI)
export function sumUsage(map) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of map.values()) { t.input += u.input_tokens || 0; t.output += u.output_tokens || 0; t.cacheRead += u.cache_read_input_tokens || 0; t.cacheWrite += u.cache_creation_input_tokens || 0; }
  return t;
}
