// Voz del Guide Agent, salida (FT-52): síntesis intercambiable, espejo de ../stt. Interfaz TtsProvider:
//   { label, available() → {ok, reason?}, voices() → [{id,label,lang,gender}], synthesize(text, {voice, lang}) → {audio: Buffer, mime} }
// POST /api/guide/tts {text, voice?} → audio; el texto solo sale del PC si el proveedor elegido es `openai`.
import crypto from 'node:crypto';
import * as store from '../../store.js';
import * as piper from './piper.js';
import * as openai from './openai.js';
import * as browser from './browser.js';

const PROVIDERS = { piper, openai, browser };
export const MAX_CHARS = 4000;
const CACHE_MAX = 50;
const cache = new Map(); // hash(proveedor+voz+texto) → {audio, mime}; los últimos 50
const fail = (status, msg) => Object.assign(new Error(msg), { status });

export const providerNames = () => Object.keys(PROVIDERS);
export const current = () => { const n = store.get().settings.ttsProvider; return PROVIDERS[n] ? n : 'piper'; };
// La voz guardada solo vale si pertenece al proveedor actual; si no, la suya por defecto.
export const currentVoice = (name = current()) => { const v = store.get().settings.ttsVoice; return PROVIDERS[name].voices().some((x) => x.id === v) ? v : PROVIDERS[name].DEFAULT_VOICE; };

// `provider` opcional: devuelve las voces de ese proveedor en vez de las del actual (selector de Ajustes antes de guardar); `provider` de la respuesta es siempre el elegido en Ajustes.
export async function status(provider) {
  const name = PROVIDERS[provider] ? provider : current();
  const providers = [];
  for (const [n, p] of Object.entries(PROVIDERS)) providers.push({ name: n, label: p.label, client: !!p.client, ...(await p.available()) });
  return { provider: current(), voice: currentVoice(name), providers, voices: PROVIDERS[name].voices() };
}

// Devuelve {audio, mime}. `voice` y `provider` opcionales (la prueba de Ajustes usa lo del formulario sin guardar).
export async function synthesize(text, voice, provider) {
  text = String(text ?? '').trim();
  if (!text) throw fail(400, 'Falta el texto');
  if (text.length > MAX_CHARS) throw fail(413, `Texto demasiado largo (máx. ${MAX_CHARS} caracteres)`);
  const name = PROVIDERS[provider] ? provider : current(), p = PROVIDERS[name];
  const a = await p.available();
  if (!a.ok) throw fail(503, `TTS «${name}» no disponible: ${a.reason}`);
  const v = p.voices().some((x) => x.id === voice) ? voice : currentVoice(name);
  const key = crypto.createHash('sha1').update([name, v, text].join('\0')).digest('hex');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; } // LRU
  const lang = store.get().settings.sttLang;
  const out = await p.synthesize(text, { voice: v, lang: !lang || lang === 'auto' ? 'es' : lang });
  cache.set(key, out);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}
