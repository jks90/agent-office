// STT con OpenAI (FT-9): POST /v1/audio/transcriptions. La clave sale de engines/auth (`.ai-keys.json` → `openai`),
// de OPENAI_API_KEY o de la que Codex tiene guardada en ~/.codex/auth.json (si entró con clave API).
import { getApiKey } from '../../engines/auth.js';

export const label = 'OpenAI (nube · /v1/audio/transcriptions)';
const MODEL = process.env.AO_STT_OPENAI_MODEL || 'whisper-1';
const URL_ = (process.env.AO_OPENAI_BASE || 'https://api.openai.com') + '/v1/audio/transcriptions';

export async function available() {
  return getApiKey('openai') ? { ok: true, detail: MODEL } : { ok: false, reason: 'sin clave de OpenAI (OPENAI_API_KEY o la clave de Codex)' };
}

export async function transcribe(buffer, mime, lang) {
  const key = getApiKey('openai');
  const t0 = Date.now();
  const type = String(mime).split(';')[0];
  const form = new FormData();
  form.set('model', MODEL);
  if (lang && lang !== 'auto') form.set('language', String(lang).slice(0, 2));
  form.set('response_format', 'json');
  form.set('file', new Blob([buffer], { type }), 'audio.' + (/ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm'));
  const r = await fetch(URL_, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`OpenAI STT: ${j.error?.message || r.statusText}`), { status: 502 });
  return { text: j.text || '', lang, ms: Date.now() - t0 };
}
