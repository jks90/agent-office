// FT-118 · Navegador del agente (Fase B): driver que habla con la extensión MV3 de extension/ por WebSocket.
// La extensión usa chrome.debugger sobre las pestañas que el usuario le cede; este driver cumple el mismo
// contrato BrowserDriver que cdp.js/fake.js (ver index.js). El servidor manda {id, op, params} y la
// extensión contesta {id, ok, result} o {id, ok:false, status, error}.
//
// Emparejamiento: Ajustes ▸ Navegador pide un código de un solo uso (5 min). La extensión lo envía en su
// `hello` y recibe una clave; en disco solo guardamos el hash SHA-256 de la clave (data/browser/ext.json)
// y la extensión la guarda en chrome.storage.session, nunca el token de AgentOffice.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accept } from './ws.js';
import { bad, checkUrl, dataDir, maskHeaders, saveShot, readPageExpr, paginateRead } from './util.js';

const CALL_TIMEOUT = 30_000;
const CODE_TTL = 5 * 60_000;
const HELLO_TIMEOUT = 5_000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const keysFile = () => path.join(dataDir(), 'ext.json');
const loadKeys = () => { try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')).keys || []; } catch { return []; } };
const saveKeys = (keys) => { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(keysFile(), JSON.stringify({ keys: keys.slice(-5) }), { mode: 0o600 }); };

let conn = null;          // conexión autenticada de la extensión
let pairing = null;       // { code, expires }
let tabsCeded = [];       // última lista de pestañas cedidas que anunció la extensión
let notify = () => {};
let seq = 0;
const pending = new Map();

export const onChange = (fn) => { notify = fn; };

// Código de un solo uso para emparejar (8 caracteres sin ambiguos).
export function newPairingCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.randomBytes(8), (b) => A[b % A.length]).join('');
  pairing = { code, expires: Date.now() + CODE_TTL };
  notify();
  return { code, expiresAt: pairing.expires };
}
const livePairing = () => (pairing && pairing.expires > Date.now() ? pairing : null);

export function status() {
  const p = livePairing();
  return { connected: !!conn, paired: loadKeys().length > 0, tabs: tabsCeded, pairing: p ? { code: p.code, expiresAt: p.expires } : null };
}
export function forget() { // «Olvidar extensión»: invalida las claves y corta la conexión
  saveKeys([]); pairing = null;
  if (conn) conn.close();
  notify();
  return { ok: true };
}

function dropPending(why) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(bad(503, why)); }
  pending.clear();
}

// Se llama desde server.on('upgrade'). Solo loopback y sin Origin de una web (una página no puede hablarle).
export function handleUpgrade(req, socket) {
  const ra = req.socket.remoteAddress || '';
  const origin = req.headers.origin || '';
  if (!/^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(ra) || (origin && !/^(chrome|moz)-extension:\/\//.test(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  const ws = accept(req, socket);
  if (!ws) return;
  let authed = false;
  const hello = setTimeout(() => { if (!authed) ws.close(); }, HELLO_TIMEOUT);
  ws.onClose(() => {
    clearTimeout(hello);
    if (conn === ws) { conn = null; tabsCeded = []; dropPending('la extensión se desconectó'); notify(); }
  });
  ws.onMessage((raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!authed) {
      if (m.type !== 'hello') return ws.close();
      let key = null;
      const p = livePairing();
      if (m.code && p && String(m.code).trim().toUpperCase() === p.code) { // código de un solo uso
        pairing = null;
        key = crypto.randomBytes(24).toString('hex');
        saveKeys([...loadKeys(), sha(key)]);
      } else if (!(m.key && loadKeys().includes(sha(m.key)))) {
        ws.send(JSON.stringify({ type: 'denied', error: 'código o clave no válidos' }));
        return ws.close();
      }
      authed = true; clearTimeout(hello);
      if (conn && conn !== ws) conn.close();
      conn = ws;
      ws.send(JSON.stringify({ type: 'ready', ...(key ? { key } : {}) }));
      notify();
      return;
    }
    if (m.type === 'tabs') { tabsCeded = (m.tabs || []).slice(0, 50).map((t) => ({ id: String(t.id), url: String(t.url || ''), title: String(t.title || ''), active: !!t.active })); return notify(); }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(bad(m.status || 500, m.error || 'error en la extensión'));
  });
}

function call(op, params = {}) {
  if (!conn) return Promise.reject(bad(503, 'La extensión no está conectada (Ajustes ▸ Navegador; instálala desde extension/)'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(bad(408, `la extensión no respondió a ${op}`)); }, CALL_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    conn.send(JSON.stringify({ id, op, params }));
  });
}

