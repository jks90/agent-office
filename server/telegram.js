// Avisos al móvil por Telegram: lo que necesita a la persona no se queda solo en la interfaz.
// Escucha el Activity Stream (bus `activity`) y manda ReviewPending, AgentBlocked y AgentFailed.
// Config en data/telegram.json (data/ no va a git) o por env AO_TELEGRAM_TOKEN + AO_TELEGRAM_CHATS (ids separados por comas):
//   { "enabled": true, "botToken": "123:abc", "chatIds": ["831858839"] }
// Sin token o con enabled:false no hace nada. Nunca debe tumbar al orquestador.
import fs from 'node:fs';
import path from 'node:path';
import { bus, DATA_DIR, get, log } from './store.js';

const CFG_FILE = path.join(DATA_DIR, 'telegram.json');
const COOLDOWN_MS = 30 * 60e3; // mismo aviso (tipo + tarea/motor) como mucho cada 30 min
const last = new Map();

export function config() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* sin fichero */ }
  const token = f.botToken || process.env.AO_TELEGRAM_TOKEN || '';
  const chats = (Array.isArray(f.chatIds) ? f.chatIds : String(process.env.AO_TELEGRAM_CHATS || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  return { enabled: f.enabled !== false && !!token && chats.length > 0, token, chats };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const projectName = (id) => get().projects.find((p) => p.id === id)?.name || id || '—';
const agentName = (id) => get().agents.find((a) => a.id === id)?.name || '';

export async function send(text) {
  const c = config();
  if (!c.enabled) return 0;
  let sent = 0;
  for (const chat of c.chats) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) sent += 1; else console.warn('[telegram] fallo', r.status);
    } catch (e) { console.warn('[telegram]', e.message); }
  }
  return sent;
}

// ── Confirmaciones con botones ✅/❌ (FT-170) ──────────────────────────────────────────────
// sendConfirm(texto, id) manda el mensaje con inline_keyboard; un poll de getUpdates (sin webhook, offset persistido)
// atiende callback_query. waitConfirm(id) → 'yes'|'no'|'timeout'. Estado en data/telegram-confirms.json (sobrevive a un reinicio).
// Solo vale la respuesta de un chat de data/telegram.json; el resto se ignora y queda en el log (SSE `log`, agente «telegram»).
const CONFIRM_FILE = path.join(DATA_DIR, 'telegram-confirms.json');
export const CONFIRM_TTL_MS = 12 * 3600e3;
const POLL_MS = 3000;
let now = () => Date.now(); // reloj sustituible en tests
export const _setClock = (fn) => { now = fn || (() => Date.now()); };
const waiters = new Map(); // id → [resolve]
let timer = null;

const note = (line) => log('telegram', line);
const loadConf = () => { try { return { offset: 0, items: {}, ...JSON.parse(fs.readFileSync(CONFIRM_FILE, 'utf8')) }; } catch { return { offset: 0, items: {} }; } };
const saveConf = (s) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CONFIRM_FILE, JSON.stringify(s)); } catch (e) { console.warn('[telegram]', e.message); } };
const api = async (c, method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${c.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`${method} ${r.status}`);
  return (await r.json())?.result;
};
const LABEL = { yes: '✅ Publicado', no: '❌ No publicar', timeout: '⌛ Caducado (12 h sin respuesta): NO se publica' };

function settle(s, id, status, note_) {
  const it = s.items[id];
  it.status = status; it.resolvedAt = now();
  saveConf(s);
  note(`confirmación ${id}: ${status}${note_ ? ` (${note_})` : ''}`);
  for (const r of waiters.get(id) || []) r(status);
  waiters.delete(id);
}

