// FT-117 · Panel «🌐 Navegador»: vista en vivo del driver (screencast) y control compartido agente ↔ usuario.
//   · estado público (control, pestañas, url, peticiones de handoff) → status() va en el snapshot SSE (`browser`)
//   · fotogramas JPEG (≤10 fps) y marcas del elemento sobre el que actúa el agente → SSE propio /api/browser/stream
//   · el usuario toma el control: el agente queda en pausa (agentDriver() lanza 409) y sus clics/teclas se reenvían al driver
//   · agentDriver() es el driver que deben usar las tools browser.* (A2): respeta la pausa y emite la marca (rectángulo 1 s)
import { getDriver } from './index.js';
import * as store from '../store.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const MARK_MS = 1000;
const subs = new Set(); // respuestas SSE abiertas
let control = 'agent'; // 'agent' | 'user'
let stopCast = null, casting = null;
let cache = { open: false, tabs: [], url: '', title: '', tabId: null };
let handoffs = []; // peticiones de handoff de A3 ({id, reason, at}); hueco hasta que A3 exista
let lastKey = '';

const send = (type, data) => { const m = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const r of subs) if (!r.writableEnded) r.write(m); };

// Estado para el snapshot (síncrono: usa la caché que refresh() mantiene al día).
export function status() {
  const d = getDriver();
  let av = { ok: false, missing: [] };
  try { av = d.available(); } catch { /* sin driver */ }
  return { driver: d.id || 'cdp', available: !!av.ok, missing: av.missing || [], open: cache.open, control, tabs: cache.tabs, url: cache.url, title: cache.title, tabId: cache.tabId, handoffs };
}

// FT-119: tras una acción el estado se lee ya y otra vez tras la navegación que haya provocado (un POST de formulario tarda en cambiar la URL)
const refreshSoon = () => { refresh().catch(() => {}); for (const ms of [300, 1200]) setTimeout(() => refresh().catch(() => {}), ms).unref?.(); };

export async function refresh() {
  const d = getDriver();
  if (!d.isOpen()) cache = { open: false, tabs: [], url: '', title: '', tabId: null };
  else {
    const tabs = await d.tabs.list().catch(() => []);
    const a = tabs.find((t) => t.active) || tabs[0];
    cache = { open: true, tabs, url: a?.url || '', title: a?.title || '', tabId: a?.id || null };
  }
  const key = JSON.stringify([cache, control, handoffs]);
  if (key !== lastKey) { lastKey = key; store.changed(); } // → evento `state` con `browser`
  return status();
}

// El screencast corre mientras haya alguien mirando y el navegador esté abierto.
async function ensureCast() {
  if (stopCast || casting || !subs.size || !getDriver().isOpen()) return;
  casting = getDriver().screencast((f) => {
    send('frame', f);
    if (f.tabId !== cache.tabId || f.url !== cache.url) refresh().catch(() => {}); // pestaña o URL cambiaron (popup, navegación)
  }).then((stop) => { stopCast = stop; }).catch(() => {}).finally(() => { casting = null; if (!subs.size) endCast(); });
}
function endCast() { if (stopCast) { stopCast(); stopCast = null; } }

export function subscribe(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  subs.add(res);
  res.write(`event: hello\ndata: ${JSON.stringify(status())}\n\n`);
  ensureCast();
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); subs.delete(res); if (!subs.size) endCast(); });
}

export const mark = (box) => { if (box) send('mark', { ...box, ms: MARK_MS, at: Date.now() }); };

// ── Control ────────────────────────────────────────────────────────────────
export async function setControl(mode) {
  if (!['agent', 'user'].includes(mode)) throw fail(400, 'mode debe ser agent o user');
  control = mode;
  send('control', { control });
  return refresh();
}
const needUser = () => { if (control !== 'user') throw fail(409, 'Toma el control del navegador para manejarlo tú'); };

// Driver para el agente: en pausa mientras el usuario controla; marca el elemento antes de actuar.
const ACTIONS = ['act', 'type', 'scroll'];
const MUTATING = ['navigate', 'back', 'forward', 'reload', 'evaluate', 'waitFor'];
export function agentDriver() {
  const d = getDriver();
  const paused = () => { if (control === 'user') throw fail(409, 'El usuario tiene el control del navegador: espera a que lo devuelva'); };
  return new Proxy(d, {
    get(t, k) {
      if (k === 'tabs') return new Proxy(t.tabs, { get: (tt, kk) => (kk === 'list' ? tt.list : async (...a) => { paused(); const r = await tt[kk](...a); refreshSoon(); return r; }) });
      if (ACTIONS.includes(k)) return async (a = {}) => { paused(); if (a.ref || a.x != null) mark(await t.box?.(a).catch(() => null)); const r = await t[k](a); refreshSoon(); return r; };
      if (MUTATING.includes(k)) return async (...a) => { paused(); const r = await t[k](...a); refreshSoon(); return r; };
      return t[k]?.bind ? t[k].bind(t) : t[k];
    },
  });
}

// ── Handoff (A3): hueco ───────────────────────────────────────────────────
export function addHandoff(h) { handoffs = [...handoffs, { id: `h${Date.now().toString(36)}`, at: Date.now(), ...h }]; return refresh(); }
export function resolveHandoff(id) { handoffs = handoffs.filter((h) => h.id !== id); return refresh(); }

// ── Acciones del usuario (HTTP) ────────────────────────────────────────────
export async function open() {
  const r = await getDriver().launch();
  await refresh();
  ensureCast();
  return { ...r, ...status() };
}
export async function close() { endCast(); await getDriver().close(); control = 'agent'; return refresh(); }

export async function nav({ op, url }) {
  needUser();
  const d = getDriver();
  if (op === 'go') await d.navigate({ url });
  else if (['back', 'forward', 'reload'].includes(op)) await d[op]();
  else throw fail(400, 'op debe ser go, back, forward o reload');
  return refresh();
}
export async function tab({ op, id, url }) {
  needUser();
  const d = getDriver();
  if (op === 'select') await d.tabs.select({ id });
  else if (op === 'new') await d.tabs.new({ url: url || undefined });
  else if (op === 'close') await d.tabs.close({ id });
  else throw fail(400, 'op debe ser select, new o close');
  return refresh();
}

// Entrada del usuario sobre el fotograma: coordenadas ya en px CSS del viewport (la UI las escala con w/h del fotograma).
export async function input(b = {}) {
  needUser();
  const d = getDriver();
  const n = (v) => { const x = Number(v); if (!Number.isFinite(x)) throw fail(400, 'coordenada inválida'); return x; };
  if (b.type === 'click' || b.type === 'dblclick') await d.act({ x: n(b.x), y: n(b.y), action: b.type });
  else if (b.type === 'move') await d.act({ x: n(b.x), y: n(b.y), action: 'hover' });
  else if (b.type === 'wheel') await d.scroll({ x: n(b.x), y: n(b.y), dx: n(b.dx || 0), dy: n(b.dy || 0) });
  else if (b.type === 'text' && typeof b.text === 'string') await d.type({ text: b.text.slice(0, 500) });
  else if (b.type === 'key' && typeof b.key === 'string') await d.type({ key: b.key.slice(0, 40) });
  else throw fail(400, 'type debe ser click, dblclick, move, wheel, text o key');
  return { ok: true };
}
