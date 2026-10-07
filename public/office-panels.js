// FT-125 · Paneles de información en los márgenes de la planta 3D.
// Tarjetas HTML semitransparentes dentro de la capa de etiquetas del Office (mismas coordenadas que las burbujas). El hueco se calcula con
// la proyección del volumen de la planta (office.floorHull()) y los obstáculos vivos (burbujas, píldoras, pizarra: office.obstacles()),
// así que nunca pisan el suelo. Si el hueco no da (ventana estrecha/móvil) se pliegan en una barra lateral desplegable.
// FT-138: los paneles se ven ENTEROS, sin scroll interno: cada uno mide lo que su contenido necesita. Si una columna no cabe en el alto del
// lienzo, los paneles se apilan y se salen por abajo, y la vista de la oficina (el contenedor del lienzo) hace scroll como página.
// Plegar/desplegar por la cabecera (recordado en localStorage por panel) deja solo la cabecera con un resumen corto.
// Los datos salen del estado SSE (S) y de `inboxItems` (FT-124): aquí no hay polling ni lógica duplicada.

const MIN_W = 170, MAX_W = 268, GAP = 8;
const COL_KEY = 'ao:opCollapsed';
const EV_FEED = {
  TaskReviewed: (e) => (e.data?.decision === 'approved' ? [e.data.merged ? '🔀' : '✅', e.data.merged ? 'fusionada' : 'aprobada'] : ['↩️', 'devuelta']),
  AgentStarted: () => ['▶️', 'empieza'],
  AgentCompleted: (e) => (e.data?.status === 'review' ? ['✋', 'a revisión'] : ['🏁', 'terminada']),
  AgentBlocked: (e) => (e.data?.questionId ? ['❓', 'pregunta'] : ['⛔', 'bloqueada']),
  AgentFailed: () => ['❌', 'falló'],
  TaskConflict: () => ['⚠️', 'conflicto'],
  ReviewPending: () => ['⏰', 'espera revisión'],
  SupervisorDecision: (e) => ['🧑‍⚖️', e.data?.action === 'approve' ? 'supervisor aprueba' : e.data?.action === 'reject' ? 'supervisor devuelve' : 'supervisor recomienda'],
  TaskCreated: () => ['🆕', 'creada'],
};
const PANELS = [
  { id: 'team', title: '👥 Equipo', col: 'l', at: 'top' },
  { id: 'feed', title: '📜 Actividad', col: 'l', at: 'bottom' },
  { id: 'progress', title: '🗂 Progreso', col: 'r', at: 'top' },
  { id: 'mine', title: '🔔 Para ti', col: 'r', at: 'mid' },
  { id: 'usage', title: '⚡ Consumo y cuota', col: 'r', at: 'bottom' },
];

