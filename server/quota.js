// FT-45 · Cuota restante de las suscripciones (Claude y Codex): ventana de 5 h, semanal y por modelo, como el /usage de
// Claude Code. Lee el login que ya hay en el PC (nunca guarda ni loguea tokens) y consulta el endpoint de uso de cada
// proveedor. Forma común: {engine, ok, plan, windows:[{id, label, percent, resetsAt, severity}], limitReached, reason?, fetchedAt}.
// Caché de 60 s por motor; los fallos también se cachean (no se martillea al proveedor). Lo consume el snapshot SSE (`quota`),
// `GET /api/quota` y el guardarraíl del planificador (`gate`).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const TTL = Number(process.env.AO_QUOTA_TTL) || 60_000; // AO_QUOTA_TTL solo para las pruebas
const TIMEOUT = 8_000;
export const GUARD_PERCENT = 97; // ventana de sesión a partir de la cual no se arrancan tareas nuevas
const CLAUDE_URL = () => process.env.AO_CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage';
const CODEX_URL = () => process.env.AO_CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/codex/usage';
const claudeFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
const codexFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

const SEV = ['normal', 'warning', 'critical'];
const sevOf = (percent, given) => {
  const byPct = percent >= 95 ? 2 : percent >= 80 ? 1 : 0;
  return SEV[Math.max(byPct, SEV.indexOf(given))]; // indexOf = -1 si el proveedor no la da o es otra
};
const win = (id, label, percent, resetsAt, severity) => {
  const p = Math.max(0, Math.round(Number(percent)));
  return { id, label, percent: p, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, severity: sevOf(p, severity) };
};
const ms = (iso) => { const t = typeof iso === 'number' ? iso : Date.parse(iso); return Number.isFinite(t) ? t : null; };
const bad = (engine, reason, plan = null, e = null) => ({ engine, ok: false, plan, windows: [], limitReached: false, reason, fetchedAt: Date.now(), ...(e?.status ? { status: e.status, retryAfter: e.retryAfter || 0 } : {}) });
// Instancia de pruebas (AO_DATA_DIR propio, p. ej. la que levanta un agente o un e2e): NO consulta la cuota real con el login
// del usuario salvo que apunte a un endpoint propio (mock) o AO_QUOTA_REAL=1. Varias instancias sondeando el mismo token = 429.
const testInstance = (urlEnv) => !!process.env.AO_DATA_DIR && !process.env[urlEnv] && process.env.AO_QUOTA_REAL !== '1';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Petición GET con el módulo http(s) de Node, NO con `fetch`: Cloudflare (chatgpt.com) responde 403 «challenge» al cliente
// de fetch/undici aunque lleve el user-agent del CLI de Codex (huella TLS/ALPN), y acepta la de `https.request` con ese UA.
function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { accept: 'application/json', 'user-agent': 'codex_cli_rs', ...headers }, timeout: TIMEOUT }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) return reject(Object.assign(new Error(`HTTP ${r.statusCode}`), { status: r.statusCode, retryAfter: Number(r.headers['retry-after']) || 0 }));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('respuesta no es JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
    req.on('error', reject);
  });
}
const netReason = (e) => (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'sin respuesta (8 s)' : e.status ? e.message : 'sin conexión');

// ── Normalización (puras: las usa la prueba) ──────────────────────────────
const MODEL_LABEL = (n) => `Modelo ${n.charAt(0).toUpperCase()}${n.slice(1)}`;
export function normalizeClaude(j, plan = null) {
  const windows = [];
  const add = (w) => { if (!windows.some((x) => x.id === w.id)) windows.push(w); };
  for (const l of Array.isArray(j?.limits) ? j.limits : []) {
    if (l?.percent == null) continue;
    const kind = String(l.kind || l.group || '');
    const at = ms(l.resets_at);
    if (kind === 'session') add(win('session', 'Sesión 5 h', l.percent, at, l.severity));
    else if (kind === 'weekly_all' || kind === 'weekly') add(win('weekly', 'Semanal 7 d', l.percent, at, l.severity));
    else if (/^weekly_/.test(kind)) { // ventana acotada a un modelo: `weekly_scoped` trae scope.model.display_name («Fable»); si no, el sufijo del kind
      const n = String(l.scope?.model?.display_name || l.scope?.model?.id || kind.replace(/^weekly_/, ''));
      add(win(`model:${n.toLowerCase()}`, `${MODEL_LABEL(n)} 7 d`, l.percent, at, l.severity));
    }
  }
  // Campos clásicos como respaldo si `limits` no trae esa ventana
  const old = (k, id, label) => { const v = j?.[k]; if (v && v.utilization != null) add(win(id, label, v.utilization, ms(v.resets_at))); };
  old('five_hour', 'session', 'Sesión 5 h'); old('seven_day', 'weekly', 'Semanal 7 d');
  for (const [k, v] of Object.entries(j || {})) {
    const m = /^seven_day_(\w+)$/.exec(k);
    if (m && v && v.utilization != null) add(win(`model:${m[1]}`, `${MODEL_LABEL(m[1])} 7 d`, v.utilization, ms(v.resets_at)));
  }
  const order = (w) => (w.id === 'session' ? 0 : w.id === 'weekly' ? 1 : 2);
  windows.sort((a, b) => order(a) - order(b));
  return { engine: 'claude', ok: true, plan, windows, limitReached: windows.some((w) => (w.id === 'session' || w.id === 'weekly') && w.percent >= 100), fetchedAt: Date.now() };
}

