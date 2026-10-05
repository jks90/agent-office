// Cuentas de los motores de IA (Claude Code y Codex): estado, login OAuth sin navegador integrado
// (la URL/código se muestran en el panel y el usuario los completa en su navegador), clave API y logout.
//   claude: `claude auth status --json` · `claude auth login [--console]` (imprime URL y pide pegar el código) · `claude auth logout`
//   codex:  `codex login status` · `codex login --device-auth` (URL fija + código de un solo uso) · `codex login --with-api-key` · `codex logout`
// La clave API de Claude se guarda en <data>/.ai-keys.json (0600) y se inyecta como ANTHROPIC_API_KEY al lanzar agentes.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';

const exec = promisify(execFile);
const BIN = { claude: process.env.AO_CLAUDE_BIN || 'claude', codex: process.env.AO_CODEX_BIN || 'codex' };
const KEYS_FILE = () => path.join(store.DATA_DIR, '.ai-keys.json');
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const mask = (k) => (k ? `…${String(k).slice(-4)}` : null);

// ── Claves API (solo Claude las guardamos nosotros; Codex guarda la suya en su auth.json) ──
function readKeys() { try { return JSON.parse(fs.readFileSync(KEYS_FILE(), 'utf8')) || {}; } catch { return {}; } }
function writeKeys(k) { fs.mkdirSync(store.DATA_DIR, { recursive: true }); fs.writeFileSync(KEYS_FILE(), JSON.stringify(k, null, 2), { mode: 0o600 }); }
export function setApiKey(engine, key) {
  const k = readKeys();
  if (key) k[engine] = String(key).trim(); else delete k[engine];
  writeKeys(k);
}
// Clave API de un proveedor para usos fuera de los motores (FT-9: STT de OpenAI). «openai»: variable de entorno, clave
// guardada aquí o la que Codex tenga en ~/.codex/auth.json (OPENAI_API_KEY). «claude»: la guardada aquí o ANTHROPIC_API_KEY.
export function getApiKey(provider) {
  if (provider === 'openai') {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    if (readKeys().openai) return readKeys().openai;
    try { return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'auth.json'), 'utf8')).OPENAI_API_KEY || null; } catch { return null; }
  }
  return readKeys()[provider] || null;
}
// Variables de entorno extra para lanzar un agente con ese motor.
export function engineEnv(engine) {
  const k = readKeys();
  if (engine === 'claude' && k.claude) return { ANTHROPIC_API_KEY: k.claude };
  return {};
}

// Clave API para los proveedores HTTP del Guide (FT-8): la guardada en Ajustes ▸ Motores (claude → Anthropic; la de Codex también
// se copia aquí como `openai`) o, si no hay, la variable de entorno.
export function guideApiKey(provider) {
  const k = readKeys();
  if (provider === 'anthropic') return k.claude || process.env.ANTHROPIC_API_KEY || null;
  if (provider === 'openai') return k.openai || process.env.OPENAI_API_KEY || null;
  return null;
}

