// Proveedor del Guide Agent sobre la API de Anthropic (FT-8): Messages API por `fetch`, streaming SSE y tools nativas con los
// esquemas del registro de FT-4. Sin SDK. `cache_control` en el system (cachea también las tools, que van antes en el prefijo).
// Clave: la de Ajustes ▸ Motores de IA (Claude, tipo clave API) o ANTHROPIC_API_KEY. URL base: ANTHROPIC_BASE_URL (mocks, proxies).
// Mismo contrato GuideProvider que claude-cli.js: ver providers/common.js.
import * as auth from '../../engines/auth.js';
import { createHttpProvider, readSse, httpError } from './common.js';

export const label = 'API de Anthropic';
export const defaultModel = 'claude-sonnet-5-5';
export const ready = () => !!auth.guideApiKey('anthropic');
const base = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');

// Turnos neutrales → mensajes de la Messages API. Los resultados de las tools van en un mensaje `user` (que absorbe el siguiente texto).
function toMessages(turns) {
  const msgs = [];
  const push = (role, content) => { const l = msgs[msgs.length - 1]; if (l?.role === role) l.content.push(...content); else msgs.push({ role, content }); };
  for (const t of turns) {
    if (t.role === 'user') { push('user', [{ type: 'text', text: t.text }]); continue; }
    const content = [...(t.text?.trim() ? [{ type: 'text', text: t.text }] : []), ...t.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name.replace('.', '_'), input: c.args }))];
    if (!content.length) continue;
    push('assistant', content);
    if (t.calls.length) push('user', t.calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.result, ...(c.ok ? {} : { is_error: true }) })));
  }
  return msgs;
}

export function create() {
  return createHttpProvider({
    who: 'anthropic-api',
    async stream({ system, tools, model, turns, signal, onText }) {
      const key = auth.guideApiKey('anthropic');
      if (!key) throw new Error('Falta la clave API de Anthropic: pégala en Ajustes ▸ Motores de IA ▸ Claude (clave API) o define ANTHROPIC_API_KEY');
      const res = await fetch(`${base()}/v1/messages`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: model || defaultModel, max_tokens: 8192, stream: true,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
          messages: toMessages(turns),
        }),
      });
      if (!res.ok) throw await httpError(res, 'API de Anthropic');
      const blocks = new Map(); // índice → { type, id, name, text|json }
      const calls = [];
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const addUsage = (u = {}) => {
        if (u.input_tokens != null) usage.input = u.input_tokens;
        if (u.output_tokens != null) usage.output = u.output_tokens;
        if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
      };
      await readSse(res, (e) => {
        if (e.type === 'message_start') addUsage(e.message?.usage);
        else if (e.type === 'message_delta') addUsage(e.usage);
        else if (e.type === 'content_block_start') blocks.set(e.index, { ...e.content_block, text: e.content_block.text || '', json: '' });
        else if (e.type === 'content_block_delta') {
          const b = blocks.get(e.index);
          if (!b) return;
          if (e.delta.type === 'text_delta') b.text += e.delta.text;
          else if (e.delta.type === 'input_json_delta') b.json += e.delta.partial_json;
        } else if (e.type === 'content_block_stop') {
          const b = blocks.get(e.index);
          if (b?.type === 'text' && b.text) onText(b.text);
          else if (b?.type === 'tool_use') {
            let args = {};
            try { args = b.json ? JSON.parse(b.json) : b.input || {}; } catch { /* argumentos truncados: la tool los rechazará por esquema */ }
            calls.push({ id: b.id, name: b.name, args });
          }
        } else if (e.type === 'error') throw new Error(`API de Anthropic: ${e.error?.message || 'error en el stream'}`);
      });
      return { calls, usage, cost: null }; // la API no devuelve el coste: solo tokens
    },
  });
}
