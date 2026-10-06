// Guide Agent (FT-6): servicio de conversación por encima del orquestador. Chats persistentes en data/guide/<id>.json
// (mensajes, tool calls con su resultado, contexto de cada turno). Cada turno se prepara con <app_context> (FT-2) y
// <eventos_desde_tu_ultimo_turno> (FT-1) y lo ejecuta un GuideProvider (providers/*.js); sus eventos salen tal cual
// por SSE (POST /api/guide/chat). Las tools que usa son las de FT-4 (políticas y auditoría incluidas).
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as context from '../context.js';
import * as activity from '../events.js';
import { SYSTEM } from './prompt.js';
import * as review from '../review.js';
import { resolveRefs } from '../uploads.js'; // FT-95
import * as claudeCli from './providers/claude-cli.js';
import * as anthropicApi from './providers/anthropic-api.js';
import * as openaiApi from './providers/openai-api.js';
import { provider as localApi } from './providers/local-api.js';
import * as fakeProvider from './providers/fake.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const PROVIDERS = { 'claude-cli': claudeCli, 'anthropic-api': anthropicApi, 'openai-api': openaiApi, 'local-api': localApi, ...(process.env.AO_GUIDE_FAKE === '1' ? { fake: fakeProvider } : {}) }; // `fake` (FT-11): solo para pruebas e2e
export const providerNames = () => Object.keys(PROVIDERS);
// Para Ajustes (FT-8): proveedores elegibles con su modelo por defecto y si tienen credenciales. El modelo de cada uno va en
// settings.guideModels[proveedor]; claude-cli conserva settings.guideModel (FT-6).
export const providerInfo = () => Object.entries(PROVIDERS).filter(([n]) => n !== 'fake').map(([id, m]) => ({ id, label: m.label, defaultModel: m.defaultModel, ready: m.ready() }));
export function modelFor(name) {
  const st = store.get().settings;
  return (name === 'claude-cli' ? st.guideModel : st.guideModels?.[name]) || PROVIDERS[name].defaultModel;
}
const DIR = () => path.join(store.DATA_DIR, 'guide');
const file = (id) => path.join(DIR(), `${id}.json`);
const MAX_EVENTS = 40;
const MAX_MESSAGES = 400;

const active = new Map();   // chatId → provider con el turno en curso (para parar)
const providers = new Map(); // chatId → { provider, model }

function readChat(id) {
  if (!/^[\w-]+$/.test(String(id))) throw fail(400, 'Id de chat no válido');
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { throw fail(404, 'Chat no encontrado'); }
}
function saveChat(chat) {
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = file(chat.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(chat));
  fs.renameSync(tmp, file(chat.id));
}

export function listChats() {
  let names = [];
  try { names = fs.readdirSync(DIR()).filter((n) => n.endsWith('.json')); } catch { /* aún no hay chats */ }
  return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(DIR(), n), 'utf8')); } catch { return null; } }).filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length, busy: active.has(c.id) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
export const getChat = (id) => readChat(id);
export function deleteChat(id) {
  readChat(id);
  stop(id);
  providers.delete(id);
  fs.rmSync(file(id), { force: true });
  return { ok: true };
}

// ── Contexto de cada turno ──────────────────────────────────────────────────
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);
function eventsBlock(since) {
  const evs = activity.list(since ? { since, limit: 500 } : { limit: 10 }).filter((e) => e.type !== 'AgentToolFinished');
  const shown = evs.slice(-MAX_EVENTS);
  const lines = shown.map((e) => {
    const d = Object.entries(e.data || {}).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(' ');
    return `${clock(e.ts)} ${e.type} ${e.taskCode || ''} ${e.agentId ? 'agente=' + e.agentId : ''} ${d}`.replace(/\s+/g, ' ').trim();
  });
  const omitted = evs.length - shown.length;
  return `<eventos_desde_tu_ultimo_turno>\n${lines.length ? (omitted > 0 ? `(… ${omitted} anteriores omitidos)\n` : '') + lines.join('\n') : '(ninguno)'}\n</eventos_desde_tu_ultimo_turno>`;
}
// FT-56: tareas en revisión desde hace más de reviewNudgeMin → el Guía las menciona en su siguiente respuesta
function pendingReview() {
  const st = store.get();
  const b = review.pendingBlock(st.tasks, Date.now(), review.nudgeMin(st.settings));
  return b ? `\n${b}` : '';
}
function appContext(client) {
  const { recentEvents, ...c } = context.get(client); // los eventos van en su propio bloque
  return c;
}

