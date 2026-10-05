#!/usr/bin/env node
// Prueba de humo del Guide Agent (FT-6, ampliada en FT-8): servidor temporal con motor demo + un chat con el proveedor LLM elegido.
// Manda las frases de los flujos A-D del documento y comprueba qué tools llama y los efectos en el estado. Los TRES proveedores
// (claude-cli, anthropic-api, openai-api) pasan exactamente las mismas comprobaciones.
//
//   node scripts/guide-smoke.mjs                       # los tres proveedores contra el mock HTTP incluido (sin coste)
//   node scripts/guide-smoke.mjs --provider openai-api # solo uno
//   node scripts/guide-smoke.mjs --real                # contra el LLM de verdad (claude con sesión / claves en el entorno): gasta tokens
//   node scripts/guide-smoke.mjs --keep                # no borra los datos temporales (se imprime la ruta)
//
// El mock hace de LLM con guion: habla el protocolo de Anthropic (Messages, SSE) y el de OpenAI (Chat Completions, SSE) y decide
// la siguiente tool a partir de la frase del usuario y de los resultados ya recibidos. Los servidores arrancan con
// ANTHROPIC_BASE_URL / OPENAI_BASE_URL apuntando a él (también el `claude` que lanza claude-cli). flow-test se simula con un stub
// de `GET /access` para pasar el candado de suite. Las confirmaciones del Guide (FT-4) se contestan «Sí» sin tocar la UI.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const real = argv.includes('--real');
const only = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : null;
const ALL = ['claude-cli', 'anthropic-api', 'openai-api'];
const providers = only ? [only] : ALL;
if (providers.some((p) => !ALL.includes(p))) { console.error(`Proveedor desconocido. Usa: ${ALL.join(' | ')}`); process.exit(2); }
const CLIENT = 'smoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });

// ── Mock del LLM ────────────────────────────────────────────────────────────
// «Cerebro» neutral: dado el texto del usuario y los resultados de tools de este turno, devuelve la siguiente acción
// {call:{tool, args}} o {text}. `ctx` es el <app_context> que el Guide mete en el mensaje.
function brain(userText, results) {
  const ctx = (() => { try { return JSON.parse(userText.match(/<app_context>\n([\s\S]*?)\n<\/app_context>/)[1]); } catch { return {}; } })();
  const ask = userText.replace(/<app_context>[\s\S]*?<\/app_context>/, '').replace(/<eventos_desde_tu_ultimo_turno>[\s\S]*?<\/eventos_desde_tu_ultimo_turno>/, '').trim();
  const code = ctx.task?.code;
  const last = results.at(-1);
  const json = (r) => { try { return JSON.parse(r.content); } catch { return {}; } };
  if (/cr[eé]ame una tarea/i.test(ask)) {
    if (!results.length) return { call: { tool: 'task.create', args: { projectId: ctx.projectId, title: 'Login 500 con email en mayúsculas', description: `${ask}\n\nHecho cuando: el login acepta el email en mayúsculas.`, role: 'back' } } };
    return { text: last.isError ? `No pude crearla: ${last.content}` : `Creada ${json(last).code}: «Login 500 con email en mayúsculas», rol back.` };
  }
  if (/c[oó]mo va/i.test(ask)) {
    if (!results.length) return { call: { tool: 'task.getStatus', args: { code } } };
    return { text: `${code} está «${json(last).status}»: ${json(last).title}.` };
  }
  if (/p[aá]ralo/i.test(ask)) {
    if (!results.length) return { call: { tool: 'task.stop', args: { code } } };
    return { text: last.isError ? `No he podido pararlo, la tool respondió: ${last.content}` : `Parado el agente de ${code}.` };
  }
  if (/ens[eé][ñn]ame/i.test(ask)) {
    if (!results.length) return { call: { tool: 'agent.getModifiedFiles', args: { code } } };
    if (results.length === 1) return { call: { tool: 'app.openArtifact', args: { code } } };
    return { text: `He abierto ${code}. Ficheros modificados: ${(json(results[0]).files || []).length}.` };
  }
  return { text: 'No entiendo la petición.' };
}

