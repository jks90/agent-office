#!/usr/bin/env node
// Servidor MCP por stdio del Guide Agent (FT-4): JSON-RPC 2.0, un mensaje por línea, sin dependencias.
// Solo hace de puente: tools/list → GET /api/guide/tools · tools/call → POST /api/guide/tool (ahí viven la política y la auditoría).
//
//   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/ao-mcp.mjs
//   claude -p --mcp-config '{"mcpServers":{"agentoffice":{"command":"node","args":["bin/ao-mcp.mjs"],"env":{"AO_URL":"http://127.0.0.1:7420"}}}}'
//
// Entorno: AO_URL (por defecto http://127.0.0.1:7420), AO_TOKEN (opcional, solo fuera del loopback), AO_CHAT_ID (chat del Guide, FT-22: clave de confirmOnce).
// Los nombres MCP no admiten «.» (^[a-zA-Z0-9_-]+$): `task.create` se publica como `task_create` y se traduce al llamar.
import readline from 'node:readline';
import http from 'node:http';
import https from 'node:https';

const base = (process.env.AO_URL || 'http://127.0.0.1:7420').replace(/\/$/, '');
const headers = { 'content-type': 'application/json', 'x-ao-via': 'mcp', ...(process.env.AO_CHAT_ID ? { 'x-ao-chat': process.env.AO_CHAT_ID } : {}), ...(process.env.AO_TOKEN ? { 'x-ao-token': process.env.AO_TOKEN } : {}) };
const PROTOCOL = '2025-06-18';
const mcpName = (n) => n.replace(/\./g, '_');

// FT-128 · Con node:http y sin timeouts propios: fetch (undici) corta a los 300 s sin cabeceras, y una confirmación 🛡
// puede tardar más. El tope lo pone AO_MCP_TOOL_TIMEOUT_MS (por defecto 30 min, mayor que el de la confirmación en el servidor).
const TOOL_TIMEOUT_MS = Number(process.env.AO_MCP_TOOL_TIMEOUT_MS) || 30 * 60_000;
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const data = body ? JSON.stringify(body) : undefined;
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: data ? { ...headers, 'content-length': Buffer.byteLength(data) } : headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* cuerpo no JSON */ }
        if (res.statusCode >= 400) reject(Object.assign(new Error(j.error || `${res.statusCode} ${path}`), { status: res.statusCode }));
        else resolve(j);
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('el usuario no ha contestado a la confirmación (tiempo agotado)'), { status: 408 })), TOOL_TIMEOUT_MS);
    timer.unref?.();
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(data);
  });
}

let catalog = null; // nombre MCP → tool de AgentOffice
async function tools() {
  // FT-115 · AO_MCP_ONLY=browser (agentes worker con la capacidad «browser»): solo browser.* salvo browser.open (xdg-open en el escritorio del usuario)
  const only = process.env.AO_MCP_ONLY === 'browser' ? (t) => t.name.startsWith('browser.') && t.name !== 'browser.open' : () => true;
  catalog = new Map((await api('GET', '/api/guide/tools')).filter(only).map((t) => [mcpName(t.name), t]));
  return [...catalog.entries()].map(([name, t]) => ({
    name, description: `[${t.policy}] ${t.description}`, inputSchema: t.input,
  }));
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notificaciones (notifications/initialized…): sin respuesta
  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'agentoffice-guide', version: '0.1.0' } });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      try { return ok(id, { tools: await tools() }); } catch (e) { return err(id, -32603, `AgentOffice no responde en ${base}: ${e.message}`); }
    case 'tools/call': {
      try {
        if (!catalog) await tools();
        const tool = catalog.get(params.name);
        if (!tool) return err(id, -32602, `Tool desconocida: ${params.name}`);
        const out = await api('POST', '/api/guide/tool', { name: tool.name, args: params.arguments || {} });
        // FT-115 · browser.screenshot: la imagen va como contenido MCP `image` (base64) para que el modelo la vea; el resto, como texto
        const { image, ...rest } = out && typeof out === 'object' ? out : { value: out };
        const content = [{ type: 'text', text: JSON.stringify(image ? rest : out, null, 2) }];
        if (image?.data) content.push({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' });
        return ok(id, { content });
      } catch (e) {
        // Fallos de la tool (403 rechazada, 501 pendiente, 404…) son resultados con isError para que el modelo los vea.
        return ok(id, { content: [{ type: 'text', text: `Error${e.status ? ' ' + e.status : ''}: ${e.message}` }], isError: true });
      }
    }
    default:
      return err(id, -32601, `Método no soportado: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
const inflight = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = (async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return process.stdout.write(JSON.stringify(err(null, -32700, 'JSON inválido')) + '\n'); }
    const res = await handle(msg).catch((e) => err(msg.id ?? null, -32603, e.message));
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  })().finally(() => inflight.delete(p));
  inflight.add(p);
});
// Al cerrarse stdin esperamos a las llamadas en curso (una confirmación del usuario puede tardar minutos).
rl.on('close', () => Promise.allSettled([...inflight]).then(() => process.exit(0)));
