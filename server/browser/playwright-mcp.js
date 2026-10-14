// Navegante · Playwright MCP (@playwright/mcp de Microsoft) para los agentes con la capacidad «playwright».
// Va por `npx` con la versión FIJADA: no es una dependencia del repo, así que llega a las instalaciones que ya existen con el
// `git pull` de la autoactualización (que no hace `npm install`). La primera vez npx lo descarga (hace falta red) y queda en caché.
// Usa el Chromium/Chrome/Brave del PC (el mismo que busca cdp.js) con un perfil PROPIO: el driver CDP bloquea el suyo
// (data/browser/profile) mientras está abierto. Ojo: estas tools no pasan por la política ni la auditoría de browser.* (FT-116).
// Env: AO_PLAYWRIGHT=off (no se monta) · AO_PLAYWRIGHT_MCP (otra versión) · AO_BROWSER_PATH · AO_BROWSER_HEADLESS=0 · AO_BROWSER_NO_SANDBOX=1
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, normalUserAgent } from './cdp.js';
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

// ── Navegador EXTERNO: el Brave/Chrome del usuario (sus sesiones, Bitwarden…) con la extensión «Playwright MCP Bridge» ──
// Token de la extensión: AO_PLAYWRIGHT_TOKEN o el fichero <data>/playwright-extension-token (0600; vale con o sin el prefijo
// «PLAYWRIGHT_MCP_EXTENSION_TOKEN=»). Sin token no hay modo externo.
const tokenFile = () => path.join(path.dirname(dataDir()), 'playwright-extension-token');
export function extensionToken() {
  if (process.env.AO_PLAYWRIGHT_TOKEN) return process.env.AO_PLAYWRIGHT_TOKEN.trim();
  try { return fs.readFileSync(tokenFile(), 'utf8').replace(/^\s*PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, '').trim() || null; } catch { return null; }
}
// Qué navegador abrir: AO_EXTERNAL_BROWSER, el que ya esté abierto (Linux: /proc; Brave de snap → /snap/bin/brave, que abre
// en la instancia viva) o el primero instalado. Tiene que ser el perfil donde está la extensión.
const EXTERNAL = {
  linux: ['/snap/bin/brave', '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/usr/bin/chromium'],
  darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
};
function runningBrowser() {
  if (process.platform !== 'linux') return null;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    const exe = cmd.split('\0')[0];
    if (!exe || cmd.includes('--type=') || cmd.includes('--headless') || cmd.includes('/browser/profile') || cmd.includes('pw-profile')) continue; // no los nuestros
    if (/^\/snap\/brave\//.test(exe) && /\/brave$/.test(exe)) return '/snap/bin/brave';
    if (/^\/snap\/chromium\//.test(exe) && /\/chrome$/.test(exe)) return '/snap/bin/chromium';
    if (/\/(brave|chrome|chromium)$/.test(exe) && fs.existsSync(exe)) return exe;
  }
  return null;
}
export function externalBrowser() {
  if (process.env.AO_EXTERNAL_BROWSER) return process.env.AO_EXTERNAL_BROWSER;
  return runningBrowser() || (EXTERNAL[process.platform] || []).find((p) => fs.existsSync(p)) || null;
}

// Guía (proveedor claude-cli) → 'external' (tu navegador, si hay token) · 'cdp' (Chromium del panel 🌐) · false (browser.* de siempre).
// settings.guideBrowserEngine: 'ao' fuerza lo de siempre; 'cdp' fuerza el panel aunque haya token.
export function guideUsesPlaywright({ settings = {}, mode = 'dedicated', provider = 'claude-cli' } = {}) {
  if (!playwrightEnabled() || provider !== 'claude-cli' || settings.guideBrowserEngine === 'ao' || process.env.AO_BROWSER === 'fake') return false;
  if (settings.guideBrowserEngine !== 'cdp' && extensionToken() && externalBrowser()) return 'external';
  return mode === 'dedicated' ? 'cdp' : false;
}

/** Definición stdio del MCP para --mcp-config (o null si está apagado). Con `cdpEndpoint` se engancha a un navegador que ya existe. */
export function playwrightMcp({ task, cdpEndpoint, external = false } = {}) {
  if (!playwrightEnabled()) return null;
  const pkg = `@playwright/mcp@${process.env.AO_PLAYWRIGHT_MCP || PW_MCP_VERSION}`;
  const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  if (external) { // tu navegador por la extensión; el token va en env (la config se escribe en un fichero 0600, nunca en la línea de órdenes)
    const token = extensionToken(), exe = externalBrowser();
    if (!token || !exe) return null;
    return { type: 'stdio', command: npxBin(), args: ['-y', pkg, '--extension', '--executable-path', exe, '--output-dir', pwOutputDir(task)], env: { ...env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } };
  }
  if (cdpEndpoint) return { type: 'stdio', command: npxBin(), args: ['-y', pkg, '--cdp-endpoint', cdpEndpoint, '--output-dir', pwOutputDir(task)], env };
  const args = ['-y', pkg, '--user-data-dir', pwProfileDir(), '--output-dir', pwOutputDir(task)];
  const exe = findBrowser();
  if (exe) args.push('--executable-path', exe); // sin navegador en el PC, Playwright pide el suyo (npx playwright install chromium)
  const headless = process.env.AO_BROWSER_HEADLESS !== '0' || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (headless) {
    args.push('--headless');
    const ua = exe && normalUserAgent(exe); // sin «HeadlessChrome»: hay webs que lo rechazan (403)
    if (ua) args.push('--user-agent', ua);
  }
  if (process.env.AO_BROWSER_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
  // PATH con la carpeta de node: npx lanza `node` por el shebang
  return { type: 'stdio', command: npxBin(), args, env };
}
