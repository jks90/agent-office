// Piezas comunes de los proveedores HTTP del Guide (FT-8): anthropic-api.js y openai-api.js. Sin SDKs: `fetch` + SSE a mano.
// Aquí vive lo que NO depende del LLM: esquemas de las tools del registro (FT-4), ejecución de tool calls con su política y
// auditoría, historial del chat y el bucle «modelo → tools → modelo» que emite los mismos eventos que claude-cli.js.
import { tools as registry, run } from '../tools.js';

const MAX_ROUNDS = 12;
// Los nombres de tool de los LLM no admiten «.»: `task.create` se publica como `task_create` (igual que el MCP de FT-4).
export const wireName = (n) => n.replace('.', '_');
export const realName = (n) => registry.find((t) => wireName(t.name) === n)?.name || n;
export const toolDefs = () => registry.filter((t) => !t.pending).map((t) => ({ name: wireName(t.name), description: t.description, schema: t.input }));

// Historial persistido del chat (user/assistant/tool) → turnos neutrales
// [{role:'user', text} | {role:'assistant', text, calls:[{id, name, args, ok, result}]}].
// Las tools de un chat guardado cuelgan de la respuesta que las hizo; las que quedaron sin resultado (turno cortado) se descartan.
export function historyTurns(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', text: m.text });
    else if (m.role === 'assistant') out.push({ role: 'assistant', text: m.text, calls: [] });
    else if (m.role === 'tool' && m.result != null) {
      let last = out[out.length - 1];
      if (last?.role !== 'assistant') { last = { role: 'assistant', text: '', calls: [] }; out.push(last); }
      last.calls.push({ id: m.id, name: m.name, args: m.args || {}, ok: !!m.ok, result: m.result });
    }
  }
  return out;
}

// Lee un cuerpo SSE y llama a onData(json) por cada `data:`. Para en `[DONE]`.
export async function readSse(res, onData) {
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      let j; try { j = JSON.parse(data); } catch { continue; }
      await onData(j);
    }
  }
}

export async function httpError(res, who) {
  const t = await res.text().catch(() => '');
  let msg = t.slice(0, 300);
  try { const j = JSON.parse(t); msg = j.error?.message || j.message || msg; } catch { /* texto plano */ }
  const hint = res.status === 401 || res.status === 403 ? ' (revisa la clave API en Ajustes ▸ Motores de IA)' : '';
  return new Error(`${who} → ${res.status}: ${msg}${hint}`);
}

// Esqueleto GuideProvider para un LLM por HTTP sin estado. `adapter` aporta lo específico del proveedor:
//   adapter.who                         nombre para los errores y la auditoría
//   adapter.stream({system, tools, model, turns, signal, onText}) → { calls:[{id,name,args}], usage, cost }
//       una llamada al modelo con el historial neutral `turns`; `onText(t)` por cada bloque de texto completo.
// Eventos: text · tool_call · tool_result · done {costUsd, usage} · error — los mismos que claude-cli.js.
export function createHttpProvider(adapter) {
  let opts = null, turns = [], ctrl = null, running = false, stopped = false;
  return {
    start(o) { opts = o; turns = historyTurns(o.history); return { sessionId: null }; },
    get sessionId() { return null; }, // sin sesión remota: el historial vive en el chat guardado (se rehidrata con `history`)
    async *send({ text, context = '', client = null }) {
      if (running) throw new Error('Ya hay un turno en curso');
      running = true; stopped = false; ctrl = new AbortController();
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let cost = null;
      const mark = turns.length;
      turns.push({ role: 'user', text: (context ? context + '\n\n' : '') + text });
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const texts = [];
          const r = await adapter.stream({ system: opts.system, tools: toolDefs(), model: opts.model, turns, signal: ctrl.signal, onText: (t) => texts.push(t) });
          for (const k of Object.keys(usage)) usage[k] += r.usage?.[k] || 0;
          if (r.cost != null) cost = (cost || 0) + r.cost;
          for (const t of texts) if (t.trim()) yield { type: 'text', text: t };
          const turn = { role: 'assistant', text: texts.join('\n\n'), calls: [] };
          turns.push(turn);
          if (!r.calls.length) { yield { type: 'done', sessionId: null, costUsd: cost, usage }; return; }
          for (const c of r.calls) {
            const name = realName(c.name);
            yield { type: 'tool_call', id: c.id, name, args: c.args };
            let ok = true, result;
            try { result = JSON.stringify(await run(name, c.args, { client, chatId: opts.chatId, via: 'guide-' + adapter.who })) ?? 'null'; }
            catch (e) { ok = false; result = String(e.message).slice(0, 2000); }
            if (stopped) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
            turn.calls.push({ id: c.id, name, args: c.args, ok, result });
            yield { type: 'tool_result', id: c.id, ok, result: result.slice(0, 20_000) };
          }
        }
        turns.length = mark;
        yield { type: 'error', error: `El modelo siguió pidiendo tools tras ${MAX_ROUNDS} rondas: lo corto aquí` };
      } catch (e) {
        turns.length = mark; // turno a medias: fuera del historial en memoria (no mandar tool_use sin su resultado)
        yield stopped || e.name === 'AbortError' ? { type: 'error', error: 'Parado por el usuario', stopped: true } : { type: 'error', error: e.message };
      } finally { running = false; ctrl = null; }
    },
    stop() { stopped = true; ctrl?.abort(); },
  };
}
