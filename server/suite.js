// Candado de suite: AgentOffice es un complemento de flow-test y solo trabaja con un flow-test
// alcanzable y con acceso vigente (su `GET /access`: mode licensed|trial|linked|cloud → ok;
// expired|revoked → bloqueado). El QA, además, usa su MCP (`<flowTestUrl>/mcp`).
import * as store from './store.js';

const TTL_MS = 5 * 60 * 1000;
const BLOCKING_MODES = new Set(['expired', 'revoked']);
let cache = { at: 0, info: null };
let inflight = null;

export const flowTestUrl = () => String(store.get().settings.flowTestUrl || 'http://localhost:9998').replace(/\/+$/, '');
export const mcpUrl = () => flowTestUrl() + '/mcp';

export async function checkSuite(force = false) {
  if (!force && cache.info && Date.now() - cache.at < TTL_MS) return cache.info;
  if (inflight) return inflight;
  inflight = (async () => {
    const url = flowTestUrl();
    let info;
    try {
      const r = await fetch(url + '/access', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const a = await r.json();
      const mode = a.mode || 'unknown';
      const blocked = BLOCKING_MODES.has(mode);
      info = {
        ok: !blocked, reachable: true, url, mode,
        plan: a.effectivePlan || a.plan || null,
        org: a.linked?.org || a.org || null,
        daysLeft: a.daysLeft ?? null,
        reason: blocked ? (mode === 'revoked' ? 'La licencia de flow-test está revocada.' : 'La prueba o la licencia de flow-test ha caducado.') : null,
      };
    } catch (e) {
      info = { ok: false, reachable: false, url, mode: null, plan: null, org: null, daysLeft: null, reason: `No hay un flow-test en ${url} (${e.name === 'TimeoutError' ? 'no responde' : e.message}).` };
    }
    cache = { at: Date.now(), info };
    inflight = null;
    return info;
  })();
  return inflight;
}

// Versión síncrona para el planificador: lo último que se sabe (y dispara un refresco si está viejo).
export function suiteOk() {
  if (!cache.info || Date.now() - cache.at >= TTL_MS) checkSuite().catch(() => {});
  return !!cache.info?.ok;
}
export const suiteInfo = () => cache.info;
