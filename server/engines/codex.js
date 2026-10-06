// Motor Codex: `codex exec --json` en el worktree de la tarea (sandbox workspace-write).
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { firstLine, toolSummary, toolKey } from './describe.js';
import { fileURLToPath } from 'node:url';
import { codexTracker, codexCostUsd, tokensForUsd } from '../usage.js';
import { codexScope } from './toolscope.js';
import { rtkBin, rtkAvailable } from './claude.js';
import { SERVER_NAME } from '../codeindex.js';

// FT-57: filtro del hook de RTK (solo reescrituras de la lista blanca).
const RTK_FILTER = fileURLToPath(new URL('../../bin/ao-rtk-codex.mjs', import.meta.url));
// Args de configuración (-c) de un intento: esfuerzo y hook de RTK. Función pura para poder probarla.
export function configArgs({ effort, rtk, mode }) {
  const a = [];
  if (effort) a.push('-c', `model_reasoning_effort="${effort}"`, '-c', 'model_reasoning_summary="concise"');
  if (rtk && mode !== 'plan') { // hook solo para los agentes, por -c: no se toca ~/.codex/config.toml del usuario
    const cmd = `${process.execPath} ${RTK_FILTER} ${rtk}`;
    a.push('-c', 'features.codex_hooks=true', '-c', `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(cmd)}}]}]`);
  }
  return a;
}

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

export function start({ cwd, prompt, system, model, mode, mcpUrl, codeIndex, kind, images = [], budgetUsd, maxTokens, effort, resumeSession, env: extraEnv = {}, onActivity, onLog, onTool = () => {}, onUsage = () => {}, onEvent = () => {} }) {
  const noSandbox = !bwrapWorks();
  const sandbox = mode === 'plan' ? 'read-only' : 'workspace-write';
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...(noSandbox ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', sandbox])];
  if (noSandbox) onLog('⚠ Codex sin sandbox (bwrap no disponible bajo el servicio): aislamiento por worktree + revisión');
  if (model) args.push('-m', model);
  if (mcpUrl && mode !== 'plan') args.push('-c', `mcp_servers.flow_test.url="${mcpUrl}"`);
  if (codeIndex) { // FT-58: servidor MCP stdio por -c (TOML; los guiones del nombre pasan a «_»)
    const k = `mcp_servers.${SERVER_NAME.replace(/-/g, '_')}`;
    args.push('-c', `${k}.command=${JSON.stringify(codeIndex.command)}`, '-c', `${k}.args=[]`, '-c', `${k}.env={${Object.entries(codeIndex.env).map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(',')}}`);
  }
  for (const c of codexScope({ kind, mode, images })) args.push('-c', c); // FT-59: sin herramientas que el rol no usa
  const useRtk = rtkAvailable() && mode !== 'plan';
  args.push(...configArgs({ effort, rtk: useRtk ? rtkBin() : null, mode }));
  for (const img of images) args.push(`--image=${img}`); // con «=» para que -i (variádico) no se trague el «-»
  if (resumeSession) args.push('resume', resumeSession); // FT-57: reintento de la misma tarea → reanuda su hilo (contexto y caché)
  args.push('-'); // el prompt va por stdin

  const child = spawn(process.env.AO_CODEX_BIN || 'codex', args, { cwd, env: { ...process.env, ...extraEnv, BROWSER: 'true', ...(useRtk ? { PATH: `${path.dirname(rtkBin())}:${process.env.PATH || ''}` } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // detached: grupo propio para pausar/matar (FT-5)
  child.stdin.end(`${system}\n\n${prompt}`);

  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* ya terminó */ } } };
  let lastMessage = '';
  let failure = null;
  let stopped = false;
  let sessionId = null, budgetHit = false, capText = null;
  // FT-57: Codex no tiene tope propio; se corta con el uso del stream (llega al cerrar cada turno). Tope en tokens si está
  // fijado (maxTokens) o, si no, el coste estimado con la tabla de precios contra el tope en $.
  const overCap = (u) => {
    if (maxTokens > 0) return u.total >= maxTokens && `${maxTokens.toLocaleString('es')} tokens`;
    if (budgetUsd > 0) return codexCostUsd(u, model) >= budgetUsd && `${budgetUsd} $ (≈ ${tokensForUsd(budgetUsd, model).toLocaleString('es')} tokens)`;
    return false;
  };
  const tracker = codexTracker();
  const stderr = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) onLog(line); return; }
    onEvent(ev); // FT-76: telemetría por turno
    const u = tracker.feed(ev); // FT-26: solo cifras de uso
    if (u) {
      onUsage(u);
      const over = !budgetHit && overCap(u);
      if (over) { budgetHit = true; capText = over; onLog(`⚠ Tope por intento alcanzado (${over}): se corta`); signal('SIGTERM'); signal('SIGCONT'); setTimeout(() => signal('SIGKILL'), 3000).unref(); }
    }
    if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
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
      if (budgetHit && !stopped) return resolve({ ok: false, budgetHit: true, capText, summary: lastMessage, sessionId, costUsd: null, error: 'Tope por intento alcanzado' });
      if (stopped) return resolve({ ok: false, stopped: true, error: 'Parado por el usuario' });
      const ok = code === 0 && !failure;
      resolve({ ok, summary: lastMessage, sessionId, costUsd: null, error: ok ? null : (failure || stderr.join('\n') || `codex terminó con código ${code}`) });
    });
  });

  return {
    done,
    pid: child.pid,
    pause() { signal('SIGSTOP'); },
    resume() { signal('SIGCONT'); },
    stop() { stopped = true; signal('SIGTERM'); signal('SIGCONT'); setTimeout(() => signal('SIGKILL'), 3000).unref(); },
  };
}
