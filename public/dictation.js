// Dictado por voz en campos de texto (FT-43). Único punto que conoce al proveedor: hoy la Web Speech API del navegador;
// para cambiarlo (p. ej. grabar y enviar a /api/guide/stt) basta con reimplementar `dictationSupported` y `createDictation`
// manteniendo el contrato: createDictation({ lang, onText(texto), onState(bool), onError(mensaje) }) → { start, stop, active }.
const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const dictationSupported = () => !!Rec;

const ERRORS = {
  'not-allowed': 'Sin permiso de micrófono: permítelo en el navegador para dictar',
  'service-not-allowed': 'El navegador no permite el dictado por voz aquí',
  'audio-capture': 'No se detecta ningún micrófono',
  network: 'El dictado necesita conexión (el reconocimiento lo hace el navegador)',
  'language-not-supported': 'Idioma no soportado por el dictado del navegador',
};

export function createDictation({ lang = 'es-ES', onText, onState, onError }) {
  let rec = null;
  const set = (on) => { onState?.(on); if (!on) rec = null; };
  return {
    get active() { return !!rec; },
    start() {
      if (!Rec || rec) return;
      rec = new Rec();
      rec.lang = lang; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText?.(e.results[i][0].transcript.trim());
      };
      rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(ERRORS[e.error] || 'Error de dictado: ' + e.error); };
      rec.onend = () => set(false);
      try { rec.start(); onState?.(true); } catch (e) { set(false); onError?.('No puedo iniciar el dictado: ' + e.message); }
    },
    stop() { try { rec?.stop(); } catch { /* ya parado */ } },
  };
}

// Inserta `text` en la posición del cursor de un input/textarea (o al final si no tuvo foco), con espacio de separación.
export function insertAtCursor(el, text) {
  if (!el || !text) return;
  const v = el.value, a = el.selectionStart ?? v.length, b = el.selectionEnd ?? v.length;
  const pre = v.slice(0, a), post = v.slice(b);
  const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + text + (post && !/^\s/.test(post) ? ' ' : '');
  el.value = pre + ins + post;
  el.selectionStart = el.selectionEnd = pre.length + ins.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
