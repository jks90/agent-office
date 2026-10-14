#!/usr/bin/env node
// Copia parcheada de la extensión «Playwright MCP Bridge» para cargarla «sin empaquetar» en Brave/Chrome:
// una sola pestaña de trabajo. La extensión de la tienda, con token, se queda con su página connect.html (pestaña NUEVA en
// cada conexión) y suelta la conexión cuando una web cierra/cambia la página dos veces seguidas (login y logout de los
// bancos) → cada reconexión del MCP abre otra pestaña. El parche:
//   1. Recuerda la última pestaña de trabajo (chrome.storage.local) y, al reconectar con token, retoma ESA pestaña (vuelve
//      a su grupo «Playwright · …») y cierra la connect.html.
//   2. Reengancha el depurador hasta 5 veces en 10 s (la tienda: 1 vez cada 3 s) antes de dar la conexión por perdida.
// Mantiene la «key» del manifest: mismo ID (mmlmfjhmonkocbjadbfplnigmagldckm), así que el MCP la usa sin cambios.
// Uso: node bin/ao-pw-extension.mjs [carpeta de la extensión instalada]  →  data/pw-extension/ (Cargar descomprimida).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const DATA = process.env.AO_DATA_DIR || path.join(ROOT, 'data');
const OUT = path.join(DATA, 'pw-extension');

// Extensión de la tienda instalada (la última versión) en los perfiles habituales de Brave/Chrome
function findInstalled() {
  const h = os.homedir();
  const bases = [
    'snap/brave/current/.config/BraveSoftware/Brave-Browser', '.config/BraveSoftware/Brave-Browser',
    '.config/google-chrome', '.config/chromium', 'snap/chromium/common/chromium',
  ].map((b) => path.join(h, b));
  for (const base of bases) {
    let profiles = [];
    try { profiles = fs.readdirSync(base); } catch { continue; }
    for (const p of profiles) {
      const dir = path.join(base, p, 'Extensions', EXT_ID);
      let vers = [];
      try { vers = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, 'manifest.json'))).sort(); } catch { continue; }
      if (vers.length) return path.join(dir, vers.at(-1));
    }
  }
  return null;
}

function patch(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) throw new Error(`No encuentro el punto de parche en ${path.basename(file)}: ${from.slice(0, 60)}… (¿otra versión de la extensión?)`);
  fs.writeFileSync(file, src.replace(from, to));
}

const src = process.argv[2] || findInstalled();
if (!src || !fs.existsSync(path.join(src, 'manifest.json'))) {
  console.error('No encuentro la extensión «Playwright MCP Bridge» instalada; pásame su carpeta (…/Extensions/' + EXT_ID + '/<versión>).');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(src, OUT, { recursive: true, filter: (p) => !p.includes(`${path.sep}_metadata`) });

// manifest: sin actualizaciones de la tienda, con permiso de storage, nombre que se distinga
const mf = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
if (!mf.key) throw new Error('El manifest no trae «key»: la copia tendría otro ID y el MCP no la encontraría.');
delete mf.update_url;
mf.permissions = [...new Set([...(mf.permissions || []), 'storage'])];
mf.name = `${mf.name} (AgentOffice)`;
mf.version_name = `${mf.version}-ao`;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(mf, null, 2));

const bg = path.join(OUT, 'lib', 'background.mjs');
// 2. reenganche más paciente
patch(bg, 'var REATTACH_COOLDOWN_MS = 3e3;', 'var REATTACH_COOLDOWN_MS = 1e4;\nvar REATTACH_MAX = 5;');
patch(bg, `		if (this._recentReattach.has(tabId)) {
			debugLog(\`Not re-attaching tab \${tabId}: re-detached within \${REATTACH_COOLDOWN_MS}ms\`);
			return false;
		}
		this._recentReattach.add(tabId);
		setTimeout(() => this._recentReattach.delete(tabId), REATTACH_COOLDOWN_MS);`,
`		this._reattachCount ??= new Map();
		const n = (this._reattachCount.get(tabId) || 0) + 1;
		if (n > REATTACH_MAX) {
			debugLog(\`Not re-attaching tab \${tabId}: \${REATTACH_MAX} re-detaches within \${REATTACH_COOLDOWN_MS}ms\`);
			return false;
		}
		this._reattachCount.set(tabId, n);
		setTimeout(() => { const c = (this._reattachCount.get(tabId) || 1) - 1; if (c > 0) this._reattachCount.set(tabId, c); else this._reattachCount.delete(tabId); }, REATTACH_COOLDOWN_MS);`);
// 1a. la última pestaña enganchada es la de trabajo
patch(bg, `	_onTabAttached(tabId) {
`, `	_onTabAttached(tabId) {
		chrome.storage.local.set({ aoWorkTabId: tabId }).catch(() => {});
`);
// 1b. con token (sin pestaña elegida) retomar la de trabajo si sigue abierta y libre
patch(bg, `				const selectedTab = message.tab ?? sender.tab;
				this._connectTab(sender.tab.id, selectedTab, message.clientName).then(`,
`				(message.tab ? Promise.resolve(message.tab) : this._aoWorkTab(sender.tab)).then((selectedTab) => this._connectTab(sender.tab.id, selectedTab, message.clientName)).then(`);
patch(bg, `	async _releaseConnectPage(tabId) {`, `	async _aoWorkTab(senderTab) {
		try {
			await this._cleanupPromise;
			const { aoWorkTabId } = await chrome.storage.local.get("aoWorkTabId");
			if (aoWorkTabId == null || aoWorkTabId === senderTab.id) return senderTab;
			const tab = await chrome.tabs.get(aoWorkTabId).catch(() => null);
			if (!tab || isNonDebuggableUrl(tab.url) || this._connectedTabIds().has(tab.id) || this._pendingConnections.has(tab.id)) return senderTab;
			return tab;
		} catch {
			return senderTab;
		}
	}
	async _releaseConnectPage(tabId) {`);

console.log(`Lista en ${OUT} (desde ${src}).
En Brave: brave://extensions → quita «${mf.name.replace(' (AgentOffice)', '')}» de la tienda → «Modo de desarrollador» → «Cargar descomprimida» → ${OUT}.
La copia genera un token nuevo: pulsa su icono, cópialo y guárdalo en data/playwright-extension-token (0600).`);
