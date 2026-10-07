// FT-118 · Mínimo servidor WebSocket (RFC 6455) sin dependencias: solo lo que necesita la extensión.
// Mensajes de texto, ping/pong y cierre; sin extensiones ni fragmentación saliente.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 32 * 1024 * 1024; // capturas en base64

// Acepta el `upgrade` y devuelve { send(str), close(), onMessage(fn), onClose(fn) }.
export function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
  socket.setNoDelay(true);
  let msgFn = () => {}, closeFn = () => {}, buf = Buffer.alloc(0), closed = false;
  const frame = (op, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    return Buffer.concat([head, payload]);
  };
  const end = () => { if (!closed) { closed = true; closeFn(); } };
  const conn = {
    send: (s) => { if (!closed) socket.write(frame(1, Buffer.from(String(s)))); },
    close: () => { if (!closed) { try { socket.write(frame(8, Buffer.alloc(0))); } catch { /* ya cerrado */ } socket.end(); end(); } },
    onMessage: (fn) => { msgFn = fn; },
    onClose: (fn) => { closeFn = fn; },
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = !!(buf[1] & 128);
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) { socket.destroy(); return end(); }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const m = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(off + (masked ? 4 : 0) + len);
      if (op === 1) msgFn(payload.toString('utf8'));
      else if (op === 9) socket.write(frame(10, payload));
      else if (op === 8) return conn.close();
    }
  });
  socket.on('close', end);
  socket.on('error', end);
  return conn;
}
