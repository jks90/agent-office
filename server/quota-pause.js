// FT-66 · Sin cuota a mitad de tarea: reconocer en el error de un motor que se acabó la cuota de la suscripción y
// cuándo vuelve. Puro (sin E/S) para poder probarlo. Lo usa team.js: en vez de dejar la tarea en «Fallidas», la pausa
// (`t.quotaPaused`) y `tick()` la relanza sola al reiniciarse la ventana (o con el otro motor si el agente es `auto`).
const PATTERNS = [
  /usage limit/i, /limit reached/i, /hit your (usage )?limit/i, /rate[ _-]?limit/i, /\b429\b/, /too many requests/i,
  /out of (extra )?usage/i, /(5|five)[- ]hour limit/i, /weekly limit/i, /quota (exceeded|exhausted)/i, /usage_limit_reached/i,
];
export const isQuotaError = (text) => PATTERNS.some((re) => re.test(String(text || '')));

// Hora de reinicio que traen los mensajes de los CLIs. Devuelve ms o null.
//   «Claude AI usage limit reached|1759780800»  · «resets 7pm» · «resets at 18:59» · «try again at 8:53 PM» · «in 2 hours» · «in 45 minutes»
export function resetFromText(text, now = Date.now()) {
  const s = String(text || '');
  const ep = s.match(/\|\s*(\d{10,13})\b/);
  if (ep) { const n = Number(ep[1]); return n < 1e12 ? n * 1000 : n; }
  const rel = s.match(/\bin\s+(\d+)\s*(h|hours?|horas?|m|min|minutes?|minutos?)\b/i);
  if (rel) return now + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3600e3 : 60e3);
  const at = s.match(/(?:resets?|try again|reinicia|vuelve)\D{0,12}?(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let h = Number(at[1]); const m = Number(at[2] || 0); const ap = (at[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

// {hit:false} | {hit:true, resetsAt|null}
export function detectQuotaHit(text, now = Date.now()) {
  if (!isQuotaError(text)) return { hit: false };
  return { hit: true, resetsAt: resetFromText(text, now) };
}
