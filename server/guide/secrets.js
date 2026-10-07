// FT-137 · Contraseñas que el usuario da al Guía en su petición y que el agente puede teclear en el navegador (con 🛡).
// Módulo sin dependencias: lo usan tools.js (autoriza el tecleo), guide/index.js (enmascara chat y SSE) y policy.js.
// Nada de esto toca disco: los valores viven solo en memoria mientras el servidor corre.
export const MASK = '••••••';

const chats = new Map(); // chatId → { messages: () => mensajes del chat en curso, known: Set de valores ya autorizados }

// El chat registra cómo leer sus mensajes (para comprobar que el usuario escribió el valor en ESTA conversación).
export function bind(chatId, messages) {
  const c = chats.get(chatId) || { known: new Set() };
  c.messages = messages;
  chats.set(chatId, c);
}

// ¿El valor lo escribió el usuario en esta conversación? Si sí, queda registrado para enmascararlo en adelante.
export function authorize(chatId, value) {
  const c = chatId && chats.get(chatId);
  const v = String(value ?? '');
  if (!c || !v) return false;
  if (c.known.has(v)) return true;
  if (!(c.messages?.() || []).some((m) => m.role === 'user' && String(m.text || '').includes(v))) return false;
  c.known.add(v);
  return true;
}

// Sustituye todos los valores autorizados del chat en un texto (o en el JSON serializado de un objeto).
export function mask(chatId, text) {
  const c = chats.get(chatId);
  let s = String(text ?? '');
  if (c) for (const v of c.known) s = s.split(v).join(MASK).split(JSON.stringify(v).slice(1, -1)).join(MASK);
  return s;
}

export const has = (chatId) => !!chats.get(chatId)?.known.size;
export const forget = (chatId) => chats.delete(chatId);