export function normalizeCodex(j) {
  const rl = j?.rate_limit || {};
  const windows = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w || w.used_percent == null) continue;
    const short = Number(w.limit_window_seconds) <= 6 * 3600;
    const at = w.reset_at ? Number(w.reset_at) * 1000 : w.reset_after_seconds != null ? Date.now() + Number(w.reset_after_seconds) * 1000 : null;
    windows.push(win(short ? 'session' : 'weekly', short ? 'Sesión 5 h' : 'Semanal 7 d', w.used_percent, at));
  }
  return { engine: 'codex', ok: true, plan: j?.plan_type || null, windows, limitReached: rl.limit_reached === true || rl.allowed === false || windows.some((w) => w.percent >= 100), fetchedAt: Date.now() };
}

// ── Lectores (red) ────────────────────────────────────────────────────────
async function fetchClaude() {
  if (testInstance('AO_CLAUDE_USAGE_URL')) return bad('claude', 'instancia de pruebas: no consulta la cuota real');
  const cred = readJson(claudeFile())?.claudeAiOauth;
  if (!cred?.accessToken) return bad('claude', 'sin login');
  const plan = cred.subscriptionType || null;
  if (cred.expiresAt && Number(cred.expiresAt) < Date.now()) return bad('claude', 'token caducado: usa claude una vez', plan); // no se refresca aquí: cada tarea con el CLI lo renueva
  try {
    return normalizeClaude(await getJson(CLAUDE_URL(), { authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }), plan);
  } catch (e) { return bad('claude', e.status === 401 ? 'token rechazado: usa claude una vez' : e.status === 429 ? 'Anthropic limita las consultas (429)' : netReason(e), plan, e); }
}
async function fetchCodex() {
  if (testInstance('AO_CODEX_USAGE_URL')) return bad('codex', 'instancia de pruebas: no consulta la cuota real');
  const t = readJson(codexFile())?.tokens;
  if (!t?.access_token) return bad('codex', 'sin login');
  try {
    return normalizeCodex(await getJson(CODEX_URL(), { authorization: `Bearer ${t.access_token}`, ...(t.account_id ? { 'chatgpt-account-id': t.account_id } : {}) }));
  } catch (e) { return bad('codex', e.status === 401 ? 'sesión de Codex caducada: usa codex una vez' : e.status === 403 ? 'rechazado (403) por chatgpt.com' : e.status === 429 ? 'chatgpt.com limita las consultas (429)' : netReason(e), null, e); }
}

// ── Caché ─────────────────────────────────────────────────────────────────
const FETCHERS = { claude: fetchClaude, codex: fetchCodex };
// good: última lectura buena · until: no volver a preguntar antes (espera tras 429/fallo de red) · fails: fallos seguidos
const cache = { claude: { v: null, t: 0, p: null, good: null, until: 0, fails: 0 }, codex: { v: null, t: 0, p: null, good: null, until: 0, fails: 0 } };
export const BACKOFF_MAX = 15 * 60_000;
const STALE_MAX = 6 * 3600_000; // un dato bueno de hace más de 6 h ya no se enseña
let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };

