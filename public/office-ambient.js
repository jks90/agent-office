// FT-150: Oficina v3 — personajes de AMBIENTE (visita, mensajero, limpieza, reunión, mantenimiento). Lógica PURA (sin three.js ni DOM).
// Implementa docs/oficina-v3/ambiente.md + ambient-contract.json. Nunca toca a los agentes reales: solo produce posiciones decorativas.
// Determinista: fase inicial por hash FNV-1a de project.id; sin Math.random. Tope duro de 3 personajes a la vez.

export const MAX_AMBIENT = 3;
const SPEED = 0.8;            // u/s (movement.maxSpeedUnitsPerSecond)
const WINDOW = 30;            // s entre admisiones
const BANDS = [               // por proporción de agentes ocupados
  { id: 'quiet', max: 0.34, chars: 3, mult: 1 },
  { id: 'mixed', max: 0.67, chars: 2, mult: 1.5 },
  { id: 'busy', max: 1.01, chars: 1, mult: 2 },
];
// Catálogo en orden fijo: periodo base (s), personajes y etiqueta que verá el usuario.
export const CATALOG = [
  { id: 'cleaner', base: 150, chars: 1, label: 'LIMPIEZA · AMBIENTE' },
  { id: 'visitor', base: 120, chars: 1, label: 'VISITA · AMBIENTE' },
  { id: 'courier', base: 210, chars: 1, label: 'REPARTO · AMBIENTE' },
  { id: 'meeting', base: 180, chars: 2, quietChars: 3, minBand: 'mixed', label: 'REUNIÓN · AMBIENTE' },
  { id: 'maintenance', base: 240, chars: 1, label: 'MANTENIMIENTO · AMBIENTE' },
];

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(String(str))) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export const bandOf = (busyRatio) => BANDS.find((b) => busyRatio < b.max) || BANDS[2];
// Proporción de agentes reales ocupados (no libres); desconocido cuenta como ocupado; equipo vacío → null (ambiente apagado).
export function busyRatio(agents) {
  if (!agents?.length) return null;
  return agents.filter((a) => a.status !== 'idle').length / agents.length;
}

// Puntos clave de una planta (en unidades de la planta) derivados del layout v3.
export function pointsOf(layout) {
  const A = new Map(layout.anchors.map((a) => [a.id, a]));
  const v = layout.routes.visitor, c = layout.routes.cleaner;
  const door = A.get('meeting-door'), rc = A.get('reception-counter');
  const doorZ = door.z + 0.5;                       // justo fuera del cristal
  const laneZ = door.z - 0.2;                       // pasillo interior ante las sillas
  const ch = (i) => A.get('meeting-chair-' + i);
  const toDoor = [...v.slice(0, 5), { x: door.x, z: doorZ }];       // entrada → umbral de la sala
  const inRoom = [{ x: door.x, z: doorZ }, { x: door.x, z: laneZ }];
  return {
    entry: v[0], toReception: [v[0], v[1]], handoff: { x: v[1].x - 0.9, z: rc.z + 0.85 },
    toDoor, cleaner: c,
    seat: [
      [...inRoom, { x: ch(0).x, z: laneZ }, { x: ch(0).x, z: ch(0).z }],
      [...inRoom, { x: ch(1).x, z: laneZ }, { x: ch(1).x, z: ch(1).z }],
      [...inRoom, { x: door.x - 0.65, z: ch(3).z }, { x: ch(3).x, z: ch(3).z }],
    ],
    plant: [...v.slice(0, 3), { x: 0.9, z: v[2].z }],
  };
}

// Programa de un actor: lista de puntos con espera (dwell, s) y pose. Ida y vuelta por el mismo camino.
const out = (pts, dwellAt) => {
  const f = pts.map((p, i) => ({ ...p, w: dwellAt[i] || 0 }));
  return [...f, ...f.slice(0, -1).reverse().map((p) => ({ x: p.x, z: p.z, w: 0 }))];
};
function program(kind, P, i = 0) {
  if (kind === 'courier') { const p = [...P.toReception, P.handoff]; return out(p, { [p.length - 1]: 14 }); }
  if (kind === 'visitor') { // recepción (saluda) → sala de reuniones (mira la mesa vacía) → vuelve por el mismo camino
    const p = [P.entry, P.toReception[1], P.handoff, P.toReception[1], ...P.toDoor.slice(2), ...P.seat[1].slice(1)];
    return out(p, { 2: 6, [p.length - 1]: 15 });
  }
  if (kind === 'cleaner') return P.cleaner.map((p, k) => ({ x: p.x, z: p.z, w: k === 3 || k === 5 ? 12 : 0 }));
  if (kind === 'maintenance') return out(P.plant, { [P.plant.length - 1]: 12 });
  const seat = P.seat[[0, 1, 2][i % 3]];                      // reunión: cada participante, su silla
  const p = [...P.toDoor, ...seat.slice(1)];
  return out(p, { [p.length - 1]: 36 });
}