export function createOfficePanels({ office, S, projectId, esc, inboxItems, inboxKind, openAgent, openTask, openInbox, quota, api }) {
  const root = office.labelRoot.parentElement || office.labelRoot; // FT-138: fuera de labelRoot (overflow:hidden) para poder salirse por abajo
  const box = document.createElement('div');
  box.className = 'op-root';
  const toggle = document.createElement('button');
  toggle.className = 'op-toggle'; toggle.type = 'button'; toggle.textContent = '☰ Paneles'; toggle.hidden = true;
  const style = document.createElement('style');
  style.textContent = `
    .op-root{position:absolute;inset:0;pointer-events:none;font-family:system-ui,sans-serif}
    .op{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;pointer-events:auto;color:#e5e7eb;font-size:11.5px;line-height:1.35;
      background:rgba(17,24,39,.78);border:1px solid rgba(148,163,184,.28);border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.25);backdrop-filter:blur(3px)}
    .op-h{display:flex;align-items:center;gap:6px;padding:5px 9px;font-weight:700;font-size:12px;color:#f8fafc;cursor:pointer;user-select:none;flex:none}
    .op-h span{margin-left:auto;color:#94a3b8;font-weight:400}
    .op-b{padding:0 9px 7px}
    .op.col .op-b{display:none}
    .op-r{display:flex;gap:6px;align-items:baseline;padding:2px 0;border-top:1px solid rgba(148,163,184,.12)}
    .op-r:first-child{border-top:0}
    .op-r[data-agent],.op-r[data-task],.op-r[data-inbox]{cursor:pointer}.op-r[data-agent]:hover,.op-r[data-task]:hover,.op-r[data-inbox]:hover{background:rgba(255,255,255,.07)}
    .op-r b{color:#f8fafc}.op-m{color:#94a3b8;font-size:10.5px}.op-w{color:#fbbf24}.op-bad{color:#fca5a5}
    .op-t{margin-left:auto;color:#94a3b8;white-space:nowrap;font-size:10.5px}
    .op-bar{height:6px;border-radius:3px;background:rgba(148,163,184,.25);overflow:hidden;margin:3px 0}.op-bar i{display:block;height:100%;background:#34d399}
    .op-bar.warn i{background:#fbbf24}.op-bar.bad i{background:#f87171}
    .op-sub{font-size:10.5px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
    .op-toggle{position:absolute;right:8px;top:8px;pointer-events:auto;z-index:5;font:600 12px system-ui,sans-serif;color:#f8fafc;background:rgba(17,24,39,.85);border:1px solid rgba(148,163,184,.35);border-radius:999px;padding:4px 11px;cursor:pointer}
    .op-root.side .op{position:static;width:100%!important;margin-bottom:6px;flex:none}
    .op-side{position:absolute;right:0;top:36px;bottom:0;width:min(300px,92%);overflow:auto;pointer-events:auto;padding:0 8px 8px;display:none;z-index:4}
    .op-root.side.open .op-side{display:block}.op-root:not(.side) .op-side{display:contents}`;
  document.head.appendChild(style);
  const side = document.createElement('div'); side.className = 'op-side';
  box.append(toggle, side);
  root.appendChild(box);

  let collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(COL_KEY) || '{}'); } catch { /* sin almacenamiento */ }
  const els = new Map(); // id → { el, head, body, html }
  for (const p of PANELS) {
    const el = document.createElement('section'); el.className = 'op'; el.dataset.panel = p.id;
    const head = document.createElement('div'); head.className = 'op-h'; head.title = 'Plegar / desplegar';
    const body = document.createElement('div'); body.className = 'op-b';
    el.append(head, body); side.appendChild(el);
    els.set(p.id, { el, head, body, html: '', hh: '' });
  }
  let sideMode = false, open = false, enabled = true;
  const feed = []; // últimos eventos del proyecto (más antiguo primero)
  let feedPid = null;

  toggle.addEventListener('click', () => { open = !open; box.classList.toggle('open', open); });
  box.addEventListener('click', (e) => {
    const h = e.target.closest('.op-h');
    if (h) { const id = h.parentElement.dataset.panel; collapsed[id] = !collapsed[id]; try { localStorage.setItem(COL_KEY, JSON.stringify(collapsed)); } catch { /* ok */ } update(); layout(); return; }
    const a = e.target.closest('[data-agent]'); if (a) return openAgent(a.dataset.agent);
    const t = e.target.closest('[data-task]'); if (t) return openTask(t.dataset.task);
    if (e.target.closest('[data-inbox]')) openInbox(projectId());
  });

  // ── Datos ──────────────────────────────────────────────────────────────────
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const money = (n) => `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} $`;
  const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? 'ahora' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`; };
  const short = (s, n = 34) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const codeOf = (t) => t?.code || '';
  const STATE = { working: '✏️ trabajando', idle: '☕ libre', waiting: '⏳ en cola', blocked: '⛔ bloqueado', paused: '⏸ pausado', failed: '⚠ falló', reviewing: '✋ en revisión' };

  function teamHtml(st) {
    const p = st.projects.find((x) => x.id === projectId());
    const ids = new Set(p?.team || []);
    const agents = st.agents.filter((a) => ids.has(a.id));
    if (!agents.length) return '<span class="op-m">Sin equipo todavía</span>';
    const t0 = today0();
    return agents.map((a) => {
      const t = st.tasks.find((x) => x.id === a.taskId && x.agentId === a.id && ['doing', 'review'].includes(x.status));
      const cost = st.tasks.filter((x) => x.agentId === a.id && (x.updatedAt || 0) >= t0).reduce((n, x) => n + (x.costUsd || 0), 0);
      const since = t && (feed.slice().reverse().find((e) => e.type === 'AgentStarted' && e.agentId === a.id && e.taskId === t.id)?.ts || a.updatedAt);
      const eng = `${a.activeEngine || a.engine || ''}${a.model ? ' · ' + a.model : ''}`;
      return `<div class="op-r" data-agent="${esc(a.id)}" title="${esc(a.activity || '')}"><div style="min-width:0"><b>${esc(a.name)}</b> <span class="op-m">${esc(st.roles?.[a.role]?.name || a.role || '')} · ${esc(short(eng, 28))}</span>
        <div>${STATE[t?.status === 'review' ? 'reviewing' : a.status] || esc(a.status)}${t ? ` · <b>${esc(codeOf(t))}</b> ${esc(short(t.title, 26))}` : ''}</div></div>
        <span class="op-t">${since ? Math.max(0, Math.round((Date.now() - since) / 60000)) + ' min<br>' : ''}${cost ? money(cost) : ''}</span></div>`;
    }).join('');
  }
  function feedHtml() {
    const rows = feed.filter((e) => EV_FEED[e.type]).slice(-8).reverse();
    if (!rows.length) return '<span class="op-m">Sin actividad reciente</span>';
    return rows.map((e) => { const [ic, tx] = EV_FEED[e.type](e); return `<div class="op-r"><span>${ic}</span><span style="min-width:0"><b>${esc(e.taskCode || '')}</b> ${esc(tx)}</span><span class="op-t">${ago(e.ts)}</span></div>`; }).join('');
  }
  function progressHtml(st) {
    const ts = st.tasks.filter((t) => t.projectId === projectId() && t.status !== 'discarded');
    if (!ts.length) return '<span class="op-m">Sin tareas</span>';
    const done = ts.filter((t) => t.status === 'done').length;
    const code = (id) => codeOf(st.tasks.find((x) => x.id === id)) || id;
    const doing = ts.filter((t) => ['doing', 'review'].includes(t.status));
    const queue = ts.filter((t) => ['todo', 'backlog'].includes(t.status)).slice(0, 4);
    const waits = (t) => (t.dependsOn || []).filter((d) => st.tasks.find((x) => x.id === d && x.status !== 'done' && x.status !== 'discarded'));
    const epics = {};
    for (const t of ts) { const m = /^\s*\[([^\]]{2,24})\]|^\s*([^:\n]{2,24}):\s/.exec(t.title || ''); if (m) { const k = (m[1] || m[2]).trim(); (epics[k] ||= { d: 0, n: 0 }).n++; if (t.status === 'done') epics[k].d++; } }
    const ep = Object.entries(epics).filter(([, v]) => v.n > 1);
    return `<div><b>${done}</b>/${ts.length} hechas <span class="op-t">${Math.round(done / ts.length * 100)} %</span></div><div class="op-bar"><i style="width:${done / ts.length * 100}%"></i></div>
      ${doing.length ? `<div class="op-sub">En curso</div>${doing.map((t) => `<div class="op-r" data-task="${esc(t.id)}"><b>${esc(codeOf(t))}</b> ${esc(short(t.title, 30))}</div>`).join('')}` : ''}
      ${queue.length ? `<div class="op-sub">Siguiente</div>${queue.map((t) => { const w = waits(t); return `<div class="op-r" data-task="${esc(t.id)}"><b>${esc(codeOf(t))}</b> ${esc(short(t.title, 26))}${w.length ? ` <span class="op-w">⏳ espera a ${esc(w.map(code).join(', '))}</span>` : ''}</div>`; }).join('')}` : ''}
      ${ep.length ? `<div class="op-sub">Épicas</div>${ep.map(([k, v]) => `<div class="op-r"><b>${esc(short(k, 22))}</b><span class="op-t">${v.d}/${v.n}</span></div>`).join('')}` : ''}`;
  }
  const mineItems = () => inboxItems(projectId()).filter((i) => !['coordlog'].includes(i.kind) && !i.imported);
  function mineHtml() {
    const items = mineItems();
    if (!items.length) return '<span class="op-m">Nada te espera 🎉</span>';
    return items.slice(0, 8).map((i) => {
      const ic = inboxKind[i.kind]?.[0] || '•', t = i.t;
      const txt = i.q ? i.q.question : t ? `<b>${esc(codeOf(t))}</b> ${esc(short(t.title, 30))}` : esc(short(i.x?.text || i.x?.why || inboxKind[i.kind]?.[1] || '', 36));
      return `<div class="op-r" ${t ? `data-task="${esc(t.id)}"` : 'data-inbox="1"'}><span>${ic}</span><span style="min-width:0">${i.q ? esc(short(txt, 40)) : txt}</span></div>`;
    }).join('') + (items.length > 8 ? `<div class="op-r" data-inbox="1"><span class="op-m">+${items.length - 8} más…</span></div>` : '');
  }
  function usageHtml(st) {
    const t0 = today0();
    const cost = st.tasks.filter((t) => t.projectId === projectId() && (t.updatedAt || 0) >= t0).reduce((n, t) => n + (t.costUsd || 0), 0);
    let warn = '';
    const rows = ['claude', 'codex'].map((e) => {
      const q = st.quota?.[e], w = quota.worst(q);
      if (!w) return `<div class="op-r"><b>${quota.name[e]}</b> <span class="op-m">${q && !q.ok ? 'sin dato' : 'leyendo…'}</span></div>`;
      const sev = quota.sev(w);
      if (sev) warn = `<div class="${sev === 'bad' ? 'op-bad' : 'op-w'}">${sev === 'bad' ? '⛔' : '⚠'} ${quota.name[e]} cerca del tope</div>`;
      return `<div class="op-r"><b>${quota.name[e]}</b> <span class="op-m">${esc(w.label)}</span><span class="op-t">${w.percent} % usado</span></div><div class="op-bar ${sev}"><i style="width:${Math.min(100, w.percent)}%"></i></div>`;
    }).join('');
    return `<div class="op-r"><span>Hoy en el proyecto</span><span class="op-t"><b>${money(cost)}</b></span></div>${rows}${warn}`;
  }
  const BUILD = {
    team: [teamHtml, (st) => { const ag = st.agents.filter((a) => (st.projects.find((x) => x.id === projectId())?.team || []).includes(a.id)); return `${ag.length} · ${ag.filter((a) => a.status === 'working').length} trabajando`; }],
    feed: [feedHtml, () => (feed.filter((e) => EV_FEED[e.type]).length ? `${Math.min(8, feed.filter((e) => EV_FEED[e.type]).length)} recientes` : '')],
    progress: [progressHtml, (st) => { const ts = st.tasks.filter((t) => t.projectId === projectId() && t.status !== 'discarded'); return ts.length ? `${ts.filter((t) => t.status === 'done').length}/${ts.length} hechas` : ''; }],
    mine: [mineHtml, () => String(mineItems().length || '')],
    usage: [usageHtml, (st) => `hoy ${money(st.tasks.filter((t) => t.projectId === projectId() && (t.updatedAt || 0) >= today0()).reduce((n, t) => n + (t.costUsd || 0), 0))}`],
  };

  // ── Pintado ────────────────────────────────────────────────────────────────
  function update() {
    const st = S();
    enabled = st.settings?.officePanels !== false && !!projectId();
    box.style.display = enabled && office.mode !== 'building' ? '' : 'none';
    if (!enabled) return;
    if (feedPid !== projectId()) { feedPid = projectId(); feed.length = 0; if (feedPid) api('GET', `/api/events?projectId=${encodeURIComponent(feedPid)}&limit=300`).then((r) => { if (feedPid === projectId() && Array.isArray(r)) { for (const e of r) if (!feed.some((x) => x.id === e.id)) feed.push(e); feed.sort((a, b) => a.ts - b.ts); update(); } }).catch(() => {}); }
    for (const p of PANELS) {
      const x = els.get(p.id), [build, badge] = BUILD[p.id];
      const html = collapsed[p.id] ? '' : build(st);
      if (html !== x.html) { x.html = html; x.body.innerHTML = html; }
      const hh = `${p.title}<span>${esc(badge(st))} ${collapsed[p.id] ? '▸' : '▾'}</span>`;
      if (hh !== x.hh) { x.hh = hh; x.head.innerHTML = hh; }
      x.el.classList.toggle('col', !!collapsed[p.id]);
    }
  }
  function onEvent(ev) {
    if (!ev || ev.projectId !== feedPid || feed.some((x) => x.id === ev.id)) return;
    feed.push(ev); if (feed.length > 300) feed.shift();
    update();
  }

  // ── Colocación ─────────────────────────────────────────────────────────────
  // Extensión horizontal ocupada por el casco y los obstáculos en la franja vertical [y0, y1].
  function extent(hull, obs, y0, y1) {
    let lo = Infinity, hi = -Infinity;
    const take = (x) => { if (x < lo) lo = x; if (x > hi) hi = x; };
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const a = hull[i], b = hull[(i + 1) % n];
      if (a.y >= y0 && a.y <= y1) take(a.x);
      for (const y of [y0, y1]) if ((a.y - y) * (b.y - y) < 0) take(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
    }
    for (const o of obs) if (o.b > y0 && o.t < y1) { take(o.l); take(o.r); }
    return { lo, hi };
  }
  function layout() {
    if (!enabled || !office.labelRoot) return;
    if (office.mode === 'building') { box.style.display = 'none'; return; }
    box.style.display = '';
    const W = office.cv.clientWidth, H = office.cv.clientHeight;
    const hull = office.floorHull(), obs = office.obstacles();
    sideMode = W < 760 || !hull.length;
    const fit = !sideMode && (placeAll(W, H, hull, obs) || placeAll(W, H, hull, obs, true));
    sideMode = !fit;
    box.classList.toggle('side', sideMode);
    toggle.hidden = !sideMode;
    if (sideMode) { for (const x of els.values()) { x.el.style.cssText = ''; } const wr = office.cv.parentElement; if (wr) wr.style.overflowY = ''; return; }
  }
  let why = ''; // por qué no cupo (QA: aoOffice.panels.why())
  const fail = (msg) => { why = msg; return false; };
  function placeAll(W, H, hull, obs, forceFlow) {
    why = '';
    const spots = [];
    for (const col of ['l', 'r']) {
      const list = PANELS.filter((p) => p.col === col), placed = [];
      // 1) alturas con anchura provisional; 2) top → arriba, bottom → abajo, mid → centrado entre ambos
      for (const p of list) { const x = els.get(p.id); x.el.style.cssText = `width:${MAX_W}px;visibility:hidden`; }
      let topY = GAP, botY = H - GAP;
      const flow = list.reduce((n, p) => n + els.get(p.id).el.offsetHeight + GAP, GAP) > H || forceFlow; // FT-138: no caben en el alto → se apilan y la vista hace scroll
      if (flow) for (const p of list) { // orden de lectura: arriba, centro, abajo
        const x = els.get(p.id);
        const freeAt = (yy, hh) => { const q = extent(hull, obs, yy, yy + hh); return col === 'l' ? q.lo - GAP * 2 : W - q.hi - GAP * 2; };
        let y = topY, h = x.el.offsetHeight, w = MAX_W;
        for (; y < H + 3000; y += 8) { // baja hasta el primer hueco con ancho suficiente (por debajo del suelo siempre lo hay)
          w = Math.min(MAX_W, freeAt(y, h));
          if (w < MIN_W) continue;
          x.el.style.width = w + 'px'; h = x.el.offsetHeight;
          if (freeAt(y, h) >= w) break;
        }
        spots.push({ x, col, y, w }); topY = y + h + GAP;
      }
      if (flow) continue;
      const order = ['top', 'bottom', 'mid'];
      for (const at of order) for (const p of list.filter((q) => q.at === at)) {
        const x = els.get(p.id);
        let h = x.el.offsetHeight, y;
        if (at === 'top') y = topY;
        else if (at === 'bottom') y = botY - h;
        else { // lo más centrado que dé el hueco: el rombo es más ancho justo en medio, así que se desliza hacia donde el margen sea mayor
          const mid = Math.round((H - h) / 2), freeAt = (yy) => { const q = extent(hull, obs, yy, yy + h); return col === 'l' ? q.lo - GAP * 2 : W - q.hi - GAP * 2; };
          const cands = []; for (let yy = topY; yy <= botY - h; yy += 8) cands.push(yy);
          cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
          y = cands.find((yy) => freeAt(yy) >= MIN_W) ?? Math.max(topY, Math.min(mid, botY - h));
        }
        if (y < 0 || h > H) return fail(`${p.id}: alto ${h} > ${H}`);
        let w = MAX_W, e = extent(hull, obs, y, y + h);
        const free = col === 'l' ? e.lo - GAP * 2 : W - e.hi - GAP * 2;
        w = Math.min(MAX_W, free);
        if (w < MIN_W) return fail(`${p.id}: ancho libre ${Math.round(w)}`);
        if (w !== MAX_W) { x.el.style.width = w + 'px'; const h2 = x.el.offsetHeight; if (at === 'bottom') y = botY - h2; h = h2; e = extent(hull, obs, y, y + h); if ((col === 'l' ? e.lo - GAP * 2 : W - e.hi - GAP * 2) < w) return fail(`${p.id}: ancho tras reajuste`); }
        if (at === 'top') topY = y + h + GAP; else if (at === 'bottom') botY = y - GAP;
        else if (y < topY - 1 || y + h > botY + 1) return fail(`${p.id}: sin sitio en el centro`);
        spots.push({ x, col, y, w });
      }
    }
    let low = 0; for (const s of spots) low = Math.max(low, s.y + s.x.el.offsetHeight + GAP);
    const wrap = office.cv.parentElement; if (wrap) wrap.style.overflowY = low > H + 1 ? 'auto' : ''; // FT-138: lo que se sale por abajo se alcanza con scroll de la vista
    for (const s of spots) { const st = s.x.el.style; st.visibility = ''; st.top = s.y + 'px'; st.bottom = 'auto'; st.left = s.col === 'l' ? GAP + 'px' : 'auto'; st.right = s.col === 'r' ? GAP + 'px' : 'auto'; st.width = s.w + 'px'; }
    return true;
  }

  return { update, layout, onEvent, isSide: () => sideMode, why: () => why, root: box };
}
