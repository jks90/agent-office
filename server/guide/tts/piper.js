// TTS local con piper (FT-52): ONNX en CPU, sin nube. `pip install piper-tts` y las voces en `data/tts/voices/` (o AO_TTS_VOICES_DIR);
// la voz elegida se descarga sola de Hugging Face (rhasspy/piper-voices) la primera vez. `AO_TTS_CMD` sustituye a piper por otro
// comando: se ejecuta con tres argumentos <fichero.wav de salida> <id de voz> <idioma> y recibe el texto por stdin.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const label = 'Local · piper (sin nube)';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HF = (process.env.AO_TTS_HF_BASE || 'https://huggingface.co/rhasspy/piper-voices/resolve/main/').replace(/\/?$/, '/');
const TIMEOUT_MS = 120_000;
export const voicesDir = () => process.env.AO_TTS_VOICES_DIR || path.join(process.env.AO_DATA_DIR || path.join(ROOT, 'data'), 'tts', 'voices');

// Catálogo: id «<modelo>[:<hablante>]». Cualquier otro modelo de rhasspy/piper-voices se añade con AO_TTS_VOICES
// («id|etiqueta|idioma|género», separados por comas; ver README), p. ej. es_ES-davefx-medium|Davefx|es|male.
const BUILTIN = [
  { id: 'es_ES-sharvard-medium:F', label: 'Sharvard · mujer (es-ES), natural — por defecto', lang: 'es', gender: 'female' },
  { id: 'es_AR-daniela-high', label: 'Daniela · mujer (es-AR, calidad alta)', lang: 'es', gender: 'female' },
  { id: 'es_ES-mls_9972-low', label: 'MLS 9972 · mujer (es-ES, ligera)', lang: 'es', gender: 'female' },
  { id: 'es_ES-davefx-medium', label: 'Davefx · hombre (es-ES)', lang: 'es', gender: 'male' },
];
const extra = () => String(process.env.AO_TTS_VOICES || '').split(',').map((s) => s.trim().split('|')).filter((p) => p[0]).map(([id, lbl, lang, gender]) => ({ id, label: lbl || id, lang: lang || 'es', gender: gender || 'female' }));
export const DEFAULT_VOICE = BUILTIN[0].id;
export const voices = () => [...BUILTIN, ...extra()];

function split(s) { return [...String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]); }
function run(cmd, args, { input, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('El comando TTS tardó demasiado')); }, timeout);
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.resume();
    p.stdin.on('error', () => {}); // el comando pudo morir antes de leer el texto
    p.on('error', (e) => { clearTimeout(to); reject(new Error(e.code === 'ENOENT' ? `No encuentro «${cmd}»` : e.message)); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || `salió con código ${code}`).slice(0, 300))); });
    p.stdin.end(input ?? '');
  });
}

export async function available() {
  if (process.env.AO_TTS_CMD) return { ok: true, detail: process.env.AO_TTS_CMD };
  try { await run('python3', ['-c', 'import piper'], { timeout: 15_000 }); return { ok: true, detail: 'piper-tts' }; }
  catch { return { ok: false, reason: 'falta piper (`pip install piper-tts`) o define AO_TTS_CMD' }; }
}

// Descarga bajo demanda (.onnx + .onnx.json): ruta es/es_ES/<nombre>/<calidad>/<modelo>; sin red → mensaje claro.
const pending = new Map();
async function ensureModel(model) {
  const dir = voicesDir();
  const onnx = path.join(dir, model + '.onnx');
  if (fs.existsSync(onnx) && fs.existsSync(onnx + '.json')) return onnx;
  if (pending.has(model)) return pending.get(model);
  const m = model.match(/^([a-z]{2})_([A-Z]{2})-(\w+)-(\w+)$/);
  if (!m) throw Object.assign(new Error(`Voz «${model}» no encontrada en ${dir}`), { status: 503 });
  const rel = `${m[1]}/${m[1]}_${m[2]}/${m[3]}/${m[4]}/${model}`;
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const ext of ['.onnx.json', '.onnx']) { // el .json primero: pesa poco y falla rápido si no hay red
      const dest = path.join(dir, model + ext), tmp = dest + '.part';
      let r;
      try { r = await fetch(HF + rel + ext, { redirect: 'follow', signal: AbortSignal.timeout(600_000) }); }
      catch { throw Object.assign(new Error(`La voz «${model}» no está en ${dir} y no hay red para descargarla de Hugging Face. Cópiala allí (${model}.onnx y .onnx.json) o conéctate una vez.`), { status: 503 }); }
      if (!r.ok) throw Object.assign(new Error(`No se pudo descargar «${model}» (${r.status})`), { status: 503 });
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      fs.renameSync(tmp, dest);
    }
    return onnx;
  })().finally(() => pending.delete(model));
  pending.set(model, job);
  return job;
}

// Letra de hablante («F») → número según `speaker_id_map` del .onnx.json del modelo.
function speakerId(onnx, name) {
  if (/^\d+$/.test(name)) return Number(name);
  try { const j = JSON.parse(fs.readFileSync(onnx + '.json', 'utf8')); if (j.speaker_id_map?.[name] != null) return j.speaker_id_map[name]; } catch { /* sin json */ }
  return 0;
}

export async function synthesize(text, { voice, lang } = {}) {
  const id = voice || DEFAULT_VOICE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tts-'));
  const out = path.join(dir, 'out.wav');
  try {
    if (process.env.AO_TTS_CMD) {
      const [cmd, ...pre] = split(process.env.AO_TTS_CMD);
      await run(cmd, [...pre, out, id, lang || 'es'], { input: text });
    } else {
      const [model, speaker] = id.split(':');
      const onnx = await ensureModel(model);
      await run('python3', ['-m', 'piper', '-m', onnx, '-f', out, ...(speaker ? ['-s', String(speakerId(onnx, speaker))] : [])], { input: text });
    }
    return { audio: fs.readFileSync(out), mime: 'audio/wav' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
