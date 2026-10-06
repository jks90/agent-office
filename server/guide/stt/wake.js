// Palabra de activación «oye guía» (FT-35). El audio se transcribe SIEMPRE con el STT local (`local-cmd`),
// nunca con OpenAI, aunque `settings.sttProvider` sea `openai`. Con wake=false no se guarda ni se registra el texto.
import * as store from '../../store.js';
import * as localCmd from './local-cmd.js';

export const MAX_BYTES = 200 * 1024; // clip corto: ~3 s de opus pesan muy por debajo
export const MAX_MS = 3000;
const fail = (status, msg) => Object.assign(new Error(msg), { status });

// Pliega tildes carácter a carácter (conserva la longitud, para cortar el texto original por el mismo índice).
const fold = (s) => [...s.toLowerCase()].map((c) => { const f = c.normalize('NFD')[0]; return f.length === 1 ? f : c; }).join('');
const PRE = /^[^\p{L}\p{N}]*(?:oye|oyes|oiga|oigan|hey|ey)[^\p{L}\p{N}]*guia(?![\p{L}\p{N}])[\s,.;:!?-]*/u;

// Pura. «Oye, guía, ¿cómo va?» → {wake:true, rest:'¿cómo va?'}
export function matchWake(text) {
  const t = String(text || '');
  const m = PRE.exec(fold(t));
  return m ? { wake: true, rest: t.slice(m[0].length).trim() } : { wake: false, rest: '' };
}

export const status = async () => {
  const a = await localCmd.available();
  return a.ok ? { ok: true } : { ok: false, reason: `escucha continua requiere STT local: ${a.reason}` };
};

// audio: Buffer; durationMs: opcional, lo declara el cliente.
export async function wake(audio, mime = 'audio/webm', durationMs) {
  if (!audio?.length) throw fail(400, 'Audio vacío');
  if (audio.length > MAX_BYTES || Number(durationMs) > MAX_MS) throw fail(413, `Audio demasiado largo para la palabra de activación (máx. ${MAX_BYTES / 1024} KB / ${MAX_MS / 1000} s)`);
  const a = await localCmd.available();
  if (!a.ok) throw fail(503, `Palabra de activación no disponible: STT local no disponible (${a.reason})`);
  const t0 = Date.now();
  const lang = store.get().settings.sttLang;
  const r = await localCmd.transcribe(audio, String(mime || 'audio/webm'), lang && lang !== 'auto' ? lang : 'es');
  return { ...matchWake(r.text), ms: Date.now() - t0 };
}
