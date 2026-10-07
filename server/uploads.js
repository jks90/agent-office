// FT-95 · adjuntos: guardado saneado en data/uploads/<hex>/ y validación de referencias para el chat del Guía.
// Funciones puras sobre disco; `index.js` las enruta (POST /api/upload) y `guide/index.js` valida con `resolveRefs`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25e6;
export const MAX_TOTAL_BYTES = 30e6;
const root = () => path.join(store.DATA_DIR, 'uploads');

// Nombre seguro: solo el basename, sin separadores ni puntos iniciales (nada de «..» ni ocultos).
export function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop();
  const n = base.replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return n || 'adjunto';
}

// files: [{name, data(base64 o data URL)}] → [{name, path, size}] (más el texto extraído, si `extract` lo da).
export function save(files, extract = () => null) {
  if (!Array.isArray(files) || !files.length) throw fail(400, 'Faltan los ficheros (files: [{name, data}])');
  if (files.length > MAX_FILES) throw fail(413, `Máximo ${MAX_FILES} adjuntos por envío`);
  const bufs = files.map((f) => {
    const b64 = String(f?.data || '').replace(/^data:[^;]+;base64,/, '');
    if (b64.length > MAX_FILE_BYTES * 1.4) throw fail(413, `«${safeName(f?.name)}» supera ${MAX_FILE_BYTES / 1e6} MB`);
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw fail(400, `«${safeName(f?.name)}» está vacío`);
    if (buf.length > MAX_FILE_BYTES) throw fail(413, `«${safeName(f?.name)}» supera ${MAX_FILE_BYTES / 1e6} MB`);
    return buf;
  });
  if (bufs.reduce((n, b) => n + b.length, 0) > MAX_TOTAL_BYTES) throw fail(413, `El envío supera ${MAX_TOTAL_BYTES / 1e6} MB en total`);
  const dir = path.join(root(), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set();
  return files.flatMap((f, i) => {
    let name = safeName(f.name);
    for (let k = 2; used.has(name); k++) name = `${k}-${safeName(f.name)}`.slice(0, 120);
    used.add(name);
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, bufs[i]);
    const ref = { name, path: dest, size: bufs[i].length };
    const text = extract(dest);
    return text ? [ref, text] : [ref];
  });
}

// FT-96 · limpieza: borra las carpetas de data/uploads cuya ruta no aparece en `inUse` (texto con el estado y los chats)
// y que tienen más de `maxAgeMs` (por defecto 1 día: da margen a un adjunto recién subido y aún sin enviar).
export function sweep(inUse, maxAgeMs = 24 * 3600e3) {
  let names = [];
  try { names = fs.readdirSync(root()); } catch { return 0; }
  let n = 0;
  for (const d of names) {
    const dir = path.join(root(), d);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < maxAgeMs || inUse.includes(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true }); n++;
    } catch { /* otro proceso lo tocó: se verá en la siguiente pasada */ }
  }
  return n;
}
// Carpeta de subida de una ruta de adjunto (data/uploads/<hex>) o null si no es de aquí.
export function dirOf(p) {
  const rel = path.relative(root(), String(p || ''));
  const d = rel.split(path.sep)[0];
  return rel && !rel.startsWith('..') && d && rel !== d ? path.join(root(), d) : null;
}

// Referencias que llegan en un mensaje ([{name?, path}]) → solo las que existen dentro de data/uploads.
export function resolveRefs(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw fail(400, 'attachments debe ser una lista');
  if (list.length > MAX_FILES) throw fail(413, `Máximo ${MAX_FILES} adjuntos por mensaje`);
  return list.map((a) => {
    const abs = path.resolve(String(a?.path || ''));
    if (!abs.startsWith(root() + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw fail(400, `Adjunto no válido: ${safeName(a?.name || a?.path)}`);
    return { name: path.basename(abs), path: abs, size: fs.statSync(abs).size };
  });
}
