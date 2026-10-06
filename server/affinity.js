// FT-64 · Afinidad de caché de prompt. La caché dura ~5 min y dos tareas seguidas del mismo repo+rol+motor comparten el
// prefijo estable (system del rol + reglas + briefing), así que `tick()` (team.js) las agrupa. Aquí, solo lo puro.
export const CACHE_WINDOW_MS = 5 * 60_000;

// Orden de reparto de las tareas «Por hacer»: pausadas por cuota primero, prioridad alta, a igualdad la «caliente»
// (`warm(t)`: su repo+rol+motor coincide con una en curso o terminada hace <5 min) y, por último, la más antigua.
// Sin `warm` (cacheAffinity apagado) queda el orden clásico: prioridad y antigüedad.
export function orderTodo(tasks, warm = () => false) {
  const w = new Map(tasks.map((t) => [t.id, warm(t) ? 1 : 0]));
  return [...tasks].sort((a, b) => (b.quotaPaused ? 1 : 0) - (a.quotaPaused ? 1 : 0) || (b.priority || 0) - (a.priority || 0) || w.get(b.id) - w.get(a.id) || a.createdAt - b.createdAt);
}