// ── Un turno de conversación ───────────────────────────────────────────────
// Generador de eventos {type:'chat', chat} · {type:'text'|'tool_call'|'tool_result'|'done'|'error', …}.
export async function* chat({ chatId, text, attachments, client = null }) {
  text = String(text || '').trim();
  const files = resolveRefs(attachments); // FT-95: referencias a data/uploads (POST /api/upload)
  if (!text && !files.length) throw fail(400, 'Falta el texto');
  const shown = text || 'Adjuntos';
  if (files.length) text = `${text}\n\nAdjuntos (ficheros locales, léelos con tus herramientas si hace falta):\n${files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}`.trim();
  const cur = chatId ? readChat(chatId) : null;
  if (cur && active.has(cur.id)) throw fail(409, 'Este chat ya está respondiendo: espera o pulsa «Parar»');
  const c = cur || { id: 'g_' + store.newId(), title: shown.slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, provider: null, lastEventTs: 0, messages: [] };
  const name = store.get().settings.guideProvider || 'claude-cli';
  if (!PROVIDERS[name]) throw fail(400, `Proveedor de Guide desconocido: ${name}`);
  const model = modelFor(name);

  let slot = providers.get(c.id);
  if (!slot || slot.model !== model || slot.name !== name) {
    slot?.provider.stop();
    const provider = PROVIDERS[name].create();
    provider.start({ system: SYSTEM, model, resume: c.provider === name ? c.sessionId : null, history: c.messages, cwd: store.DATA_DIR, chatId: c.id });
    slot = { provider, model, name };
    providers.set(c.id, slot);
  }
  const { provider } = slot;

  const ctx = appContext(client);
  const turnStart = Date.now();
  const prompt = `<app_context>\n${JSON.stringify(ctx, null, 1).slice(0, 12_000)}\n</app_context>\n${eventsBlock(c.lastEventTs)}${pendingReview()}`;
  const { host, ...ctxLite } = ctx; // en el chat guardado, sin el contexto de flow-test (puede ser grande)
  c.messages.push({ role: 'user', ts: turnStart, text: shown, ...(files.length ? { attachments: files } : {}), context: { ...ctxLite, task: ctx.task && { code: ctx.task.code, title: ctx.task.title, status: ctx.task.status }, agent: ctx.agent && { name: ctx.agent.name }, project: ctx.project && { name: ctx.project.name }, hasHost: !!host } });
  c.updatedAt = turnStart;
  saveChat(c);
  yield { type: 'chat', chat: { id: c.id, title: c.title } };

  active.set(c.id, provider);
  store.changed();
  let reply = '';
  const flush = () => { if (reply) { c.messages.push({ role: 'assistant', ts: Date.now(), text: reply }); reply = ''; } };
  try {
    for await (const ev of provider.send({ text, context: prompt, client })) {
      if (ev.type === 'text') { reply += (reply ? '\n\n' : '') + ev.text; }
      else if (ev.type === 'tool_call') { flush(); c.messages.push({ role: 'tool', ts: Date.now(), id: ev.id, name: ev.name, args: ev.args, ok: null, result: null }); }
      else if (ev.type === 'tool_result') { flush(); const m = c.messages.findLast((x) => x.role === 'tool' && x.id === ev.id); if (m) Object.assign(m, { ok: ev.ok, result: ev.result.slice(0, 4000) }); }
      else if (ev.type === 'error') { flush(); c.messages.push({ role: 'error', ts: Date.now(), text: ev.error, stopped: !!ev.stopped }); }
      else if (ev.type === 'done') { flush(); if (ev.costUsd != null || ev.usage) c.messages.push({ role: 'meta', ts: Date.now(), provider: name, model, costUsd: ev.costUsd ?? null, usage: ev.usage || null }); }
      yield ev.type === 'done' ? { ...ev, provider: name, model } : ev;
      if (ev.type !== 'text') { c.updatedAt = Date.now(); saveChat(c); }
    }
  } finally {
    flush();
    active.delete(c.id);
    c.sessionId = provider.sessionId || c.sessionId;
    c.provider = name;
    c.lastEventTs = turnStart;
    c.updatedAt = Date.now();
    saveChat(c);
    store.changed();
  }
}

export function stop(chatId) {
  const p = active.get(chatId);
  if (!p) return { ok: true, stopped: false };
  p.stop();
  return { ok: true, stopped: true };
}
