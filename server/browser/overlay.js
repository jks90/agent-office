// 🫧 Burbuja del agente: mientras un agente (o el Guía) usa el navegador con Playwright, una ventanita flotante FUERA de
// AgentOffice (Electron sin marco, siempre encima de todas las ventanas) enseña quién es, qué hace y sus preguntas con
// las opciones como botones. Se cierra sola cuando nadie usa el navegador (tarea terminada o IDLE_MS sin tools).
// Electron va por `npx` con la versión FIJADA (como @playwright/mcp): llega con el `git pull` de la autoactualización,
// sin `npm install`; la 1.ª vez npx descarga el binario (~100 MB) en su caché.
// La ventana carga /overlay.html de este servidor y se pinta con el SSE /overlay/events (estado pequeño, no el snapshot).
// Env: AO_OVERLAY=off (apagada) · AO_OVERLAY_ELECTRON (otra versión) · AO_OVERLAY_IDLE_MS. Ajuste: settings.agentOverlay=false.
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ELECTRON = process.env.AO_OVERLAY_ELECTRON || 'electron@31.7.7';
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'overlay', 'main.cjs');
const IDLE_MS = Number(process.env.AO_OVERLAY_IDLE_MS) || 90_000;
const RETRY_MS = 5 * 60_000; // si Electron se cae (no hay escritorio, falla la descarga…) no se relanza en bucle
export const GUIDE = 'guide';

export const isBrowserTool = (name) => /^mcp__playwright__/.test(String(name || '')) || /^browser[._]/.test(String(name || ''));

