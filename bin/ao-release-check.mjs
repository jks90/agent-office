#!/usr/bin/env node
// 🚀 Comprobación de la ⏰ programada «Publicar si hay cambios»: pide a AgentOffice la publicación programada
// (POST /api/release/scheduled) e imprime qué hizo. Sale con 0 (la programada solo lo apunta; las tareas
// «Documentar/Publicar» las crea el propio AgentOffice) o 1 si falla.  Env: AO_URL (por defecto http://127.0.0.1:7420).
const base = (process.env.AO_URL || `http://127.0.0.1:${process.env.AO_PORT || 7420}`).replace(/\/$/, '');
try {
  const r = await fetch(`${base}/api/release/scheduled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(`✗ ${j.error || `HTTP ${r.status}`}`); process.exit(1); }
  const ao = j.agentOffice, ft = j.flowTest || {};
  if (ao) console.log(ao.ahead ? `AgentOffice: ${ao.pushed ? `⬆ subidos ${ao.ahead} commit(s)` : `⚠ no se subió (${ao.skipped || 'error'})`}` : 'AgentOffice: sin cambios');
  console.log(ft.action === 'none' ? `flow-test: sin cambios desde ${ft.since || 'la última publicación'}`
    : ft.action === 'dispatched' ? `flow-test: 🚀 publicación ${ft.version} encargada (Documentar → Publicar)`
      : ft.action === 'busy' ? 'flow-test: ya hay una publicación en curso' : `flow-test: ${ft.action}${ft.version ? ' ' + ft.version : ''}`);
  process.exit(0);
} catch (e) { console.log(`✗ AgentOffice no responde: ${e.message}`); process.exit(1); }
