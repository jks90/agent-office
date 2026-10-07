// FT-149: Oficina v3 — lógica PURA de la planta por zonas (sin three.js ni DOM).
// Implementa docs/oficina-v3/planta.md sobre el contrato visual-contract-v3.json (copia mínima en office-v3-data.js).
// Reglas: cada agente REAL ocupa exactamente un puesto según su estado (nunca café si trabaja); el ambiente
// (visita, limpieza) lo pinta office3d.js aparte y jamás entra aquí.
import DATA from './office-v3-data.js';

export const V3 = DATA;
const hex = (s) => parseInt(String(s).replace('#', ''), 16);

// Se elige el primer contrato cuyo rango contiene al equipo real; 0–1 usan team-2. Fuera de 2..8 → null (planta heredada).
export function pickLayout(count) {
  if (count > 8) return null;
  return DATA.layouts.find((l) => count >= l.minAgents && count <= l.maxAgents) || DATA.layouts[0];
}

// floorZones del contrato en el formato de office3d (color/fill como enteros, x/z/w/d centro y tamaño).
export function zonesV3(layout) {
  const out = {};
  for (const [id, z] of Object.entries(layout.floorZones)) {
    out[id] = { ...z, color: hex(z.color), fill: hex(z.fill), v3: true, labelX: z.labelAnchor.x, labelZ: z.labelAnchor.z };
  }
  return out;
}

const anchorMap = (layout) => new Map(layout.anchors.map((a) => [a.id, a]));
const isQa = (role) => /qa|test|quality/i.test(String(role || ''));
const isPo = (role) => String(role || '').trim().toLowerCase() === 'po';

// Asigna el menor índice libre conservando el previo mientras siga en rango y libre (sin reindexar en cada SSE).
function take(prev, pool, id, cap) {
  const keep = prev?.[id];
  const idx = Number.isInteger(keep) && keep < cap && !pool.has(keep) ? keep : [...Array(cap).keys()].find((i) => !pool.has(i));
  if (idx == null) return null;
  pool.add(idx);
  return idx;
}

// agents: estados visuales ({id,status,role,…}); raw: Map id → rol sin normalizar (para detectar `po` exacto).
export function layoutV3(agents, raw, layout, prev = null) {
  const A = anchorMap(layout);
  const cap = layout.capacity;
  const pv = prev?.v3 && prev.v3.id === layout.id ? prev.v3 : {};
  const home = {}, qa = {}, wait = {}, idle = {};
  const pools = { home: new Set(), qa: new Set(), wait: new Set(), idle: new Set() };
  const roleOf = (a) => String(raw?.get(a.id) ?? a.role ?? '');
  const sorted = [...agents].sort((a, b) => roleOf(a).localeCompare(roleOf(b)) || String(a.id).localeCompare(String(b.id)));
  const poId = sorted.find((a) => isPo(roleOf(a)))?.id;
  // Cada agente real tiene su mesa propia (capacidad ≥ equipo): sirve de refugio para bloqueo/fallo/libre sin plaza.
  for (const a of sorted) home[a.id] = take(pv.home, pools.home, a.id, cap.home) ?? 0;
  const slots = {}, desks = new Set();
  const put = (a, zone, idx, seat, extra = {}) => {
    slots[a.id] = { zone, module: 0, index: idx, x: seat.x, z: seat.z, rot: seat.rotationY, agentId: a.id, status: a.status, role: roleOf(a),
      condition: [zone, a.status, roleOf(a), a.taskId || ''].join(':'), ...extra };
  };
  const homeSeat = (a) => { const id = 'chair-' + home[a.id]; desks.add(id); put(a, 'development', home[a.id], A.get(id)); };
  const qaSeat = (a, i) => { const id = 'qa-chair-' + i; desks.add(id); put(a, 'qa', i, A.get(id)); };
  const working = (a) => ['working', 'blocked', 'failed'].includes(a.status);
  // QA: primero los puestos de quien trabaja/está bloqueado/falla en QA; luego los revisores en índices libres.
  for (const a of sorted) if (a.status !== 'reviewing' && working(a) && isQa(roleOf(a)) && a.id !== poId) { qa[a.id] = take(pv.qa, pools.qa, a.id, cap.qa); }
  for (const a of sorted) if (a.status === 'reviewing') qa[a.id] = take(pv.qa, pools.qa, a.id, cap.qa);
  for (const a of sorted) {
    if (a.status === 'reviewing' && qa[a.id] != null) { qaSeat(a, qa[a.id]); continue; }
    if (a.status === 'waiting') {
      wait[a.id] = take(pv.wait, pools.wait, a.id, cap.waiting);
      if (wait[a.id] != null) { put(a, 'board', wait[a.id], A.get('wait-' + wait[a.id])); continue; }
    }
    if (a.id === poId) { put(a, 'po', 0, A.get('po-chair')); continue; }
    if (qa[a.id] != null) { qaSeat(a, qa[a.id]); continue; }
    if (a.status === 'idle') {
      idle[a.id] = take(pv.idle, pools.idle, a.id, cap.idleSofa);
      if (idle[a.id] != null) { put(a, 'idle', idle[a.id], A.get('idle-seat-' + idle[a.id])); continue; }
    }
    homeSeat(a); // working / sin plaza / estado desconocido: su mesa, nunca café ni ocio
  }
  // Mesas que se construyen = las realmente asignadas (no se pueblan los pools con mesas vacías).
  const used = [...desks].map((c) => { const ch = A.get(c); return { chair: ch, desk: A.get(ch.deskId) }; });
  const sig = [...desks].sort().join(',');
  return {
    size: { kind: 'v3:' + layout.id, rx: layout.floor.rx, rz: layout.floor.rz, v3: layout.id },
    slots, modules: [], sig, usedDesks: used,
    v3: { id: layout.id, home, qa, wait, idle },
  };
}

