// Motor Claude Code: `claude -p --output-format stream-json` en el worktree de la tarea.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { describeTool, toolSummary, firstLine } from './describe.js';

// Lectura/edición + shell de andar por casa (sin rm, sudo, docker, ssh ni git push).
const WORK_TOOLS = [
  'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(python3 *)', 'Bash(curl *)', 'Bash(timeout *)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
  'Bash(sed *)', 'Bash(awk *)', 'Bash(sort *)', 'Bash(uniq *)', 'Bash(cut *)', 'Bash(tr *)', 'Bash(xargs *)', 'Bash(diff *)',
  'Bash(du *)', 'Bash(file *)', 'Bash(stat *)', 'Bash(date *)', 'Bash(echo *)', 'Bash(printf *)', 'Bash(true)', 'Bash(sleep *)',
  'Bash(mkdir *)', 'Bash(cp *)', 'Bash(mv *)', 'Bash(touch *)', 'Bash(cd *)', 'Bash(pwd)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git branch*)',
  'Bash(git rm *)', 'Bash(git mv *)', 'Bash(git restore *)', // borrar/mover/deshacer ficheros del worktree (reversible por git; sin `rm` genérico)
];
const PLAN_TOOLS = ['Read', 'Glob', 'Grep'];

export function start({ cwd, prompt, system, model, mode, mcpUrl, env: extraEnv = {}, onActivity, onLog, onTool = () => {} }) {
  const tools = [...(mode === 'plan' ? PLAN_TOOLS : WORK_TOOLS)];
  // FT-5: entrada stream-json con stdin abierto → se pueden inyectar mensajes del cliente en caliente.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', system];
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

  let result = null;
  let stopped = false;
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    if (closeTimer && ev.type !== 'result') cancelClose(); // otro turno en marcha
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
        error: ok ? null : (result?.result || stderr.join('\n') || `claude terminó con código ${code}`),
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
