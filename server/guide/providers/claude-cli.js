// Proveedor del Guide Agent sobre Claude Code (FT-6): `claude -p --input-format stream-json --output-format stream-json`.
// Mismo patrón que engines/claude.js, pero con la sesión VIVA entre mensajes (un proceso por chat; se mata tras un rato
// ocioso y la siguiente vez se retoma con `--resume <session_id>`). Sin Bash/Edit/Write: solo las tools MCP del Guide
// (bin/ao-mcp.mjs → política y auditoría de FT-4). Interfaz GuideProvider:
//   start({system, tools?, model, resume, cwd, env}) → { sessionId }
//   send({text, context}) → AsyncGenerator de {type:'text'|'tool_call'|'tool_result'|'done'|'error', …}
//   stop() → aborta el turno en curso y mata el proceso
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateCost, sumUsage } from '../budget.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const label = 'Claude Code (CLI)';
export const defaultModel = 'sonnet';
export const ready = () => true; // usa la sesión del propio `claude` (suscripción o clave)
const IDLE_MS = 10 * 60_000;
const MCP_SERVER = 'agentoffice';
// `mcp__agentoffice__task_create` → `task.create` (los nombres MCP no admiten «.»; ver bin/ao-mcp.mjs)
export const toolName = (n) => String(n).replace(`mcp__${MCP_SERVER}__`, '').replace('_', '.');

export function create() {
  let child = null, opts = null, sessionId = null, idle = null;
  let queue = null; // { push(ev), end() } del turno en curso
  const stderr = [];
  const turnUse = new Map(); // FT-132: usage por mensaje del turno en curso

  function spawnChild() {
    const mcpServers = { [MCP_SERVER]: { command: process.execPath, args: [path.join(ROOT, 'bin/ao-mcp.mjs')], env: { AO_URL: `http://127.0.0.1:${process.env.AO_PORT || 7420}`, ...(process.env.AO_TOKEN ? { AO_TOKEN: process.env.AO_TOKEN } : {}), ...(opts.chatId ? { AO_CHAT_ID: opts.chatId } : {}) } } };
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--system-prompt', opts.system];
    args.push('--model', opts.model || 'sonnet');
    args.push('--tools', '', '--permission-mode', 'dontAsk', '--disable-slash-commands'); // sin Bash/Edit/Write: el Guide no es un worker
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }));
    args.push('--allowedTools', `mcp__${MCP_SERVER}`);
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, ...(opts.env || {}) };
    delete env.CLAUDECODE;
    const c = spawn(process.env.AO_CLAUDE_BIN || 'claude', args, { cwd: opts.cwd || ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    c.on('error', (e) => { if (child === c) { child = null; queue?.push({ type: 'error', error: `No se pudo lanzar claude: ${e.message}` }); queue?.end(); } });
    c.on('close', (code) => {
      if (child !== c) return;
      child = null;
      if (queue) { queue.push({ type: 'error', error: stderr.slice(-5).join('\n') || `claude terminó con código ${code}` }); queue.end(); }
    });
    readline.createInterface({ input: c.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 30) stderr.shift(); });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      if (!queue) return;
      if (ev.type === 'assistant') {
        if (ev.message?.usage && ev.message.id) { // FT-132: coste estimado en curso (el real solo llega al final)
          turnUse.set(ev.message.id, ev.message.usage);
          const u = sumUsage(turnUse);
          queue.push({ type: 'usage', usage: u, costUsd: estimateCost(opts?.model, u) });
        }
        for (const b of ev.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) queue.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') queue.push({ type: 'tool_call', id: b.id, name: toolName(b.name), args: b.input || {} });
        }
      } else if (ev.type === 'user') {
        for (const b of ev.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n');
          queue.push({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, result: text.slice(0, 20_000) });
        }
      } else if (ev.type === 'result') {
        if (ev.is_error) queue.push({ type: 'error', error: ev.result || 'Error del modelo' });
        else queue.push({ type: 'done', sessionId, costUsd: ev.total_cost_usd ?? null, ...(turnUse.size ? { usage: sumUsage(turnUse) } : {}) });
        queue.end();
      }
    });
    return c;
  }

  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { if (!queue) kill(); }, IDLE_MS); idle.unref?.(); };
  function kill() {
    clearTimeout(idle);
    const c = child; child = null;
    if (c) { c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 3000).unref(); }
  }

  return {
    start(o) { opts = o; sessionId = o.resume || null; return { sessionId }; },
    get sessionId() { return sessionId; },
    async *send({ text, context = '' }) {
      if (queue) throw new Error('Ya hay un turno en curso');
      const items = [], waiters = [];
      turnUse.clear();
      let ended = false;
      queue = { push: (ev) => { items.push(ev); waiters.shift()?.(); }, end: () => { ended = true; waiters.shift()?.(); } };
      try {
        clearTimeout(idle);
        if (!child) child = spawnChild();
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: (context ? context + '\n\n' : '') + text }] } }) + '\n');
        while (true) {
          if (items.length) { const ev = items.shift(); yield ev; if (ev.type === 'done' || ev.type === 'error') return; continue; }
          if (ended) return;
          await new Promise((r) => waiters.push(r));
        }
      } finally { queue = null; if (child) arm(); }
    },
    stop() { const q = queue; kill(); if (q) { q.push({ type: 'error', error: 'Parado por el usuario', stopped: true }); q.end(); } },
  };
}
