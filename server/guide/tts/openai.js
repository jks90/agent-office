// TTS con OpenAI (FT-52): POST /v1/audio/speech (nube: el texto sale del PC; solo si se elige este proveedor). Misma clave que el STT.
import { getApiKey } from '../../engines/auth.js';

export const label = 'OpenAI (nube · /v1/audio/speech)';
const MODEL = process.env.AO_TTS_OPENAI_MODEL || 'tts-1';
const URL_ = () => (process.env.AO_OPENAI_BASE || 'https://api.openai.com') + '/v1/audio/speech';
export const DEFAULT_VOICE = 'nova';
export const voices = () => [
  { id: 'nova', label: 'Nova · mujer', lang: 'multi', gender: 'female' },
  { id: 'shimmer', label: 'Shimmer · mujer', lang: 'multi', gender: 'female' },
  { id: 'alloy', label: 'Alloy · neutra', lang: 'multi', gender: 'neutral' },
  { id: 'onyx', label: 'Onyx · hombre', lang: 'multi', gender: 'male' },
];

export async function available() {
  return getApiKey('openai') ? { ok: true, detail: MODEL } : { ok: false, reason: 'sin clave de OpenAI (OPENAI_API_KEY o la clave de Codex)' };
}

export async function synthesize(text, { voice } = {}) {
  const r = await fetch(URL_(), { method: 'POST', headers: { authorization: `Bearer ${getApiKey('openai')}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, voice: voice || DEFAULT_VOICE, input: text, response_format: 'mp3' }), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(`OpenAI TTS: ${j.error?.message || r.statusText}`), { status: 502 }); }
  return { audio: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}
