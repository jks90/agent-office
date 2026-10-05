// FT-20 · Backend Linux del DesktopProvider. Detecta la sesión en tiempo de ejecución:
//   X11            → xdotool (ventana activa) + wmctrl -lp (lista)
//   Wayland GNOME  → gdbus a org.gnome.Shell: Eval (si no está bloqueado) o la extensión «Window Calls»
// Sin dependencias npm: execFile con timeout de 3 s. El nombre del proceso sale de /proc/<pid>/comm.
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
async function shotToFile(cmd, argsFor) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-desk-'));
  const f = join(dir, 'shot.png');
  try { await run(cmd, argsFor(f)); return { mime: 'image/png', data: readFileSync(f) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

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
  async capture({ window } = {}) {
    if (has('import')) return { mime: 'image/png', data: await run('import', ['-window', window || 'root', 'png:-'], { raw: true }) };
    if (has('scrot')) return shotToFile('scrot', f => ['-o', ...(window ? ['-u'] : []), f]);
    if (has('gnome-screenshot')) return shotToFile('gnome-screenshot', f => ['-f', f]);
    throw fail503('falta una herramienta de captura (imagemagick, scrot o gnome-screenshot)');
  },
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
  async capture() {
    if (has('grim')) return { mime: 'image/png', data: await run('grim', ['-'], { raw: true }) };
    if (has('gnome-screenshot')) return shotToFile('gnome-screenshot', f => ['-f', f]);
    throw fail503('falta una herramienta de captura (grim o gnome-screenshot)');
  },
};

export function createLinuxProvider(env = process.env) {
  const session = detectSession(env);
  const be = session === 'x11' ? x11 : session === 'wayland-gnome' ? gnome : null;
  const nope = () => Object.assign(new Error(session === 'none'
    ? 'sin sesión gráfica (XDG_SESSION_TYPE/WAYLAND_DISPLAY/DISPLAY vacíos)'
    : 'Wayland sin GNOME: aún no soportado'), { status: 501 });
  return {
    id: 'linux',
    session,
    available() {
      if (!be) return { ok: false, missing: [session === 'none' ? 'sesión gráfica' : 'soporte para este compositor Wayland'] };
      const missing = be.missing();
      return { ok: !missing.length, missing };
    },
    getActive: async () => { if (!be) throw nope(); return be.getActive(); },
    list: async () => { if (!be) throw nope(); return be.list(); },
    capture: async (opts = {}) => { if (!be) throw nope(); return be.capture(opts); },
  };
}
