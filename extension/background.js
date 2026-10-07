// FT-118 · Extensión MV3: implementa el contrato BrowserDriver de AgentOffice con chrome.debugger (CDP)
// sobre las pestañas que el usuario cede. Protocolo: ver server/browser/extension.js.
// La clave de emparejamiento vive solo en chrome.storage.session (se borra al cerrar el navegador);
// el token de AgentOffice no se usa ni se guarda.
const DEFAULT_URL = 'ws://127.0.0.1:7420/api/browser/ext';
const MAX_NODES = 300, RING = 200, MAX_W = 1280;
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-ao-token)$|token|secret|password|api[-_]?key|session/i;

let ws = null, wsUrl = DEFAULT_URL, lastError = '', retry = null;
let ceded = new Set();            // ids de pestañas cedidas
let active = null;                // pestaña sobre la que actúa el agente
const tabState = new Map();       // tabId → { refs: Map, next, console: [], network: [], reqs: Map }
const loadWaiters = new Map();    // tabId → [fn]

const bad = (status, error) => Object.assign(new Error(error), { status });
const sess = chrome.storage.session;
const ts = (id) => { if (!tabState.has(id)) tabState.set(id, { refs: new Map(), byNode: new Map(), next: 1, console: [], network: [], reqs: new Map(), pending: new Set() }); return tabState.get(id); };
const ring = (a, x) => { a.push(x); if (a.length > RING) a.splice(0, a.length - RING); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okUrl = (u) => /^https?:\/\//i.test(u || '');
const mask = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE.test(k) ? '***' : String(v).slice(0, 300)]));
const own = (u) => { try { const a = new URL(u), b = new URL(wsUrl.replace(/^ws/, 'http')); return a.host === b.host; } catch { return false; } };

// ───────── cesión de pestañas ─────────
const persist = () => sess.set({ ceded: [...ceded], active });
async function sendTabs() {
  const list = [];
  for (const id of ceded) { try { const t = await chrome.tabs.get(id); list.push({ id, url: t.url, title: t.title, active: id === active }); } catch { /* cerrada */ } }
  send({ type: 'tabs', tabs: list });
}
async function cede(tabId) {
  const t = await chrome.tabs.get(tabId);
  if (!okUrl(t.url)) throw bad(400, 'Solo se pueden ceder pestañas http(s)');
  if (own(t.url)) throw bad(400, 'No se cede la propia AgentOffice');
  await attach(tabId);
  ceded.add(tabId); active = tabId;
  try {
    const gid = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(gid, { title: 'AgentOffice', color: 'purple' });
  } catch { /* sin grupos (ventana emergente) */ }
  persist(); sendTabs();
}
async function revoke(tabId) {
  ceded.delete(tabId);
  if (active === tabId) active = [...ceded][0] ?? null;
  try { await chrome.debugger.detach({ tabId }); } catch { /* ya suelta */ }
  try { await chrome.tabs.ungroup(tabId); } catch { /* sin grupo */ }
  tabState.delete(tabId);
  persist(); sendTabs();
}
async function attach(tabId) {
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (e) { if (!/already attached/i.test(e.message)) throw bad(503, e.message); }
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable']) await cmd(tabId, m);
}
const cmd = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params).catch((e) => { throw bad(/No node|Cannot find/i.test(e.message) ? 404 : 500, e.message); });
const cur = (tabId) => {
  const id = tabId ?? active;
  if (id == null || !ceded.has(id)) throw bad(503, 'El usuario no ha cedido ninguna pestaña (botón «Dejar al agente esta pestaña»)');
  return id;
};

