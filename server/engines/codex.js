// Motor Codex: `codex exec --json` en el worktree de la tarea (sandbox workspace-write).
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { firstLine, toolSummary, toolKey } from './describe.js';
import { codexTracker } from '../usage.js';

// Codex envuelve cada orden en `/usr/bin/zsh -lc "…"`: en el bocadillo solo interesa la orden.
const unwrap = (cmd) => {
  const m = String(cmd ?? '').match(/^\S*\/?(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/);
  return m ? m[2] : String(cmd ?? '');
};

// El sandbox de Codex (bwrap, espacios de usuario) no funciona cuando AgentOffice corre como servicio de systemd
// («setting up uid map: Permission denied»). Se comprueba una vez; si falla, Codex corre sin sandbox (como Claude aquí):
// el aislamiento lo da el worktree y la revisión humana.
let sandboxOk = null;
function bwrapWorks() {
  if (sandboxOk !== null) return sandboxOk;
  try { execFileSync('bwrap', ['--unshare-user', '--dev-bind', '/', '/', 'true'], { stdio: 'ignore', timeout: 5000 }); sandboxOk = true; }
  catch { sandboxOk = false; }
  return sandboxOk;
}

export function start({ cwd, prompt, system, model, mode, mcpUrl, images = [], env: extraEnv = {}, onActivity, onLog, onTool = () => {}, onUsage = () => {} }) {
  const noSandbox = !bwrapWorks();
  const sandbox = mode === 'plan' ? 'read-only' : 'workspace-write';
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...(noSandbox ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', sandbox])];
  if (noSandbox) onLog('⚠ Codex sin sandbox (bwrap no disponible bajo el servicio): aislamiento por worktree + revisión');
  if (model) args.push('-m', model);
  if (mcpUrl && mode !== 'plan') args.push('-c', `mcp_servers.flow_test.url="${mcpUrl}"`);
  for (const img of images) args.push(`--image=${img}`); // con «=» para que -i (variádico) no se trague el «-»
  args.push('-'); // el prompt va por stdin

  const child = spawn(process.env.AO_CODEX_BIN || 'codex', args, { cwd, env: { ...process.env, ...extraEnv, BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // detached: grupo propio para pausar/matar (FT-5)
  child.stdin.end(`${system}\n\n${prompt}`);

  let lastMessage = '';
  let failure = null;
  let stopped = false;
  const tracker = codexTracker();
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    const u = tracker.feed(ev); // FT-26: solo cifras de uso
    if (u) onUsage(u);
    const it = ev.item;
    if ((ev.type === 'item.started' || ev.type === 'item.completed') && it) {
      const started = ev.type === 'item.started';
      // Activity Stream (FT-1): herramientas con id, nombre y resumen sin contenido sensible
      const tool = { command_execution: ['Bash', { command: unwrap(it.command) }], file_change: ['Edit', { file_path: it.changes?.[0]?.path }], mcp_tool_call: [`mcp__${it.server}__${it.tool}`, {}], web_search: ['WebSearch', { query: it.query }] }[it.type];
      if (tool) {
        const call = { callId: it.id, tool: tool[0], summary: toolSummary(...tool), key: toolKey(...tool) };
        if (started) onTool({ phase: 'started', ...call });
        else {
          if (it.type === 'file_change') onTool({ phase: 'started', ...call }); // file_change solo llega completado
          onTool({ phase: 'finished', callId: it.id, ok: it.type === 'command_execution' ? !it.exit_code : it.status !== 'failed' });
        }
      }
      switch (it.type) {
        case 'command_execution':
          if (started) { onActivity(`Ejecutando \`${firstLine(unwrap(it.command), 50)}\``); onLog('🔧 $ ' + unwrap(it.command)); }
          else if (it.exit_code) onLog(`⚠ código ${it.exit_code}: ${firstLine(it.aggregated_output, 200)}`);
          break;
        case 'file_change':
          if (!started) {
            const files = (it.changes || []).map((c) => String(c.path).split('/').slice(-2).join('/')).join(', ');
            onActivity('Editando ' + files);
            onLog('🔧 Editando ' + files);
          }
          break;
        case 'mcp_tool_call':
          if (started) { onActivity(`${it.server}: ${it.tool}`); onLog(`🔧 ${it.server}: ${it.tool}`); }
          break;
        case 'web_search':
          if (started) onActivity(`Buscando en la web «${firstLine(it.query, 30)}»`);
          break;
        case 'reasoning':
          if (!started && it.text) onActivity('Pensando: ' + firstLine(it.text, 50));
          break;
        case 'agent_message':
          if (!started) { lastMessage = it.text || ''; onLog('💬 ' + lastMessage); }
          break;
        case 'error':
          onLog('⚠ ' + it.message);
          break;
      }
    } else if (ev.type === 'turn.failed') {
      failure = ev.error?.message || 'turno fallido';
    } else if (ev.type === 'error') {
      failure = ev.message || 'error';
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (l) => { stderr.push(l); if (stderr.length > 30) stderr.shift(); });

  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: `No se pudo lanzar codex: ${e.message}` }));
    child.on('close', (code) => {
      if (stopped) return resolve({ ok: false, stopped: true, error: 'Parado por el usuario' });
      const ok = code === 0 && !failure;
      resolve({ ok, summary: lastMessage, costUsd: null, error: ok ? null : (failure || stderr.join('\n') || `codex terminó con código ${code}`) });
    });
  });

  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* ya terminó */ } } };
  return {
    done,
    pid: child.pid,
    pause() { signal('SIGSTOP'); },
    resume() { signal('SIGCONT'); },
    stop() { stopped = true; signal('SIGTERM'); signal('SIGCONT'); setTimeout(() => signal('SIGKILL'), 3000).unref(); },
  };
}
