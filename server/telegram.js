// Avisos al móvil por Telegram: lo que necesita a la persona no se queda solo en la interfaz.
// Escucha el Activity Stream (bus `activity`) y manda ReviewPending, AgentBlocked y AgentFailed.
// Config en data/telegram.json (data/ no va a git) o por env AO_TELEGRAM_TOKEN + AO_TELEGRAM_CHATS (ids separados por comas):
//   { "enabled": true, "botToken": "123:abc", "chatIds": ["831858839"] }
// Sin token o con enabled:false no hace nada. Nunca debe tumbar al orquestador.
import fs from 'node:fs';
import path from 'node:path';
import { bus, DATA_DIR, get } from './store.js';

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