chrome.debugger.onDetach.addListener((src, reason) => { if (ceded.has(src.tabId) && reason !== 'replaced_with_devtools') { ceded.delete(src.tabId); if (active === src.tabId) active = [...ceded][0] ?? null; persist(); sendTabs(); } });
chrome.tabs.onRemoved.addListener((id) => { if (ceded.delete(id)) { if (active === id) active = [...ceded][0] ?? null; tabState.delete(id); persist(); sendTabs(); } });
chrome.debugger.onEvent.addListener((src, method, p) => {
  const id = src.tabId; if (!ceded.has(id)) return;
  const s = ts(id);
  if (method === 'Runtime.consoleAPICalled') ring(s.console, { ts: Date.now(), level: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 1000) });
  else if (method === 'Runtime.exceptionThrown') ring(s.console, { ts: Date.now(), level: 'error', text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').slice(0, 1000) });
  else if (method === 'Network.requestWillBeSent') { const e = { ts: Date.now(), method: p.request.method, url: p.request.url.slice(0, 500), type: (p.type || '').toLowerCase(), status: null, requestHeaders: mask(p.request.headers) }; s.reqs.set(p.requestId, e); s.pending.add(p.requestId); ring(s.network, e); }
  else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') s.pending.delete(p.requestId);
  else if (method === 'Network.responseReceived') { const e = s.reqs.get(p.requestId); if (e) e.status = p.response.status; }
  else if (method === 'Page.loadEventFired') (loadWaiters.get(id) || []).splice(0).forEach((f) => f());
});

// ───────── helpers CDP ─────────
const evalIn = async (id, expression) => {
  const r = await cmd(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw bad(422, r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const info = async (id) => { const t = await chrome.tabs.get(id); return { id: String(id), url: t.url, title: t.title, active: id === active }; };
const nav = async (id) => { const t = await chrome.tabs.get(id); return { url: t.url, title: t.title }; };
const waitLoad = (id, ms = 15000) => new Promise((res) => { const t = setTimeout(res, ms); const l = loadWaiters.get(id) || []; l.push(() => { clearTimeout(t); res(); }); loadWaiters.set(id, l); });

async function center(id, a) {
  if (a.ref) {
    const node = ts(id).refs.get(a.ref);
    if (node == null) { if (a.x == null) throw bad(404, `ref ${a.ref} desconocida (haz un snapshot nuevo)`); }
    else {
      try {
        await cmd(id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node });
        const { model } = await cmd(id, 'DOM.getBoxModel', { backendNodeId: node });
        const q = model.content; // 8 números: 4 esquinas
        return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, node };
      } catch (e) { if (a.x == null) throw e; } // sin caja: cae a coordenadas
    }
  }
  if (a.x == null || a.y == null) throw bad(400, 'indica ref o x,y');
  return { x: Number(a.x), y: Number(a.y) };
}
const mouse = (id, type, x, y, extra = {}) => cmd(id, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
async function press(id, key) {
  const code = KEYS[key];
  const base = { key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) };
  await cmd(id, 'Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...base });
  await cmd(id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const callOn = async (id, node, fn) => {
  const { object } = await cmd(id, 'DOM.resolveNode', { backendNodeId: node });
  return cmd(id, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, returnByValue: true });
};

// FT-136 · Espera tras una acción, como settle() de cdp.js: red en reposo (~400 ms sin peticiones vivas) y DOM estable (~300 ms),
// con tope (3 s). Nunca falla: devuelve { networkIdle, domStable, waitedMs }.
async function settle(id, timeout = 3000) {
  const t0 = Date.now(), s = ts(id);
  await sleep(120);
  let quiet = Date.now();
  while (Date.now() - t0 < timeout) {
    if (s.pending.size) quiet = Date.now(); else if (Date.now() - quiet >= 400) break;
    await sleep(60);
  }
  const networkIdle = !s.pending.size;
  let domStable = true;
  try {
    const cap = Math.max(300, timeout - (Date.now() - t0));
    domStable = await evalIn(id, `new Promise((res)=>{let t;const done=(v)=>{mo.disconnect();clearTimeout(t);clearTimeout(c);res(v)};const mo=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(()=>done(true),300)});mo.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});t=setTimeout(()=>done(true),300);const c=setTimeout(()=>done(false),${cap})})`);
  } catch { domStable = true; } // el documento cambió durante la espera
  return { networkIdle, domStable, waitedMs: Date.now() - t0 };
}
const navS = async (id) => ({ ...(await nav(id)), settle: await settle(id) });

// ───────── operaciones del contrato ─────────
const ops = {
  async ping() { return { ok: true, ceded: ceded.size }; },
  async release() { for (const id of [...ceded]) await revoke(id); return { ok: true }; },
  'tabs.list': async () => Promise.all([...ceded].map(info)),
  async 'tabs.new'({ url } = {}) {
    if (url && !okUrl(url)) throw bad(400, 'solo http(s)');
    const t = await chrome.tabs.create({ url: url || 'about:blank', active: false });
    await attach(t.id); ceded.add(t.id); active = t.id;
    try { const gid = await chrome.tabs.group({ tabIds: [t.id] }); await chrome.tabGroups.update(gid, { title: 'AgentOffice', color: 'purple' }); } catch { /* sin grupos */ }
    persist(); sendTabs();
    return info(t.id);
  },
  async 'tabs.select'({ id }) { const n = Number(id); if (!ceded.has(n)) throw bad(404, `la pestaña ${id} no está cedida`); active = n; await chrome.tabs.update(n, { active: true }); persist(); return info(n); },
  async 'tabs.close'({ id } = {}) { const n = id ? Number(id) : cur(); if (!ceded.has(n)) throw bad(404, `la pestaña ${id} no está cedida`); await revoke(n); await chrome.tabs.remove(n); return { ok: true, id: String(n), tabs: ceded.size }; },
  async navigate({ url }) {
    if (!okUrl(url)) throw bad(400, 'solo http(s)');
    const id = cur(); const w = waitLoad(id);
    const r = await cmd(id, 'Page.navigate', { url });
    if (r.errorText) throw bad(502, r.errorText);
    await w; return nav(id);
  },
  async back() { return history(-1); },
  async forward() { return history(1); },
  async reload() { const id = cur(); const w = waitLoad(id); await cmd(id, 'Page.reload'); await w; return nav(id); },
  async snapshot() {
    const id = cur(); const s = ts(id);
    const { nodes } = await cmd(id, 'Accessibility.getFullAXTree');
    const out = []; let total = 0;
    for (const n of nodes) {
      const role = n.role?.value;
      if (n.ignored || !role || ['none', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea'].includes(role)) continue;
      const name = (n.name?.value || '').toString().trim();
      if (role === 'StaticText' && !name) continue;
      total++;
      if (out.length >= MAX_NODES) continue;
      let ref = n.backendDOMNodeId != null ? s.byNode.get(n.backendDOMNodeId) : null; // refs estables entre snapshots
      if (n.backendDOMNodeId != null && !ref) { ref = `e${s.next++}`; s.byNode.set(n.backendDOMNodeId, ref); s.refs.set(ref, n.backendDOMNodeId); }
      const states = (n.properties || []).filter((p) => ['disabled', 'checked', 'expanded', 'selected', 'required', 'focused'].includes(p.name) && p.value?.value && p.value.value !== 'false').map((p) => p.name);
      out.push({ ref: ref || `n${out.length}`, role, name: name.slice(0, 120), value: String(n.value?.value ?? '').slice(0, 120), states });
    }
    const t = await chrome.tabs.get(id);
    return { tabId: String(id), url: t.url, title: t.title, nodes: out, total, truncated: total > out.length, omitted: total - out.length };
  },
  async act(a = {}) {
    const id = cur(); const action = a.action || 'click';
    if (!['click', 'dblclick', 'hover', 'focus', 'select'].includes(action)) throw bad(400, `acción desconocida: ${action}`);
    const c = await center(id, a); const via = a.ref && c.node != null ? 'ref' : 'xy';
    if (action === 'focus') { if (c.node == null) throw bad(400, 'focus necesita ref'); await cmd(id, 'DOM.focus', { backendNodeId: c.node }); }
    else if (action === 'select') {
      if (c.node == null) throw bad(400, 'select necesita ref');
      await callOn(id, c.node, `function(){const v=${JSON.stringify(String(a.value ?? ''))};const o=[...this.options||[]].find(o=>o.value===v||o.text===v);if(!o)throw new Error('opción no encontrada');this.value=o.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}`).then((r) => { if (r.exceptionDetails) throw bad(422, r.exceptionDetails.exception?.description || 'select falló'); });
    } else {
      await mouse(id, 'mouseMoved', c.x, c.y, { button: 'none', clickCount: 0 });
      if (action !== 'hover') {
        const n = action === 'dblclick' ? 2 : 1;
        for (let i = 1; i <= n; i++) { await mouse(id, 'mousePressed', c.x, c.y, { clickCount: i }); await mouse(id, 'mouseReleased', c.x, c.y, { clickCount: i }); }
      }
    }
    return { ok: true, via, ...(await navS(id)) };
  },
  async type({ ref, text = '', clear = false, submit = false, key } = {}) {
    const id = cur();
    if (ref) {
      const node = ts(id).refs.get(ref); if (node == null) throw bad(404, `ref ${ref} desconocida`);
      await cmd(id, 'DOM.focus', { backendNodeId: node });
      if (clear) await callOn(id, node, `function(){if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}))}else{this.textContent=''}}`);
    }
    if (text) await cmd(id, 'Input.insertText', { text });
    if (key) await press(id, key);
    if (submit) await press(id, 'Enter');
    return { ok: true, ...(await navS(id)) };
  },
  // FT-136 · como cdp.js: DOM.setFileInputFiles sobre un <input type=file> (dispara input/change). `files`: rutas absolutas ya validadas por AgentOffice.
  async upload({ ref, files = [] } = {}) {
    if (!ref) throw bad(400, 'falta ref del campo de fichero');
    if (!files.length) throw bad(400, 'faltan ficheros');
    const id = cur(); const node = ts(id).refs.get(ref);
    if (node == null) throw bad(404, `ref ${ref} desconocida (haz un snapshot nuevo)`);
    const k = (await callOn(id, node, 'function(){ return { type: this.tagName === "INPUT" ? this.type : "", multiple: !!this.multiple }; }')).result?.value;
    if (k?.type !== 'file') throw bad(400, `${ref} no es un <input type=file>`);
    if (files.length > 1 && !k.multiple) throw bad(400, 'el campo no admite varios ficheros');
    await cmd(id, 'DOM.setFileInputFiles', { files, backendNodeId: node });
    return { ok: true, files: files.map((f) => String(f).split(/[\\/]/).pop()), ...(await navS(id)) };
  },
  async box(a = {}) {
    const id = cur(); const node = ts(id).refs.get(a.ref);
    if (node != null) { const { model } = await cmd(id, 'DOM.getBoxModel', { backendNodeId: node }); const q = model.border; return { x: q[0], y: q[1], w: q[2] - q[0], h: q[5] - q[1] }; }
    return a.x != null ? { x: a.x - 12, y: a.y - 12, w: 24, h: 24 } : null;
  },
  async scroll(a = {}) {
    const id = cur();
    let x, y;
    if (a.ref || a.x != null) ({ x, y } = await center(id, a));
    else { const v = await evalIn(id, '({w:innerWidth,h:innerHeight})'); x = v.w / 2; y = v.h / 2; }
    await cmd(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(a.dx || 0), deltaY: Number(a.dy || 0) });
    await settle(id, 1500); // contenido perezoso
    return { ok: true, ...(await evalIn(id, '({scrollX:Math.round(scrollX),scrollY:Math.round(scrollY)})')) };
  },
  // FT-136 · detail:'low' → JPEG q50 de ≤800 px; region:{x,y,w,h} (px CSS del viewport) → zoom (hasta ×2). Devuelve scale/originX/originY como cdp.js.
  async screenshot({ format = 'png', fullPage = false, detail, region, maxWidth } = {}) {
    const id = cur(); const low = detail === 'low';
    const m = await cmd(id, 'Page.getLayoutMetrics');
    const vp = m.cssVisualViewport, cs = m.cssContentSize;
    const R = !fullPage && region && Number(region.w) > 0 && Number(region.h) > 0 ? { x: Number(region.x) || 0, y: Number(region.y) || 0, w: Number(region.w), h: Number(region.h) } : null;
    const w = R ? R.w : fullPage ? cs.width : vp.clientWidth, h = R ? R.h : fullPage ? cs.height : vp.clientHeight;
    const cap = Math.min(MAX_W, Number(maxWidth) || (low ? 800 : MAX_W));
    const scale = R ? Math.min(2, cap / w) : Math.min(1, cap / w);
    const f = low || format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png';
    const ox = R ? R.x : 0, oy = R ? R.y : 0;
    const r = await cmd(id, 'Page.captureScreenshot', { format: f, quality: f === 'jpeg' ? (low ? 50 : 70) : undefined, captureBeyondViewport: !!fullPage, clip: { x: fullPage ? 0 : vp.pageX + ox, y: fullPage ? 0 : vp.pageY + oy, width: w, height: h, scale } });
    return { data: r.data, format: f, width: Math.round(w * scale), height: Math.round(h * scale), tabId: String(id), scale, originX: ox, originY: oy };
  },
  async evaluate({ expression } = {}) { if (!expression) throw bad(400, 'falta expression'); return { value: await evalIn(cur(), expression) }; },
  async console({ limit = 50, clear = false } = {}) { const id = cur(); const s = ts(id); const entries = s.console.slice(-limit); if (clear) s.console.length = 0; return { tabId: String(id), entries }; },
  async network({ limit = 50, clear = false } = {}) { const id = cur(); const s = ts(id); const entries = s.network.slice(-limit); if (clear) { s.network.length = 0; s.reqs.clear(); } return { tabId: String(id), entries }; },
  async waitFor({ text, selector, url, ms, timeout = 10000 } = {}) {
    const id = cur();
    if (ms) { await sleep(Math.min(Number(ms), 30000)); return { ok: true, ...(await nav(id)) }; }
    if (!text && !selector && !url) throw bad(400, 'indica text, selector, url o ms');
    const until = Date.now() + Math.min(Number(timeout), 30000);
    const probe = text ? `document.body&&document.body.innerText.includes(${JSON.stringify(text)})` : selector ? `!!document.querySelector(${JSON.stringify(selector)})` : `location.href.includes(${JSON.stringify(url)})`;
    while (Date.now() < until) { if (await evalIn(id, probe).catch(() => false)) return { ok: true, ...(await nav(id)) }; await sleep(250); }
    throw bad(408, 'tiempo de espera agotado');
  },
};
async function history(delta) {
  const id = cur(); const h = await cmd(id, 'Page.getNavigationHistory'); const e = h.entries[h.currentIndex + delta];
  if (e) { const w = waitLoad(id, 8000); await cmd(id, 'Page.navigateToHistoryEntry', { entryId: e.id }); await w; }
  return nav(id);
}

// ───────── conexión con AgentOffice ─────────
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
async function connect(code) {
  clearTimeout(retry);
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* nada */ } }
  const { key } = await sess.get('key');
  if (!code && !key) { lastError = 'sin emparejar'; return; }
  try { ws = new WebSocket(wsUrl); } catch (e) { lastError = e.message; return; }
  ws.onopen = () => send({ type: 'hello', ...(code ? { code } : { key }) });
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ready') { lastError = ''; if (m.key) await sess.set({ key: m.key }); sendTabs(); return; }
    if (m.type === 'denied') { lastError = m.error; await sess.remove('key'); return; }
    if (!m.op) return;
    try { send({ id: m.id, ok: true, result: await (ops[m.op] || (() => { throw bad(400, `operación desconocida: ${m.op}`); }))(m.params || {}) }); }
    catch (e) { send({ id: m.id, ok: false, status: e.status || 500, error: e.message }); }
  };
  ws.onclose = () => { ws = null; retry = setTimeout(() => connect(), 5000); };
  ws.onerror = () => { lastError = 'sin conexión con AgentOffice'; };
}
setInterval(() => send({ type: 'keepalive' }), 20000); // mantiene vivo el service worker mientras hay conexión

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  (async () => {
    if (m.type === 'status') return reply({ connected: ws?.readyState === 1, cededIds: [...ceded], url: wsUrl, error: lastError });
    if (m.type === 'cede') { try { await cede(m.tabId); reply({ ok: true }); } catch (e) { reply({ error: e.message }); } return; }
    if (m.type === 'revoke') { await revoke(m.tabId); return reply({ ok: true }); }
    if (m.type === 'connect') { if (m.url) { wsUrl = m.url; await chrome.storage.local.set({ url: m.url }); } await connect(m.code || ''); return reply({ ok: true }); }
  })();
  return true;
});

(async () => {
  const [{ url }, { ceded: c = [], active: a = null }] = await Promise.all([chrome.storage.local.get('url'), sess.get(['ceded', 'active'])]);
  if (url) wsUrl = url;
  for (const id of c) { try { await chrome.tabs.get(id); await attach(id); ceded.add(id); } catch { /* ya no existe */ } }
  active = ceded.has(a) ? a : [...ceded][0] ?? null;
  connect();
})();
