// FT-62: detector de agentes atascados. Función pura sobre el stream que ya llega (onTool / onUsage), igual para claude, codex y demo.
// Señales: misma orden o misma lectura repetida, errores de herramienta seguidos, turnos sin editar, el mismo e2e fallando igual
// y gasto de tokens por turno que crece sin cambios en el worktree. `feed()`/`usage()` devuelven la señal (texto) o null.
export const DEFAULTS = { enabled: true, repeat: 3, errors: 4, noEdit: 25, tokensPerTurn: 80000 };
// Codex lee con una orden de shell por paso (sed -n/rg…) y cada paso reenvía todo el contexto: su «sin editar» salta antes.
export const NO_EDIT_CODEX = 15;

const E2E = /\b(e2e|playwright|cypress|vitest|jest|mocha|pytest|node --test|npm (run )?test|yarn test|pnpm test)\b/i;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function limits(settings = {}, engine = '') {
  const n = (v, def, min, max) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.max(min, Math.min(max, Math.round(Number(v)))) : def);
  return {
    enabled: settings.stuckGuard !== false,
    repeat: n(settings.stuckRepeat, DEFAULTS.repeat, 2, 20),
    errors: n(settings.stuckErrors, DEFAULTS.errors, 2, 30),
    noEdit: n(settings.stuckNoEdit, engine === 'codex' ? NO_EDIT_CODEX : DEFAULTS.noEdit, 5, 200),
    tokensPerTurn: n(settings.stuckTokens, DEFAULTS.tokensPerTurn, 5000, 5_000_000),
  };
}

// `isCode`: tarea de código (no plan, ni QA/docs), la única donde «sin editar» es sospechoso.
// `probe`: async () => string con el estado del worktree (git status + diff --stat); sin él no se evalúa la señal de tokens.
export function createDetector({ limits: L = DEFAULTS, isCode = true, probe = null } = {}) {
  const counts = new Map();   // «Bash:cmd» / «Read:ruta» → veces desde la última edición
  const e2eFails = new Map(); // comando e2e → fallos seguidos
  const calls = new Map();    // callId → { key, e2e }
  let errorRun = 0, turnsNoEdit = 0, turns = 0;
  // tokens: ventana de turnos desde la última comprobación del worktree
  let lastTotal = 0, winTurns = 0, winTokens = 0, lastState = null, busy = false;
  const WINDOW = 4;

  return {
    // c: { phase, callId, tool, key?, ok? } (los de `started` traen `key`: orden completa o ruta; nunca sale de aquí)
    feed(c) {
      if (!L.enabled) return null;
      if (c.phase === 'started') {
        turns++;
        const edit = EDIT_TOOLS.has(c.tool);
        const key = c.key ? `${c.tool}:${c.key}` : null;
        calls.set(c.callId, { key, e2e: c.tool === 'Bash' && E2E.test(c.key || '') ? c.key : null });
        if (edit) { counts.clear(); turnsNoEdit = 0; return null; } // editar = hay progreso: se reinician repeticiones
        turnsNoEdit++;
        if (key && (c.tool === 'Bash' || c.tool === 'Read') && !calls.get(c.callId).e2e) { // los e2e los juzga su racha de fallos
          const n = (counts.get(key) || 0) + 1;
          counts.set(key, n);
          if (n >= L.repeat) return c.tool === 'Bash'
            ? `repite la orden «${short(c.key)}» (${n} veces sin editar nada entre medias)`
            : `relee ${short(c.key)} (${n} veces sin editarlo)`;
        }
        if (isCode && turnsNoEdit >= L.noEdit) return `${turnsNoEdit} pasos seguidos sin editar ningún fichero`;
        return null;
      }
      const call = calls.get(c.callId);
      calls.delete(c.callId);
      errorRun = c.ok ? 0 : errorRun + 1;
      if (!c.ok && errorRun >= L.errors) return `${errorRun} errores de herramienta seguidos`;
      if (call?.e2e) {
        if (c.ok) e2eFails.delete(call.e2e);
        else {
          const n = (e2eFails.get(call.e2e) || 0) + 1;
          e2eFails.set(call.e2e, n);
          if (n >= L.repeat) return `la prueba «${short(call.e2e)}» falla igual por ${n}.ª vez`;
        }
      }
      return null;
    },
    // total: tokens acumulados de la sesión (usage.total). Devuelve una promesa con la señal o null.
    async usage(total) {
      if (!L.enabled || !probe || !Number.isFinite(total)) return null;
      winTokens += Math.max(0, total - lastTotal); lastTotal = total; winTurns++;
      if (winTurns < WINDOW || busy) return null;
      busy = true;
      const spent = winTokens, n = winTurns;
      winTurns = 0; winTokens = 0;
      try {
        const state = await probe();
        const same = lastState !== null && state === lastState;
        lastState = state;
        if (same && spent / n > L.tokensPerTurn) return `gasta ≈${Math.round(spent / n / 1000)} k tokens por turno desde hace ${n} turnos sin cambios en el worktree`;
      } catch { /* sin git: sin señal */ }
      finally { busy = false; }
      return null;
    },
    get turns() { return turns; },
  };
}

const short = (s, n = 70) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Texto del aviso en caliente (FT-5): redacción neutra, sin encabezados imperativos (el modelo los rechaza como inyección).
export const nudgeText = (signal) => `Nota del sistema de AgentOffice: ${signal}. Parece que das vueltas sobre lo mismo; cambia de enfoque, o termina con lo que tienes y explica en tu resumen qué te bloquea.`;