// Línea de tiempo: segmentos con velocidad constante y esperas. Devuelve { dur, at(t) }.
function timeline(pts, delay = 0) {
  const segs = []; let t = delay, ang = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    if (k) { const q = pts[k - 1], len = Math.hypot(p.x - q.x, p.z - q.z), d = len / SPEED; if (len) ang = Math.atan2(p.x - q.x, p.z - q.z); segs.push({ t0: t, t1: t + d, a: q, b: p, ang, w: 0 }); t += d; }
    if (p.w) { segs.push({ t0: t, t1: t + p.w, a: p, b: p, ang, w: 1 }); t += p.w; }
  }
  const first = pts[0];
  return {
    dur: t,
    at(now) {
      if (now < delay) return { x: first.x, z: first.z, ang: 0, hidden: true };
      let s = segs[segs.length - 1];
      for (const g of segs) if (now < g.t1) { s = g; break; }
      const k = s.t1 > s.t0 ? Math.min(1, Math.max(0, (now - s.t0) / (s.t1 - s.t0))) : 1;
      return { x: s.a.x + (s.b.x - s.a.x) * k, z: s.a.z + (s.b.z - s.a.z) * k, ang: s.ang, dwell: !!s.w };
    },
  };
}

// Planificador. now = segundos visibles acumulados; busy = busyRatio() (null → apagado).
export function createScheduler(projectId, layout) {
  const phase = fnv1a(projectId || '') % 60;
  const P = pointsOf(layout);
  return { P, phase, last: Object.fromEntries(CATALOG.map((k) => [k.id, phase - k.base])), active: [], win: -1, started: 0, layoutId: layout.id };
}

// Avanza el planificador y devuelve los personajes visibles: [{ id, kind, label, x, z, ang, dwell, hidden }]
export function stepScheduler(S, now, busy, { enabled = true, reduced = false } = {}) {
  S.active = S.active.filter((e) => now < e.t0 + e.dur);                  // los que terminaron salen
  if (!enabled || busy == null) { S.active = []; return []; }
  if (reduced) return []; // sin movimiento: nada (ni siquiera figuras estáticas)
  const win = Math.floor(now / WINDOW);
  if (win !== S.win) {
    S.win = win;
    const band = bandOf(busy);
    const live = S.active.reduce((n, e) => n + e.actors.length, 0);
    const free = Math.min(MAX_AMBIENT, band.chars) - live;
    const due = CATALOG
      .filter((k) => !S.active.some((e) => e.kind === k.id) && now >= S.last[k.id] + k.base * band.mult)
      .filter((k) => k.id !== 'meeting' || band.id !== 'busy')
      .sort((a, b) => (S.last[a.id] + a.base * band.mult) - (S.last[b.id] + b.base * band.mult));
    const k = due.find((c) => (c.id === 'meeting' ? (band.id === 'quiet' ? c.quietChars : c.chars) : c.chars) <= free);
    if (k) {
      const n = k.id === 'meeting' ? (band.id === 'quiet' ? k.quietChars : k.chars) : 1;
      const actors = Array.from({ length: n }, (_, i) => {
        const tl = timeline(program(k.id, S.P, i), i * 0.6 / SPEED);       // fila india a 0,6 u
        return { id: `ambient:${k.id}:${i}`, tl };
      });
      S.last[k.id] = now;
      S.active.push({ kind: k.id, label: k.label, t0: now, dur: Math.max(...actors.map((a) => a.tl.dur)), actors });
    }
  }
  const res = [];
  for (const e of S.active) for (const a of e.actors) res.push({ id: a.id, kind: e.kind, label: e.label, ...a.tl.at(now - e.t0) });
  return res;
}
