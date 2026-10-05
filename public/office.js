// La oficina en 2D: pixel art dibujado a mano en un canvas (sin sprites ni librerías).
// Coordenadas lógicas W×H; cada unidad son S píxeles reales. El texto se pinta a resolución nativa.
const W = 320, H = 208, S = 3;
const SPINE = 244;          // pasillo vertical entre las mesas y la zona de descanso
const WALL = 44;
const SPEED = 46;           // unidades por segundo
const DOOR = { x: 247, y: 50 };

const DESKS = [
  { x: 16, y: 80 }, { x: 72, y: 80 }, { x: 128, y: 80 }, { x: 184, y: 80 },
  { x: 16, y: 146 }, { x: 72, y: 146 }, { x: 128, y: 146 }, { x: 184, y: 146 },
];
const seatOf = (d) => ({ x: d.x + 32, y: d.y + 3, corr: d.y - 12 });
const BOARD_SPOTS = [{ x: 118, y: 58 }, { x: 154, y: 58 }];
const LOUNGE = [
  { x: 266, y: 182 }, { x: 282, y: 182 }, { x: 298, y: 182 }, { x: 302, y: 112 },
  { x: 262, y: 124 }, { x: 286, y: 146 }, { x: 270, y: 156 }, { x: 304, y: 146 },
];

