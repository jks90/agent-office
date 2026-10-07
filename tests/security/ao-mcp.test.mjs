// FT-161 · puente MCP bin/ao-mcp.mjs: JSON-RPC por stdio contra un AgentOffice simulado en loopback (sin red externa).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ao-mcp.mjs');
const CATALOG = [
  { name: 'task.create', policy: 'write', description: 'crea', input: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } },
  { name: 'browser.screenshot', policy: 'read', description: 'foto', input: { type: 'object' } },
  { name: 'browser.open', policy: 'navigate', description: 'abre', input: { type: 'object' } },
  { name: 'browser.click', policy: 'execute', description: 'clic', input: { type: 'object' } },
];
const seen = [];
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ url: req.url, headers: req.headers, body });
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
    if (req.url === '/api/guide/tools') return send(200, CATALOG);
    if (req.url === '/api/guide/tool') {
      const { name, args } = body;
      if (name === 'task.create' && typeof args.title !== 'string') return send(400, { error: 'title es obligatorio' });
      if (name === 'browser.click') return send(403, { error: 'rechazada por el usuario' });
      if (name === 'browser.screenshot') return send(200, { ok: true, image: { data: 'QUJD', mimeType: 'image/png' } });
      return send(200, { ok: true, args });
    }
    send(500, 'no es json');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;

// Lanza el puente, envía líneas y devuelve las respuestas (una por línea) al cerrar stdin.
function talk(lines, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [MCP], { env: { ...process.env, AO_URL: URL_, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    p.on('error', reject);
    setTimeout(() => p.kill(), 8000).unref();
    p.stdin.end(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  });
}
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('tools/list publica los nombres sin punto y con la política en la descripción', async () => {
  const [r] = await talk([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.deepEqual(r.result.tools.map((t) => t.name), ['task_create', 'browser_screenshot', 'browser_open', 'browser_click']);
  assert.match(r.result.tools[0].description, /^\[write\]/);
});

test('AO_MCP_ONLY=browser: solo browser.*, sin browser.open', async () => {
  const [r] = await talk([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { AO_MCP_ONLY: 'browser' });
  assert.deepEqual(r.result.tools.map((t) => t.name), ['browser_screenshot', 'browser_click']);
  const [c] = await talk([call(2, 'task_create', { title: 'x' })], { AO_MCP_ONLY: 'browser' });
  assert.equal(c.error.code, -32602, 'una tool fuera del ámbito no se puede llamar');
});

test('tool desconocida o sin nombre → error -32602', async () => {
  const rs = await talk([call(1, 'no_existe', {}), call(2, undefined, {}), call(3, 42, {}), { jsonrpc: '2.0', id: 4, method: 'tools/call' }]);
  assert.equal(rs.length, 4);
  for (const r of rs) assert.equal(r.error.code, -32602);
});

test('argumentos inválidos: el 400 del servidor llega como isError, no como caída', async () => {
  const rs = await talk([call(1, 'task_create', {}), call(2, 'task_create', { title: 5 }), call(3, 'task_create', null), call(4, 'task_create')]);
  for (const r of rs) { assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /^Error 400: title es obligatorio/); }
});

test('rechazo del usuario (403) se devuelve como isError con el código', async () => {
  const [r] = await talk([call(1, 'browser_click', { ref: 'e1' })]);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Error 403/);
});

test('tools/call correcta: traduce el nombre, reenvía args y cabeceras x-ao-via / chat / token', async () => {
  seen.length = 0;
  const [r] = await talk([call(1, 'task_create', { title: 'hola' })], { AO_CHAT_ID: 'chat9', AO_TOKEN: 'tok' });
  assert.equal(r.result.isError, undefined);
  const post = seen.find((s) => s.url === '/api/guide/tool');
  assert.deepEqual(post.body, { name: 'task.create', args: { title: 'hola' } });
  assert.equal(post.headers['x-ao-via'], 'mcp');
  assert.equal(post.headers['x-ao-chat'], 'chat9');
  assert.equal(post.headers['x-ao-token'], 'tok');
});

test('sin AO_TOKEN no se envía x-ao-token', async () => {
  seen.length = 0;
  await talk([call(1, 'task_create', { title: 'a' })], { AO_TOKEN: '' });
  assert.equal(seen.at(-1).headers['x-ao-token'], undefined);
});

test('browser.screenshot: la imagen va como contenido image y no dentro del texto', async () => {
  const [r] = await talk([call(1, 'browser_screenshot', {})]);
  const [text, img] = r.result.content;
  assert.equal(img.type, 'image'); assert.equal(img.data, 'QUJD'); assert.equal(img.mimeType, 'image/png');
  assert.ok(!text.text.includes('QUJD'));
});

test('JSON inválido, método desconocido y líneas vacías no tumban el puente', async () => {
  const rs = await talk(['{no json', '', '   ', { jsonrpc: '2.0', id: 7, method: 'cosa/rara' }, { jsonrpc: '2.0', id: 8, method: 'ping' }, '[1,2]']);
  assert.equal(rs[0].error.code, -32700); assert.equal(rs[0].id, null);
  assert.equal(rs.find((r) => r.id === 7).error.code, -32601);
  assert.deepEqual(rs.find((r) => r.id === 8).result, {});
});

test('línea JSON null no debe tumbar el puente', { todo: 'BUG FT-161: handle(null) lanza al desestructurar y el .catch lee msg.id de null → rechazo no capturado, el proceso muere' }, async () => {
  const rs = await talk(['null', { jsonrpc: '2.0', id: 9, method: 'ping' }]);
  assert.ok(rs.some((r) => r.id === 9));
});

test('notificaciones (sin id) no reciben respuesta', async () => {
  const rs = await talk([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].result.serverInfo.name, 'agentoffice-guide');
});

test('AgentOffice caído: tools/list devuelve error -32603 y tools/call isError', async () => {
  const [a, b] = await talk([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'task_create', { title: 'x' })], { AO_URL: 'http://127.0.0.1:9' });
  assert.equal(a.error.code, -32603);
  assert.equal(b.result.isError, true);
});

test.after(() => srv.close());