// Camino por pasillos: del asiento a su «salida» (pasillo entre filas o pasillo norte/sur), por la espina más cercana.
export function routeV3(layout, c, t) {
  const walk = (id) => layout.walkways.find((w) => w.id === id);
  const northZ = walk('north')?.z ?? 2.9, southZ = walk('south')?.z ?? layout.floor.rz - 3.5;
  const exit = (p, zone) => {
    if (zone === 'development' || zone === 'qa' || zone === 'board') return { x: p.x, z: p.z + 0.5 };
    if (p.z < northZ + 0.5) return { x: p.x, z: northZ };
    return { x: p.x, z: southZ };
  };
  const spines = layout.walkways.filter((w) => w.id.startsWith('spine')).map((w) => w.x);
  const e0 = exit(c, c.zone), e1 = exit(t, t.zone);
  const sx = spines.length ? spines.reduce((b, x) => (Math.abs(c.x - x) + Math.abs(t.x - x) < Math.abs(c.x - b) + Math.abs(t.x - b) ? x : b)) : e0.x;
  const pts = [e0];
  if (Math.abs(e0.x - sx) > 0.05 || Math.abs(e0.z - e1.z) > 0.05) pts.push({ x: sx, z: e0.z }, { x: sx, z: e1.z });
  pts.push(e1, { x: t.x, z: t.z });
  return pts;
}

// Posición del personaje de AMBIENTE en `now` s. Visita: ida y vuelta por el mismo camino; limpieza: circuito.
export function ambientPos(layout, ch, now, still = false) {
  const route = layout.routes[ch.route === 'cleaner' ? 'cleaner' : 'visitor'];
  const lens = route.slice(1).map((p, i) => Math.hypot(p.x - route[i].x, p.z - route[i].z));
  const total = lens.reduce((s, l) => s + l, 0) || 1;
  if (still) { const p = route[1]; return { x: p.x + (ch.route === 'cleaner' ? -0.6 : 0.6), z: p.z, ang: Math.PI }; }
  const u = (((now + ch.phaseSeconds) % ch.durationSeconds) / ch.durationSeconds);
  const f = ch.route === 'cleaner' ? u : (u < 0.5 ? u * 2 : 2 - u * 2);
  let d = f * total, i = 0;
  while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
  const k = lens[i] ? Math.min(1, d / lens[i]) : 0;
  const a = route[i], b = route[i + 1];
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, ang: Math.atan2(b.x - a.x, b.z - a.z) };
}