// Hay escritorio donde pintar la ventana (systemd --user hereda DISPLAY de la sesión gráfica).
export function hasDesktop(env = process.env, platform = process.platform) {
  if (platform === 'darwin' || platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// Núcleo testeable: sin temporizadores ni procesos propios (se inyectan `now`, `spawn`, `getState`, `listQuestions`).
export function createOverlay({ url, getState, listQuestions, spawn = nodeSpawn, now = Date.now, enabled = () => true, log = () => {} }) {
  const browsing = new Map(); // key (agentId | 'guide') → { key, agentId, name, taskId, taskCode, activity, since, lastTs }
  const clients = new Set();
  let child = null, dismissed = false, failedAt = 0, lastSent = '';

  const agentOf = (id) => getState().agents.find((a) => a.id === id);

  function touch(key, info = {}) {
    const cur = browsing.get(key);
    const a = key === GUIDE ? null : agentOf(key);
    browsing.set(key, {
      key, agentId: key === GUIDE ? null : key, name: key === GUIDE ? 'Guía' : a?.name || cur?.name || '?',
      taskId: info.taskId ?? cur?.taskId ?? a?.taskId ?? null, taskCode: info.taskCode ?? cur?.taskCode ?? null,
      activity: info.activity || cur?.activity || '', since: cur?.since || now(), lastTs: now(),
    });
    sync();
  }
  function drop(key) { if (browsing.delete(key)) sync(); }

  // Preguntas que se enseñan: las de los agentes en la burbuja, las de login en el navegador (browser:true) y, si el
  // Guía está navegando, sus confirmaciones 🛡 (kind:'confirm', sin tarea).
  function questions() {
    return listQuestions().filter((q) => (q.agentId && browsing.has(q.agentId)) || (q.kind === 'confirm' && browsing.has(GUIDE)))
      .map(({ id, agentId, agentName, taskCode, question, options, allowCustom, context, browser, kind }) => ({ id, agentId, agentName, taskCode, question, options, allowCustom, context, browser: !!browser, kind: kind || 'ask' }));
  }

  function view() {
    const st = getState();
    return {
      agents: [...browsing.values()].map((b) => {
        const a = b.agentId ? st.agents.find((x) => x.id === b.agentId) : null;
        return { key: b.key, name: b.name, role: a?.role || (b.key === GUIDE ? 'guide' : ''), taskCode: b.taskCode, activity: a?.activity || b.activity, since: b.since };
      }),
      questions: questions(),
    };
  }

  // Limpia lo que ya no navega: tarea fuera de «doing», agente sin tarea o IDLE_MS sin tools (salvo pregunta abierta).
  function prune() {
    const st = getState();
    const open = new Set(listQuestions().map((q) => (q.kind === 'confirm' ? GUIDE : q.agentId)));
    for (const [k, b] of browsing) {
      const a = b.agentId ? st.agents.find((x) => x.id === b.agentId) : null;
      const t = b.taskId ? st.tasks.find((x) => x.id === b.taskId) : null;
      const gone = b.agentId && (!a || !a.taskId || (t && t.status !== 'doing')); // la tarea acabó: fuera aunque quede una pregunta colgada
      if (gone || (!open.has(k) && now() - b.lastTs > IDLE_MS)) browsing.delete(k);
    }
  }

  function sync() {
    // Una pregunta de login en el navegador mete a su agente en la burbuja aunque aún no haya usado Playwright
    // (antes de limpiar: si su tarea ya no está en curso, prune lo saca).
    for (const q of listQuestions()) if (q.browser && q.agentId && !browsing.has(q.agentId)) { browsing.set(q.agentId, { key: q.agentId, agentId: q.agentId, name: q.agentName, taskId: q.taskId ?? agentOf(q.agentId)?.taskId ?? null, taskCode: q.taskCode, activity: '', since: now(), lastTs: now() }); }
    prune();
    if (!browsing.size) { dismissed = false; stop(); } else start();
    broadcast();
  }

  function broadcast(force = false) {
    const v = view();
    const s = JSON.stringify(v);
    if (!force && s === lastSent) return;
    lastSent = s;
    for (const send of clients) send(v);
  }

  function start() {
    if (child || dismissed || !enabled() || !hasDesktop() || now() - failedAt < RETRY_MS) return;
    const args = ['--yes', ELECTRON, MAIN, `--ao-url=${url()}`];
    const { ELECTRON_RUN_AS_NODE, ...env } = process.env; // lo exporta VS Code: con él Electron arranca como Node y no hay ventana
    try {
      child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'ignore', detached: process.platform !== 'win32', env: { ...env, ELECTRON_NO_ATTACH_CONSOLE: '1' } });
    } catch (e) { failedAt = now(); log(`🫧 Burbuja del agente: no arranca (${e.message})`); return; }
    const me = child;
    me.on('error', (e) => { failedAt = now(); log(`🫧 Burbuja del agente: no arranca (${e.message})`); if (child === me) child = null; });
    me.on('exit', (code, signal) => {
      if (child !== me) return; // la paramos nosotros
      child = null;
      if (code === 0) dismissed = true; // ✕ del usuario: no vuelve hasta la próxima vez que se use el navegador
      else { failedAt = now(); log(`🫧 Burbuja del agente: Electron salió con ${code ?? signal}`); }
    });
  }

  function stop() {
    const c = child;
    child = null;
    if (!c || c.exitCode != null) return;
    // npx no reenvía la señal a Electron: se mata el grupo de procesos entero (npx + electron + sus hijos)
    try { if (c.pid && process.platform !== 'win32') process.kill(-c.pid, 'SIGTERM'); else c.kill('SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* ya no está */ } }
  }

  function onActivity(ev) {
    if (ev.type === 'AgentToolStarted' && ev.agentId && isBrowserTool(ev.data?.tool)) touch(ev.agentId, { taskId: ev.taskId, taskCode: ev.taskCode, activity: ev.data?.summary });
    else if (['AgentCompleted', 'AgentFailed', 'AgentPaused'].includes(ev.type) && ev.agentId) drop(ev.agentId);
  }

  // SSE /overlay/events: estado pequeño de la burbuja (no el snapshot entero).
  function subscribe(send) { clients.add(send); send(view()); return () => clients.delete(send); }

  return { touch, drop, sync, onActivity, subscribe, view, dismiss: () => { dismissed = true; stop(); broadcast(true); }, running: () => !!child, _browsing: browsing };
}