const SKIN = ['#f1c7a3', '#e0ac85', '#c68863', '#8d5a3b', '#f6d5bd'];
const HAIR = ['#2b1d16', '#6b3f22', '#c9a227', '#9a3412', '#111827', '#d6d3d1', '#7c2d12'];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export class Office {
  constructor(canvas, { onAgentClick } = {}) {
    this.cv = canvas;
    this.cv.width = W * S;
    this.cv.height = H * S;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.agents = [];
    this.tasks = [];
    this.roles = {};
    this.title = '';
    this.chars = new Map();
    this.selected = null;
    this.last = performance.now();
    canvas.addEventListener('click', (e) => { const id = this.hit(e); if (id) onAgentClick?.(id); });
    canvas.addEventListener('mousemove', (e) => { canvas.style.cursor = this.hit(e) ? 'pointer' : 'default'; });
    requestAnimationFrame(this.frame);
  }

  update({ agents, tasks, roles, title, selected }) {
    this.agents = agents;
    this.tasks = tasks;
    this.roles = roles;
    this.title = title;
    this.selected = selected;
    for (const id of this.chars.keys()) if (!agents.some((a) => a.id === id)) this.chars.delete(id);
  }

  hit(e) {
    const r = this.cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    for (const [id, c] of this.chars) if (Math.abs(x - c.x) < 6 && y > c.y - 19 && y < c.y + 3) return id;
    return null;
  }

  // ── Movimiento ──────────────────────────────────────────────────────────
  targetFor(agent, index) {
    const task = this.tasks.find((t) => t.id === agent.taskId);
    if (agent.status === 'working' && task?.kind === 'plan') return { key: 'board', ...BOARD_SPOTS[index % 2], corr: null };
    if (agent.status === 'working') return { key: 'desk', ...seatOf(DESKS[index % DESKS.length]) };
    const c = this.chars.get(agent.id);
    const spot = c?.loungeSpot ?? index;
    return { key: 'lounge' + spot, ...LOUNGE[spot % LOUNGE.length], corr: null };
  }

  route(c, t) {
    const pts = [];
    const ya = c.corr ?? c.y;
    const yb = t.corr ?? t.y;
    if (c.corr != null) pts.push({ x: c.x, y: ya });
    if (Math.abs(c.x - t.x) > 1 || Math.abs(ya - yb) > 1) {
      pts.push({ x: SPINE, y: ya }, { x: SPINE, y: yb }, { x: t.x, y: yb });
    }
    if (t.corr != null) pts.push({ x: t.x, y: t.y });
    return pts;
  }

  step(dt, now) {
    this.agents.forEach((a, i) => {
      let c = this.chars.get(a.id);
      if (!c) {
        // Entran por la puerta de uno en uno: si salen a la vez van solapados por el pasillo y parece que falta gente.
        const queued = [...this.chars.values()].filter((o) => o.enterAt >= now).length;
        c = { x: DOOR.x, y: DOOR.y, corr: null, path: [], key: null, moving: false, dir: 1, face: 'down', loungeSpot: i, enterAt: now + queued * 900, nextWander: now + 8000 + Math.random() * 12000 };
        this.chars.set(a.id, c);
      }
      // En la zona de descanso cambian de sitio de vez en cuando.
      if (a.status !== 'working' && now > c.nextWander && !c.moving) {
        const taken = new Set([...this.chars.values()].map((o) => o.loungeSpot));
        const free = LOUNGE.map((_, k) => k).filter((k) => !taken.has(k));
        if (free.length) c.loungeSpot = free[Math.floor(Math.random() * free.length)];
        c.nextWander = now + 10000 + Math.random() * 15000;
      }
      if (now < c.enterAt) return;
      const t = this.targetFor(a, i);
      if (t.key !== c.key) {
        c.path = this.route(c, t);
        c.key = t.key;
        c.corr = null;
        c.dest = t;
      }
      if (c.path.length) {
        const p = c.path[0];
        const dx = p.x - c.x, dy = p.y - c.y;
        const d = Math.hypot(dx, dy);
        const mv = SPEED * dt;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.5) { c.dir = Math.sign(dx); c.face = c.dir > 0 ? 'right' : 'left'; }
        else if (Math.abs(dy) > 0.5) c.face = dy > 0 ? 'down' : 'up';
        if (d <= mv) { c.x = p.x; c.y = p.y; c.path.shift(); } else { c.x += (dx / d) * mv; c.y += (dy / d) * mv; }
        c.moving = true;
        if (!c.path.length) c.corr = c.dest.corr;
      } else {
        c.moving = false;
      }
    });
  }

  frame = (now) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.step(dt, now);
    this.draw(now);
    requestAnimationFrame(this.frame);
  };

  // ── Dibujo ──────────────────────────────────────────────────────────────
  px(x, y, w, h, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x * S), Math.round(y * S), Math.round(w * S), Math.round(h * S));
  }

  draw(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W * S, H * S);
    this.drawRoom(now);

    // Todo lo que tiene profundidad se ordena por su «pie» (y) para que se tape bien.
    const items = [];
    DESKS.forEach((d, i) => {
      const owner = this.agents[i];
      items.push({ y: d.y + 14, draw: () => this.drawDesk(d, owner, now) });
      items.push({ y: d.y - 1, draw: () => this.drawChair(d) });
    });
    items.push({ y: 67, draw: () => this.drawBookshelf(266, 46) });
    items.push({ y: 141, draw: () => this.drawFloorLamp(312, 140, now) });
    items.push({ y: 172, draw: () => this.drawSofaBack(now) });
    items.push({ y: 196, draw: () => this.drawSofaFront() });
    items.push({ y: 112, draw: () => this.drawPlant(306, 108) });
    items.push({ y: 196, draw: () => this.drawPlant(246, 194) });
    this.agents.forEach((a) => {
      const c = this.chars.get(a.id);
      if (c && now >= c.enterAt) items.push({ y: c.y, draw: () => this.drawChar(a, c, now) });
    });
    items.sort((p, q) => p.y - q.y).forEach((it) => it.draw());

    this.labelBoxes = [];
    this.agents.forEach((a) => { const c = this.chars.get(a.id); if (c && now >= c.enterAt) this.drawLabels(a, c, now); });
  }

  drawRoom(now) {
    // Suelo de tarima
    this.px(0, WALL, W, H - WALL, '#c69b70');
    for (let y = WALL; y < H; y += 6) {
      this.px(0, y, W, 0.5, '#ac8059');
      const off = ((y / 6) % 2) * 20;
      for (let x = off; x < W; x += 40) this.px(x, y, 0.5, 6, '#ac8059');
      for (let x = (off + 13) % 40; x < W; x += 40) this.px(x, y + 2, 5, 0.5, 'rgba(255,255,255,.12)');
    }
    // Alfombra de la zona de descanso
    this.px(250, 98, 66, 100, '#415a77');
    this.px(253, 101, 60, 94, '#5f7f8e');
    for (let yy = 106; yy < 190; yy += 12) for (let xx = 258; xx < 308; xx += 12) this.px(xx, yy, 6, 2, '#91b0aa');
    this.px(260, 120, 46, 46, 'rgba(255,255,255,.08)');
    // Pared
    this.px(0, 0, W, WALL, '#596076');
    this.px(0, 0, W, 3, '#3b4057');
    for (let x = 0; x < W; x += 12) this.px(x, 3, 1, WALL - 7, 'rgba(255,255,255,.05)');
    this.px(0, WALL - 6, W, 3, '#737b91');
    this.px(0, WALL - 3, W, 3, '#30344a');
    // Ventanas con cielo que cambia según la hora real
    const hour = new Date().getHours();
    const sky = hour >= 21 || hour < 7 ? '#1e2a4a' : hour >= 19 ? '#f59e0b' : '#93c5fd';
    for (const wx of [14, 196]) {
      this.px(wx, 8, 44, 26, '#2a2e40');
      this.px(wx + 2, 10, 40, 22, sky);
      this.px(wx + 21, 10, 2, 22, '#2a2e40');
      this.px(wx + 2, 20, 40, 1.5, '#2a2e40');
      if (sky === '#93c5fd') { this.px(wx + 6, 14, 8, 2, '#fff'); this.px(wx + 28, 24, 10, 2, '#fff'); }
      if (sky === '#1e2a4a') { this.px(wx + 8, 13, 1, 1, '#fff'); this.px(wx + 32, 16, 1, 1, '#fff'); this.px(wx + 15, 26, 1, 1, '#fff'); }
      if (hour >= 8 && hour < 18) {
        this.px(wx + 6, WALL + 3, 26, 9, 'rgba(255,244,184,.16)');
        this.px(wx + 26, WALL + 12, 36, 7, 'rgba(255,244,184,.1)');
      }
    }
    // Cuadros y reloj
    this.px(66, 12, 14, 16, '#1f2937'); this.px(68, 14, 10, 12, '#c4b5fd'); this.px(70, 22, 6, 2, '#7c3aed');
    this.px(181, 13, 12, 12, '#1f2937'); this.px(183, 15, 8, 8, '#f8fafc'); this.px(187, 17, 1, 4, '#111827'); this.px(187, 20, 3, 1, '#111827');
    this.px(260, 13, 16, 14, '#1f2937'); this.px(262, 15, 12, 10, '#fed7aa'); this.px(264, 20, 8, 1, '#fb923c');
    // Pizarra con el tablero de tareas en directo
    this.drawWhiteboard();
    // Puerta
    this.px(236, 12, 20, 32, '#5b3a22');
    this.px(238, 14, 16, 30, '#7a4f2e');
    this.px(251, 28, 2, 2, '#fbbf24');
    // Cafetera y encimera
    this.px(266, 36, 50, 8, '#6b7280');
    this.px(266, 36, 50, 2, '#9ca3af');
    this.px(296, 20, 14, 16, '#1f2937');
    this.px(298, 23, 10, 5, '#374151');
    this.px(300, 30, 6, 4, '#111827');
    this.px(306, 22, 2, 2, Math.floor(now / 600) % 2 ? '#ef4444' : '#7f1d1d');
    this.px(274, 30, 6, 6, '#e5e7eb');
    this.px(282, 32, 4, 4, '#fde68a');
    const steam = Math.floor(now / 260) % 3;
    for (let i = 0; i < 3; i++) this.px(276 + i * 4, 25 - ((steam + i) % 3) * 2, 1, 3, 'rgba(255,255,255,.55)');
  }

  drawWhiteboard() {
    const x = 92, y = 6, w = 92, h = 30;
    this.px(x - 2, y - 2, w + 4, h + 4, '#64748b');
    this.px(x - 1, y - 1, w + 2, h + 2, '#cbd5e1');
    this.px(x, y, w, h, '#f8fafc');
    const cols = [
      ['todo', '#fde047'], ['doing', '#60a5fa'], ['review', '#fb923c'], ['done', '#4ade80'],
    ];
    const labels = ['Por hacer', 'En curso', 'Revisión', 'Hecho'];
    const cw = w / 4;
    cols.forEach(([status, color], i) => {
      const cx = x + i * cw;
      this.px(cx + 2, y + 2, cw - 4, 3, color);
      if (i) this.px(cx, y + 2, 0.5, h - 4, '#e2e8f0');
      this.ctx.font = `700 ${2.8 * S}px ui-sans-serif, system-ui`;
      this.ctx.fillStyle = '#334155';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(labels[i], (cx + 3) * S, (y + 3.4) * S);
      const list = this.tasks.filter((t) => t.status === status || (status === 'todo' && t.status === 'failed'));
      list.slice(0, 8).forEach((t, k) => {
        const sx = cx + 2 + (k % 2) * 10, sy = y + 7 + Math.floor(k / 2) * 6;
        this.px(sx + 1, sy + 1, 8, 5, 'rgba(0,0,0,.13)');
        this.px(sx, sy, 8, 5, t.status === 'failed' ? '#f87171' : color);
        this.px(sx, sy, 8, 1, 'rgba(255,255,255,.45)');
        this.px(sx + 1, sy + 2, 5, 0.6, 'rgba(0,0,0,.25)');
        this.px(sx + 1, sy + 3.5, 4, 0.6, 'rgba(0,0,0,.25)');
      });
    });
  }

  drawChair(d) {
    this.px(d.x + 27, d.y - 3, 11, 2, 'rgba(0,0,0,.18)');
    this.px(d.x + 27, d.y - 13, 10, 7, '#4b5563');
    this.px(d.x + 28, d.y - 12, 8, 5, '#ef4444');
    this.px(d.x + 29, d.y - 11, 6, 2, '#fca5a5');
    this.px(d.x + 31, d.y - 6, 2, 3, '#1f2937');
    this.px(d.x + 27, d.y - 3, 10, 3, '#b91c1c');
    this.px(d.x + 28, d.y, 1, 3, '#111827');
    this.px(d.x + 36, d.y, 1, 3, '#111827');
  }

  drawDesk(d, owner, now) {
    const working = owner?.status === 'working';
    this.px(d.x + 2, d.y + 12, 42, 5, 'rgba(0,0,0,.18)');
    // Monitor
    this.px(d.x + 3, d.y - 13, 20, 13, '#111827');
    this.px(d.x + 5, d.y - 11, 16, 9, owner ? (working ? '#07111f' : '#1e293b') : '#374151');
    this.px(d.x + 6, d.y - 10, 5, 1, 'rgba(255,255,255,.35)');
    if (working) {
      const colors = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'];
      const t = Math.floor(now / 350);
      for (let i = 0; i < 4; i++) {
        const w = 3 + ((t + i * 7 + d.x) % 9);
        this.px(d.x + 6 + (i % 2) * 2, d.y - 10 + i * 2, w, 1, colors[(t + i) % colors.length]);
      }
    } else if (owner) {
      this.px(d.x + 11, d.y - 8, 4, 3, '#334155');
    }
    this.px(d.x + 12, d.y, 3, 2, '#1f2937');
    // Tablero de la mesa
    this.px(d.x - 1, d.y - 1, 46, 3, '#d6a36f');
    this.px(d.x, d.y + 2, 44, 4, '#a87146');
    this.px(d.x, d.y + 6, 44, 8, '#7c4f30');
    this.px(d.x + 4, d.y + 7, 10, 1, 'rgba(255,255,255,.16)');
    this.px(d.x + 2, d.y + 13, 2, 1, '#5b3a22');
    this.px(d.x + 40, d.y + 13, 2, 1, '#5b3a22');
    this.px(d.x + 26, d.y + 1, 11, 2, '#d1d5db');
    this.px(d.x + 39, d.y, 3, 3, '#f3f4f6');
    if (owner) {
      const role = this.roles[owner.role];
      this.px(d.x + 2, d.y + 5.5, 22, 5, role?.color || '#999');
      const ctx = this.ctx;
      ctx.font = `700 ${3.2 * S}px ui-sans-serif, system-ui`;
      ctx.fillStyle = '#111827';
      ctx.textBaseline = 'middle';
      ctx.fillText(owner.name.slice(0, 9), (d.x + 3) * S, (d.y + 8.2) * S);
    }
  }

  drawBookshelf(x, y) {
    this.px(x - 1, y - 1, 48, 22, 'rgba(0,0,0,.15)');
    this.px(x, y, 46, 20, '#5b3a22');
    this.px(x + 2, y + 2, 42, 4, '#7a4f2e');
    this.px(x + 2, y + 10, 42, 4, '#7a4f2e');
    const books = ['#ef4444', '#f59e0b', '#22c55e', '#38bdf8', '#a78bfa'];
    for (let i = 0; i < 14; i++) this.px(x + 4 + i * 3, y + 3 + (i % 2) * 8, 2, 7, books[i % books.length]);
  }

  drawFloorLamp(x, y, now) {
    const glow = Math.floor(now / 900) % 2 ? 'rgba(254,240,138,.18)' : 'rgba(254,240,138,.12)';
    this.px(x - 10, y - 28, 22, 18, glow);
    this.px(x - 5, y - 28, 12, 8, '#facc15');
    this.px(x - 3, y - 26, 8, 5, '#fde68a');
    this.px(x + 1, y - 20, 2, 18, '#334155');
    this.px(x - 5, y - 2, 14, 2, '#334155');
  }

  drawSofaBack(now) {
    this.px(257, 165, 52, 10, 'rgba(0,0,0,.2)');
    this.px(258, 164, 50, 10, '#5b21b6');
    this.px(260, 166, 46, 3, '#8b5cf6');
    this.px(270, 170, 12, 8, '#f97316');
    this.px(286, 170, 12, 8, Math.floor(now / 700) % 2 ? '#22c55e' : '#16a34a');
  }
  drawSofaFront() {
    this.px(256, 178, 54, 9, '#6d28d9');
    this.px(256, 178, 54, 2, '#a78bfa');
    this.px(254, 168, 5, 18, '#4c1d95');
    this.px(308, 168, 5, 18, '#4c1d95');
    this.px(259, 186, 4, 3, '#2e1065');
    this.px(303, 186, 4, 3, '#2e1065');
  }
  drawPlant(x, y) {
    const sway = Math.sin(performance.now() / 850 + x) > 0 ? 1 : 0;
    this.px(x - 5, y - 1, 10, 2, 'rgba(0,0,0,.16)');
    this.px(x - 4, y - 6, 8, 6, '#78350f');
    this.px(x - 3, y - 5, 6, 4, '#92400e');
    this.px(x - 7 + sway, y - 15, 5, 9, '#15803d');
    this.px(x - 2, y - 18, 4, 12, '#22c55e');
    this.px(x + 2 - sway, y - 14, 6, 8, '#16a34a');
    this.px(x - 1, y - 17, 1, 8, 'rgba(255,255,255,.18)');
  }

  drawChar(a, c, now) {
    const h = hash(a.name + a.id);
    const skin = SKIN[h % SKIN.length];
    const hair = HAIR[(h >> 3) % HAIR.length];
    const shirt = this.roles[a.role]?.color || '#999';
    const x = c.x, y = c.y;
    const sitting = !c.moving && c.key === 'desk';
    const typing = sitting && a.status === 'working';
    const step = c.moving ? Math.floor(now / 140) % 2 : 0;
    const bob = !c.moving && !typing ? Math.sin(now / 500 + h) * 0.3 : 0;
    const face = typing ? 'up' : (c.face || 'down');
    const outline = '#111827';
    const shade = shadeColor(shirt, -28);
    const hi = shadeColor(shirt, 28);

    if (this.selected === a.id) { this.px(x - 8, y - 2, 16, 2, 'rgba(250,204,21,.75)'); this.px(x - 6, y, 12, 2, 'rgba(250,204,21,.35)'); }
    this.px(x - 5, y - 1, 10, 2, 'rgba(0,0,0,.24)');
    // Piernas
    if (!sitting) {
      if (face === 'left' || face === 'right') {
        const stride = step ? -1 : 1;
        this.px(x - 3, y - 6, 5, 6, outline);
        this.px(x - 2, y - 5, 2, 5, '#2d3142');
        this.px(x + stride, y - 5, 2, 4, '#374151');
        this.px(x - 3, y - 1, 4, 1, outline);
        this.px(x + stride - 1, y - 1.5, 5, 1, outline);
      } else {
        this.px(x - 4, y - 6, 3, 6, outline);
        this.px(x + 1, y - 6, 3, 6, outline);
        this.px(x - 3, y - 5, 2, step ? 4 : 5, '#2d3142');
        this.px(x + 2, y - 5, 2, step ? 5 : 4, '#2d3142');
        this.px(x - 4, y - (step ? 1.5 : 1), 4, 1, outline);
        this.px(x + 1, y - (step ? 1 : 1.5), 4, 1, outline);
      }
    }
    const by = y - (sitting ? 3 : 0) + bob;
    // Cuerpo y brazos
    if (face === 'left' || face === 'right') {
      const s = face === 'right' ? 1 : -1;
      this.px(x - 4, by - 12, 8, 8, outline);
      this.px(x - 3, by - 11, 6, 6, shirt);
      this.px(x - 2, by - 10, 2, 4, hi);
      this.px(x + s, by - 11, 2, 6, shade);
    } else {
      this.px(x - 5, by - 12, 10, 8, outline);
      this.px(x - 4, by - 11, 8, 6, shirt);
      this.px(x - 3, by - 10, 2, 4, hi);
      this.px(x + 2, by - 11, 2, 6, shade);
    }
    if (typing) {
      const k = Math.floor(now / 160) % 2;
      this.px(x - 6, by - 10, 2, 4, outline);
      this.px(x + 4, by - 10, 2, 4, outline);
      this.px(x - 5, by - 10, 2, 3, shade);
      this.px(x + 3, by - 10, 2, 3, shade);
      this.px(x - 4, by - 7 - k * 0.6, 3, 1.5, skin);
      this.px(x + 1, by - 7 - (1 - k) * 0.6, 3, 1.5, skin);
    } else {
      const sw = c.moving ? (step ? 0.8 : -0.8) : 0;
      if (face === 'left' || face === 'right') {
        const s = face === 'right' ? 1 : -1;
        this.px(x - s * 4, by - 11 - sw, 2, 6, outline);
        this.px(x - s * 3.5, by - 11 - sw, 1.5, 5, shade);
        this.px(x - s * 3.5, by - 6 - sw, 1.5, 1.2, skin);
        this.px(x + s * 3, by - 10 + sw, 2, 5, outline);
        this.px(x + s * 2, by - 10 + sw, 1.5, 4, shade);
        this.px(x + s * 2, by - 6 + sw, 1.5, 1.2, skin);
      } else {
        this.px(x - 6, by - 11 + sw, 2, 6, outline);
        this.px(x + 4, by - 11 - sw, 2, 6, outline);
        this.px(x - 5, by - 11 + sw, 1.5, 5, shade);
        this.px(x + 3.5, by - 11 - sw, 1.5, 5, shade);
        this.px(x - 5, by - 6 + sw, 1.5, 1.2, skin);
        this.px(x + 3.5, by - 6 - sw, 1.5, 1.2, skin);
      }
    }
    // Cabeza
    this.px(x - 4, by - 18, 8, 8, outline);
    this.px(x - 3, by - 17, 6, 6, skin);
    if (face === 'up') {
      this.px(x - 4, by - 19, 8, 5, hair);
      this.px(x - 3, by - 15, 6, 3, hair);
    } else if (face === 'left' || face === 'right') {
      const s = face === 'right' ? 1 : -1;
      this.px(x - 4, by - 18, 8, 5, outline);
      this.px(x - 3, by - 17, 6, 6, skin);
      this.px(x - 4, by - 19, 8, 4, hair);
      this.px(x - s * 4, by - 16, 3, 5, hair);
      this.px(x + s * 3, by - 15, 2, 2, skin);
      this.px(x + s * 3, by - 13, 1, 1, shadeColor(skin, -25));
      this.px(x - s * 1, by - 18, 3, 1, shadeColor(hair, 24));
    } else {
      this.px(x - 3.5, by - 18.5, 7, 2.8, hair);
      this.px(x - 3.5, by - 16, 1, 2.5, hair);
      this.px(x + 2.5, by - 16, 1, 2.5, hair);
      this.px(x - 1, by - 18.8, 3, 1, shadeColor(hair, 24));
    }
    const look = face === 'right' ? 0.8 : face === 'left' ? -0.8 : 0;
    const blink = Math.floor(now / 100 + h) % 40 === 0;
    if (!blink && face !== 'up') {
      this.px(x - 1.8 + look, by - 14.5, 1, 1, '#1f2937');
      this.px(x + 0.8 + look, by - 14.5, 1, 1, '#1f2937');
    }
    if (face === 'left' || face === 'right') this.px(x + (face === 'right' ? 2 : -3), by - 12.5, 1.5, 0.7, '#9f5f46');
    else if (face !== 'up') this.px(x - 0.5 + look, by - 12.5, 2, 0.7, '#9f5f46');
    // Accesorio de cada rol
    if (a.role === 'po') { this.px(x - 0.5, by - 11, 1, 4, '#e11d48'); this.px(x - 1.5, by - 7, 3, 1, '#be123c'); }
    if (a.role === 'back') { this.px(x - 4, by - 16, 1, 3, '#111827'); this.px(x + 3, by - 16, 1, 3, '#111827'); this.px(x - 3.5, by - 18.6, 7, 0.8, '#111827'); }
    if (a.role === 'front') { this.px(x - 4, by - 19, 8, 2, '#f59e0b'); this.px(x + (face === 'left' ? -5 : 2), by - 18, 3, 1, '#f59e0b'); }
    if (a.role === 'qa' && face !== 'up') { this.px(x - 2.5 + look, by - 15, 2, 2, 'rgba(15,23,42,.8)'); this.px(x + 0.5 + look, by - 15, 2, 2, 'rgba(15,23,42,.8)'); this.px(x - 0.5 + look, by - 14.5, 1, 0.5, '#0f172a'); }
    // Taza de café cuando descansan
    if (!c.moving && a.status !== 'working' && c.key?.startsWith('lounge')) this.px(x + 4, by - 8, 2, 2, '#f8fafc');
  }

  drawLabels(a, c, now) {
    const ctx = this.ctx;
    const X = c.x * S;
    const sitting = !c.moving && c.key === 'desk';
    const topY = (c.y - (sitting ? 3 : 0) - 20) * S;

    // Nombre bajo los pies (salvo sentado: ya está en la placa de la mesa)
    if (!sitting) {
      ctx.font = `600 ${3.4 * S}px ui-sans-serif, system-ui`;
      const tw = ctx.measureText(a.name).width;
      ctx.fillStyle = 'rgba(17,24,39,.65)';
      roundRect(ctx, X - tw / 2 - 5, (c.y + 1.5) * S, tw + 10, 4.6 * S, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(a.name, X, (c.y + 3.9) * S);
      ctx.textAlign = 'left';
    }

    let text = null, kind = 'work';
    const review = this.tasks.find((t) => t.agentId === a.id && t.status === 'review');
    const failed = this.tasks.find((t) => t.agentId === a.id && t.status === 'failed');
    if (a.status === 'working') {
      text = a.activity || 'Trabajando…';
      if (c.moving) text = c.key === 'board' ? 'Voy a la pizarra' : 'Voy a mi mesa';
      kind = c.key === 'board' ? 'plan' : 'work';
    } else if (failed && !c.moving) { text = `⚠ #${failed.id} falló`; kind = 'error'; }
    else if (review && !c.moving) { text = `✋ #${review.id} en revisión`; kind = 'review'; }
    if (!text) {
      if (!c.moving && Math.floor(now / 2400 + hash(a.id)) % 5 === 0) this.bubble(X, topY, '☕', 'idle');
      return;
    }
    this.bubble(X, topY, text, kind);
  }

  bubble(X, Y, text, kind) {
    const ctx = this.ctx;
    const max = 40;
    const t = text.length > max ? text.slice(0, max - 1) + '…' : text;
    ctx.font = `600 ${4.3 * S}px ui-sans-serif, system-ui`;
    const icon = { work: '▣', plan: '◆', review: '✓', error: '!', idle: '☕' }[kind] || '▣';
    const w = Math.min(W * S - 8, ctx.measureText(t).width + 27);
    const h = 8.5 * S;
    const bx = Math.max(4, Math.min(W * S - w - 4, X - w / 2));
    let by = Math.max(4, Y - h);
    const boxes = this.labelBoxes || (this.labelBoxes = []);
    for (let tries = 0; tries < 5; tries++) {
      const hit = boxes.some((b) => bx < b.x + b.w + 3 && bx + w + 3 > b.x && by < b.y + b.h + 2 && by + h + 8 > b.y);
      if (!hit || by <= 4) break;
      by -= h + 3;
    }
    by = Math.max(4, by);
    boxes.push({ x: bx, y: by, w, h: h + 8 });
    const style = {
      work: ['#ffffff', '#1f2937', '#cbd5e1'],
      plan: ['#f5f3ff', '#4c1d95', '#a78bfa'],
      review: ['#fff7ed', '#9a3412', '#fb923c'],
      error: ['#fef2f2', '#991b1b', '#f87171'],
      idle: ['#ffffff', '#1f2937', '#e5e7eb'],
    }[kind];
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    pixelBox(ctx, bx + 3, by + 3, w, h, 3 * S);
    ctx.fillStyle = style[0];
    ctx.strokeStyle = style[2];
    pixelBox(ctx, bx, by, w, h, 3 * S);
    ctx.fill();
    ctx.lineWidth = S;
    pixelBox(ctx, bx, by, w, h, 3 * S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X - 5, by + h - 1);
    ctx.lineTo(X + 5, by + h - 1);
    ctx.lineTo(X, by + h + 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = style[2];
    ctx.fillRect(bx + 5, by + 5, 6 * S, h - 10);
    ctx.fillStyle = style[1];
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(icon, bx + 8 * S, by + h / 2 + 1);
    ctx.textAlign = 'left';
    ctx.fillText(t, bx + 14 * S, by + h / 2 + 1, w - 16 * S);
  }
}

function pixelBox(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.lineTo(x + w - r, y + r);
  ctx.lineTo(x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.lineTo(x + w - r, y + h - r);
  ctx.lineTo(x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.lineTo(x + r, y + h - r);
  ctx.lineTo(x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x + r, y + r);
  ctx.closePath();
}

function shadeColor(hex, amount) {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return hex;
  const n = Number.parseInt(raw, 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + amount);
  const g = clamp(((n >> 8) & 255) + amount);
  const b = clamp((n & 255) + amount);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
