// Motor Claude Code: `claude -p --output-format stream-json` en el worktree de la tarea.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { describeTool, firstLine } from './describe.js';

const WORK_TOOLS = [
  'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite',
  'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(mkdir *)', 'Bash(curl *)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git add*)', 'Bash(git commit*)',
];
const PLAN_TOOLS = ['Read', 'Glob', 'Grep'];

export function start({ cwd, prompt, system, model, mode, mcpUrl, onActivity, onLog }) {
  const tools = [...(mode === 'plan' ? PLAN_TOOLS : WORK_TOOLS)];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', system];
  if (model) args.push('--model', model);
  // --strict-mcp-config: el agente NO hereda los MCP globales del usuario; solo flow-test para el QA.
  const mcpServers = {};
  if (mcpUrl && mode !== 'plan') {
    mcpServers['flow-test'] = { type: 'http', url: mcpUrl };
    tools.push('mcp__flow-test');
  }
  args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }));
  args.push('--allowedTools', ...tools);

  const env = { ...process.env };
  delete env.CLAUDECODE; // si el servidor se lanzó desde una sesión de Claude Code
  const child = spawn(process.env.AO_CLAUDE_BIN || 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);

  let result = null;
  let stopped = false;
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_use') {
          const d = describeTool(c.name, c.input);
          onActivity(d);
          onLog('🔧 ' + d);
        } else if (c.type === 'text' && c.text.trim()) {
          onActivity('Pensando: ' + firstLine(c.text, 50));
          onLog('💬 ' + c.text.trim());
        }
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_result' && c.is_error) onLog('⚠ ' + firstLine(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 200));
      }
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      onLog(`⚙ Claude Code · modelo ${ev.model || '?'} · ${ev.tools?.length ?? 0} herramientas`);
    } else if (ev.type === 'result') {
      result = ev;
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

  return { done, stop() { stopped = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); } };
}