async function markMessages(c, it, status) {
  for (const m of it.messages || []) {
    try { await api(c, 'editMessageText', { chat_id: m.chat, message_id: m.id, text: `${it.text}\n\n${LABEL[status]}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); }
    catch (e) { note(`no se pudo editar el mensaje de ${it.id}: ${e.message}`); }
  }
}

/** Manda la pregunta con «✅ Publicar / ❌ No». Devuelve cuántos chats la recibieron. */
export async function sendConfirm(text, id) {
  const c = config();
  if (!c.enabled) return 0;
  id = String(id);
  const safe = String(text ?? '').split(c.token).join('***');
  const s = loadConf();
  const it = s.items[id] = { id, text: safe, status: 'pending', createdAt: now(), messages: [] };
  for (const chat of c.chats) {
    try {
      const res = await api(c, 'sendMessage', {
        chat_id: chat, text: safe, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '✅ Publicar', callback_data: `ao:yes:${id}` }, { text: '❌ No', callback_data: `ao:no:${id}` }]] },
      });
      it.messages.push({ chat: String(chat), id: res?.message_id });
    } catch (e) { note(`fallo al enviar la confirmación ${id}: ${e.message}`); }
  }
  saveConf(s);
  startPolling();
  return it.messages.length;
}

/** Espera la respuesta: 'yes' | 'no' | 'timeout'. Una confirmación desconocida cuenta como 'timeout' (nunca publica). */
export function waitConfirm(id) {
  id = String(id);
  const it = loadConf().items[id];
  if (!it) return Promise.resolve('timeout');
  if (it.status !== 'pending') return Promise.resolve(it.status);
  startPolling();
  return new Promise((res) => { waiters.set(id, [...(waiters.get(id) || []), res]); });
}

/** Un ciclo: caduca las vencidas y atiende getUpdates. Exportada para tests. */
export async function pollOnce() {
  const c = config(), s = loadConf();
  if (!c.enabled) return;
  for (const it of Object.values(s.items)) {
    if (it.status === 'pending' && now() - it.createdAt >= CONFIRM_TTL_MS) { settle(s, it.id, 'timeout'); await markMessages(c, it, 'timeout'); }
  }
  if (!Object.values(s.items).some((i) => i.status === 'pending')) return;
  let updates = [];
  try { updates = (await api(c, 'getUpdates', { offset: s.offset, timeout: 0, allowed_updates: ['callback_query'] })) || []; }
  catch (e) { note(`getUpdates: ${e.message}`); return; }
  for (const u of updates) {
    s.offset = Math.max(s.offset, u.update_id + 1);
    const q = u.callback_query;
    if (!q) continue;
    const chat = String(q.message?.chat?.id ?? '');
    if (!c.chats.includes(chat)) { note(`respuesta ignorada de un chat ajeno (${chat || '?'})`); continue; }
    const m = /^ao:(yes|no):(.+)$/.exec(q.data || ''), it = m && s.items[m[2]];
    let reply = 'Respuesta no válida';
    if (it && it.status === 'pending') { settle(s, it.id, m[1], `chat ${chat}`); reply = LABEL[m[1]]; await markMessages(c, it, m[1]); }
    else if (it) reply = `Ya está resuelta (${it.status})`;
    try { await api(c, 'answerCallbackQuery', { callback_query_id: q.id, text: reply }); } catch { /* best effort */ }
  }
  saveConf(s);
}

function startPolling() {
  if (timer) return;
  timer = setInterval(() => {
    pollOnce().catch((e) => note(`poll: ${e.message}`));
    if (!Object.values(loadConf().items).some((i) => i.status === 'pending')) { clearInterval(timer); timer = null; }
  }, POLL_MS);
  timer.unref?.();
}
// Tras un reinicio, retoma el poll si había confirmaciones pendientes.
try { if (Object.values(loadConf().items).some((i) => i.status === 'pending') && config().enabled) startPolling(); } catch { /* nunca tumba */ }

/** Texto del aviso para un evento, o null si ese evento no se avisa. */
export function message(ev) {
  const d = ev.data || {}, task = ev.taskCode ? `<b>${esc(ev.taskCode)}</b>` : 'una tarea', who = agentName(ev.agentId);
  const head = `🏢 <b>${esc(projectName(ev.projectId))}</b>${who ? ` · ${esc(who)}` : ''}`;
  if (ev.type === 'ReviewPending') {
    const blocks = (d.blocks || []).length ? `\nBloquea: ${d.blocks.map(esc).join(', ')}` : '';
    return `👀 ${task} espera tu revisión desde hace ${d.minutes} min\n${head}${blocks}`;
  }
  if (ev.type === 'SupervisorDecision') return d.action === 'recommend' ? `🧑‍⚖️ ${task}: ${esc(d.text)}\n${head}` : null;
  if (ev.type === 'ReviewBlocking') return `🚧 ${task} lleva ${d.minutes} min en revisión y bloquea a ${(d.blocks || []).length} tarea(s): ${(d.blocks || []).map(esc).join(', ')}${d.required ? '\n(revisión obligatoria: solo tú puedes aprobarla)' : ''}\n${head}`;
  if (ev.type === 'AgentBlocked') {
    if (d.question) return `❓ ${task} tiene una pregunta para ti:\n<i>${esc(String(d.question).slice(0, 400))}</i>\n${head}`;
    if (d.reason === 'quota') return `⏸ Sin cuota de ${esc(d.engine)} (${d.percent ?? '?'} %) — ${task} parada${d.resetsAt ? ` hasta ${esc(new Date(d.resetsAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}` : ''}\n${head}`;
    if (d.reason === 'stuck') return `🌀 ${task} parece atascada (${esc(d.signal)})\n${head}`;
    if (d.reason === 'budget') return `💸 ${task} llegó al tope de gasto (${Number(d.costUsd || 0).toFixed(2)} / ${d.capUsd} US$)\n${head}`;
    return `⛔ ${task} bloqueada (${esc(d.reason || '?')})\n${head}`;
  }
  if (ev.type === 'AgentFailed') return `❌ ${task} ha fallado:\n<code>${esc(String(d.error || '').slice(0, 300))}</code>\n${head}`;
  return null;
}

// La cuota se avisa una vez por motor (si no, llega un mensaje por cada tarea parada); el resto, por tarea.
const keyOf = (ev) => (ev.data?.reason === 'quota' ? `quota:${ev.data.engine}` : `${ev.type}:${ev.taskId || ev.taskCode}`);

bus.on('activity', (ev) => {
  try {
    const text = message(ev);
    if (!text || !config().enabled) return;
    const k = keyOf(ev), now = Date.now();
    if (now - (last.get(k) || 0) < COOLDOWN_MS) return;
    last.set(k, now);
    send(text).catch(() => {});
  } catch { /* nunca tumba al orquestador */ }
});