// Un mock por arranque: guarda las peticiones recibidas para poder comprobar el protocolo.
function startMock() {
  const seen = { anthropic: [], openai: [] };
  const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [ev, data] of events) res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(data)}\n\n`); res.end(); };
  const srv = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let b = {}; try { b = JSON.parse(raw); } catch { /* sin cuerpo */ }
    const json = (o, s = 200) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    // — Anthropic Messages —
    if (req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
      seen.anthropic.push({ headers: req.headers, body: b });
      if (!req.headers['x-api-key']) return json({ type: 'error', error: { type: 'authentication_error', message: 'sin x-api-key' } }, 401);
      const msgs = b.messages || [];
      const blocks = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
      const at = msgs.findLastIndex((m) => m.role === 'user' && blocks(m).some((c) => c.type === 'text' && c.text.includes('<app_context>')));
      const userText = at >= 0 ? blocks(msgs[at]).filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
      // Los resultados que cuentan son los de este turno: los de mensajes posteriores a la última frase del usuario.
      const turnResults = msgs.slice(at + 1).flatMap(blocks).filter((c) => c.type === 'tool_result').map((c) => ({ content: typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text).join(''), isError: !!c.is_error }));
      if (argv.includes('--debug')) console.error('mock anthropic ←', at, turnResults.length, msgs.map((m) => `${m.role}:${blocks(m).map((c) => c.type + (c.text ? `(${c.text.slice(0, 40).replace(/\n/g, ' ')})` : '')).join('|')}`).join(' // ').slice(0, 900));
      const act = brain(userText || '', turnResults);
      const toolName = act.call && (b.tools || []).map((t) => t.name).find((n) => n === act.call.tool.replace('.', '_') || n.endsWith('__' + act.call.tool.replace('.', '_')));
      const usage = { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 };
      const content = act.call ? (toolName ? [{ type: 'tool_use', id: `toolu_${seen.anthropic.length}`, name: toolName, input: act.call.args }] : [{ type: 'text', text: `(mock) la tool ${act.call.tool} no está en la petición` }]) : [{ type: 'text', text: act.text }];
      const stop = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
      if (!b.stream) return json({ id: `msg_mock_${seen.anthropic.length}`, type: 'message', role: 'assistant', model: b.model, content, stop_reason: stop, stop_sequence: null, usage });
      const events = [['message_start', { type: 'message_start', message: { id: `msg_mock_${seen.anthropic.length}`, type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }]];
      content.forEach((c, index) => {
        if (c.type === 'text') {
          events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
          for (let i = 0; i < c.text.length; i += 12) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: c.text.slice(i, i + 12) } }]);
        } else {
          events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }]);
          const j = JSON.stringify(c.input);
          for (let i = 0; i < j.length; i += 20) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: j.slice(i, i + 20) } }]);
        }
        events.push(['content_block_stop', { type: 'content_block_stop', index }]);
      });
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }], ['message_stop', { type: 'message_stop' }]);
      return sse(res, events);
    }
    // — OpenAI Chat Completions —
    if (req.url.startsWith('/v1/chat/completions')) {
      seen.openai.push({ headers: req.headers, body: b });
      if (!/^Bearer \S+/.test(req.headers.authorization || '')) return json({ error: { message: 'sin Authorization: Bearer' } }, 401);
      const msgs = b.messages || [];
      const lastUser = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === 'user').at(-1);
      const turnResults = msgs.slice(lastUser[1] + 1).filter((m) => m.role === 'tool').map((m) => ({ content: m.content, isError: /^(El usuario rechaz|.*→ \d{3}|.*\b(501|40\d)\b)/.test(m.content) && !m.content.trim().startsWith('{') && !m.content.trim().startsWith('[') }));
      const act = brain(lastUser[0].content, turnResults);
      const chunk = (delta, finish = null, extra = {}) => [null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }];
      const events = [chunk({ role: 'assistant', content: '' })];
      if (act.call) {
        const name = (b.tools || []).map((t) => t.function.name).find((n) => n === act.call.tool.replace('.', '_'));
        const j = JSON.stringify(act.call.args);
        events.push(chunk({ tool_calls: [{ index: 0, id: `call_${seen.openai.length}`, type: 'function', function: { name, arguments: '' } }] }));
        for (let i = 0; i < j.length; i += 20) events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: j.slice(i, i + 20) } }] }));
        events.push(chunk({}, 'tool_calls'));
      } else {
        for (let i = 0; i < act.text.length; i += 12) events.push(chunk({ content: act.text.slice(i, i + 12) }));
        events.push(chunk({}, 'stop'));
      }
      events.push([null, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: b.model, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 800 } } }]);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [, d] of events) res.write(`data: ${JSON.stringify(d)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json({ error: { message: `mock: ruta no soportada ${req.url}` } }, 404);
  });
  return { srv, seen };
}

