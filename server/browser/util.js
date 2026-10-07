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

// FT-132 · Modo lectura: expresión JS (se evalúa en la página) que devuelve el texto legible por bloques
// —encabezados `## `, listas `- `, filas `a | b`— sin menús, pies ni scripts. Sin bloques cae a innerText.
export function readPageExpr(selector) {
  return `((sel) => {
    const root = (sel && document.querySelector(sel)) || document.querySelector('article, main, [role=main]') || document.body;
    if (!root) return '';
    const SKIP = 'script,style,noscript,nav,footer,aside,svg,template,[aria-hidden=true],[hidden]';
    const out = [], seen = new Set();
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,dt,dd,figcaption,summary')) {
      if (el.closest(SKIP) || (el.checkVisibility && !el.checkVisibility())) continue;
      let a = el.parentElement, dup = false;
      while (a && a !== root) { if (seen.has(a)) { dup = true; break; } a = a.parentElement; }
      if (dup) continue;
      const tag = el.tagName;
      let t = tag === 'TR' ? [...el.children].map((c) => norm(c.innerText)).filter(Boolean).join(' | ') : tag === 'PRE' ? String(el.innerText || '').trim() : norm(el.innerText);
      if (!t) continue;
      seen.add(el);
      if (/^H[1-6]$/.test(tag)) t = '#'.repeat(Number(tag[1])) + ' ' + t;
      else if (tag === 'LI') t = '- ' + t;
      out.push(t);
    }
    return out.length ? out.join('\\n') : norm(root.innerText).replace(/(.{200}[.!?]) /g, '$1\\n');
  })(${JSON.stringify(selector || null)})`;
}
// Pagina el texto de readPageExpr: offset/max en caracteres; «section» salta al encabezado que la contenga.
export function paginateRead(raw, { offset = 0, max = 6000, section } = {}) {
  const text = String(raw || '');
  const sections = [];
  let pos = 0;
  for (const line of text.split('\n')) { if (/^#{1,6} /.test(line)) sections.push({ at: pos, title: line.replace(/^#+ /, '').slice(0, 80) }); pos += line.length + 1; }
  let from = Math.max(0, Number(offset) || 0);
  if (section) {
    const q = String(section).toLowerCase();
    const s = sections.find((x) => x.title.toLowerCase().includes(q));
    if (!s) throw bad(404, `no hay ninguna sección con «${section}»`);
    from = s.at;
  }
  const size = Math.min(20000, Math.max(500, Number(max) || 6000));
  let to = Math.min(text.length, from + size);
  if (to < text.length) { const nl = text.lastIndexOf('\n', to); if (nl > from + size / 2) to = nl; } // corta en fin de línea
  return { text: text.slice(from, to), offset: from, end: to, total: text.length, next: to < text.length ? to : null, ...(to < text.length ? { truncated: true, hint: `Texto recortado: quedan ${text.length - to} caracteres; vuelve a llamar con offset=${to}` } : {}), sections: sections.slice(0, 40) };
}

export function saveShot(buf, format, tabId) {
  fs.mkdirSync(capturesDir(), { recursive: true });
  const ts = Date.now();
  const file = path.join(capturesDir(), `${ts}-${tabId}.${format === 'jpeg' ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length, format, ts };
}
