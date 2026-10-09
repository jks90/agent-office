// Cliente de SSE por WebSocket con la interfaz de EventSource (addEventListener, onopen/onerror/onmessage, readyState,
// close). Si el WebSocket no llega a abrir (proxy sin WebSocket, p. ej. una pasarela del cloud) vuelve a EventSource y lo
// recuerda en la sesión. Ver ws-sse.js en el servidor.
const NO_WS_KEY = 'ws-sse:off';
const noWs = () => { try { return sessionStorage.getItem(NO_WS_KEY) === '1'; } catch { return false; } };
const markNoWs = () => { try { sessionStorage.setItem(NO_WS_KEY, '1'); } catch { /* sin almacenamiento */ } };

class WsEventSource {
  constructor(url) {
    this.url = new URL(url, location.href).href;
    this.readyState = 0;
    this.onopen = null; this.onerror = null; this.onmessage = null;
    this._ls = new Map(); this._buf = ''; this._es = null; this._closed = false;
    this._connect();
  }
  addEventListener(type, fn) {
    if (!this._ls.has(type)) this._ls.set(type, new Set());
    this._ls.get(type).add(fn);
    if (this._es) this._es.addEventListener(type, fn);
  }
  removeEventListener(type, fn) { this._ls.get(type)?.delete(fn); if (this._es) this._es.removeEventListener(type, fn); }
  close() { this._closed = true; this.readyState = 2; try { this._ws?.close(); } catch { /* ya cerrado */ } this._es?.close(); }
  _emit(type, data) {
    const ev = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    const prop = this['on' + type]; if (typeof prop === 'function') prop.call(this, ev);
    for (const fn of this._ls.get(type) || []) fn.call(this, ev);
  }
  _dispatch(block) {
    let type = 'message'; const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':'), k = i < 0 ? line : line.slice(0, i), v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (k === 'event') type = v; else if (k === 'data') data.push(v);
    }
    if (type === '__http_error') { this._httpError = true; return; }
    if (data.length || type !== 'message') this._emit(type, data.join('\n'));
  }
  _connect() {
    const u = new URL(this.url); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false, ws;
    try { ws = this._ws = new WebSocket(u.href); } catch { return this._fallback(); }
    const t = setTimeout(() => { if (!opened) { ws.onclose = null; try { ws.close(); } catch { /* */ } this._fallback(); } }, 4000);
    ws.onopen = () => { opened = true; clearTimeout(t); if (this._closed) return ws.close(); this.readyState = 1; this._emit('open'); };
    ws.onmessage = (m) => {
      this._buf += typeof m.data === 'string' ? m.data : '';
      let i;
      while ((i = this._buf.indexOf('\n\n')) >= 0) { const b = this._buf.slice(0, i); this._buf = this._buf.slice(i + 2); this._dispatch(b); }
    };
    ws.onclose = () => {
      clearTimeout(t);
      if (this._closed) return;
      if (!opened) return this._fallback(); // nunca abrió: este camino no admite WebSocket
      this.readyState = 2; this._emit('error'); // como EventSource cerrado: quien lo usa decide si reconecta
    };
  }
  _fallback() {
    if (this._closed || this._es) return;
    markNoWs();
    const es = this._es = new EventSource(this.url);
    for (const [type, set] of this._ls) for (const fn of set) es.addEventListener(type, fn);
    es.onopen = (e) => { this.readyState = 1; this.onopen?.call(this, e); };
    es.onerror = (e) => { this.readyState = es.readyState; this.onerror?.call(this, e); };
    es.onmessage = (e) => this.onmessage?.call(this, e);
  }
}
WsEventSource.CONNECTING = 0; WsEventSource.OPEN = 1; WsEventSource.CLOSED = 2;

// Abre un flujo de eventos: por WebSocket si se puede, si no EventSource normal.
export function openEventStream(url) {
  if (typeof WebSocket === 'undefined' || noWs()) return new EventSource(url);
  return new WsEventSource(url);
}
