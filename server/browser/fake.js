// FT-114 · Driver falso (AO_BROWSER=fake): mismo contrato que cdp.js, sin Chromium, para pruebas.
import { readFileSync } from 'node:fs';
import { bad, checkUrl, maskHeaders, ringPush, saveShot } from './util.js';

const PNG = readFileSync(new URL('../desktop/fake.png', import.meta.url));
const TREE = [
  { role: 'heading', name: 'Página falsa', value: '', states: [] },
  { role: 'textbox', name: 'Nombre', value: '', states: [] },
  { role: 'button', name: 'Enviar', value: '', states: [] },
  { role: 'link', name: 'Más info', value: '', states: [] },
];

export function createFakeDriver() {
  let open = false, seq = 0, active = null;
  const tabs = new Map();
  const log = []; // acciones recibidas, para que los tests las inspeccionen
  const mk = (url = 'about:blank') => {
    const t = { id: `t${++seq}`, hist: [url], i: 0, console: [], network: [], values: {} };
    tabs.set(t.id, t);
    return t;
  };
  const url = (t) => t.hist[t.i];
  const info = (t) => ({ id: t.id, url: url(t), title: `Fake ${url(t)}`, active: t === active });
  const nav = (t) => ({ url: url(t), title: `Fake ${url(t)}` });
  const ready = () => { if (!open) { open = true; active = mk(); } };
  const cur = () => { ready(); return active; };
  const go = (t, u) => {
    t.hist = t.hist.slice(0, t.i + 1); t.hist.push(u); t.i++;
    ringPush(t.network, { ts: Date.now(), method: 'GET', url: u, type: 'document', status: 200, requestHeaders: maskHeaders({ cookie: 'x', accept: '*/*' }) });
    ringPush(t.console, { ts: Date.now(), level: 'log', text: `navegado a ${u}` });
  };
  const pick = (id) => { const t = tabs.get(id); if (!t) throw bad(404, `no existe la pestaña ${id}`); return t; };
  return {
    id: 'fake',
    log,
    available: () => ({ ok: true, missing: [], exe: 'fake', headless: true }),
    async launch() { const reused = open; ready(); return { ok: true, reused }; },
    async close() { open = false; tabs.clear(); active = null; return { ok: true }; },
    isOpen: () => open,
    tabs: {
      async list() { ready(); return [...tabs.values()].map(info); },
      async new({ url: u } = {}) { ready(); active = mk(); if (u) go(active, checkUrl(u)); return info(active); },
      async select({ id }) { ready(); active = pick(id); return info(active); },
      async close({ id } = {}) { ready(); const t = id ? pick(id) : active; tabs.delete(t.id); if (active === t) active = [...tabs.values()].at(-1) || null; return { ok: true, id: t.id, tabs: tabs.size }; },
    },
    async navigate({ url: u }) { const t = cur(); go(t, checkUrl(u)); return nav(t); },
    async back() { const t = cur(); t.i = Math.max(0, t.i - 1); return nav(t); },
    async forward() { const t = cur(); t.i = Math.min(t.hist.length - 1, t.i + 1); return nav(t); },
    async reload() { const t = cur(); go(t, url(t)); t.hist.pop(); t.i--; return nav(t); },
    async snapshot() {
      const t = cur();
      const nodes = TREE.map((n, i) => ({ ...n, ref: `e${i + 1}`, value: t.values[`e${i + 1}`] || '' }));
      return { tabId: t.id, ...nav(t), nodes, total: nodes.length, truncated: false, omitted: 0 };
    },
    async act(a = {}) {
      const t = cur();
      if (a.ref && !/^e[1-4]$/.test(a.ref) && (a.x == null)) throw bad(404, `ref ${a.ref} desconocido`);
      log.push({ op: 'act', ...a });
      return { ok: true, via: a.ref ? 'ref' : 'xy', ...nav(t) };
    },
    async type(a = {}) {
      const t = cur();
      if (a.ref) t.values[a.ref] = (a.clear ? '' : t.values[a.ref] || '') + (a.text || '');
      log.push({ op: 'type', ...a });
      return { ok: true, ...nav(t) };
    },
    async scroll(a = {}) { cur(); log.push({ op: 'scroll', ...a }); return { ok: true, scrollX: a.dx || 0, scrollY: a.dy || 0 }; },
    async screenshot() { const t = cur(); return { ...saveShot(PNG, 'png', t.id), width: 1, height: 1, tabId: t.id }; },
    async evaluate({ expression }) { if (!expression) throw bad(400, 'falta expression'); cur(); return { value: `fake:${expression}` }; },
    async console({ limit = 50, clear = false } = {}) { const t = cur(); const entries = t.console.slice(-limit); if (clear) t.console.length = 0; return { tabId: t.id, entries }; },
    async network({ limit = 50, clear = false } = {}) { const t = cur(); const entries = t.network.slice(-limit); if (clear) t.network.length = 0; return { tabId: t.id, entries }; },
    async waitFor() { const t = cur(); return { ok: true, ...nav(t) }; },
  };
}
