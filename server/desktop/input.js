// FT-30 · Entrada ciega (último recurso): construye los comandos de xdotool (X11) y ydotool (Wayland).
// Funciones puras: devuelven la lista de invocaciones (argumentos); linux.js las ejecuta con execFile (sin shell).
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const int = (v, name) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad(`${name} debe ser un número`); return n; };
const MAX_CLICKS = 50;
const clamp = (n) => Math.max(-MAX_CLICKS, Math.min(MAX_CLICKS, n));

export const BUTTONS = { left: 1, middle: 2, right: 3 };
const YDO_BTN = { left: 0, right: 1, middle: 2 };

// Alias → nombre canónico
const ALIAS = { control: 'ctrl', ctl: 'ctrl', return: 'enter', del: 'delete', esc: 'escape', option: 'alt', win: 'super', meta: 'super', cmd: 'super', pgup: 'pageup', pgdn: 'pagedown' };
export const MODS = ['ctrl', 'alt', 'shift', 'super'];

// 'Ctrl+S' → { mods:['ctrl'], key:'s', canon:'ctrl+s' } (modificadores en orden fijo para poder comparar)
export function parseKeys(keys) {
  const parts = String(keys || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean).map((p) => ALIAS[p] || p);
  if (!parts.length) throw bad('keys vacío');
  const key = parts[parts.length - 1];
  if (MODS.includes(key) && parts.length === 1) throw bad('falta la tecla (solo hay modificadores)');
  if (parts.slice(0, -1).some((m) => !MODS.includes(m))) throw bad(`modificador no válido en «${keys}»`);
  const mods = MODS.filter((m) => parts.slice(0, -1).includes(m));
  return { mods, key, canon: [...mods, key].join('+') };
}

// keysym de xdotool y códigos evdev de ydotool
const XKEY = { enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
const LETTERS = { q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50 };
const CODES = { ...LETTERS, ctrl: 29, shift: 42, alt: 56, super: 125, escape: 1, enter: 28, tab: 15, space: 57, backspace: 14, delete: 111, up: 103, left: 105, right: 106, down: 108, home: 102, end: 107, pageup: 104, pagedown: 109, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11, f11: 87, f12: 88 };
for (let i = 1; i <= 10; i++) CODES[`f${i}`] = 58 + i;

const code = (k) => { if (CODES[k] === undefined) throw bad(`tecla no soportada en Wayland: «${k}»`); return CODES[k]; };

// Invocaciones [[args…], …] para el binario del backend ('xdotool' | 'ydotool').
export function plan(backend, kind, o = {}) {
  const x = backend === 'xdotool';
  if (kind === 'click') {
    const btn = o.button || 'left';
    if (!(btn in BUTTONS)) throw bad('button debe ser left, right o middle');
    const px = String(int(o.x, 'x')), py = String(int(o.y, 'y'));
    return x
      ? [['mousemove', px, py, 'click', ...(o.double ? ['--repeat', '2', '--delay', '80'] : []), String(BUTTONS[btn])]]
      : [['mousemove', '--absolute', '-x', px, '-y', py], ['click', ...(o.double ? ['--repeat', '2', '--next-delay', '80'] : []), `0xC${YDO_BTN[btn]}`]];
  }
  if (kind === 'scroll') {
    const dx = int(o.dx ?? 0, 'dx'), dy = int(o.dy ?? 0, 'dy');
    if (!dx && !dy) throw bad('scroll sin desplazamiento (dx/dy)');
    const at = o.x !== undefined && o.y !== undefined ? [String(int(o.x, 'x')), String(int(o.y, 'y'))] : null;
    const move = at ? [x ? ['mousemove', ...at] : ['mousemove', '--absolute', '-x', at[0], '-y', at[1]]] : [];
    // dy>0 baja, dx>0 va a la derecha
    const steps = x
      ? [dy && ['click', '--repeat', String(Math.abs(clamp(dy))), dy > 0 ? '5' : '4'], dx && ['click', '--repeat', String(Math.abs(clamp(dx))), dx > 0 ? '7' : '6']].filter(Boolean)
      : [['mousemove', '--wheel', '-x', String(clamp(dx)), '-y', String(-clamp(dy))]];
    return [...move, ...steps];
  }
  if (kind === 'type') {
    const text = String(o.text ?? '');
    if (!text) throw bad('text vacío');
    return [x ? ['type', '--delay', '12', '--', text] : ['type', '--', text]];
  }
  if (kind === 'keyPress') {
    const { mods, key } = parseKeys(o.keys);
    if (x) return [['key', [...mods, key].map((k) => XKEY[k] || k).join('+')]];
    const seq = [...mods, key].map(code);
    return [['key', ...seq.map((c) => `${c}:1`), ...[...seq].reverse().map((c) => `${c}:0`)]];
  }
  throw bad(`entrada desconocida: ${kind}`);
}
