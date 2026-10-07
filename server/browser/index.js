// FT-114 · Navegador del agente (Fase A): Chromium dedicado por CDP. Una sola instancia compartida.
//
// Contrato BrowserDriver (cdp.js y fake.js lo cumplen; la Fase B —extensión MV3— usará el mismo):
//   available() → { ok, missing[], exe, headless }          isOpen() → bool
//   launch() · close()                       // close no borra el perfil (data/browser/profile)
//   tabs.list() · tabs.new({url?}) · tabs.select({id}) · tabs.close({id?})   → { id, url, title, active }
//   navigate({url}) · back() · forward() · reload()          → { url, title }   (solo http/https)
//   snapshot() → { tabId, url, title, nodes:[{ref, role, name, value, states[], frame?}], total, truncated, omitted }
//   act({ref|x,y, action:'click'|'dblclick'|'hover'|'focus'|'select', value?}) · type({ref?, text, clear?, submit?, key?}) · scroll({ref|x,y, dx, dy})
//   screenshot({format?, fullPage?}) → { path, width≤1280, height, bytes, format }   en data/browser/captures
//   evaluate({expression}) → { value } · console({limit?, clear?}) · network({limit?, clear?}) → { entries } (anillo de 200, cabeceras sensibles a ***)
//   waitFor({text|selector|url|ms, timeout?})
// Errores con `.status` (400 entrada, 404 ref/pestaña, 408 espera, 422 evaluate, 503 sin navegador).
// Env: AO_BROWSER=fake · AO_BROWSER_PATH · AO_BROWSER_HEADLESS=1 · AO_BROWSER_IDLE_MS (15 min) · AO_BROWSER_NO_SANDBOX=1
import { createCdpDriver } from './cdp.js';
import { createFakeDriver } from './fake.js';

let shared = null;
export function getDriver() {
  if (!shared) shared = process.env.AO_BROWSER === 'fake' ? createFakeDriver() : createCdpDriver();
  return shared;
}
export { renderSnapshot } from './util.js';
