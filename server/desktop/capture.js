// FT-21 · Guardado de capturas: data/desktop/captures/<ts>.png, FIFO de 20 y ancho máx. 1920 px.
// Nunca captura por sí solo: solo guarda lo que le pasa un provider cuando alguien llama a capture().
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_CAPTURES = 20;
export const MAX_WIDTH = 1920;
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
// Se lee en cada llamada para respetar AO_DATA_DIR (igual que store.js)
export const capturesDir = () => join(process.env.AO_DATA_DIR || join(ROOT, 'data'), 'desktop', 'captures');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// Ancho/alto desde la cabecera IHDR del PNG
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 4).equals(SIG)) {
    throw Object.assign(new Error('la herramienta de captura no devolvió un PNG válido'), { status: 503 });
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let seq = 0;
export function saveCapture(data, tool) {
  const { width } = pngSize(data);
  const dir = capturesDir();
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  // Sufijo para que dos capturas en el mismo ms no se pisen (y el orden alfabético siga el cronológico)
  const file = join(dir, `${ts}-${String(seq++ % 1000).padStart(3, '0')}.png`);
  writeFileSync(file, data);
  if (width > MAX_WIDTH && spawnSync('which', ['convert'], { stdio: 'ignore' }).status === 0) {
    try { execFileSync('convert', [file, '-resize', `${MAX_WIDTH}x>`, file], { timeout: 10000 }); } catch { /* se queda el original */ }
  }
  const { width: w, height: h } = pngSize(readFileSync(file));
  // FIFO: se borran las más antiguas
  const all = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_CAPTURES))) rmSync(join(dir, f), { force: true });
  return { path: file, width: w, height: h, bytes: statSync(file).size, tool, ts };
}
