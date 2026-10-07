// FT-142 · Marketplace: cliente de la nube. AgentOffice solo habla con flow-test (`<flowTestUrl>/account-link/marketplace/*`),
// que reenvía a flow-accounts con el token de vinculación (nunca llega aquí). Empaquetar/instalar: marketplace.js (FT-141).
import * as store from './store.js';
import { flowTestUrl } from './suite.js';
import * as mp from './marketplace.js';

const fail = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const SCOPES = ['team', 'public'];
const KINDS = ['role', 'skill', 'agent'];
const linkUrl = () => `${flowTestUrl()}/account-link`;
const UNLINKED = 'Esta instalación no está vinculada a una cuenta de FlowTest: vincúlala en flow-test para usar el marketplace';

// Llamada a la puerta de flow-test. Sin vinculación (401/403/412 o `unlinked`) → aviso claro con enlace.
async function call(method, sub, body) {
  let r;
  try {
    r = await fetch(`${flowTestUrl()}/account-link/marketplace${sub}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw fail(502, `flow-test no responde (${flowTestUrl()}): ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403 || r.status === 412 || j.unlinked) throw fail(412, UNLINKED, { unlinked: true, linkUrl: linkUrl() });
  if (!r.ok) throw fail(r.status === 404 ? 404 : r.status >= 500 ? 502 : r.status, j.error || j.message || `flow-test respondió ${r.status}`);
  return j;
}

const checkScope = (s) => { if (!SCOPES.includes(s)) throw fail(400, 'Ámbito desconocido (team|public)'); return s; };
const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };

// Lista con lo ya instalado: `installedVersion` y `update` (hay una versión distinta a la instalada).
export async function search({ scope = 'team', kind, q } = {}) {
  checkScope(scope);
  if (kind && !KINDS.includes(kind)) throw fail(400, 'Tipo desconocido (role|skill|agent)');
  const list = await call('GET', qs({ scope, kind, q }));
  const reg = mp.installed();
  return (Array.isArray(list) ? list : []).map((i) => {
    const prev = reg[`${i.kind}:${i.name}`];
    return { ...i, installedVersion: prev?.version || null, update: !!prev && prev.version !== i.version };
  });
}

// ¿Vinculada? (para pintar el aviso antes de listar)
export async function status() {
  try { await call('GET', qs({ scope: 'team' })); return { linked: true, linkUrl: linkUrl() }; }
  catch (e) { if (e.unlinked) return { linked: false, linkUrl: e.linkUrl, error: e.message }; return { linked: null, linkUrl: linkUrl(), error: e.message }; }
}

const idOf = (id) => { if (!/^[\w.-]{1,80}$/.test(String(id || ''))) throw fail(400, 'Id de paquete no válido'); return id; };
const fileList = (pkg) => pkg.files.map((f) => ({ path: f.path, size: Buffer.from(f.content, 'base64').length, exec: !!f.exec }));

// Qué se subiría (ya saneado) sin enviar nada.
export function previewPublish(b = {}) {
  const scope = checkScope(b.scope || 'team');
  const pkg = mp.exportPackage(b.kind, b.id, scope, { version: b.version || undefined, projectId: b.projectId });
  if (b.summary) pkg.summary = String(b.summary).slice(0, 300);
  return {
    scope, kind: pkg.kind, name: pkg.name, version: pkg.version, summary: pkg.summary, size: Buffer.byteLength(JSON.stringify(pkg)),
    files: fileList(pkg), hasCode: !!pkg.meta?.hasCode,
    memory: pkg.memory ? { agent: pkg.memory.agent.length, project: pkg.memory.project?.length || 0, sample: pkg.memory.agent.slice(0, 600) } : null,
    sanitized: 'Rutas del usuario → {{HOME}}; paquete sin secretos detectados', // exportPackage rechaza con 422 si hay secretos
  };
}

export async function publish(b = {}) {
  const scope = checkScope(b.scope || 'team');
  const opts = { version: b.version || undefined, projectId: b.projectId };
  if (opts.version && !/^\d+\.\d+\.\d+/.test(String(opts.version))) throw fail(400, 'Versión no válida (semver, p. ej. 1.0.0)');
  const pkg = mp.exportPackage(b.kind, b.id, scope, opts);
  if (b.summary) pkg.summary = String(b.summary).slice(0, 300);
  const r = await call('POST', '', { scope, package: pkg });
  return { ...r, scope, name: pkg.name, version: pkg.version, pending: scope === 'public' };
}

async function fetchItem(id) {
  const r = await call('GET', `/${encodeURIComponent(idOf(id))}`);
  if (!r?.package) throw fail(502, 'La nube no devolvió el paquete');
  return r;
}

// Antes de instalar: ficheros, código, memoria, si ya existe (para los 🛡 y el selector de proyecto).
export async function inspectItem(id) {
  const { item, package: pkg } = await fetchItem(id);
  const info = mp.inspect(pkg, { org: item.orgName });
  return { item, info, files: fileList(pkg), projects: store.get().projects.map((p) => ({ id: p.id, name: p.name })) };
}

export async function install(id, b = {}) {
  const { item, package: pkg } = await fetchItem(id);
  const r = mp.importPackage(pkg, {
    org: item.orgName, scope: item.scope, marketId: item.id || id,
    overwrite: !!b.overwrite, confirmCode: !!b.confirmCode, projectId: b.projectId, agentName: b.agentName,
  });
  return { ...r, scope: item.scope, orgName: item.orgName };
}

export async function remove(id) { return call('DELETE', `/${encodeURIComponent(idOf(id))}`); }
