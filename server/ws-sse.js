// SSE por WebSocket (oct-2026, mismo adaptador que flow-test server/ws-sse.js). Chrome solo admite 6 conexiones HTTP/1.1 abiertas por servidor y cada
// pestaña mantenía varias SSE permanentes (puente MCP, colaboración, eventos de AgentOffice): con dos ventanas visibles
// el cupo se agotaba y cualquier petición nueva (enviar al Guía, contestar una 🛡) se quedaba en cola dentro del navegador.
// Los WebSocket NO cuentan en ese cupo. Este adaptador acepta el `upgrade` en la MISMA ruta del SSE y se lo pasa al
// manejador HTTP de siempre con un `res` falso que reenvía cada trozo del flujo SSE como mensaje de texto: así valen todas
// las comprobaciones existentes (licencia, plan, token) y el propio proxy /agents sin cambiar nada. El cliente
// (wsEventSource) parsea el texto SSE igual que EventSource y, si el WebSocket no conecta, vuelve a EventSource.
import { PassThrough, Writable } from 'node:stream';
import { accept } from './browser/ws.js';

// Los navegadores no aplican CORS a los WebSocket: sin esto cualquier web abierta podría engancharse al puente MCP.
export function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // clientes no-navegador (curl, tests)
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

export function serveSseOverWs(req, socket, handler) {
  if (!sameOrigin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  const ws = accept(req, socket);
  if (!ws) return;
  // req falso: GET sin cuerpo que no se «cierra» solo (el 'close' de verdad lo dispara el WebSocket)
  const fakeReq = new PassThrough({ autoDestroy: false });
  Object.assign(fakeReq, { url: req.url, method: 'GET', headers: { ...req.headers, accept: 'text/event-stream' }, httpVersion: req.httpVersion, socket, connection: socket });
  delete fakeReq.headers.upgrade; delete fakeReq.headers.connection;
  fakeReq.end();
  let status = 200, gone = false;
  const res = new Writable({ write(chunk, _enc, cb) { if (status < 300) ws.send(chunk.toString()); cb(); } });
  Object.assign(res, {
    statusCode: 200, headersSent: false,
    writeHead(code) { status = code || 200; res.statusCode = status; res.headersSent = true; return res; },
    setHeader() {}, getHeader() {}, removeHeader() {}, hasHeader() { return false; }, flushHeaders() {}, writeContinue() {},
  });
  const end0 = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (chunk && typeof chunk !== 'function') {
      if (status >= 300) ws.send(`event: __http_error\ndata: ${JSON.stringify({ status, body: String(chunk).slice(0, 2000) })}\n\n`);
      else ws.send(String(chunk));
    } else if (status >= 300) ws.send(`event: __http_error\ndata: ${JSON.stringify({ status })}\n\n`);
    setImmediate(() => ws.close());
    return end0(typeof chunk === 'function' ? chunk : undefined, ...rest.filter((x) => typeof x === 'function'));
  };
  ws.onClose(() => { if (gone) return; gone = true; fakeReq.emit('aborted'); fakeReq.emit('close'); res.destroy(); });
  Promise.resolve().then(() => handler(fakeReq, res)).catch(() => ws.close());
}
