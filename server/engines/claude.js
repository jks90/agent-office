// Motor Claude Code: `claude -p --output-format stream-json` en el worktree de la tarea.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import { describeTool, toolSummary, toolKey, firstLine } from './describe.js';
import { RTK_RULES } from './allowlist.js';
import { claudeScope } from './toolscope.js';
import { claudeTracker } from '../usage.js';
import { SERVER_NAME } from '../codeindex.js';

// Subagente explorador (FT-65): solo lectura (Read/Grep/Glob + shell de lectura de la lista blanca), modelo barato.
export const EXPLORER = {
  name: 'explorador',
  def: {
    description: 'Explora el repo en un contexto aparte (entender un módulo, buscar todos los usos de algo, enumerar dónde ocurre algo) y devuelve solo un resumen corto con rutas y líneas. Solo lectura.',
    prompt: 'Eres un explorador de código de SOLO LECTURA. Responde a la pregunta que te den leyendo lo necesario (Grep -n y Read con offset/limit; nunca ficheros grandes enteros). Devuelve únicamente un resumen breve (máx. ~25 líneas): hallazgos con `ruta:línea` y una frase cada uno. No pegues código largo ni modifiques nada.',
    tools: ['Read', 'Grep', 'Glob', 'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(sed -n *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(wc *)', 'Bash(git log*)', 'Bash(git status*)', 'Bash(git diff*)'],
    model: 'haiku',
  },
};

// RTK instalado → hook solo para los agentes (por --settings; no se toca ~/.claude/settings.json del usuario).
const RTK_BIN = [process.env.AO_RTK_BIN, path.join(os.homedir(), '.local/bin/rtk'), '/usr/local/bin/rtk'].find((f) => f && fs.existsSync(f)) || null;
export const rtkBin = () => RTK_BIN;
export const rtkAvailable = () => !!RTK_BIN && process.env.AO_RTK !== 'off';

