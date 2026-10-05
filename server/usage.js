// Consumo de tokens por sesión (FT-26). Solo cifras: nunca se guarda ni se muestra texto de prompts ni de transcripts.
// Forma común: { input, output, cache, total, limit, used, costUsd, source, updatedAt }
//   input  = tokens de entrada nuevos · cache = leídos de / escritos en caché · output = salida · total = suma de las tres
//   limit/used = ventana de contexto del modelo y lo ocupado ahora (null si el CLI no lo informa → la UI pinta «n/d»)
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const finish = (u) => ({ ...u, total: u.input + u.output + u.cache, updatedAt: Date.now() });

// Claude Code (stream-json): cada evento `assistant` trae message.usage {input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}; un mismo mensaje se repite por bloque de contenido, así que se deduplica por message.id.
// El evento final `result` trae el `usage` acumulado, `total_cost_usd` y `modelUsage[modelo].contextWindow` (límite de contexto).
// La cuota del plan (Session/Weekly de /usage) NO la expone `claude -p`: no se puede leer sin inventarla → solo ventana de contexto.
export function claudeTracker() {
  const byMsg = new Map();
  let lastCtx = null, limit = null, cost = null, final = null;
  const fromUsage = (u = {}) => ({ input: num(u.input_tokens), output: num(u.output_tokens), cache: num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) });
  const snap = () => {
    let base = { input: 0, output: 0, cache: 0 };
    if (final) base = final;
    else for (const m of byMsg.values()) { base.input += m.input; base.output += m.output; base.cache += m.cache; }
    return finish({ ...base, limit, used: lastCtx, costUsd: cost, source: 'claude stream-json' });
  };
  return {
    // devuelve el uso actualizado, o null si el evento no aporta cifras
    feed(ev) {
      if (ev.type === 'assistant' && ev.message?.usage) {
        const u = fromUsage(ev.message.usage);
        byMsg.set(ev.message.id || `n${byMsg.size}`, u);
        lastCtx = u.input + u.cache; // lo que ocupaba el contexto en la última llamada
        final = null; // otro turno: vuelve la suma por mensajes
        return snap();
      }
      if (ev.type === 'result' && ev.usage) {
        // `result` acumula la sesión; por si un CLI lo contase distinto, vale el máximo de las dos cuentas
        const r = fromUsage(ev.usage);
        const sum = [...byMsg.values()].reduce((a, m) => ({ input: a.input + m.input, output: a.output + m.output, cache: a.cache + m.cache }), { input: 0, output: 0, cache: 0 });
        final = { input: Math.max(r.input, sum.input), output: Math.max(r.output, sum.output), cache: Math.max(r.cache, sum.cache) };
        const wins = Object.values(ev.modelUsage || {}).map((m) => num(m?.contextWindow)).filter(Boolean);
        if (wins.length) limit = Math.max(...wins);
        if (Number.isFinite(ev.total_cost_usd)) cost = ev.total_cost_usd;
        return snap();
      }
      return null;
    },
  };
}

// Codex (`codex exec --json`): el evento `turn.completed` trae usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}.
// input_tokens INCLUYE los cacheados (aquí se separan) y la salida ya incluye el razonamiento. Solo llega al terminar cada turno (no a mitad).
// Ese stream no informa ventana de contexto ni cuota (los `token_count` de ~/.codex/sessions no se leen) → limit/used = null.
export function codexTracker() {
  let acc = { input: 0, output: 0, cache: 0 };
  return {
    feed(ev) {
      if (ev.type !== 'turn.completed' || !ev.usage) return null;
      const cached = num(ev.usage.cached_input_tokens);
      acc = { input: acc.input + Math.max(0, num(ev.usage.input_tokens) - cached), output: acc.output + num(ev.usage.output_tokens), cache: acc.cache + cached };
      return finish({ ...acc, limit: null, used: null, costUsd: null, source: 'codex turn.completed' });
    },
  };
}

// Suma de sesiones (intentos de una tarea). limit/used son de la sesión en curso, no se suman.
export function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return finish({ input: a.input + b.input, output: a.output + b.output, cache: a.cache + b.cache, limit: b.limit, used: b.used, costUsd: a.costUsd != null || b.costUsd != null ? (a.costUsd || 0) + (b.costUsd || 0) : null, source: b.source });
}
