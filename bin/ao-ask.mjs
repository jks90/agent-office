#!/usr/bin/env node
// Pregunta al cliente desde una tarea de AgentOffice y espera su respuesta (la imprime por stdout).
//
//   node bin/ao-ask.mjs "¿Baja el stock al marcar dañado?" --opt "Sí, baja" --opt "No: queda como dañado"
//   node bin/ao-ask.mjs "¿Qué nombre le pongo al parámetro?"            # respuesta libre
//   --no-custom       solo se puede elegir una opción
//   --context "…"     detalle que ayuda a decidir (se enseña bajo la pregunta)
//   --timeout <min>   cuánto esperar como máximo (por defecto AO_ASK_TIMEOUT_MIN o 120)
//
// Entorno (lo pone AgentOffice al lanzar al agente): AO_URL, AO_TASK, AO_TOKEN (opcional).
// Si nadie responde a tiempo imprime «SIN RESPUESTA …» y sale con 0: el agente decide él y lo anota.
const args = process.argv.slice(2);
const opts = [];
let question = '', context = '', allowCustom = true, timeoutMin = Number(process.env.AO_ASK_TIMEOUT_MIN || 120);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--opt' || a === '-o') opts.push(args[++i]);
  else if (a === '--context' || a === '-c') context = args[++i];
  else if (a === '--no-custom') allowCustom = false;
  else if (a === '--timeout') timeoutMin = Number(args[++i]) || timeoutMin;
  else if (a === '-h' || a === '--help') { console.log('uso: ao-ask "pregunta" [--opt A --opt B] [--no-custom] [--context "…"] [--timeout min]'); process.exit(0); }
  else question += (question ? ' ' : '') + a;
}
const base = (process.env.AO_URL || 'http://127.0.0.1:7420').replace(/\/$/, '');
const taskId = process.env.AO_TASK;
if (!taskId) { console.log('SIN RESPUESTA (este comando solo funciona dentro de una tarea de AgentOffice). Decide tú con criterio y anótalo en el resumen.'); process.exit(0); }
if (!question.trim()) { console.error('Falta la pregunta'); process.exit(2); }
const headers = { 'content-type': 'application/json', ...(process.env.AO_TOKEN ? { 'x-ao-token': process.env.AO_TOKEN } : {}) };
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${path}`);
  return j;
};
try {
  const { id } = await call('POST', '/api/questions', { taskId, question, options: opts, allowCustom, context });
  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    const r = await call('POST', `/api/questions/${id}/wait`, { ms: 50000 });
    if (r.status === 'answered') { console.log(r.answer); process.exit(0); }
    if (r.status === 'cancelled') { console.log('SIN RESPUESTA (la pregunta se canceló). Decide tú con el criterio más conservador y anótalo en el resumen final.'); process.exit(0); }
  }
  console.log(`SIN RESPUESTA (el cliente no contestó en ${timeoutMin} min). Decide tú con el criterio más conservador, deja la decisión bien visible en el resumen final y sigue.`);
} catch (e) {
  console.log(`SIN RESPUESTA (no pude preguntar: ${e.message}). Decide tú con el criterio más conservador y anótalo en el resumen final.`);
}
