// FT-114 · BrowserDriver sobre Chromium/Chrome/Brave dedicado, controlado por CDP con puppeteer-core.
// puppeteer-core se importa en el primer launch(): sin él el resto de AgentOffice arranca igual (503 claro).
import fs from 'node:fs';
import { bad, checkUrl, maskHeaders, ringPush, profileDir, saveShot, MAX_SHOT_WIDTH } from './util.js';

const CANDIDATES = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
};
export function findBrowser() {
  const forced = process.env.AO_BROWSER_PATH;
  if (forced) return fs.existsSync(forced) ? forced : null;
  return (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null;
}
// Visible por defecto si hay escritorio; headless con AO_BROWSER_HEADLESS=1 o sin pantalla.
const headless = () => process.env.AO_BROWSER_HEADLESS === '1'
  || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

const MAX_NODES = () => Number(process.env.AO_BROWSER_SNAPSHOT_NODES) || 300;
const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'Iframe']);
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'tab', 'option', 'listbox', 'treeitem', 'textarea']);
const STATE_PROPS = ['focused', 'disabled', 'checked', 'expanded', 'selected', 'required', 'readonly', 'invalid', 'pressed', 'modal'];
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function createCdpDriver() {
  let browser = null;
  let launching = null;
  let idleTimer = null;
  let seq = 0;
  const tabs = new Map();       // id → tab
  const byPage = new WeakMap(); // page → tab
  let active = null;            // tab activa

  const touch = () => {
    clearTimeout(idleTimer);
    const ms = Number(process.env.AO_BROWSER_IDLE_MS) || 15 * 60 * 1000;
    idleTimer = setTimeout(() => { driver.close().catch(() => {}); }, ms);
    idleTimer.unref?.();
  };

  function register(page) {
    if (byPage.has(page)) return byPage.get(page);
    const tab = { id: `t${++seq}`, page, session: null, console: [], network: [], reqs: new Map(), refs: new Map(), rev: new Map(), refSeq: 0 };
    byPage.set(page, tab);
    tabs.set(tab.id, tab);
    page.on('console', (m) => ringPush(tab.console, { ts: Date.now(), level: m.type(), text: clip(m.text(), 500) }));
    page.on('pageerror', (e) => ringPush(tab.console, { ts: Date.now(), level: 'pageerror', text: clip(String(e?.message || e), 500) }));
    page.on('request', (r) => {
      const e = { ts: Date.now(), method: r.method(), url: clip(r.url(), 500), type: r.resourceType(), status: null, requestHeaders: maskHeaders(r.headers()) };
      tab.reqs.set(r, e);
      ringPush(tab.network, e);
    });
    page.on('response', (r) => {
      const e = tab.reqs.get(r.request());
      if (e) { e.status = r.status(); e.responseHeaders = maskHeaders(r.headers()); }
    });
    page.on('requestfailed', (r) => { const e = tab.reqs.get(r); if (e) e.failed = r.failure()?.errorText || 'failed'; });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) { tab.refs.clear(); tab.rev.clear(); } }); // los backendNodeId mueren con el documento
    page.on('close', () => {
      tabs.delete(tab.id);
      if (active === tab) active = [...tabs.values()].at(-1) || null;
    });
    return tab;
  }

  async function launch() {
    if (browser) { touch(); return { ok: true, reused: true }; }
    if (launching) return launching;
    launching = (async () => {
      const exe = findBrowser();
      if (!exe) throw bad(503, 'No encuentro Chromium/Chrome/Brave (pon AO_BROWSER_PATH=/ruta/al/binario)');
      let puppeteer;
      try { puppeteer = (await import('puppeteer-core')).default; } catch { throw bad(503, 'falta puppeteer-core (npm install)'); }
      fs.mkdirSync(profileDir(), { recursive: true });
      const args = ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
      if (process.env.AO_BROWSER_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
      browser = await puppeteer.launch({ executablePath: exe, userDataDir: profileDir(), headless: headless(), defaultViewport: null, args });
      browser.on('disconnected', () => { browser = null; tabs.clear(); active = null; });
      browser.on('targetcreated', async (t) => {
        if (t.type() !== 'page') return;
        try {
          const page = await t.page();
          if (!page) return;
          const tab = register(page);
          if (t.opener()) active = tab; // popup abierto por la página: pasa a ser la activa
        } catch { /* pestaña ya cerrada */ }
      });
      for (const p of await browser.pages()) register(p);
      active = [...tabs.values()][0] || register(await browser.newPage());
      return { ok: true, exe, headless: headless(), profile: profileDir() };
    })().finally(() => { launching = null; });
    const r = await launching;
    touch();
    return r;
  }

  async function ready() { await launch(); touch(); }
  async function cur() {
    await ready();
    if (!active) active = register(await browser.newPage());
    return active;
  }
  const pick = (id) => {
    const t = tabs.get(id);
    if (!t) throw bad(404, `no existe la pestaña ${id}`);
    return t;
  };
  const info = async (tab) => ({ id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => ''), active: tab === active });
  async function cdp(tab) {
    if (!tab.session) {
      tab.session = await tab.page.createCDPSession();
      await tab.session.send('DOM.enable');
      await tab.session.send('Accessibility.enable');
    }
    return tab.session;
  }
  const navInfo = async (tab) => ({ url: tab.page.url(), title: await tab.page.title().catch(() => '') });

  // ref → centro del nodo en coordenadas del viewport (o null si no tiene caja)
  async function centerOf(tab, backendNodeId) {
    const s = await cdp(tab);
    try {
      await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
      const { quads } = await s.send('DOM.getContentQuads', { backendNodeId });
      for (const q of quads) {
        const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        if (w > 0 && h > 0) return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
      }
    } catch { /* nodo desaparecido */ }
    return null;
  }
  // Resuelve el objetivo: ref (preferente) y, si no hay caja o no existe, coordenadas x/y.
  async function target(tab, { ref, x, y }) {
    if (ref) {
      const e = tab.refs.get(ref);
      if (e) {
        const c = await centerOf(tab, e.backendNodeId);
        if (c) return { ...c, backendNodeId: e.backendNodeId, via: 'ref' };
      }
      if (x == null || y == null) throw bad(404, `ref ${ref} desconocido o sin caja (haz un snapshot nuevo)`);
    }
    if (x == null || y == null) throw bad(400, 'indica ref o x,y');
    return { x: Number(x), y: Number(y), via: 'xy' };
  }
  const callOn = async (tab, backendNodeId, fn, ...args) => {
    const s = await cdp(tab);
    const { object } = await s.send('DOM.resolveNode', { backendNodeId });
    const r = await s.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true });
    return r.result?.value;
  };

  const driver = {
    id: 'cdp',
    available() {
      const exe = findBrowser();
      return { ok: !!exe, missing: exe ? [] : ['Chromium/Chrome/Brave (AO_BROWSER_PATH)'], exe, headless: headless() };
    },
    launch,
    async close() {
      clearTimeout(idleTimer);
      const b = browser;
      browser = null; tabs.clear(); active = null;
      if (b) await b.close().catch(() => {});
      return { ok: true }; // el perfil NO se borra
    },
    isOpen: () => !!browser,

    tabs: {
      async list() { await ready(); return Promise.all([...tabs.values()].map(info)); },
      async new({ url } = {}) {
        await ready();
        const page = await browser.newPage();
        const tab = register(page);
        active = tab;
        if (url) await page.goto(checkUrl(url), { waitUntil: 'domcontentloaded' });
        return info(tab);
      },
      async select({ id }) { await ready(); const t = pick(id); active = t; await t.page.bringToFront(); return info(t); },
      async close({ id } = {}) {
        await ready();
        const t = id ? pick(id) : await cur();
        await t.page.close();
        return { ok: true, id: t.id, tabs: tabs.size };
      },
    },

    async navigate({ url }) {
      const tab = await cur();
      await tab.page.goto(checkUrl(url), { waitUntil: 'domcontentloaded' });
      return navInfo(tab);
    },
    async back() { const t = await cur(); await t.page.goBack({ waitUntil: 'domcontentloaded' }); return navInfo(t); },
    async forward() { const t = await cur(); await t.page.goForward({ waitUntil: 'domcontentloaded' }); return navInfo(t); },
    async reload() { const t = await cur(); await t.page.reload({ waitUntil: 'domcontentloaded' }); return navInfo(t); },

    // Árbol de accesibilidad compacto con refs estables (e1, e2…) por pestaña, incluidos los iframes.
    async snapshot() {
      const tab = await cur();
      const s = await cdp(tab);
      const frames = [];
      const walk = (n) => { frames.push(n.frame); (n.childFrames || []).forEach(walk); };
      walk((await s.send('Page.getFrameTree')).frameTree);
      const out = [];
      for (const [i, f] of frames.entries()) {
        let nodes;
        try { nodes = (await s.send('Accessibility.getFullAXTree', { frameId: f.id })).nodes; } catch { continue; }
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));
        for (const n of nodes) {
          const role = n.role?.value;
          if (n.ignored || !role || SKIP_ROLES.has(role) || n.backendDOMNodeId == null) continue;
          const name = clip(String(n.name?.value ?? '').replace(/\s+/g, ' ').trim());
          const value = n.value?.value != null ? clip(String(n.value.value), 200) : '';
          if (!INTERACTIVE.has(role) && !name && !value && !/^(heading|img|image|table|form|dialog|alert|main|navigation)$/.test(role)) continue;
          if (role === 'StaticText') { // texto ya recogido por su padre (enlace, botón, encabezado…)
            const p = byId.get(n.parentId);
            if (p && String(p.name?.value ?? '').includes(name)) continue;
          }
          const states = [];
          for (const p of n.properties || []) {
            if (!STATE_PROPS.includes(p.name)) continue;
            const v = p.value?.value;
            if (v === true) states.push(p.name); else if (v === 'mixed' || v === 'true') states.push(`${p.name}=${v}`);
          }
          const key = `${f.id}:${n.backendDOMNodeId}`;
          let ref = tab.rev.get(key);
          if (!ref) { ref = `e${++tab.refSeq}`; tab.rev.set(key, ref); tab.refs.set(ref, { backendNodeId: n.backendDOMNodeId, frameId: f.id }); }
          out.push({ ref, role, name, value, states, ...(i ? { frame: f.url } : {}) });
        }
      }
      const max = MAX_NODES();
      return { tabId: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => ''), nodes: out.slice(0, max), total: out.length, truncated: out.length > max, omitted: Math.max(0, out.length - max) };
    },

    // action: click | dblclick | hover | focus | select (value)
    async act({ ref, x, y, action = 'click', value, button = 'left' } = {}) {
      const tab = await cur();
      const t = await target(tab, { ref, x, y });
      const m = tab.page.mouse;
      if (action === 'hover') await m.move(t.x, t.y);
      else if (action === 'click') await m.click(t.x, t.y, { button });
      else if (action === 'dblclick') await m.click(t.x, t.y, { clickCount: 2 });
      else if (action === 'focus') { if (t.backendNodeId) await (await cdp(tab)).send('DOM.focus', { backendNodeId: t.backendNodeId }); else await m.click(t.x, t.y); }
      else if (action === 'select') {
        if (!t.backendNodeId) throw bad(400, 'select requiere ref');
        const ok = await callOn(tab, t.backendNodeId, `function(v){ if(this.tagName!=='SELECT') return false; const o=[...this.options].find(o=>o.value===v||o.text===v); if(!o) return false; this.value=o.value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true; }`, String(value));
        if (!ok) throw bad(400, `no puedo seleccionar «${value}»`);
      } else throw bad(400, `acción desconocida: ${action}`);
      return { ok: true, via: t.via, ...(await navInfo(tab)) };
    },

    // Escribe en el nodo (ref) o en el foco actual; clear vacía antes; submit pulsa Enter; key pulsa una tecla.
    async type({ ref, x, y, text = '', clear = false, submit = false, key } = {}) {
      const tab = await cur();
      if (ref || x != null) {
        const t = await target(tab, { ref, x, y });
        if (t.backendNodeId) await (await cdp(tab)).send('DOM.focus', { backendNodeId: t.backendNodeId }).catch(() => tab.page.mouse.click(t.x, t.y));
        else await tab.page.mouse.click(t.x, t.y);
        if (clear) {
          if (t.backendNodeId) await callOn(tab, t.backendNodeId, `function(){ if('value' in this){ this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); } else if(this.isContentEditable){ this.textContent=''; } }`);
          else { await tab.page.keyboard.down('Control'); await tab.page.keyboard.press('KeyA'); await tab.page.keyboard.up('Control'); await tab.page.keyboard.press('Backspace'); }
        }
      }
      if (text) await tab.page.keyboard.type(String(text));
      if (key) await tab.page.keyboard.press(key);
      if (submit) await tab.page.keyboard.press('Enter');
      return { ok: true, ...(await navInfo(tab)) };
    },

    // Scroll de la rueda sobre un nodo/punto (centro del viewport por defecto); devuelve la posición resultante.
    async scroll({ ref, x, y, dx = 0, dy = 0 } = {}) {
      const tab = await cur();
      if (ref || x != null) { const t = await target(tab, { ref, x, y }); await tab.page.mouse.move(t.x, t.y); }
      else await tab.page.mouse.move(400, 300);
      if (dx || dy) await tab.page.mouse.wheel({ deltaX: Number(dx), deltaY: Number(dy) });
      else if (!ref) throw bad(400, 'indica dx/dy o ref');
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, scrollX: await tab.page.evaluate('Math.round(scrollX)'), scrollY: await tab.page.evaluate('Math.round(scrollY)') };
    },

    // PNG/JPEG reducido a ≤1280 px de ancho en data/browser/captures
    async screenshot({ format = 'png', fullPage = false } = {}) {
      const tab = await cur();
      const s = await cdp(tab);
      const m = await s.send('Page.getLayoutMetrics');
      const vp = m.cssVisualViewport || m.visualViewport;
      const w = fullPage ? m.cssContentSize.width : vp.clientWidth;
      const h = fullPage ? m.cssContentSize.height : vp.clientHeight;
      const scale = Math.min(1, MAX_SHOT_WIDTH / w);
      const fmt = format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png';
      const { data } = await s.send('Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? 70 : undefined, captureBeyondViewport: fullPage, clip: { x: fullPage ? 0 : vp.pageX, y: fullPage ? 0 : vp.pageY, width: w, height: h, scale } });
      return { ...saveShot(Buffer.from(data, 'base64'), fmt, tab.id), width: Math.round(w * scale), height: Math.round(h * scale), tabId: tab.id };
    },

    // FT-117 · Caja (viewport, px CSS) de un ref o de un punto: para la marca visual del panel. null si no hay.
    async box({ ref, x, y } = {}) {
      const tab = await cur();
      const e = ref && tab.refs.get(ref);
      if (e) {
        try {
          const s = await cdp(tab);
          const { quads } = await s.send('DOM.getContentQuads', { backendNodeId: e.backendNodeId });
          const q = quads.find((k) => k.length === 8);
          if (q) {
            const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
            const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
            if (r.w > 0 && r.h > 0) return r;
          }
        } catch { /* nodo desaparecido */ }
      }
      return x != null && y != null ? { x: Number(x) - 12, y: Number(y) - 12, w: 24, h: 24 } : null;
    },

    // FT-117 · Screencast en vivo de la pestaña activa (Page.startScreencast), ≤10 fps; sigue a la pestaña activa.
    // onFrame({mime, data(base64), w, h, tabId, url}); devuelve stop().
    async screencast(onFrame, { fps = 10 } = {}) {
      await ready();
      const gap = 1000 / Math.min(10, Math.max(1, fps));
      let stopped = false, att = null, last = 0, pending = null, flush = null;
      const emit = (f) => { last = Date.now(); pending = null; try { onFrame(f); } catch { /* el consumidor se ocupa */ } };
      const detach = async () => { const a = att; att = null; if (a) { await a.s.send('Page.stopScreencast').catch(() => {}); await a.s.detach().catch(() => {}); } };
      const attach = async (tab) => {
        await detach();
        if (!tab) return;
        const s = await tab.page.createCDPSession();
        const a = { tab, s };
        s.on('Page.screencastFrame', (fr) => {
          s.send('Page.screencastFrameAck', { sessionId: fr.sessionId }).catch(() => {});
          const f = { mime: 'image/jpeg', data: fr.data, w: Math.round(fr.metadata.deviceWidth), h: Math.round(fr.metadata.deviceHeight), tabId: tab.id, url: tab.page.url() };
          const wait = gap - (Date.now() - last);
          if (wait <= 0) return emit(f);
          pending = f; // el último fotograma no se pierde: sale al cumplirse el hueco
          if (!flush) flush = setTimeout(() => { flush = null; if (pending && !stopped) emit(pending); }, wait);
        });
        await s.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
        att = a;
      };
      await attach(active);
      const watch = setInterval(() => { if (stopped) return; if (!browser) return stop(); if ((att?.tab || null) !== active) attach(active).catch(() => {}); }, 200);
      function stop() { if (stopped) return; stopped = true; clearInterval(watch); clearTimeout(flush); detach().catch(() => {}); }
      return stop;
    },

    async evaluate({ expression }) {
      if (!expression) throw bad(400, 'falta expression');
      const tab = await cur();
      try { return { value: await tab.page.evaluate(String(expression)) }; } catch (e) { throw bad(422, `evaluate: ${String(e.message).split('\n')[0]}`); }
    },

    async console({ limit = 50, clear = false } = {}) {
      const tab = await cur();
      const r = tab.console.slice(-limit);
      if (clear) tab.console.length = 0;
      return { tabId: tab.id, entries: r };
    },
    async network({ limit = 50, clear = false } = {}) {
      const tab = await cur();
      const r = tab.network.slice(-limit);
      if (clear) tab.network.length = 0;
      return { tabId: tab.id, entries: r };
    },

    // Espera a: text (visible en la página), selector, url (subcadena) o ms fijos.
    async waitFor({ text, selector, url, ms, timeout = 10000 } = {}) {
      const tab = await cur();
      const o = { timeout: Number(timeout) };
      try {
        if (text) await tab.page.waitForFunction((t) => document.body?.innerText.includes(t), o, String(text));
        else if (selector) await tab.page.waitForSelector(String(selector), o);
        else if (url) await tab.page.waitForFunction((u) => location.href.includes(u), o, String(url));
        else await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 500, 30000)));
      } catch (e) {
        if (e?.name === 'TimeoutError') throw bad(408, 'tiempo de espera agotado');
        throw e;
      }
      return { ok: true, ...(await navInfo(tab)) };
    },
  };
  return driver;
}
