// FT-20 · Backend Linux del DesktopProvider. Detecta la sesión en tiempo de ejecución:
//   X11            → xdotool (ventana activa) + wmctrl -lp (lista)
//   Wayland GNOME  → gdbus a org.gnome.Shell: Eval (si no está bloqueado) o la extensión «Window Calls»
// Sin dependencias npm: execFile con timeout de 3 s. El nombre del proceso sale de /proc/<pid>/comm.
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCapture } from './capture.js';
import * as atspi from './atspi.js';
import * as input from './input.js';

const TIMEOUT = 3000;
const fail503 = msg => Object.assign(new Error(msg), { status: 503 });

// Devuelve texto (o Buffer con raw:true). Los errores salen como 503.
const run = (cmd, args, { raw = false } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (e, out, errOut) => {
    if (e) return reject(fail503(`${cmd}: ${String(errOut || '').trim() || e.message}`));
    resolve(raw ? out : out.toString('utf8'));
  });
});
const has = cmd => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
const comm = pid => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } };
const hex = n => '0x' + Number(n).toString(16).padStart(8, '0');

export function detectSession(env = process.env) {
  const t = (env.XDG_SESSION_TYPE || '').toLowerCase();
  if (t === 'wayland' || env.WAYLAND_DISPLAY) {
    const de = `${env.XDG_CURRENT_DESKTOP || ''} ${env.DESKTOP_SESSION || ''}`;
    return /gnome|ubuntu/i.test(de) ? 'wayland-gnome' : 'wayland';
  }
  if (t === 'x11' || env.DISPLAY) return 'x11';
  return 'none';
}

