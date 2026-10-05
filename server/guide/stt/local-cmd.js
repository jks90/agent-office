// STT local (FT-9): ejecuta un comando por fichero de audio. `AO_STT_CMD` es el comando (con comillas si hay espacios);
// se le añaden dos argumentos: <fichero de audio> <idioma>. Imprime el texto por stdout (o JSON {"text","lang"}).
// Por defecto: `python3 bin/stt-whisper.py` (faster-whisper; `pip install faster-whisper`).
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

export async function available() {
  if (process.env.AO_STT_CMD) return { ok: true, detail: process.env.AO_STT_CMD };
  try { await run('python3', ['-c', 'import faster_whisper'], { timeout: 15_000 }); return { ok: true, detail: 'faster-whisper' }; }
  catch { return { ok: false, reason: 'falta faster-whisper (`pip install faster-whisper`) o define AO_STT_CMD' }; }
}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };

export async function transcribe(buffer, mime, lang) {
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stt-'));
  const file = path.join(dir, 'audio.' + (EXT[String(mime).split(';')[0]] || 'webm'));
  try {
    fs.writeFileSync(file, buffer);
    const [cmd, ...pre] = argv();
    const out = (await run(cmd, [...pre, file, lang])).trim();
    try { const j = JSON.parse(out); if (j && typeof j.text === 'string') return { text: j.text, lang: j.lang || lang, ms: Date.now() - t0 }; } catch { /* texto plano */ }
    return { text: out, lang, ms: Date.now() - t0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
