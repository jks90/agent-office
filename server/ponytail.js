// Ponytail (FT-86): reglas de «construir lo mínimo», activables por rol y por agente (apagadas por defecto).
// Inspiradas en la escalera de decisión del plugin Ponytail (DietrichGebert/ponytail); el texto es NUESTRO, no una copia.
// Módulo puro: `team.js` decide cuándo meter el bloque (parte ESTABLE del prompt, FT-59) y etiqueta el intento con `variant`.

export const BLOCK = [
  'MODO «CONSTRUIR LO MÍNIMO» (Ponytail): antes de escribir código nuevo recorre esta escalera y párate en el primer peldaño que resuelva la tarea:',
  '1. ¿Hace falta? Si el objetivo se cumple sin hacer nada, no lo hagas y explícalo en el resumen.',
  '2. ¿Ya existe en el repo? Búscalo (grep) antes de escribir: puede que ya esté hecho.',
  '3. ¿Se resuelve configurando lo que hay (ajuste, opción, parámetro)?',
  '4. ¿Se puede reutilizar o extender código existente en vez de crear un módulo paralelo?',
  '5. ¿Basta un cambio de una línea o de pocas líneas?',
  '6. Escribe lo mínimo que cumpla los criterios de hecho de la tarea: sin abstracciones, opciones ni ficheros «por si acaso».',
  '7. Solo si ninguno de los anteriores sirve, escribe código nuevo, y que sea pequeño.',
  'Lo mínimo no es lo peor: los criterios de hecho y las pruebas de la tarea se cumplen igual. Menos código = menos tokens que releer en cada turno.',
].join('\n');

// ¿Va activa para este agente? Por agente (`agent.ponytail`) o por rol (`settings.ponytailRoles[rol]`).
export const enabled = (settings, agent, roleId) => !!(agent?.ponytail || settings?.ponytailRoles?.[roleId ?? agent?.role]);

// Etiqueta de la telemetría de costes.
export const variantOf = (settings, agent, roleId) => (enabled(settings, agent, roleId) ? 'ponytail' : 'base');
export const VARIANTS = ['base', 'ponytail'];

// Normaliza el mapa de roles que llega por Ajustes: solo claves tipo id de rol con valor true.
export const cleanRoles = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).filter(([k, v]) => v === true && /^[\w-]{1,60}$/.test(k)));
