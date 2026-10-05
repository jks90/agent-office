// Proveedor de PRUEBAS del Guide Agent (FT-11): no habla con ningún LLM, ejecuta un guion de tool calls. Solo se registra con
// AO_GUIDE_FAKE=1 (ver guide/index.js). El guion va en el propio mensaje del usuario, tras « ::»:
//   Enséñame lo que ha cambiado ::[{"say":"Voy a mirar"},{"tool":"agent.getModifiedFiles","args":{"code":"AO-1"}}]
// Cada paso es {say} (evento text) o {tool, args} (tool_call → run() del registro FT-4, con su política y auditoría → tool_result).
// Un mensaje sin guion solo se devuelve en eco. Mismo contrato GuideProvider que claude-cli.js: start / send / stop / sessionId.
import { run } from '../tools.js';

export const label = 'fake', defaultModel = 'fake', ready = () => true;
export function create() {
  let stopped = false;
  let sessionId = null;
  return {
    start(o) { sessionId = o.resume || 'fake-' + Date.now().toString(36); return { sessionId }; },
    get sessionId() { return sessionId; },
    async *send({ text }) {
      stopped = false;
      const at = text.indexOf(' ::[');
      let script = [];
      if (at >= 0) { try { script = JSON.parse(text.slice(at + 3)); } catch { yield { type: 'error', error: 'Guion de prueba no válido (JSON)' }; return; } }
      if (!script.length) { yield { type: 'text', text: `fake: ${text}` }; yield { type: 'done', sessionId, costUsd: 0 }; return; }
      let n = 0;
      for (const step of script) {
        if (stopped) { yield { type: 'error', error: 'Parado por el usuario', stopped: true }; return; }
        if (step.say) { yield { type: 'text', text: String(step.say) }; continue; }
        const id = `fake_${++n}`;
        yield { type: 'tool_call', id, name: step.tool, args: step.args || {} };
        try {
          const out = await run(step.tool, step.args || {}, { via: 'guide-fake' });
          yield { type: 'tool_result', id, ok: true, result: JSON.stringify(out).slice(0, 20_000) };
        } catch (e) {
          yield { type: 'tool_result', id, ok: false, result: String(e.message).slice(0, 2000) };
        }
      }
      yield { type: 'done', sessionId, costUsd: 0 };
    },
    stop() { stopped = true; },
  };
}