// ── Una pasada completa (A–D + persistencia) con un proveedor ───────────────
const checks = [];
const check = (label, ok, extra = '') => { checks.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); };

async function runProvider(name, { stubPort, mock }) {
  const port = 7600 + Math.floor(Math.random() * 300);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guide-smoke-'));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir };
  if (!real) {
    const m = `http://127.0.0.1:${mock.srv.address().port}`;
    Object.assign(env, { ANTHROPIC_BASE_URL: m, OPENAI_BASE_URL: `${m}/v1`, ANTHROPIC_API_KEY: 'sk-mock-anthropic', OPENAI_API_KEY: 'sk-mock-openai' });
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  for (const s of [server.stdout, server.stderr]) s.on('data', (d) => { serverLog += d; });

  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
    return j;
  };
  // Escucha el SSE global: órdenes `ui` (app.openArtifact/navigate…) que el Guide manda a la UI.
  const uiCmds = [];
  const sseAbort = new AbortController();
  const listenUi = () => (async () => {
    const r = await fetch(base + '/events', { signal: sseAbort.signal });
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^event: ui$/m.test(block)) uiCmds.push(JSON.parse(block.match(/^data: (.*)$/m)[1]));
      }
    }
  })().catch(() => {});
  // Contesta «Sí» a las confirmaciones del Guide (kind:'confirm').
  let confirmations = 0;
  const answerer = setInterval(async () => {
    try { for (const q of await api('GET', '/api/questions')) if (q.kind === 'confirm') { confirmations++; await api('POST', `/api/questions/${q.id}/answer`, { answer: 'Sí' }); } } catch { /* servidor parado */ }
  }, 500);

  // Un turno del chat: devuelve los eventos del proveedor ya agrupados.
  async function say(chatId, text) {
    const r = await fetch(base + '/api/guide/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-client': CLIENT }, body: JSON.stringify({ chatId, text }) });
    if (!r.ok) throw new Error(`chat → ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
    const out = { chatId, calls: [], results: new Map(), text: '', error: null, done: null, order: [] };
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i).match(/^data: (.*)$/m)[1]); buf = buf.slice(i + 2);
        out.order.push(ev.type);
        if (ev.type === 'chat') out.chatId = ev.chat.id;
        else if (ev.type === 'text') out.text += (out.text ? '\n' : '') + ev.text;
        else if (ev.type === 'tool_call') out.calls.push(ev);
        else if (ev.type === 'tool_result') out.results.set(ev.id, ev);
        else if (ev.type === 'done') out.done = ev;
        else if (ev.type === 'error') out.error = ev.error;
      }
    }
    return out;
  }
  const names = (t) => t.calls.map((c) => c.name);
  const show = (t) => console.log(`    tools: ${names(t).join(', ') || '(ninguna)'}\n    «${t.text.replace(/\s+/g, ' ').slice(0, 220)}»${t.error ? '\n    ERROR: ' + t.error : ''}`);
  // Contrato común: los eventos salen en el orden chat → (text|tool_call → tool_result)* → done, y cada tool_call tiene su resultado.
  const contract = (t) => t.order[0] === 'chat' && t.order.at(-1) === 'done' && t.calls.every((c) => t.results.has(c.id) && t.order.indexOf('tool_result') > t.order.indexOf('tool_call')) && t.calls.every((c) => /^[a-z]+\.[A-Za-z]+$/.test(c.name));

  const bad0 = checks.filter((x) => !x).length;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
    listenUi();
    await api('POST', '/api/settings', { flowTestUrl: `http://127.0.0.1:${stubPort}`, guideProvider: name });
    await api('GET', '/api/suite');
    const snap = await api('GET', '/api/state');
    check(`Ajustes: el proveedor «${name}» queda elegido y aparece en el estado`, snap.settings.guideProvider === name && snap.guideProviders?.some((p) => p.id === name), (snap.guideProviders || []).map((p) => `${p.id}${p.ready ? '' : ' (sin clave)'}`).join(', '));
    // Proyecto propio con el equipo por defecto y motor demo (no depende de las carpetas del flow-test real).
    const proj = await api('POST', '/api/projects', { name: 'Smoke Guide', engine: 'demo' });
    const pid = proj.id;
    // Estado de partida: una tarea de back en marcha con el motor demo (la que el usuario «tiene delante»).
    const base1 = await api('POST', '/api/tasks', { projectId: pid, role: 'back', title: 'Login con email: endpoint POST /api/login' });
    await api('POST', `/api/projects/${pid}/run`, { running: true });
    for (let i = 0; i < 60 && (await api('GET', '/api/state')).tasks.find((t) => t.id === base1.id)?.status !== 'doing'; i++) await sleep(500);
    await api('POST', '/api/context', { view: 'tasks', projectId: pid, openTaskId: base1.id });
    const code = base1.code;
    console.log(`Servidor ${base} · proveedor ${name} · proyecto ${proj.name} · tarea abierta ${code}\n`);

    console.log('A · «Créame una tarea para solucionar esto»');
    const before = (await api('GET', '/api/state')).tasks.length;
    const a = await say(null, 'Créame una tarea para solucionar esto: el login devuelve 500 cuando el email viene en mayúsculas.');
    const chat = a.chatId; show(a);
    const after = (await api('GET', '/api/state')).tasks;
    const created = after.find((t) => t.title && /login|email|mayúscul/i.test(t.title) && t.id !== base1.id);
    check('llama a task.create', names(a).includes('task.create'));
    check('hay una tarea nueva en el estado, en el proyecto abierto, con rol', after.length === before + 1 && created?.projectId === pid && !!created?.role, created ? `${created.code} · ${created.role} · «${created.title}»` : '');
    check('la respuesta cita el código creado', !!created && a.text.includes(created.code));
    check('se pidió confirmación (política write=confirm)', confirmations > 0);
    check('contrato de eventos (chat → tool_call/tool_result → done)', contract(a) && !a.error);
    check('done trae el coste o los tokens del turno', a.done && (a.done.costUsd != null || a.done.usage?.input > 0), JSON.stringify({ costUsd: a.done?.costUsd, usage: a.done?.usage }));

    console.log('\nB · «¿Cómo va?»');
    const b = await say(chat, '¿Cómo va?');
    show(b);
    check('consulta con task.getStatus / agent.getLastActions', names(b).some((n) => ['task.getStatus', 'agent.getLastActions'].includes(n)));
    check('no vuelve a preguntar qué tarea (la cita)', b.text.includes(code));
    check('sin errores', !b.error && contract(b));

    console.log('\nC · «Páralo»');
    const c = await say(chat, 'Páralo.');
    show(c);
    const stopCall = c.calls.find((x) => ['task.stop', 'task.pause', 'agent.message'].includes(x.name));
    const sr = stopCall && c.results.get(stopCall.id);
    check('llama a task.stop (o pause / agent.message)', !!stopCall, stopCall?.name);
    check('si la tool falla (501…) lo cuenta tal cual, sin simularlo', !sr || sr.ok || /no disponible|a[uú]n no|todav[ií]a|501|no est[áa] implementad|no pude|no he podido/i.test(c.text), sr && !sr.ok ? sr.result.slice(0, 80) : 'ok');
    check('contrato de eventos', contract(c));

    console.log('\nD · «Enséñame lo que ha cambiado»');
    const d = await say(chat, 'Enséñame lo que ha cambiado.');
    show(d);
    check('llama a agent.getModifiedFiles', names(d).includes('agent.getModifiedFiles'));
    check('llama a app.openArtifact', names(d).includes('app.openArtifact'));
    console.log('    órdenes ui:', JSON.stringify(uiCmds.map((u) => [u.type, u.taskId, u.client])));
    check('la UI recibe la orden openTask de esa tarea', uiCmds.some((u) => u.type === 'openTask' && u.taskId === base1.id));
    check('contrato de eventos', contract(d));

    console.log('\nPersistencia');
    const saved = await api('GET', `/api/guide/chats/${chat}`);
    const list = await api('GET', '/api/guide/chats');
    check('el chat queda guardado con mensajes, tool calls y resultados', saved.messages.filter((m) => m.role === 'user').length === 4 && saved.messages.some((m) => m.role === 'tool' && m.result != null));
    check('GET /api/guide/chats lo lista', list.some((x) => x.id === chat));

    if (!real && name !== 'claude-cli') { // protocolo del proveedor HTTP
      console.log('\nProtocolo ' + name);
      const key = name === 'anthropic-api' ? 'anthropic' : 'openai';
      const reqs = mock.seen[key];
      const last = reqs.at(-1)?.body;
      const wire = name === 'anthropic-api' ? (last?.tools || []) : (last?.tools || []).map((t) => t.function);
      check('manda las tools del registro (FT-4) con nombres válidos y esquema', wire.length >= 15 && wire.every((t) => /^[\w-]+$/.test(t.name)) && wire.some((t) => t.name === 'task_create'));
      if (name === 'anthropic-api') {
        check('cache_control en el system', last.system?.[0]?.cache_control?.type === 'ephemeral');
        check('x-api-key y anthropic-version', reqs.every((r) => r.headers['x-api-key'] === 'sk-mock-anthropic' && r.headers['anthropic-version']));
        check('hay un tool_result con su tool_use_id en el historial', last.messages.some((m) => m.content?.some?.((x) => x.type === 'tool_result' && x.tool_use_id)));
        check('modelo por defecto del proveedor', last.model === 'claude-sonnet-5-5', last.model);
      } else {
        check('Authorization Bearer y stream_options.include_usage', reqs.every((r) => r.headers.authorization === 'Bearer sk-mock-openai') && last.stream_options?.include_usage === true);
        check('system primero y role tool con tool_call_id en el historial', last.messages[0].role === 'system' && last.messages.some((m) => m.role === 'tool' && m.tool_call_id));
        check('modelo por defecto del proveedor', last.model === 'gpt-5.5', last.model);
      }
      // Cambiar de proveedor/modelo en Ajustes aplica al siguiente turno y el chat sigue con su historial.
      await api('POST', '/api/settings', { guideModels: { [name]: 'modelo-de-prueba' } });
      await say(chat, '¿Cómo va?');
      const now = mock.seen[key].at(-1).body;
      check('el modelo elegido en Ajustes se usa en el siguiente turno', now.model === 'modelo-de-prueba', now.model);
      const msgs = now.messages;
      check('el chat conserva el historial al cambiar de modelo (rehidratado desde el chat guardado)', msgs.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('Créame una tarea')).length === 1);
    }
  } catch (e) {
    console.error('Error:', e.stack);
    if (serverLog.trim()) console.error(serverLog.trim());
    checks.push(false);
  } finally {
    clearInterval(answerer);
    sseAbort.abort();
    server.kill('SIGTERM');
    await sleep(300);
    if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* el servidor aún escribe: queda en /tmp */ } } else console.log('datos:', dataDir);
  }
  return checks.filter((x) => !x).length === bad0;
}

const stub = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"trial","daysLeft":30}'));
await listen(stub);
const mock = startMock();
await listen(mock.srv);
const verdict = [];
for (const p of providers) {
  console.log(`\n════ ${p} ${real ? '(LLM real)' : '(mock HTTP)'} ════`);
  verdict.push([p, await runProvider(p, { stubPort: stub.address().port, mock })]);
}
stub.close(); mock.srv.close();
console.log('\n' + verdict.map(([p, ok]) => `${ok ? '✓' : '✗'} ${p}`).join('   '));
const bad = checks.filter((x) => !x).length;
console.log(`${bad ? '✗' : '✓'} ${checks.length - bad}/${checks.length} comprobaciones`);
process.exit(bad ? 1 : 0);
