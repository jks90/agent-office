// Dictado por voz en campos de texto (FT-43). Único punto que conoce a los proveedores; contrato:
//   createDictation({ lang, onText(texto), onState(bool), onError(mensaje), server? }) → { start, stop, active }
// Dos proveedores:
//   · servidor (preferido): graba con el MISMO VAD del push-to-talk (`record` = voiceRecord de app.js) y transcribe con
//     POST /api/guide/stt (`transcribe`), es decir, el STT LOCAL de tu instalación (faster-whisper): el audio no sale de tu PC.
//     Se usa cuando `server` viene informado (app.js lo pasa si GET /api/guide/stt dice que el proveedor está disponible).
//   · navegador (respaldo): Web Speech API. En Chrome el audio va al servicio de Google; Brave lo bloquea (la API existe pero
//     falla con «network»). Preferencia del navegador `ao:dictation` = 'browser' para forzarlo (p. ej. sin STT local).
const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const browserDictationSupported = () => !!Rec;
// ¿Se puede dictar? Con STT del servidor basta con poder grabar; si no, hace falta la Web Speech API.
export const dictationSupported = ({ server = false } = {}) => (server && canRecord()) || !!Rec;
const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

const ERRORS = {
  'not-allowed': 'Sin permiso de micrófono: permítelo en el navegador para dictar',
  'service-not-allowed': 'El navegador no permite el dictado por voz aquí',
  'audio-capture': 'No se detecta ningún micrófono',
  network: 'El dictado del navegador necesita conexión (el reconocimiento lo hace Google; en Brave no funciona — usa el STT local del servidor)',
  'language-not-supported': 'Idioma no soportado por el dictado del navegador',
};

function createBrowserDictation({ lang = 'es-ES', onText, onState, onError }) {
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

// Servidor: micro abierto mientras dura el dictado; cada frase (el VAD corta por silencio, tope `maxMs`) se transcribe y se inserta.
function createServerDictation({ record, transcribe, maxMs = 12000, onText, onState, onError }) {
  let stream = null, cur = null, stopping = false;
  return {
    get active() { return !!stream; },
    async start() {
      if (stream || !canRecord()) return;
      let mine;
      try { mine = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { onError?.(/Permission|NotAllowed/i.test(e.name + e.message) ? ERRORS['not-allowed'] : 'No puedo usar el micrófono: ' + e.message); return; }
      stream = mine; stopping = false;
      onState?.(true);
      while (stream === mine && !stopping) {
        let r;
        try { cur = await record({ stream: mine, gate: true, maxMs }); r = await cur.result; } catch (e) { onError?.('Error al grabar: ' + e.message); break; }
        cur = null;
        if (stopping || stream !== mine || !r.spoke) continue; // sin voz en el segmento: se sigue escuchando
        try { const j = await transcribe(r); if (j?.text) onText?.(String(j.text).trim()); }
        catch { break; } // `api()` ya avisa del error (p. ej. 503 sin STT): se para el dictado
      }
      mine.getTracks().forEach((t) => t.stop());
      if (stream === mine) stream = null;
      cur = null;
      onState?.(false);
    },
    stop() { stopping = true; cur?.stop(); },
  };
}

export function createDictation({ server = null, ...opts }) {
  return server && canRecord() ? createServerDictation({ ...opts, ...server }) : createBrowserDictation(opts);
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
