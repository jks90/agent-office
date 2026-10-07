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
    // FT-130: un nodo interno de un <input> nativo (spinbutton de date/time…) actúa sobre el input anfitrión
    const wrapped = `function(...a){ let n=this; const h=n.getRootNode&&n.getRootNode().host; if(h&&h.tagName==='INPUT') n=h; return (${fn}).apply(n,a); }`;
    const r = await s.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: wrapped, arguments: args.map((value) => ({ value })), returnByValue: true });
    return r.result?.value;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // FT-130 · funciones que corren en la página sobre el nodo (this)
  const KIND_FN = `function(){ const t=this.tagName, ty=(this.type||'').toLowerCase(); const sub=(t==='BUTTON'&&ty!=='button'&&ty!=='reset')||(t==='INPUT'&&(ty==='submit'||ty==='image'))||(t==='A'&&!!this.href); return { tag:t, type:ty, multiple:!!this.multiple, ce:!!this.isContentEditable&&t!=='INPUT'&&t!=='TEXTAREA', submit:sub }; }`;
  const NATIVE_SET_FN = `function(v){ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(this,v); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return { ok: this.value!==''||v==='', value:this.value }; }`;
  const SELECT_FN = `function(vals){ if(this.tagName!=='SELECT') return { ok:false, error:'no es un <select>' }; const opts=[...this.options]; const pick=(v)=>opts.find(o=>o.value===v)||opts.find(o=>o.text.trim()===String(v).trim()); let want=vals.map(String); if(this.multiple&&want.length===1&&!pick(want[0])&&want[0].includes('|')) want=want[0].split('|').map(x=>x.trim()); const found=want.map(pick); const missing=want.filter((_,i)=>!found[i]); if(missing.length) return { ok:false, error:'no existe la opción: '+missing.join(', '), options:opts.slice(0,30).map(o=>o.text.trim()) }; if(this.multiple) opts.forEach(o=>{o.selected=found.includes(o)}); else this.value=found[0].value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return { ok:true, selected:[...this.selectedOptions].map(o=>o.text.trim()) }; }`;
  const CARET_FN = `function(clear){ if(this.isContentEditable&&this.tagName!=='INPUT'&&this.tagName!=='TEXTAREA'){ const r=document.createRange(); r.selectNodeContents(this); const s=getSelection(); s.removeAllRanges(); s.addRange(r); if(!clear) s.collapseToEnd(); return; } try{ if(clear) this.select(); else this.setSelectionRange(this.value.length,this.value.length); }catch{} }`;
  const VALID_FN = `function(){ const f=this&&(this.form||(this.closest&&this.closest('form'))); if(!f||f.checkValidity()) return null; return [...f.elements].filter(e=>e.willValidate&&!e.checkValidity()).slice(0,20).map(e=>({ field:(e.labels&&e.labels[0]?e.labels[0].textContent.trim():'')||e.getAttribute('aria-label')||e.name||e.id||e.type, type:e.type, message:e.validationMessage })); }`;

  // Observa navegación y cambios del DOM tras una acción; settle(max) espera a lo primero que ocurra (hasta max ms).
  async function watch(tab) {
    const st = { nav: false, url0: tab.page.url() };
    const on = (f) => { if (f === tab.page.mainFrame()) st.nav = true; };
    tab.page.on('framenavigated', on);
    await tab.page.evaluate('(()=>{window.__aoM=0;try{new MutationObserver(()=>{window.__aoM++}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true})}catch{}})()').catch(() => {});
    return {
      async settle(max, grace = 300) {
        const t0 = Date.now();
        try {
          for (;;) {
            if (st.nav) break;
            const m = await tab.page.evaluate('window.__aoM').catch(() => undefined);
            if (m === undefined) { st.nav = true; break; } // el documento cambió bajo nuestros pies
            if (m > 0) { await sleep(grace); break; }
            if (Date.now() - t0 >= max) break;
            await sleep(100);
          }
          if (st.nav) await tab.page.waitForFunction('document.readyState!=="loading"', { timeout: 4000 }).catch(() => {});
        } finally { tab.page.off('framenavigated', on); }
        return st.nav || tab.page.url() !== st.url0;
      },
    };
  }
  // Resultado común: {navigated, url, title} y, si un envío no navegó, los errores de validación del formulario.
  async function outcome(tab, w, { long = false, backendNodeId } = {}) {
    const navigated = await w.settle(long ? 5000 : 300, long ? 700 : 250);
    const r = { navigated, ...(await navInfo(tab)) };
    if (long && !navigated) {
      let v = null;
      try { v = backendNodeId ? await callOn(tab, backendNodeId, VALID_FN) : await tab.page.evaluate(`(${VALID_FN}).call(document.activeElement)`); } catch { /* nodo desaparecido */ }
      if (v?.length) { r.submitted = false; r.validation = v; r.hint = 'El formulario no se envió: corrige los campos de «validation» y vuelve a pulsar enviar.'; }
    }
    return r;
  }
  // Rellena un campo según su tipo (date/time/range/color…, select, checkbox, contenteditable, texto) disparando input/change.
  async function fill(tab, backendNodeId, text, clear) {
    const s = await cdp(tab);
    const k = await callOn(tab, backendNodeId, KIND_FN);
    if (!k) throw bad(404, 'el nodo ya no existe (haz un snapshot nuevo)');
    if (k.type === 'file') throw bad(400, 'es un campo de fichero: usa browser.upload');
    if (k.tag === 'SELECT') { const r = await callOn(tab, backendNodeId, SELECT_FN, [String(text)]); if (!r?.ok) throw bad(400, `${r?.error || 'no puedo seleccionar'}${r?.options ? ` (opciones: ${r.options.join(' | ')})` : ''}`); return; }
    if (k.type === 'checkbox' || k.type === 'radio') {
      const want = !/^(false|0|off|no|desmarcado)$/i.test(String(text).trim());
      const on = await callOn(tab, backendNodeId, 'function(){ return this.checked; }');
      if (on !== want) await callOn(tab, backendNodeId, 'function(){ this.click(); }');
      return;
    }
    if (['date', 'time', 'datetime-local', 'month', 'week', 'range', 'color'].includes(k.type)) {
      const r = await callOn(tab, backendNodeId, NATIVE_SET_FN, String(text));
      if (!r?.ok) throw bad(400, `valor no válido para ${k.type}: «${text}» (formato: ${({ date: 'AAAA-MM-DD', time: 'HH:MM', 'datetime-local': 'AAAA-MM-DDTHH:MM', month: 'AAAA-MM', week: 'AAAA-Www', color: '#rrggbb', range: 'número' })[k.type]})`);
      return;
    }
    await s.send('DOM.focus', { backendNodeId });
    await callOn(tab, backendNodeId, CARET_FN, !!clear);
    if (text) await s.send('Input.insertText', { text: String(text) });
    else if (clear) await tab.page.keyboard.press('Backspace');
  }

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

    // action: click | dblclick | hover | focus | select (value; array o «a|b» en <select multiple>)
    async act({ ref, x, y, action = 'click', value, button = 'left' } = {}) {
      const tab = await cur();
      const t = await target(tab, { ref, x, y });
      const m = tab.page.mouse;
      let long = false;
      if (action === 'click' && t.backendNodeId) long = !!(await callOn(tab, t.backendNodeId, KIND_FN).catch(() => null))?.submit;
      const w = await watch(tab);
      try {
        if (action === 'hover') await m.move(t.x, t.y);
        else if (action === 'click') await m.click(t.x, t.y, { button });
        else if (action === 'dblclick') await m.click(t.x, t.y, { clickCount: 2 });
        else if (action === 'focus') { if (t.backendNodeId) await (await cdp(tab)).send('DOM.focus', { backendNodeId: t.backendNodeId }); else await m.click(t.x, t.y); }
        else if (action === 'select') {
          if (!t.backendNodeId) throw bad(400, 'select requiere ref');
          const r = await callOn(tab, t.backendNodeId, SELECT_FN, Array.isArray(value) ? value : [value]);
          if (!r?.ok) throw bad(400, `${r?.error || `no puedo seleccionar «${value}»`}${r?.options ? ` (opciones: ${r.options.join(' | ')})` : ''}`);
        } else throw bad(400, `acción desconocida: ${action}`);
      } catch (e) { await w.settle(0).catch(() => {}); throw e; }
      return { ok: true, via: t.via, ...(await outcome(tab, w, { long, backendNodeId: t.backendNodeId })) };
    },

    // Escribe en el nodo (ref) o en el foco actual, según el tipo de campo (FT-130); clear vacía antes; submit pulsa Enter; key pulsa una tecla.
    async type({ ref, x, y, text = '', clear = false, submit = false, key } = {}) {
      const tab = await cur();
      const s = await cdp(tab);
      let t = null;
      if (ref || x != null) {
        t = await target(tab, { ref, x, y });
        if (t.backendNodeId) { if (text || clear) await fill(tab, t.backendNodeId, text, clear); else await s.send('DOM.focus', { backendNodeId: t.backendNodeId }).catch(() => tab.page.mouse.click(t.x, t.y)); }
        else {
          await tab.page.mouse.click(t.x, t.y);
          if (clear) { await tab.page.keyboard.down('Control'); await tab.page.keyboard.press('KeyA'); await tab.page.keyboard.up('Control'); await tab.page.keyboard.press('Backspace'); }
          if (text) await s.send('Input.insertText', { text: String(text) });
        }
      } else if (text) await s.send('Input.insertText', { text: String(text) });
      const enter = submit || /^(enter|numpadenter)$/i.test(key || '');
      const w = await watch(tab);
      if (key) await tab.page.keyboard.press(key);
      if (submit) await tab.page.keyboard.press('Enter');
      return { ok: true, ...(await outcome(tab, w, { long: enter, backendNodeId: t?.backendNodeId })) };
    },

    // FT-130 · Sube ficheros a un <input type=file> (DOM.setFileInputFiles: dispara input/change). `files`: rutas absolutas ya validadas.
    async upload({ ref, files = [] } = {}) {
      if (!ref) throw bad(400, 'falta ref del campo de fichero');
      if (!files.length) throw bad(400, 'faltan ficheros');
      const tab = await cur();
      const e = tab.refs.get(ref);
      if (!e) throw bad(404, `ref ${ref} desconocido (haz un snapshot nuevo)`);
      const k = await callOn(tab, e.backendNodeId, KIND_FN);
      if (k?.type !== 'file') throw bad(400, `${ref} no es un <input type=file>`);
      if (files.length > 1 && !(await callOn(tab, e.backendNodeId, 'function(){ return this.multiple; }'))) throw bad(400, 'el campo no admite varios ficheros');
      await (await cdp(tab)).send('DOM.setFileInputFiles', { files, backendNodeId: e.backendNodeId });
      return { ok: true, files: files.map((f) => f.split('/').pop()), ...(await navInfo(tab)) };
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