// ── Estado ──────────────────────────────────────────────────────────────────
async function claudeStatus() {
  const keys = readKeys();
  try {
    const { stdout } = await exec(BIN.claude, ['auth', 'status', '--json'], { timeout: 15000, env: { ...process.env, BROWSER: 'true' } });
    const j = JSON.parse(stdout);
    const oauth = !!j.loggedIn;
    return {
      installed: true, loggedIn: oauth || !!keys.claude,
      method: keys.claude ? 'api-key' : oauth ? (j.authMethod === 'claude.ai' ? 'claude.ai' : j.authMethod || 'oauth') : null,
      account: j.email || null, plan: j.subscriptionType || null, org: j.orgName || null,
      apiKey: mask(keys.claude), oauthAlso: !!(keys.claude && oauth),
      billing: keys.claude ? 'api' : (j.subscriptionType ? 'suscripción' : oauth ? 'api' : null),
    };
  } catch (e) {
    return { installed: !/ENOENT/.test(e.message), loggedIn: !!keys.claude, method: keys.claude ? 'api-key' : null, apiKey: mask(keys.claude), error: /ENOENT/.test(e.message) ? 'No encuentro el CLI `claude`' : null };
  }
}
async function codexStatus() {
  try {
    const { stdout, stderr } = await exec(BIN.codex, ['login', 'status'], { timeout: 15000, env: { ...process.env, BROWSER: 'true' } });
    const txt = strip(stdout + stderr).trim();
    const loggedIn = /logged in/i.test(txt) && !/not logged in/i.test(txt);
    const method = !loggedIn ? null : /api key/i.test(txt) ? 'api-key' : /chatgpt/i.test(txt) ? 'chatgpt' : 'oauth';
    return { installed: true, loggedIn, method, text: txt.split('\n')[0], billing: method === 'api-key' ? 'api' : loggedIn ? 'suscripción' : null };
  } catch (e) {
    const txt = strip((e.stdout || '') + (e.stderr || '')).trim();
    if (/not logged in/i.test(txt)) return { installed: true, loggedIn: false, method: null, text: txt.split('\n')[0] };
    return { installed: !/ENOENT/.test(e.message), loggedIn: false, method: null, error: /ENOENT/.test(e.message) ? 'No encuentro el CLI `codex`' : (txt || e.message) };
  }
}
// Estado cacheado (60 s) para decidir el motor automático sin lanzar los CLIs en cada tick.
let statusCache = { at: 0, value: null, inflight: null };
export function cachedEnginesStatus() {
  if (Date.now() - statusCache.at > 60000 && !statusCache.inflight) {
    statusCache.inflight = enginesStatus().then((v) => { statusCache = { at: Date.now(), value: v, inflight: null }; return v; }).catch(() => { statusCache.inflight = null; });
  }
  return statusCache.value;
}
export async function enginesStatus() {
  const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()]);
  return { claude: { ...claude, login: publicLogin('claude') }, codex: { ...codex, login: publicLogin('codex') } };
}

// ── Modelos disponibles por motor ──────────────────────────────────────────
// Claude: alias + ids de la familia 5 (Fable/Opus/Sonnet 5.x necesitan Claude Code ≥ 2.1.251). Codex: caché de modelos de la cuenta.
let cliVersionCache = { at: 0, v: null };
async function claudeVersion() {
  if (Date.now() - cliVersionCache.at < 600000) return cliVersionCache.v;
  try { const { stdout } = await exec(BIN.claude, ['--version'], { timeout: 10000 }); cliVersionCache = { at: Date.now(), v: (stdout.match(/(\d+\.\d+\.\d+)/) || [])[1] || null }; }
  catch { cliVersionCache = { at: Date.now(), v: null }; }
  return cliVersionCache.v;
}
const verGte = (a, b) => { if (!a) return false; const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return true; };
export async function enginesModels() {
  const v = await claudeVersion();
  const new5 = verGte(v, '2.1.251');
  const claude = [
    { id: 'opus', label: 'Opus (alias → el Opus más reciente que admita el CLI)', available: true },
    { id: 'sonnet', label: 'Sonnet (alias)', available: true },
    { id: 'haiku', label: 'Haiku (alias)', available: true },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', available: new5, note: new5 ? '' : `requiere Claude Code ≥ 2.1.251 (tienes ${v || '?'}): ejecuta «claude update»` },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', available: new5, note: new5 ? '' : 'requiere Claude Code ≥ 2.1.251' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', available: new5, note: new5 ? '' : 'requiere Claude Code ≥ 2.1.251' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', available: true },
  ];
  let codex = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.codex', 'models_cache.json'), 'utf8'));
    const list = cache.models || cache.data || cache;
    // La caché no dice qué modelos admite el plan (ChatGPT rechaza algunos, p. ej. gpt-6.1-sol): solo gpt-5.5 está comprobado.
    codex = (Array.isArray(list) ? list : []).filter((m) => typeof m === 'object' && m.visibility !== 'hide').map((m) => ({ id: m.slug, label: `${m.display_name || m.slug}${m.slug === 'gpt-5.5' ? ' — comprobado con tu cuenta' : ''}`, available: true, note: m.slug === 'gpt-5.5' ? '' : 'sin comprobar con tu plan de ChatGPT' })).filter((m) => m.id && !/review/i.test(m.id));
  } catch { /* sin caché */ }
  if (!codex.some((m) => m.id === 'gpt-5.5')) codex.push({ id: 'gpt-5.5', label: 'gpt-5.5', available: true });
  return { claude, codex, claudeVersion: v };
}

