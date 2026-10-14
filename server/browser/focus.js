// Navegador EXTERNO: trae al frente la ventana del navegador del usuario (Brave/Chrome) para que haga un login.
// Linux X11 con xdotool; macOS con osascript. Wayland/Windows: no se puede (el usuario lo verá por el aviso y Telegram).
import { execFileSync } from 'node:child_process';

const CLASSES = ['brave', 'brave-browser', 'Brave-browser', 'google-chrome', 'Google-chrome', 'chromium', 'Chromium'];

export function focusExternalBrowser() {
  try {
    if (process.platform === 'darwin') {
      for (const app of ['Brave Browser', 'Google Chrome']) {
        try { execFileSync('osascript', ['-e', `tell application "${app}" to activate`], { timeout: 5000 }); return { ok: true, app }; } catch { /* siguiente */ }
      }
      return { ok: false, reason: 'sin Brave ni Chrome' };
    }
    if (process.platform !== 'linux') return { ok: false, reason: 'plataforma sin soporte' };
    if (process.env.XDG_SESSION_TYPE === 'wayland' && !process.env.DISPLAY) return { ok: false, reason: 'Wayland sin X11' };
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
    for (const cls of CLASSES) {
      let ids = [];
      try { ids = execFileSync('xdotool', ['search', '--onlyvisible', '--class', cls], { encoding: 'utf8', timeout: 5000, env }).trim().split('\n').filter(Boolean); } catch { continue; }
      if (!ids.length) continue;
      execFileSync('xdotool', ['windowactivate', ids.at(-1)], { timeout: 5000, env }); // la última: la ventana más reciente
      return { ok: true, window: ids.at(-1), class: cls };
    }
    return { ok: false, reason: 'no encuentro la ventana del navegador' };
  } catch (e) { return { ok: false, reason: String(e.message).split('\n')[0] }; }
}
