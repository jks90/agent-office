// Plantilla de 9–10 agentes: genera la planta «team-10» a partir de «team-8» con una 5.ª fila de mesas (Trabajo, QA y Kanban)
// y todo lo que hay al sur (pasillo sur, café, recreo, recepción) 1,6 más abajo; y sus posiciones de decoración siguiendo el
// mismo patrón que hay entre team-6 y team-8. Escribe docs/oficina-v3/visual-contract-v3.json y public/office-decor.js;
// después: node scripts/gen-office-v3-data.mjs. Idempotente (rehace team-10 si ya existe).
import { readFileSync, writeFileSync } from 'node:fs';

const ROW = 1.6, SOUTH8 = 10.0, SOUTH6 = SOUTH8 - ROW;
const r2 = (n) => Math.round(n * 1000) / 1000;
const contractUrl = new URL('../docs/oficina-v3/visual-contract-v3.json', import.meta.url);
const c = JSON.parse(readFileSync(contractUrl, 'utf8'));
const l8 = c.layouts.find((l) => l.id === 'team-8');
const l = JSON.parse(JSON.stringify(l8));
l.id = 'team-10'; l.minAgents = 9; l.maxAgents = 10;
l.floor.rz = r2(l.floor.rz + ROW);
const south = (o) => { if (o.z >= SOUTH8) o.z = r2(o.z + ROW); };
for (const a of l.anchors) south(a);
// 5.ª fila: copia de la 4.ª (índices 6 y 7) un paso más abajo, con índices 8 y 9
const renum = (s) => s.replace(/-(6|7)$/, (_, n) => `-${Number(n) + 2}`);
for (const a of l8.anchors.filter((x) => /^(desk|chair|qa-desk|qa-chair|wait)-(6|7)$/.test(x.id))) {
  const b = { ...a, id: renum(a.id), z: r2(a.z + ROW), index: a.index + 2 };
  if (b.row != null) b.row += 1;
  if (b.seatId) b.seatId = renum(b.seatId);
  if (b.deskId) b.deskId = renum(b.deskId);
  l.anchors.push(b);
}
for (const w of l.walkways) {
  if (w.id.startsWith('spine')) { w.d = r2(w.d + ROW); w.z = r2(w.z + ROW / 2); } else south(w);
}
for (const r of Object.values(l.routes)) for (const p of r) south(p);
for (const [k, z] of Object.entries(l.floorZones)) {
  if (['development', 'qa', 'board'].includes(k)) { z.d = r2(z.d + ROW); z.z = r2(z.z + ROW / 2); continue; }
  if (z.z >= SOUTH8) { z.z = r2(z.z + ROW); z.labelAnchor.z = r2(z.labelAnchor.z + ROW); z.labelZ = r2(z.labelZ + ROW); }
}
l.capacity = { ...l.capacity, home: 10, qa: 10, waiting: 10 };
c.layouts = [...c.layouts.filter((x) => x.id !== 'team-10'), l];
c.layoutSelection = String(c.layoutSelection).replace('Outside 2..8', 'Outside 2..10');
writeFileSync(contractUrl, JSON.stringify(c, null, 2) + '\n');

// Decoración: lo del sur baja una fila; lo que team-8 añadió por fila respecto a team-6 se repite una fila más abajo.
const decorUrl = new URL('../public/office-decor.js', import.meta.url);
let src = readFileSync(decorUrl, 'utf8');
src = src.replace(/\n\s*"team-10": \[[^\n]*\],?(?=\n)/g, '');
const decor = (await import(decorUrl.href + '?' + Date.now())).default;
let added = 0;
const lines = src.split('\n');
for (const item of decor.items || []) {
  const p6 = item.placements?.['team-6'], p8 = item.placements?.['team-8'];
  if (!Array.isArray(p8)) continue;
  const same = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.z - b.z) < 0.01 && Math.abs((a.y || 0) - (b.y || 0)) < 0.01;
  const p6in8 = (p6 || []).map((p) => ({ ...p, z: p.z >= SOUTH6 ? r2(p.z + ROW) : p.z }));
  // centradas en su zona (alfombras): de team-6 a team-8 bajaron media fila → bajan otra media
  const centered = (p) => p.z < SOUTH8 && (p6 || []).some((q) => same({ ...q, z: r2(q.z + ROW / 2) }, p));
  const fresh = p8.filter((p) => p.z < SOUTH8 && !centered(p) && !p6in8.some((q) => same(p, q)));
  const p10 = [...p8.map((p) => ({ ...p, z: p.z >= SOUTH8 ? r2(p.z + ROW) : centered(p) ? r2(p.z + ROW / 2) : p.z })), ...fresh.map((p) => ({ ...p, z: r2(p.z + ROW) }))];
  const at = lines.findIndex((ln) => ln.includes(`id: "${item.id}"`));
  const i = at < 0 ? -1 : lines.findIndex((ln, k) => k > at && /^\s*"team-8": \[/.test(ln));
  if (i < 0) continue;
  const indent = lines[i].match(/^\s*/)[0];
  if (!lines[i].trimEnd().endsWith(',')) lines[i] = lines[i].trimEnd() + ',';
  const body = p10.map((p) => JSON.stringify(p).replace(/":/g, '": ').replace(/,"/g, ',"')).join(',');
  lines.splice(i + 1, 0, `${indent}"team-10": [${body}]${''}`);
  added++;
}
writeFileSync(decorUrl, lines.join('\n'));
console.log(`team-10: ${l.anchors.length} anclas · decoración en ${added} elementos`);
