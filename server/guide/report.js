// 📮 «Reportar al admin» del Guía: cuando el Guía NO puede hacer lo que le piden (no hay tool, o la app se lo deniega por
// permisos o porque no existe), llama a guide.report, que solo DEJA OFRECIDO el reporte: el chat pinta un botón y es el
// usuario quien decide enviarlo. Al pulsarlo, AgentOffice lo entrega a flow-test (POST <flowTestUrl>/feedback), que lo firma
// con la credencial de la instalación, lo reintenta si el cloud no responde y lo deja en 📮 Reportes del admin de
// flow-accounts (allí el callcenter lo convierte en tarea). El usuario solo ve si se envió o no.
// Estado en data/guide-reports.json (sin datos sensibles: lo que pidió, por qué no se pudo y dónde estaba).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from '../store.js';
import { flowTestUrl } from '../suite.js';

const FILE = () => path.join(store.DATA_DIR, 'guide-reports.json');
const MAX = 500;
const fail = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => String(s || '').replace(/\s+\n/g, '\n').trim().slice(0, n);
export const TITLE_PREFIX = '🧭 Guía no pudo: ';

function load() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } }
function save(all) {
  const ids = Object.keys(all);
  if (ids.length > MAX) for (const id of ids.sort((a, b) => all[a].createdAt - all[b].createdAt).slice(0, ids.length - MAX)) delete all[id];
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 1), { mode: 0o600 });
}
// Lo que ve el chat: solo el estado (offered | sent | failed), nunca la respuesta del servidor.
const view = (r) => ({ id: r.id, status: r.status, title: r.title });

// guide.report: registra la oferta. No envía nada.
export function offer({ title, request, reason }, ctx = {}) {
  const t = clip(title, 160);
  if (!t) throw fail(400, 'Falta un título corto del reporte');
  const all = load();
  const r = {
    id: crypto.randomBytes(6).toString('hex'), status: 'offered', createdAt: Date.now(),
    title: t, request: clip(request, 4000), reason: clip(reason, 2000), chatId: ctx.chatId || null,
    where: ctx.where || null,
  };
  all[r.id] = r;
  save(all);
  return { reportId: r.id, offered: true, note: 'El usuario ve un botón «📮 Reportar al admin»: no lo envíes tú ni digas que ya está enviado.' };
}

export const list = () => Object.fromEntries(Object.values(load()).map((r) => [r.id, view(r)]));

// El usuario pulsa el botón → entrega por flow-test. Un reporte enviado no se reenvía.
export async function send(id, { fetchImpl = fetch } = {}) {
  const all = load();
  const r = all[id];
  if (!r) throw fail(404, 'Reporte no encontrado');
  if (r.status === 'sent') return view(r);
  const s = store.get();
  const description = [
    `El Guía de AgentOffice no pudo hacer lo que se le pidió y el usuario lo ha reportado.`,
    '', `**Qué pidió:** ${r.request || '—'}`, '', `**Por qué no se pudo:** ${r.reason || '—'}`,
    '', `**Dónde:** ${r.where || '—'} · AgentOffice ${s.settings?.aoVersion || ''}`.trim(),
  ].join('\n');
  let ok = false, error = null;
  try {
    const res = await fetchImpl(`${flowTestUrl()}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ kind: 'idea', title: (TITLE_PREFIX + r.title).slice(0, 200), description, context: { from: 'agentoffice-guide', where: r.where } }),
    });
    const j = await res.json().catch(() => ({}));
    ok = res.ok && j.ok !== false; // entregado o en cola de reintento de flow-test: ya está fuera de aquí
    if (!ok) error = j.error || `flow-test respondió ${res.status}`;
  } catch (e) { error = `flow-test no responde: ${e.message}`; }
  Object.assign(r, { status: ok ? 'sent' : 'failed', sentAt: ok ? Date.now() : r.sentAt || null, error: ok ? null : String(error).slice(0, 300) });
  save(all);
  return view(r);
}
