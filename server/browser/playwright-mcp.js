// Navegante · Playwright MCP (@playwright/mcp de Microsoft) para los agentes con la capacidad «playwright».
// Va por `npx` con la versión FIJADA: no es una dependencia del repo, así que llega a las instalaciones que ya existen con el
// `git pull` de la autoactualización (que no hace `npm install`). La primera vez npx lo descarga (hace falta red) y queda en caché.
// Usa el Chromium/Chrome/Brave del PC (el mismo que busca cdp.js) con un perfil PROPIO: el driver CDP bloquea el suyo
// (data/browser/profile) mientras está abierto. Ojo: estas tools no pasan por la política ni la auditoría de browser.* (FT-116).
// Env: AO_PLAYWRIGHT=off (no se monta) · AO_PLAYWRIGHT_MCP (otra versión) · AO_BROWSER_PATH · AO_BROWSER_HEADLESS=0 · AO_BROWSER_NO_SANDBOX=1
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser } from './cdp.js';
import { dataDir } from './util.js';

export const PW_MCP_VERSION = '0.0.83';
export const pwProfileDir = () => path.join(dataDir(), 'pw-profile');
export const pwOutputDir = (task) => path.join(dataDir(), 'pw-output', String(task || 'sin-tarea').replace(/[^\w.-]+/g, '-'));
export const playwrightEnabled = () => process.env.AO_PLAYWRIGHT !== 'off';

// npx junto al node que corre AgentOffice (con systemd el PATH puede no tenerlo); si no, el del PATH.
function npxBin() {
  const near = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return fs.existsSync(near) ? near : 'npx';
}

/** Definición stdio del MCP para --mcp-config (o null si está apagado). */
export function playwrightMcp({ task } = {}) {
  if (!playwrightEnabled()) return null;
  const pkg = `@playwright/mcp@${process.env.AO_PLAYWRIGHT_MCP || PW_MCP_VERSION}`;
  const args = ['-y', pkg, '--user-data-dir', pwProfileDir(), '--output-dir', pwOutputDir(task)];
  const exe = findBrowser();
  if (exe) args.push('--executable-path', exe); // sin navegador en el PC, Playwright pide el suyo (npx playwright install chromium)
  const headless = process.env.AO_BROWSER_HEADLESS !== '0' || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (headless) args.push('--headless');
  if (process.env.AO_BROWSER_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
  // PATH con la carpeta de node: npx lanza `node` por el shebang
  return { type: 'stdio', command: npxBin(), args, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } };
}
