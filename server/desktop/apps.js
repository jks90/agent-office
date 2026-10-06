// FT-31 · Aplicaciones instaladas (.desktop) y lanzamiento seguro. Sin dependencias npm.
// Solo se lanza un `id` que salga de la propia lista; nunca se pasa un comando ni argumentos libres.
import { readdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const bad = (status, msg) => Object.assign(new Error(msg), { status });

export const appDirs = () => [
  '/usr/share/applications', '/usr/local/share/applications',
  join(homedir(), '.local/share/applications'),
  '/var/lib/flatpak/exports/share/applications', join(homedir(), '.local/share/flatpak/exports/share/applications'),
];

// Parsea la sección [Desktop Entry] (primer valor de cada clave, sin localizar). → {name, exec, hidden, type} | null
export function parseDesktop(text) {
  const kv = {};
  let inEntry = false;
  for (const raw of String(text).split('\n')) {
    const l = raw.trim();
    if (l.startsWith('[')) { inEntry = l === '[Desktop Entry]'; continue; }
    if (!inEntry || !l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0 && !(l.slice(0, i) in kv)) kv[l.slice(0, i)] = l.slice(i + 1);
  }
  if (!kv.Name) return null;
  return { name: kv.Name, exec: kv.Exec || '', hidden: kv.NoDisplay === 'true' || kv.Hidden === 'true', type: kv.Type || 'Application' };
}

// Lee los .desktop de los directorios → [{id, name, exec}] sin NoDisplay, ordenado por nombre. id = nombre del fichero sin «.desktop».
export function listFromDirs(dirs = appDirs()) {
  const byId = new Map();
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      let e; try { e = parseDesktop(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!e || e.type !== 'Application') continue;
      const id = f.slice(0, -'.desktop'.length);
      if (e.hidden) byId.delete(id); else byId.set(id, { id, name: e.name, exec: e.exec }); // un directorio posterior (usuario) tapa al anterior
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Apps que nunca se lanzan: AgentOffice/flow-test y terminales (ejecución arbitraria).
const OWN = /flow[-_. ]?test|agent[-_. ]?office/i;
const TERM = /terminal|konsole|xterm|alacritty|kitty|wezterm|terminator|tilix|guake|yakuake|rxvt|ptyxis|ghostty|sakura|terminology|org\.gnome\.console|(^|[^a-z])(kgx|foot|st)([^a-z]|$)/i;
export function denyReason(app) {
  if (OWN.test(`${app.id} ${app.name}`)) return 'no se lanzan flow-test ni AgentOffice';
  if (TERM.test(app.id) || TERM.test(app.name)) return 'no se lanzan terminales (ejecución arbitraria)';
  return null;
}

// Valida un id contra la lista: 400 si no es válido o no existe, 403 si está vetado. → la app.
export function resolveApp(apps, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._+-]{1,200}$/.test(id)) throw bad(400, 'entrada no válida: «id» debe ser un id de application.list (solo letras, números y . _ + -)');
  const app = apps.find(a => a.id === id);
  const deny = denyReason(app || { id, name: '' });
  if (deny) throw bad(403, `aplicación vetada: ${deny}`);
  if (!app) throw bad(400, `entrada no válida: «${id}» no está en la lista de application.list`);
  return app;
}

// Lanza con gtk-launch (o gio launch) desacoplado, sin shell ni argumentos extra.
export function launch(id) {
  const has = c => spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
  const [cmd, args] = has('gtk-launch') ? ['gtk-launch', [id]] : has('gio') ? ['gio', ['launch', `${id}.desktop`]] : [];
  if (!cmd) throw bad(503, 'falta gtk-launch (libgtk-3-bin) o gio (libglib2.0-bin)');
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
  p.on('error', () => {});
  p.unref();
  return { ok: true, id, launcher: cmd };
}