function refresh(engine, force = false) {
  const c = cache[engine];
  if (c.v && (Date.now() < c.until || (!force && Date.now() - c.t < TTL))) return Promise.resolve(c.v); // en espera tras un 429 ni el «forzar» pregunta
  if (c.p) return c.p;
  c.p = FETCHERS[engine]().catch(() => bad(engine, 'error inesperado')).then((v) => {
    // Fallo de red o límite (429/5xx): espera creciente (Retry-After si lo da; si no 2, 4, 8… min, tope 15) y, mientras, se
    // sigue enseñando la última lectura buena marcada como antigua en vez de «sin dato».
    if (v.ok) Object.assign(c, { good: v, until: 0, fails: 0 });
    else if (v.status === 429 || v.status >= 500 || !v.status && !/sin login|caducad|rechazad|pruebas/.test(v.reason)) {
      c.fails++;
      c.until = Date.now() + Math.min(BACKOFF_MAX, Math.max((v.retryAfter || 0) * 1000, TTL * 2 ** c.fails));
      if (c.good && Date.now() - c.good.fetchedAt < STALE_MAX) v = { ...c.good, stale: true, staleReason: v.reason, retryAt: c.until };
    }
    const sig = (x) => JSON.stringify([x?.ok, x?.plan, x?.windows, x?.reason, x?.limitReached, x?.stale]);
    const changed = sig(c.v) !== sig(v);
    Object.assign(c, { v, t: Date.now(), p: null });
    if (changed) onChange();
    return v;
  });
  return c.p;
}
export const readClaudeQuota = (opts = {}) => refresh('claude', opts.force);
export const readCodexQuota = (opts = {}) => refresh('codex', opts.force);
export const readAll = async (opts = {}) => ({ claude: await readClaudeQuota(opts), codex: await readCodexQuota(opts) });
// Lo ya leído, sin red (snapshot SSE). Puede faltar un motor hasta la primera lectura.
export const snapshot = () => Object.fromEntries(Object.entries(cache).filter(([, c]) => c.v).map(([e, c]) => [e, c.v]));
export const resetCache = () => { for (const c of Object.values(cache)) Object.assign(c, { v: null, t: 0, p: null, good: null, until: 0, fails: 0 }); };

// Refresco periódico (cada 60 s) para que el chip y el guardarraíl tengan cifras frescas sin que nadie las pida.
export function startPolling() {
  const go = () => { for (const e of Object.keys(FETCHERS)) refresh(e); };
  go();
  setInterval(go, TTL).unref();
}

// ── Guardarraíl ───────────────────────────────────────────────────────────
// Los motores sin suscripción medible (demo) no se frenan; AO_QUOTA_ENGINE_MAP="demo=claude" (pruebas) los trata como otro.
const keyOf = (engineId) => {
  const map = Object.fromEntries(String(process.env.AO_QUOTA_ENGINE_MAP || '').split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p[1]));
  const k = map[engineId] || engineId;
  return FETCHERS[k] ? k : null;
};
const hhmm = (t) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const NAME = { claude: 'Claude', codex: 'Codex' };

// {block:false} | {wait:true} (aún sin primera lectura: se pide y se reintenta en el siguiente tick) | {block:true, percent, resetsAt, message}
export function gate(engineId) {
  const k = keyOf(engineId);
  if (!k) return { block: false };
  const c = cache[k];
  if (!c.v || Date.now() - c.t >= TTL) refresh(k); // el tick no espera a la red
  if (!c.v) return { wait: true };
  const v = c.v;
  if (!v.ok) return { block: false }; // sin dato fiable no se frena el trabajo
  const s = v.windows.find((w) => w.id === 'session');
  if (v.stale && s?.resetsAt && s.resetsAt <= Date.now()) return { block: false }; // dato antiguo cuya ventana ya se reinició
  const full = v.limitReached || (s && s.percent >= GUARD_PERCENT);
  if (!full) return { block: false };
  const at = s?.resetsAt || v.windows.map((w) => w.resetsAt).filter(Boolean).sort()[0] || null;
  const pct = s ? s.percent : 100;
  return { block: true, engine: k, percent: pct, resetsAt: at, message: `⏸ ${NAME[k]} al ${pct} %: espera al reinicio${at ? ` de las ${hhmm(at)}` : ''}` };
}
// Margen de sesión (100 − %) de un motor; null si no hay dato. Para que `auto` elija el que más le sobra.
export function margin(engineId) {
  const k = keyOf(engineId);
  const s = k && cache[k].v?.ok ? cache[k].v.windows.find((w) => w.id === 'session') : null;
  return s ? 100 - s.percent : null;
}
