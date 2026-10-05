// Motor Codex: `codex exec --json` en el worktree de la tarea (sandbox workspace-write).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { firstLine } from './describe.js';

export function start({ cwd, prompt, system, model, mode, mcpUrl, onActivity, onLog }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', mode === 'plan' ? 'read-only' : 'workspace-write'];
  if (model) args.push('-m', model);
  if (mcpUrl && mode !== 'plan') args.push('-c', `mcp_servers.flow_test.url="${mcpUrl}"`);
  args.push('-'); // el prompt va por stdin

  const child = spawn(process.env.AO_CODEX_BIN || 'codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(`${system}\n\n${prompt}`);

  let lastMessage = '';
  let failure = null;
  let stopped = false;
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    const it = ev.item;
    if ((ev.type === 'item.started' || ev.type === 'item.completed') && it) {
      const started = ev.type === 'item.started';
      switch (it.type) {
        case 'command_execution':
          if (started) { onActivity(`Ejecutando \`${firstLine(it.command, 50)}\``); onLog('🔧 $ ' + it.command); }
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

  return { done, stop() { stopped = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); } };
}
