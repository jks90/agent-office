// Voz del Guide Agent (FT-9): transcripción intercambiable. Interfaz SttProvider:
//   { name, label, available() → {ok, reason?}, transcribe(buffer, mime, lang) → {text, lang, ms} }
// El audio entra por POST /api/guide/stt y el texto vuelve al cliente, que lo manda al MISMO POST /api/guide/chat que el teclado.
import * as store from '../../store.js';
import * as localCmd from './local-cmd.js';
import * as openai from './openai.js';

const PROVIDERS = { 'local-cmd': localCmd, openai };
export const MAX_BYTES = 12e6; // 30 s de opus pesan <0,5 MB; margen para wav
const fail = (status, msg) => Object.assign(new Error(msg), { status });

export const providerNames = () => Object.keys(PROVIDERS);
export const current = () => { const n = store.get().settings.sttProvider; return PROVIDERS[n] ? n : 'local-cmd'; };

// Estado para Ajustes: proveedores, cuál está elegido y si funciona.
export async function status() {
  const out = [];
  for (const [name, p] of Object.entries(PROVIDERS)) out.push({ name, label: p.label, ...(await p.available()) });
  return { provider: current(), lang: store.get().settings.sttLang || 'es', providers: out };
}

// audio: Buffer. Devuelve {text, lang, ms, provider}.
export async function transcribe(audio, mime = 'audio/webm', lang) {
  if (!audio?.length) throw fail(400, 'Audio vacío');
  if (audio.length > MAX_BYTES) throw fail(413, 'Audio demasiado largo');
  const name = current();
  const a = await PROVIDERS[name].available();
  if (!a.ok) throw fail(503, `STT «${name}» no disponible: ${a.reason}`);
  const t0 = Date.now();
  const r = await PROVIDERS[name].transcribe(audio, String(mime || 'audio/webm'), String(lang || store.get().settings.sttLang || 'es'));
  return { text: String(r.text || '').trim(), lang: r.lang || lang || null, ms: r.ms ?? Date.now() - t0, provider: name };
}