const maskEntries = (r) => ({ ...r, entries: (r.entries || []).map((e) => ({ ...e, requestHeaders: maskHeaders(e.requestHeaders), responseHeaders: e.responseHeaders ? maskHeaders(e.responseHeaders) : undefined })) });

export function createExtensionDriver() {
  const c = (op) => (a = {}) => call(op, a);
  return {
    id: 'extension',
    available: () => (conn ? { ok: true, missing: [], exe: 'extension', headless: false } : { ok: false, missing: ['extensión MV3 conectada (extension/)'], exe: 'extension', headless: false }),
    async launch() { await call('ping'); return { ok: true, reused: true }; },
    async close() { if (!conn) return { ok: true }; return call('release'); }, // suelta las pestañas (quita el depurador); el navegador es del usuario
    isOpen: () => !!conn,
    tabs: {
      list: c('tabs.list'),
      new: async (a = {}) => call('tabs.new', { url: a.url ? checkUrl(a.url) : undefined }),
      select: c('tabs.select'),
      close: c('tabs.close'),
    },
    navigate: async (a = {}) => call('navigate', { url: checkUrl(a.url) }),
    back: c('back'), forward: c('forward'), reload: c('reload'),
    snapshot: c('snapshot'),
    act: c('act'), type: c('type'), scroll: c('scroll'),
    upload: c('upload'), // FT-136: DOM.setFileInputFiles en la extensión (rutas ya validadas por AgentOffice)
    async screenshot(a = {}) {
      const r = await call('screenshot', a);
      if (!r?.data) throw bad(500, 'la extensión no devolvió imagen');
      return { ...saveShot(Buffer.from(r.data, 'base64'), r.format === 'jpeg' ? 'jpeg' : 'png', r.tabId), width: r.width, height: r.height, tabId: r.tabId, scale: r.scale ?? 1, originX: r.originX ?? 0, originY: r.originY ?? 0 };
    },
    box: async (a = {}) => call('box', a).catch(() => null), // rectángulo del elemento (marca del panel, FT-117)
    // FT-117 · sin screencast fiable en chrome.debugger: el panel en vivo degrada a capturas JPEG periódicas
    async screencast(onFrame, { fps = 1 } = {}) {
      let stopped = false, busy = false;
      const tick = async () => {
        if (stopped || busy || !conn) return;
        busy = true;
        try {
          const r = await call('screenshot', { format: 'jpeg' });
          const t = (await call('tabs.list')).find((x) => x.active);
          if (!stopped && r?.data) onFrame({ mime: 'image/jpeg', data: r.data, w: r.width, h: r.height, tabId: r.tabId, url: t?.url || '' });
        } catch { /* sin pestaña cedida o desconectada: se reintenta */ }
        busy = false;
      };
      const iv = setInterval(tick, 1000 / Math.min(2, Math.max(0.2, fps)));
      tick();
      return () => { stopped = true; clearInterval(iv); };
    },
    // FT-132 · modo lectura con la misma expresión que el driver CDP, evaluada en la pestaña cedida
    async readPage(a = {}) {
      const r = await call('evaluate', { expression: readPageExpr(a.selector) });
      const t = (await call('tabs.list')).find((x) => x.active) || {};
      return { tabId: t.id, url: t.url, title: t.title, ...paginateRead(r?.value, a) };
    },
    evaluate: c('evaluate'),
    async console(a) { return call('console', a); },
    async network(a) { return maskEntries(await call('network', a)); },
    waitFor: c('waitFor'),
  };
}
