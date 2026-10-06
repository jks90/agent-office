// Proveedor del Guide Agent sobre la API de OpenAI (FT-8): Chat Completions con streaming y function calling, por `fetch`, sin SDK.
// Clave: la de Codex guardada en Ajustes ▸ Motores de IA (clave API) o OPENAI_API_KEY. URL base: OPENAI_BASE_URL (con /v1, como el SDK).
// Mismo contrato GuideProvider que claude-cli.js: ver providers/common.js.
import * as auth from '../../engines/auth.js';
import { createHttpProvider, readSse, httpError } from './common.js';

export const label = 'API de OpenAI';
export const defaultModel = 'gpt-5.5';
export const ready = () => !!auth.guideApiKey('openai');
const base = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

// Turnos neutrales → mensajes de Chat Completions (system, user, assistant con tool_calls, y un `tool` por resultado).
function toMessages(system, turns) {
  const msgs = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') { msgs.push({ role: 'user', content: t.text }); continue; }
    if (!t.text?.trim() && !t.calls.length) continue;
    msgs.push({
      role: 'assistant', content: t.text?.trim() ? t.text : null,
      ...(t.calls.length ? { tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name.replace('.', '_'), arguments: JSON.stringify(c.args) } })) } : {}),
    });
    for (const c of t.calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: c.result });
  }
  return msgs;
}

// FT-54: el mismo cliente sirve a cualquier servidor compatible con OpenAI (IA local: LM Studio/Ollama); `cfg` = { who, name, baseUrl(), key(), required }
export function create(cfg = {}) {
  const { who = 'openai-api', name = 'API de OpenAI', baseUrl = base, key: getKey = () => auth.guideApiKey('openai'), required = true } = cfg;
  return createHttpProvider({
    who,
    async stream({ system, tools, model, turns, signal, onText }) {
      const key = getKey();
      if (required && !key) throw new Error('Falta la clave API de OpenAI: pégala en Ajustes ▸ Motores de IA ▸ Codex (clave API) o define OPENAI_API_KEY');
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: model || defaultModel, stream: true, stream_options: { include_usage: true },
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
          messages: toMessages(system, turns),
        }),
      });
      if (!res.ok) throw await httpError(res, name);
      let text = '';
      const acc = new Map(); // índice de tool_call → { id, name, json }
      let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost = null;
      await readSse(res, (e) => {
        if (e.error) throw new Error(`${name}: ${e.error.message || 'error en el stream'}`);
        if (e.usage) {
          const cached = e.usage.prompt_tokens_details?.cached_tokens || 0;
          usage = { input: (e.usage.prompt_tokens || 0) - cached, output: e.usage.completion_tokens || 0, cacheRead: cached, cacheWrite: 0 };
          if (typeof e.usage.cost === 'number') cost = e.usage.cost; // algunos gateways (p. ej. OpenRouter) lo dan
        }
        const d = e.choices?.[0]?.delta;
        if (!d) return;
        if (d.content) text += d.content;
        for (const tc of d.tool_calls || []) {
          const c = acc.get(tc.index ?? 0) || acc.set(tc.index ?? 0, { id: '', name: '', json: '' }).get(tc.index ?? 0);
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.json += tc.function.arguments;
        }
      });
      if (text.trim()) onText(text);
      const calls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => {
        let args = {};
        try { args = c.json ? JSON.parse(c.json) : {}; } catch { /* argumentos truncados: la tool los rechazará por esquema */ }
        return { id: c.id || `call_${i}`, name: c.name, args };
      });
      return { calls, usage, cost };
    },
  });
}