// ── Logins en curso ─────────────────────────────────────────────────────────
const logins = new Map(); // engine -> { proc, state, url, code, output, error, startedAt, mode }
const publicLogin = (engine) => {
  const l = logins.get(engine);
  return l ? { state: l.state, url: l.url, code: l.code, mode: l.mode, error: l.error, startedAt: l.startedAt } : null;
};

export function startLogin(engine, { mode = 'oauth' } = {}) {
  if (!BIN[engine]) throw Object.assign(new Error('Motor desconocido'), { status: 404 });
  if (logins.get(engine)?.proc) throw Object.assign(new Error('Ya hay un login en curso: cancélalo o complétalo'), { status: 409 });
  const args = engine === 'claude' ? ['auth', 'login', ...(mode === 'console' ? ['--console'] : [])] : ['login', '--device-auth'];
  const proc = spawn(BIN[engine], args, { env: { ...process.env, BROWSER: 'true', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const l = { proc, state: 'starting', url: null, code: null, output: '', error: null, startedAt: Date.now(), mode };
  logins.set(engine, l);
  const onData = (d) => {
    l.output = (l.output + strip(d)).slice(-8000);
    const url = l.output.match(/https?:\/\/\S+/);
    if (url && !l.url) l.url = url[0].replace(/[),.]+$/, '');
    if (engine === 'codex') {
      const code = l.output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/);
      if (code) l.code = code[1];
      if (l.url && l.code) l.state = 'waiting_browser';
    } else if (/paste code here/i.test(l.output) || l.url) {
      l.state = 'waiting_code';
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => { l.state = 'error'; l.error = e.message; l.proc = null; });
  proc.on('close', (code) => {
    l.proc = null;
    if (l.state === 'cancelled') return;
    if (code === 0) { l.state = 'done'; setTimeout(() => { if (logins.get(engine) === l) logins.delete(engine); }, 60000); }
    else { l.state = 'error'; l.error = l.error || (l.output.trim().split('\n').pop() || `terminó con código ${code}`); }
  });
  setTimeout(() => { if (l.proc) { l.error = 'Tiempo agotado (15 min)'; l.state = 'error'; l.proc.kill(); } }, 15 * 60 * 1000).unref();
  return new Promise((resolve) => setTimeout(() => resolve(publicLogin(engine)), 1500));
}

export function submitCode(engine, code) {
  const l = logins.get(engine);
  if (!l?.proc) throw Object.assign(new Error('No hay un login esperando código'), { status: 409 });
  l.proc.stdin.write(String(code).trim() + '\n');
  l.state = 'verifying';
  return new Promise((resolve) => setTimeout(() => resolve(publicLogin(engine)), 2500));
}

export function cancelLogin(engine) {
  const l = logins.get(engine);
  if (l?.proc) { l.state = 'cancelled'; l.proc.kill('SIGTERM'); }
  logins.delete(engine);
}

export async function logout(engine) {
  cancelLogin(engine);
  if (engine === 'codex') setApiKey('openai', null);
  if (engine === 'claude') { setApiKey('claude', null); await exec(BIN.claude, ['auth', 'logout'], { timeout: 15000 }).catch(() => {}); }
  else await exec(BIN.codex, ['logout'], { timeout: 15000 }).catch(() => {});
}

export async function loginWithApiKey(engine, key) {
  if (!key?.trim()) throw Object.assign(new Error('Pega una clave API'), { status: 400 });
  if (engine === 'claude') { setApiKey('claude', key); return; }
  // Codex guarda la clave en su propio auth.json
  await new Promise((resolve, reject) => {
    const p = spawn(BIN.codex, ['login', '--with-api-key'], { env: { ...process.env, BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? (setApiKey('openai', key), resolve()) : reject(Object.assign(new Error(strip(err).trim() || `codex login terminó con código ${c}`), { status: 400 }))));
    p.stdin.end(key.trim() + '\n');
  });
}
