// STT local (FT-9): ejecuta un comando por fichero de audio. `AO_STT_CMD` es el comando (con comillas si hay espacios);
// se le añaden dos argumentos: <fichero de audio> <idioma>. Imprime el texto por stdout (o JSON {"text","lang"}).
// Por defecto: `python3 bin/stt-whisper.py --serve`, un proceso PERSISTENTE que carga el modelo una vez (medium; GPU si
// arranca) y transcribe con vocabulario (initial_prompt). Si ese proceso no arranca, se vuelve al comando de una vez.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const label = 'Local (comando · faster-whisper)';
const DEFAULT = ['python3', path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/stt-whisper.py')];
const TIMEOUT_MS = 120_000;

// «cmd "a b" c» → ['cmd','a b','c']
function split(s) { return [...String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]); }
const argv = () => (process.env.AO_STT_CMD ? split(process.env.AO_STT_CMD) : DEFAULT);

function run(cmd, args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('El comando STT tardó demasiado')); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(to); reject(new Error(e.code === 'ENOENT' ? `No encuentro «${cmd}»` : e.message)); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').pop() || `salió con código ${code}`).slice(0, 300))); });
  });
}

// ── Proceso persistente (sin AO_STT_CMD) ──────────────────────────────────
let worker = null; // { proc, ready: Promise<{model,device}>, pending: Map(id → {resolve,reject,timer}), info }
let seq = 0;
function startWorker() {
  const [cmd, script] = DEFAULT;
  const proc = spawn(cmd, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, pending: new Map(), info: null, err: '' };
  let buf = '';
  w.ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('El modelo de voz tardó demasiado en cargar')), 180_000); // la 1.ª vez puede descargarlo
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.ready) { clearTimeout(to); w.info = { model: j.model, device: j.device }; resolve(w.info); continue; }
        const p = w.pending.get(j.id);
        if (!p) continue;
        w.pending.delete(j.id); clearTimeout(p.timer);
        j.error ? p.reject(new Error(j.error)) : p.resolve(j);
      }
    });
    proc.stderr.on('data', (d) => { w.err = (w.err + d).slice(-2000); });
    proc.on('error', (e) => { clearTimeout(to); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(to);
      reject(new Error((w.err.trim().split('\n').pop() || `el proceso de voz salió con código ${code}`).slice(0, 300)));
      for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new Error('El proceso de voz se cerró')); }
      w.pending.clear();
      if (worker === w) worker = null; // la siguiente petición lo relanza
    });
  });
  w.ready.catch(() => { if (worker === w) worker = null; });
  return w;
}
async function viaWorker(file, lang, prompt) {
  worker ||= startWorker();
  const w = worker;
  await w.ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.pending.delete(id); reject(new Error('El comando STT tardó demasiado')); }, TIMEOUT_MS);
    w.pending.set(id, { resolve, reject, timer });
    w.proc.stdin.write(JSON.stringify({ id, file, lang, prompt: prompt || null }) + '\n');
  });
}
export const workerInfo = () => worker?.info || null;
// Cargar el modelo al arrancar AgentOffice: el primer dictado no espera la carga (GPU ≈ 8 s, CPU más).
export function warm() { if (process.env.AO_STT_CMD || worker) return; worker = startWorker(); worker.ready.then((i) => console.log(`🎤 voz lista: faster-whisper ${i.model} en ${i.device === 'cuda' ? 'GPU' : 'CPU'}`), () => {}); }

export async function available() {
  if (process.env.AO_STT_CMD) return { ok: true, detail: process.env.AO_STT_CMD };
  try { await run('python3', ['-c', 'import faster_whisper'], { timeout: 15_000 }); const i = workerInfo(); return { ok: true, detail: i ? `faster-whisper · ${i.model} · ${i.device === 'cuda' ? 'GPU' : 'CPU'}` : 'faster-whisper' }; }
  catch { return { ok: false, reason: 'falta faster-whisper (`pip install faster-whisper`) o define AO_STT_CMD' }; }
}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };

export async function transcribe(buffer, mime, lang, { prompt = '' } = {}) {
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stt-'));
  const file = path.join(dir, 'audio.' + (EXT[String(mime).split(';')[0]] || 'webm'));
  try {
    fs.writeFileSync(file, buffer);
    if (!process.env.AO_STT_CMD) { // persistente; si no arranca, el comando de una vez de siempre
      try { const j = await viaWorker(file, lang, prompt); return { text: j.text || '', lang: j.lang || lang, ms: Date.now() - t0 }; }
      catch (e) { if (/tardó demasiado|se cerró/.test(e.message) && worker) throw e; /* si no, se intenta el modo de una vez */ }
    }
    const [cmd, ...pre] = argv();
    const out = (await run(cmd, [...pre, file, lang, ...(prompt && !process.env.AO_STT_CMD ? [prompt] : [])])).trim();
    try { const j = JSON.parse(out); if (j && typeof j.text === 'string') return { text: j.text, lang: j.lang || lang, ms: Date.now() - t0 }; } catch { /* texto plano */ }
    return { text: out, lang, ms: Date.now() - t0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
