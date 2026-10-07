// FT-114 · Piezas comunes de los drivers del navegador del agente (sin dependencias ni estado global).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No importamos store.js (arrancaría efectos): misma resolución de la carpeta de datos.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataDir = () => path.join(process.env.AO_DATA_DIR || path.join(ROOT, 'data'), 'browser');
export const profileDir = () => path.join(dataDir(), 'profile');
export const capturesDir = () => path.join(dataDir(), 'captures');

export const RING = 200;                    // entradas de consola/red por pestaña
export const MAX_SHOT_WIDTH = 1280;
export const bad = (status, msg) => Object.assign(new Error(msg), { status });

// Anillo de tamaño fijo: lo más viejo se descarta.
export function ringPush(arr, item, max = RING) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// Cabeceras que nunca deben salir en el registro de red.
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-ao-token)$|token|secret|password|api[-_]?key|session/i;
export function maskHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SENSITIVE.test(k) ? '***' : String(v).slice(0, 300);
  return out;
}

// Solo http(s) y about:blank: nada de file:, data:, javascript:, chrome:…
export function checkUrl(url) {
  const u = String(url || '').trim();
  if (u === 'about:blank') return u;
  let p;
  try { p = new URL(u); } catch { throw bad(400, 'URL no válida (usa http:// o https://)'); }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') throw bad(400, `esquema no permitido: ${p.protocol}`);
  return p.href;
}

// Una línea por nodo: `[e12] button "Enviar" (disabled)`; útil para pasar el snapshot a un modelo.
export function renderSnapshot(s) {
  const lines = [`# ${s.title || '(sin título)'} — ${s.url}`];
  for (const n of s.nodes) {
    lines.push(`${n.frame ? '  ' : ''}[${n.ref}] ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = ${JSON.stringify(n.value)}` : ''}${n.states.length ? ` (${n.states.join(', ')})` : ''}`);
  }
  if (s.truncated) lines.push(`… truncado: faltan ${s.omitted} nodos (haz scroll o pide un snapshot tras actuar)`);
  return lines.join('\n');
}

export function saveShot(buf, format, tabId) {
  fs.mkdirSync(capturesDir(), { recursive: true });
  const ts = Date.now();
  const file = path.join(capturesDir(), `${ts}-${tabId}.${format === 'jpeg' ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length, format, ts };
}