// Captura con una herramienta que solo escribe a fichero: se usa un temporal.
async function shotToFile(cmd, args) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-desk-'));
  const f = join(dir, 'shot.png');
  try { await run(cmd, args(f)); return readFileSync(f); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
// FT-21 · Cada herramienta de captura: { name, hint (paquete), run({windowId}) → Buffer PNG }.
// windowId solo lo entienden las de X11; en Wayland target:'window' sin id = ventana activa.
const noId = (windowId, msg) => {
  if (windowId) throw Object.assign(new Error(msg), { status: 501 });
};
const gnomeShot = {
  name: 'gnome-screenshot', hint: 'gnome-screenshot',
  run: ({ windowId, target }) => {
    noId(windowId, 'Wayland: no se puede capturar una ventana por id; usa target:"window" sin windowId (ventana activa)');
    return shotToFile('gnome-screenshot', f => [...(target === 'window' ? ['-w'] : []), '-f', f]);
  },
};
const gdbusShot = {
  name: 'gdbus', hint: 'gdbus (libglib2.0-bin)',
  run: ({ windowId, target }) => {
    noId(windowId, 'Wayland: no se puede capturar una ventana por id');
    const [method, extra] = target === 'window' ? ['ScreenshotWindow', ['true', 'false', 'true']] : ['Screenshot', ['false', 'true']];
    return shotToFile('gdbus', f => [...SHELL_ARGS, '--object-path', '/org/gnome/Shell/Screenshot', '--method', `org.gnome.Shell.Screenshot.${method}`, ...extra, f]);
  },
};
const grimShot = {
  name: 'grim', hint: 'grim',
  run: ({ windowId }) => {
    noId(windowId, 'Wayland: no se puede capturar una ventana por id');
    return run('grim', ['-'], { raw: true });
  },
};

// ---- X11 ----
const x11 = {
  missing: () => ['xdotool', 'wmctrl'].filter(c => !has(c)),
  async getActive() {
    const id = (await run('xdotool', ['getactivewindow'])).trim();
    const [title, pid] = await Promise.all([
      run('xdotool', ['getwindowname', id]).then(s => s.trim()).catch(() => ''),
      run('xdotool', ['getwindowpid', id]).then(s => Number(s.trim()) || 0).catch(() => 0),
    ]);
    return { id: hex(id), title, app: comm(pid), pid };
  },
  async list() {
    const active = await x11.getActive().catch(() => null);
    // wmctrl -lp: <id> <escritorio> <pid> <host> <título…>
    return (await run('wmctrl', ['-lp'])).split('\n').filter(Boolean).map(l => {
      const m = l.match(/^(\S+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s?(.*)$/);
      if (!m) return null;
      const id = hex(parseInt(m[1], 16));
      const pid = Number(m[3]);
      return { id, title: m[5], app: comm(pid), pid, active: !!active && active.id === id };
    }).filter(Boolean);
  },
  captureTools: [
    { name: 'import', hint: 'imagemagick', run: async ({ windowId, target }) => run('import', ['-window', windowId || (target === 'window' ? (await x11.getActive()).id : 'root'), 'png:-'], { raw: true }) },
    { name: 'scrot', hint: 'scrot', run: ({ windowId, target }) => shotToFile('scrot', f => ['-o', ...(windowId || target === 'window' ? ['-u'] : []), f]) },
    { ...gnomeShot, run: o => (o.windowId ? Promise.reject(Object.assign(new Error('gnome-screenshot no captura por id'), { status: 501 })) : gnomeShot.run(o)) },
  ],
};

// ---- Wayland GNOME ----
const SHELL_ARGS = ['call', '--session', '--dest', 'org.gnome.Shell'];
const JS_WINDOWS = 'JSON.stringify(global.get_window_actors().map(a=>a.meta_window).filter(w=>w.get_window_type()===0).map(w=>({id:String(w.get_id()),title:w.get_title(),app:w.get_wm_class(),pid:w.get_pid(),active:w.has_focus()})))';

// gdbus imprime una cadena GVariant: «(true, '<json>')» (Eval) o «('<json>',)» (Window Calls).
const unquote = s => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

async function gnomeWindows() {
  try { // 1) Eval (bloqueado desde GNOME 41 salvo modo unsafe)
    const out = await run('gdbus', [...SHELL_ARGS, '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Eval', JS_WINDOWS]);
    const m = out.trim().match(/^\((true|false),\s*'([\s\S]*)'\)$/);
    if (m && m[1] === 'true') return JSON.parse(unquote(m[2]));
  } catch { /* cae a la extensión */ }
  try { // 2) Extensión «Window Calls»
    const out = await run('gdbus', [...SHELL_ARGS, '--object-path', '/org/gnome/Shell/Extensions/Windows', '--method', 'org.gnome.Shell.Extensions.Windows.List']);
    const m = out.trim().match(/^\('([\s\S]*)',?\)$/);
    return JSON.parse(unquote(m[1])).map(w => ({ id: String(w.id), title: w.title || '', app: w.wm_class || '', pid: w.pid || 0, active: !!w.focus }));
  } catch {
    throw fail503('GNOME Shell no expone las ventanas: Eval está bloqueado y falta la extensión «Window Calls» (https://extensions.gnome.org/extension/4724/window-calls/)');
  }
}

const gnome = {
  missing: () => (has('gdbus') ? [] : ['gdbus']),
  async list() { return (await gnomeWindows()).map(w => ({ ...w, app: comm(w.pid) || w.app })); },
  async getActive() {
    const a = (await gnome.list()).find(w => w.active);
    if (!a) throw Object.assign(new Error('ninguna ventana activa'), { status: 404 });
    const { active, ...rest } = a;
    return rest;
  },
  captureTools: [gnomeShot, gdbusShot],
};

// Wayland wlroots (sway, Hyprland…): solo captura con grim; ventanas aún no soportadas (501).
const wlroots = {
  missing: () => [],
  captureTools: [grimShot],
  getActive: () => Promise.reject(Object.assign(new Error('Wayland sin GNOME: ventanas aún no soportadas'), { status: 501 })),
  list: () => wlroots.getActive(),
};

export function createLinuxProvider(env = process.env) {
  const session = detectSession(env);
  const be = session === 'x11' ? x11 : session === 'wayland-gnome' ? gnome : session === 'wayland' ? wlroots : null;
  const captureTool = () => be?.captureTools.find(t => has(t.name));
  const nope = () => Object.assign(new Error(session === 'none'
    ? 'sin sesión gráfica (XDG_SESSION_TYPE/WAYLAND_DISPLAY/DISPLAY vacíos)'
    : 'Wayland sin GNOME: aún no soportado'), { status: 501 });
  // FT-29 · pid del objetivo: explícito, el de windowId o el de la ventana activa
  const pidFor = async ({ pid, windowId } = {}) => {
    if (pid) return pid;
    if (!be) throw nope();
    const w = windowId ? (await be.list()).find(x => x.id === windowId) : await be.getActive();
    if (!w?.pid) throw Object.assign(new Error(windowId ? `ventana no encontrada: ${windowId}` : 'la ventana activa no tiene pid'), { status: 404 });
    return w.pid;
  };
  const inputAvailable = () => {
    if (!be) return { ok: false, missing: [session === 'none' ? 'sesión gráfica' : 'soporte para este compositor Wayland'] };
    const bin = session === 'x11' ? 'xdotool' : 'ydotool';
    return has(bin) ? { ok: true, missing: [], tool: bin } : { ok: false, missing: [bin] };
  };
  const sendInput = async (kind, o = {}) => {
    const av = inputAvailable();
    if (!av.ok) throw Object.assign(fail503(`entrada no disponible: falta ${av.missing.join(', ')}`), { missing: av.missing });
    for (const args of input.plan(av.tool, kind, o)) await run(av.tool, args);
    return { ok: true, tool: av.tool };
  };
  return {
    id: 'linux',
    session,
    available() {
      if (!be) return { ok: false, missing: [session === 'none' ? 'sesión gráfica' : 'soporte para este compositor Wayland'] };
      const missing = be.missing();
      const tool = captureTool();
      // FT-21 · captureTool: la herramienta de captura que se usaría (null si no hay ninguna)
      if (!tool) missing.push(`herramienta de captura (${be.captureTools.map(t => t.hint).join(' | ')})`);
      return { ok: !missing.length, missing, captureTool: tool?.name || null };
    },
    getActive: async () => { if (!be) throw nope(); return be.getActive(); },
    list: async () => { if (!be) throw nope(); return be.list(); },
    // FT-29 · AT-SPI
    a11yAvailable: () => (be ? atspi.a11yAvailable() : { ok: false, missing: [session === 'none' ? 'sesión gráfica' : 'soporte para este compositor Wayland'] }),
    uiTree: async (o = {}) => atspi.tree({ ...o, pid: await pidFor(o) }),
    uiFind: async (o = {}) => atspi.filterNodes(await atspi.tree({ pid: await pidFor(o), depth: atspi.MAX_DEPTH, maxNodes: atspi.MAX_NODES }), o),
    uiNode: async (ref) => atspi.nodeInfo(ref),
    uiAct: async (o) => atspi.act(o),
    // FT-30 · fallback de entrada: xdotool en X11, ydotool en Wayland. Si falta el binario, 503 con `missing`.
    inputAvailable,
    click: (o) => sendInput('click', o),
    scroll: (o) => sendInput('scroll', o),
    type: (o) => sendInput('type', o).then((r) => ({ ...r, chars: [...String(o.text)].length })),
    keyPress: (o) => sendInput('keyPress', o),
    // FT-21 · capture({target:'screen'|'window', windowId?}) → { path, width, height, bytes, tool, ts }
    capture: async ({ target = 'screen', windowId } = {}) => {
      if (!be) throw nope();
      const tool = captureTool();
      if (!tool) throw fail503(`falta una herramienta de captura para ${session}: instala ${be.captureTools.map(t => t.hint).join(' o ')}`);
      return saveCapture(await tool.run({ target, windowId }), tool.name);
    },
  };
}
