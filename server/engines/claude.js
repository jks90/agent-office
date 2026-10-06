// Motor Claude Code: `claude -p --output-format stream-json` en el worktree de la tarea.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import { describeTool, toolSummary, firstLine } from './describe.js';
import { RTK_RULES, BASH_TOOLS } from './allowlist.js';
import { claudeTracker } from '../usage.js';

// Lectura/edición + shell de andar por casa (sin rm, sudo, docker, ssh ni git push; lista blanca compartida con terminal.execute del Guide, FT-10).
const WORK_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite', ...BASH_TOOLS];
// El planificador no escribe código, pero sí puede preguntar al cliente (bin/ao-ask.mjs) y leer el repo con el shell básico.
const ASK_RULE = `Bash(node ${path.join(ROOT, 'bin', 'ao-ask.mjs')} *)`;
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', ASK_RULE, 'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(sed -n *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(wc *)', 'Bash(git log*)', 'Bash(git status*)', 'Bash(git diff*)'];

// RTK instalado → hook solo para los agentes (por --settings; no se toca ~/.claude/settings.json del usuario).
const RTK_BIN = [process.env.AO_RTK_BIN, path.join(os.homedir(), '.local/bin/rtk'), '/usr/local/bin/rtk'].find((f) => f && fs.existsSync(f)) || null;
export const rtkAvailable = () => !!RTK_BIN && process.env.AO_RTK !== 'off';

export function start({ cwd, prompt, system, model, mode, mcpUrl, budgetUsd, effort, resumeSession, env: extraEnv = {}, onActivity, onLog, onTool = () => {}, onUsage = () => {} }) {
  const tools = [...(mode === 'plan' ? PLAN_TOOLS : WORK_TOOLS)];
  // FT-5: entrada stream-json con stdin abierto → se pueden inyectar mensajes del cliente en caliente.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', system];
  if (resumeSession) args.push('--resume', resumeSession); // reintento de la MISMA tarea en su worktree: reaprovecha el contexto (y su caché) en vez de volver a explorar
  if (rtkAvailable() && mode !== 'plan') {
    args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${RTK_BIN} hook claude` }] }] } }));
    tools.push(...RTK_RULES.map((r) => `Bash(${r})`));
  }
  if (budgetUsd) args.push('--max-budget-usd', String(budgetUsd)); // tope de gasto por intento: al pasarlo, el CLI corta y la tarea falla con el motivo
  if (effort) args.push('--effort', effort); // menos «pensamiento» = menos tokens de salida (medium por defecto)
  args.push('--model', model || 'sonnet'); // nunca heredar el modelo por defecto de la sesión del usuario (puede no estar disponible en -p)
  // --strict-mcp-config: el agente NO hereda los MCP globales del usuario; solo flow-test para el QA.
  const mcpServers = {};
  if (mcpUrl && mode !== 'plan') {
    mcpServers['flow-test'] = { type: 'http', url: mcpUrl };
    tools.push('mcp__flow-test');
  }
  args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }));
  args.push('--allowedTools', ...tools);

  const env = { ...process.env, ...extraEnv, BROWSER: 'true' };
  if (rtkAvailable() && !String(env.PATH || '').split(':').includes(path.dirname(RTK_BIN))) env.PATH = `${path.dirname(RTK_BIN)}:${env.PATH || ''}`; // el comando reescrito («rtk git …») tiene que encontrarse
  delete env.CLAUDECODE; // si el servidor se lanzó desde una sesión de Claude Code
  // detached: el hijo lidera su propio grupo de procesos, para pausar (SIGSTOP/SIGCONT) y matar también a sus subprocesos (FT-5).
  const child = spawn(process.env.AO_CLAUDE_BIN || 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.stdin.on('error', () => {}); // EPIPE si el proceso ya murió
  const userMsg = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  child.stdin.write(userMsg(prompt)); // el prompt inicial es el primer mensaje de usuario

  // Con stdin abierto el CLI no sale solo tras el `result`: se cierra cuando, tras un `result`, no arranca otro turno
  // (un mensaje en cola empieza a emitir eventos enseguida; uno enviado en la ventana cancela el cierre).
  let closeTimer = null;
  const armClose = () => { clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (!child.stdin.destroyed) child.stdin.end(); }, 2500); };
  const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };

  let result = null, sessionId = null;
  const tracker = claudeTracker();
  let stopped = false;
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    if (closeTimer && ev.type !== 'result') cancelClose(); // otro turno en marcha
    const u = tracker.feed(ev); // FT-26: solo cifras de uso
    if (u) onUsage(u);
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_use') {
          const d = describeTool(c.name, c.input);
          onActivity(d);
          onTool({ phase: 'started', callId: c.id, tool: c.name, summary: toolSummary(c.name, c.input) });
          onLog('🔧 ' + d);
        } else if (c.type === 'text' && c.text.trim()) {
          onActivity('Pensando: ' + firstLine(c.text, 50));
          onLog('💬 ' + c.text.trim());
        }
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_result') onTool({ phase: 'finished', callId: c.tool_use_id, ok: !c.is_error });
        if (c.type === 'tool_result' && c.is_error) onLog('⚠ ' + firstLine(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 200));
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      sessionId = ev.session_id || sessionId;
      onLog(`⚙ Claude Code · modelo ${ev.model || '?'} · ${ev.tools?.length ?? 0} herramientas`);
    } else if (ev.type === 'result') {
      result = ev; // con varios turnos manda el último
      armClose();
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 30) stderr.shift(); });

  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: `No se pudo lanzar claude: ${e.message}` }));
    child.on('close', (code) => {
      if (stopped) return resolve({ ok: false, stopped: true, error: 'Parado por el usuario' });
      const ok = code === 0 && result && !result.is_error;
      resolve({
        ok,
        summary: result?.result || '',
        costUsd: result?.total_cost_usd ?? null,
        sessionId,
        budgetHit: result?.subtype === 'error_max_budget_usd',
        error: ok ? null : (result?.result || (result?.errors || []).join(' ') || stderr.join('\n') || `claude terminó con código ${code}`),
      });
    });
  });

  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* ya terminó */ } } };
  return {
    done,
    pid: child.pid,
    pause() { signal('SIGSTOP'); },
    resume() { signal('SIGCONT'); },
    // Mensaje en caliente (FT-5): nuevo mensaje de usuario por stdin. false si el CLI ya no admite entrada.
    message(text) {
      if (child.stdin.destroyed || child.stdin.writableEnded) return false;
      cancelClose();
      // Redacción neutra a propósito: un encabezado en mayúsculas tipo «INSTRUCCIÓN… prioritaria… confírmala literalmente» hace que
      // el modelo lo trate como inyección y lo rechace (probado con el CLI real).
      child.stdin.write(userMsg(`El cliente (quien revisa tu trabajo) añade esta indicación para lo que queda de la tarea: «${text}». Aplícala a partir de ahora y menciónala en tu resumen final.`));
      return true;
    },
    stop() { stopped = true; cancelClose(); signal('SIGTERM'); signal('SIGCONT'); setTimeout(() => signal('SIGKILL'), 3000).unref(); }, // SIGCONT: un grupo parado no recibe SIGTERM
  };
}