export function start({ cwd, prompt, system, model, mode, mcpUrl, codeIndex, kind, roleId, roleTools, hasSkills, budgetUsd, effort, resumeSession, addDirs = [], extraMcp = {}, extraBash = [], env: extraEnv = {}, onActivity, onLog, onTool = () => {}, onUsage = () => {}, onEvent = () => {} }) {
  // FT-59: --tools limita las herramientas DISPONIBLES (sus definiciones no se envían); --allowedTools, lo que se permite sin preguntar.
  const scope = claudeScope({ kind, mode, roleTools, hasSkills, roleId });
  const tools = [...scope.allowed];
  // FT-5: entrada stream-json con stdin abierto → se pueden inyectar mensajes del cliente en caliente.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', system];
  if (resumeSession) args.push('--resume', resumeSession); // reintento de la MISMA tarea en su worktree: reaprovecha el contexto (y su caché) en vez de volver a explorar
  // FT-134: sin segundo plano en los workers (hook que rechaza run_in_background) + RTK si está instalado; un único --settings.
  const preHooks = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin', 'ao-nobg.mjs'))}` }] }];
  if (kind === 'release') preHooks.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin', 'ao-release.mjs'))}` }] }); // FT-171
  if (rtkAvailable() && mode !== 'plan' && kind !== 'release') { // release: sin reescritura de RTK
    preHooks.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `${RTK_BIN} hook claude` }] });
    tools.push(...RTK_RULES.map((r) => `Bash(${r})`));
  }
  args.push('--settings', JSON.stringify({ hooks: { PreToolUse: preHooks } }));
  if (budgetUsd) args.push('--max-budget-usd', String(budgetUsd)); // tope de gasto por intento: al pasarlo, el CLI corta y la tarea falla con el motivo
  if (effort) args.push('--effort', effort); // menos «pensamiento» = menos tokens de salida (medium por defecto)
  args.push('--model', model || 'sonnet'); // nunca heredar el modelo por defecto de la sesión del usuario (puede no estar disponible en -p)
  // --strict-mcp-config: el agente NO hereda los MCP globales del usuario; solo flow-test para el QA.
  const mcpServers = {};
  if (mcpUrl && scope.mcp) {
    mcpServers['flow-test'] = { type: 'http', url: mcpUrl };
    tools.push('mcp__flow-test');
  }
  if (scope.browser) { // FT-115: tools browser.* del Guía (solo ellas) por ao-mcp; la política y la auditoría viven en el servidor
    mcpServers['agentoffice-browser'] = { type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'bin', 'ao-mcp.mjs')], env: { AO_URL: extraEnv.AO_URL || `http://127.0.0.1:${process.env.AO_PORT || 7420}`, AO_MCP_ONLY: 'browser', ...(extraEnv.AO_TASK ? { AO_CHAT_ID: `task:${extraEnv.AO_TASK}` } : {}) } };
    tools.push('mcp__agentoffice-browser');
  }
  if (addDirs.length) args.push('--add-dir', ...addDirs); // FT-44: worktrees de los demás repos del proyecto
  if (codeIndex) { // FT-58: índice de código local (stdio); solo lectura de símbolos
    mcpServers[SERVER_NAME] = { type: 'stdio', command: codeIndex.command, args: [], env: codeIndex.env };
    tools.push(`mcp__${SERVER_NAME}`);
  }
  for (const [n, d] of Object.entries(extraMcp)) { mcpServers[n] = d; tools.push(`mcp__${n}`); } // MCP del catálogo asignados al agente/rol
  // Con MCP del usuario la config lleva sus claves (env/cabeceras): va en un fichero 0600 y no en la línea de órdenes (visible en ps)
  let mcpFile = null;
  if (Object.keys(extraMcp).length) {
    mcpFile = path.join(os.tmpdir(), `ao-mcp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });
  }
  args.push('--strict-mcp-config', '--mcp-config', mcpFile || JSON.stringify({ mcpServers }));
  for (const b of extraBash) tools.push(`Bash(${b}:*)`); // scripts del catálogo asignados
  // FT-65: subagente «explorador» (solo lectura, haiku): lee en SU contexto y devuelve un resumen; lo leído no se reenvía en cada turno del agente.
  // Su lista de tools es explícita (sin MCP, sin Edit/Write) y --strict-mcp-config sigue vigente; el resto de subagentes integrados se veta.
  // Con las herramientas acotadas por rol (FT-59), Task/Agent se añaden a las DISPONIBLES solo cuando el explorador está activo.
  const builtin = [...scope.builtin];
  if (process.env.AO_EXPLORER === 'on' && mode !== 'plan') { // opcional hasta que el benchmark FT-61 confirme que ahorra
    args.push('--agents', JSON.stringify({ [EXPLORER.name]: EXPLORER.def }));
    for (const x of ['Task', 'Agent']) { if (!builtin.includes(x)) builtin.push(x); tools.push(x); }
    args.push('--disallowedTools', 'Task(general-purpose)', 'Task(Explore)', 'Task(Plan)', 'Agent(general-purpose)', 'Agent(Explore)', 'Agent(Plan)');
  }
  if (extraBash.length && !builtin.includes('Bash')) builtin.push('Bash');
  args.push('--tools', builtin.join(','), '--allowedTools', ...tools);

  const env = { ...process.env, ...extraEnv, BROWSER: 'true', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
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
    onEvent(ev); // FT-76: telemetría por turno
    const u = tracker.feed(ev); // FT-26: solo cifras de uso
    if (u) onUsage(u);
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_use') {
          const d = describeTool(c.name, c.input);
          onActivity(d);
          onTool({ phase: 'started', callId: c.id, tool: c.name, summary: toolSummary(c.name, c.input), key: toolKey(c.name, c.input) });
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
      if (mcpFile) { try { fs.unlinkSync(mcpFile); } catch { /* ya no está */ } }
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
    message(text, opt = false) { const raw = opt === true || !!(opt && opt.raw); // raw: instrucción del propio orquestador (FT-62 pasa true, FT-63 {raw:true}), sin el envoltorio «el cliente añade…»
      if (child.stdin.destroyed || child.stdin.writableEnded) return false;
      cancelClose();
      if (raw) { child.stdin.write(userMsg(text)); return true; }
      // Redacción neutra a propósito: un encabezado en mayúsculas tipo «INSTRUCCIÓN… prioritaria… confírmala literalmente» hace que
      // el modelo lo trate como inyección y lo rechace (probado con el CLI real).
      else child.stdin.write(userMsg(`El cliente (quien revisa tu trabajo) añade esta indicación para lo que queda de la tarea: «${text}». Aplícala a partir de ahora y menciónala en tu resumen final.`));
      return true;
    },
    stop() { stopped = true; cancelClose(); signal('SIGTERM'); signal('SIGCONT'); setTimeout(() => signal('SIGKILL'), 3000).unref(); }, // SIGCONT: un grupo parado no recibe SIGTERM
  };
}
