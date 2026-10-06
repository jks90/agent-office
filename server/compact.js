// Evitar la compactación automática al límite del contexto (FT-63). Funciones puras: `team.js` decide qué hacer con ellas.
// La compactación automática salta cerca del 93 % de la ventana y relee/resume varias veces (caro). Antes de llegar:
//  1) medir el contexto por turno y, al pasar `at` (≈62 %), pedir al agente las notas de estado y relanzar con ellas;
//  2) detectar tareas grandes antes de lanzarlas para que el PO las trocee.
export const NOTES_FILE = 'NOTAS.md';
export const DEFAULT_AT = 0.62;
export const MAX_COMPACTIONS = 3; // relanzamientos por intento: más allá, la tarea es demasiado grande y se deja terminar

// Ventana de contexto: la que informa el CLI (`modelUsage.contextWindow`, solo llega en `result`) o, mientras tanto, la del modelo.
export function windowOf(u, model = '') {
  if (u?.limit > 0) return u.limit;
  if (Number(process.env.AO_CONTEXT_WINDOW) > 0) return Number(process.env.AO_CONTEXT_WINDOW);
  if (/\[1m\]|-1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

// Fracción de la ventana ocupada en la última llamada. `used` (Claude: entrada+caché del último mensaje) o `ctx` (otros motores).
// null si el motor no informa del contexto (Codex `exec` solo da cifras al cerrar el turno → no hay medida a mitad).
export function contextShare(u, model) {
  const used = u?.used > 0 ? u.used : u?.ctx > 0 ? u.ctx : 0;
  return used ? used / windowOf(u, model) : null;
}

// `at` = umbral (0 lo apaga). Acepta fracción (0.62) o porcentaje (62).
export function threshold(setting) {
  const v = setting === undefined || setting === null || setting === '' ? DEFAULT_AT : Number(setting);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(0.9, Math.max(0.3, v > 1 ? v / 100 : v));
}

export const reached = (u, model, at) => !!at && (contextShare(u, model) ?? 0) >= at;

export const COMPACT_INSTRUCTION = `Tu contexto ya va por más de la mitad de su ventana y seguir así saldría caro. Haz esto ahora: escribe el fichero ${NOTES_FILE} en la raíz de tu copia del repo con (1) lo que ya está hecho y verificado, (2) decisiones tomadas y por qué, (3) ficheros tocados, (4) lo que falta, paso a paso, y (5) cómo probarlo. Debe bastar para seguir sin releer nada. Después termina tu turno sin más texto: se retomará la tarea con esas notas en un contexto limpio. Si en realidad ya terminaste todo, no escribas ${NOTES_FILE} y entrega el resumen final.`;

// Bloque del prompt de la tarea relanzada. `notes` vacío = el motor no llegó a escribirlas: el avance está en la rama.
export function notesBlock(notes) {
  return notes
    ? `\nRETOMAS LA TAREA tras compactar el contexto. Notas que escribiste (${NOTES_FILE}; el fichero ya se retiró del repo):\n${String(notes).slice(0, 12_000)}\nTu avance está en esta rama (mira \`git log\` y \`git diff\` contra la base solo si lo necesitas). Sigue por el paso siguiente sin releer lo ya hecho.`
    : '\nRETOMAS LA TAREA tras cortar la sesión para no llenar el contexto. Tu avance está en esta rama: mira `git log` y `git diff` contra la base, y continúa donde lo dejaste sin releer lo ya hecho.';
}

// ¿Es una tarea demasiado grande para un solo agente? Devuelve el motivo o null. Heurísticas baratas sobre el texto y la estimación
// por rol (FT-26): muchas piezas enumeradas, varios «y además…», descripción larguísima o estimación cerca del tope de gasto.
export function bigTaskReason(t, { estimate = null, capUsd = 3 } = {}) {
  const text = `${t.title || ''}\n${t.description || ''}`;
  const items = (t.description || '').split('\n').filter((l) => /^\s*(?:\d+[.)]|[-*•]|\[[ x]\])\s+\S/.test(l)).length;
  const extras = (text.match(/\by además\b|\badem[aá]s\b|\by también\b|\bpor otro lado\b|\badicionalmente\b/gi) || []).length;
  if (items >= 6) return `${items} puntos enumerados`;
  if (extras >= 2) return `${extras} «y además…» en la descripción`;
  if ((t.description || '').length > 2500) return 'descripción muy larga';
  if (estimate && estimate >= capUsd * 0.7 && (items >= 3 || extras >= 1)) return `estimación ≈ ${estimate} $ (tope ${capUsd} $) y varias piezas`;
  return null;
}
