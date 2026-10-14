// Navegador de AgentOffice = Playwright MCP (@playwright/mcp de Microsoft) para el Guía y los agentes con la capacidad
// «browser» (o «playwright»). Va por `npx` con la versión FIJADA: no es una dependencia del repo, así que llega a las
// instalaciones que ya existen con el `git pull` de la autoactualización (que no hace `npm install`).
// Dos modos: «external» = TU navegador (Brave/Chrome con la extensión «Playwright MCP Bridge» y su token) · «own» = un
// Chromium/Chrome del PC lanzado por Playwright con perfil propio (data/browser/pw-profile), en ventana visible si hay escritorio.
// Estas tools no tienen 🛡 por acción: los límites van en el prompt (preguntar antes de enviar, pagar o borrar).
// Env: AO_PLAYWRIGHT=off · AO_PLAYWRIGHT_MCP (otra versión) · AO_PLAYWRIGHT_TOKEN · AO_EXTERNAL_BROWSER · AO_BROWSER_PATH ·
//      AO_BROWSER_HEADLESS=1 · AO_BROWSER_NO_SANDBOX=1 · AO_BROWSER_UA
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDir } from './util.js';

// Chromium/Chrome/Brave del PC para el modo «own» (Playwright lo lanza con su perfil propio). AO_BROWSER_PATH lo fuerza.
const CANDIDATES = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
};
// Oculto, Chrome se anuncia como «HeadlessChrome» y bastantes webs (bancos: MyInvestor da 403) lo rechazan: se lanza con el
// user-agent de un Chrome normal de la misma versión. AO_BROWSER_UA lo fuerza.
const UA_OS = { linux: 'X11; Linux x86_64', darwin: 'Macintosh; Intel Mac OS X 10_15_7', win32: 'Windows NT 10.0; Win64; x64' };
export function normalUserAgent(exe) {
  if (process.env.AO_BROWSER_UA) return process.env.AO_BROWSER_UA;
  let major = '';
  try { major = (execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 }).match(/(\d+)\.\d+/) || [])[1] || ''; } catch { /* sin versión */ }
  if (!major) return null;
  return `Mozilla/5.0 (${UA_OS[process.platform] || UA_OS.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
export function findBrowser() {
  const forced = process.env.AO_BROWSER_PATH;
  if (forced) return fs.existsSync(forced) ? forced : null;
  return (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null;
}

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

// Guía: 'external' (tu navegador, si hay token) · 'own' (Chromium propio de Playwright) · false (proveedor sin MCP: sin navegador).
// settings.guideBrowserEngine='off' lo apaga.
export function guideUsesPlaywright({ settings = {}, provider = 'claude-cli' } = {}) {
  if (!playwrightEnabled() || provider !== 'claude-cli' || settings.guideBrowserEngine === 'off') return false;
  return extensionToken() && externalBrowser() ? 'external' : 'own';
}

/** Definición stdio del MCP para --mcp-config (o null si está apagado): `external` = tu navegador por la extensión; si no, Chromium propio. */
export function playwrightMcp({ task, external = false } = {}) {
  if (!playwrightEnabled()) return null;
  const pkg = `@playwright/mcp@${process.env.AO_PLAYWRIGHT_MCP || PW_MCP_VERSION}`;
  const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  if (external) { // tu navegador por la extensión; el token va en env (la config se escribe en un fichero 0600, nunca en la línea de órdenes)
    const token = extensionToken(), exe = externalBrowser();
    if (!token || !exe) return null;
    return { type: 'stdio', command: npxBin(), args: ['-y', pkg, '--extension', '--executable-path', exe, '--output-dir', pwOutputDir(task)], env: { ...env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } };
  }
  const args = ['-y', pkg, '--user-data-dir', pwProfileDir(), '--output-dir', pwOutputDir(task)];
  const exe = findBrowser();
  if (exe) args.push('--executable-path', exe); // sin navegador en el PC, Playwright pide el suyo (npx playwright install chromium)
  // Ventana VISIBLE si hay escritorio (el usuario ve lo que hace y puede hacer el login ahí); oculto sin escritorio o con AO_BROWSER_HEADLESS=1
  const headless = process.env.AO_BROWSER_HEADLESS === '1' || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (headless) {
    args.push('--headless');
    const ua = exe && normalUserAgent(exe); // sin «HeadlessChrome»: hay webs que lo rechazan (403)
    if (ua) args.push('--user-agent', ua);
  }
  if (process.env.AO_BROWSER_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
  // PATH con la carpeta de node: npx lanza `node` por el shebang
  return { type: 'stdio', command: npxBin(), args, env };
}
