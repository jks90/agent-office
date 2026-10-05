// La oficina en 2D: pixel art con sprites Kenney CC0 y algunos elementos dinámicos dibujados a mano.
// Coordenadas lógicas W×H; cada unidad son S píxeles reales. El texto se pinta a resolución nativa.
const W = 320, H = 208, S = 3;
const SPINE = 244;          // pasillo vertical entre las mesas y la zona de descanso
const WALL = 44;
const SPEED = 46;           // unidades por segundo
const DOOR = { x: 247, y: 50 };
const TILE = 16;
const STEP = 17;

const DESKS = [
  { x: 16, y: 80 }, { x: 80, y: 80 }, { x: 144, y: 80 },
  { x: 16, y: 144 }, { x: 80, y: 144 }, { x: 144, y: 144 },
];
const seatOf = (d) => ({ x: d.x + 24, y: d.y + 16, corr: d.y + 48 });
const BOARD_SPOTS = [{ x: 112, y: 64 }, { x: 160, y: 64 }];
const LOUNGE = [
  { x: 256, y: 176 }, { x: 288, y: 176 }, { x: 304, y: 144 }, { x: 256, y: 128 },
  { x: 272, y: 112 }, { x: 304, y: 112 }, { x: 240, y: 160 }, { x: 288, y: 144 },
];

const SKIN_ROWS = [0, 1, 2];
const HAIR_SETS = [
  { row: 0, cols: [19, 20, 21, 22] },
  { row: 0, cols: [23, 24, 25, 26] },
  { row: 4, cols: [19, 20, 21, 22] },
  { row: 4, cols: [23, 24, 25, 26] },
  { row: 8, cols: [19, 20, 21, 22] },
];
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
    this.spriteCache = new Map();
    this.assetsReady = false;
    this.indoor = this.loadSprite('assets/kenney/indoor.png');
    this.characters = this.loadSprite('assets/kenney/characters.png');
    this.selected = null;
    this.last = performance.now();
    canvas.addEventListener('click', (e) => { const id = this.hit(e); if (id) onAgentClick?.(id); });
    canvas.addEventListener('mousemove', (e) => { canvas.style.cursor = this.hit(e) ? 'pointer' : 'default'; });
    requestAnimationFrame(this.frame);
  }

  loadSprite(src) {
    const img = new Image();
    img.onload = () => {
      if (this.indoor?.complete && this.characters?.complete) this.assetsReady = true;
    };
    img.src = src;
    return img;
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

  tile(img, col, row, dx, dy) {
    this.ctx.drawImage(img, col * STEP, row * STEP, TILE, TILE, Math.round(dx * S), Math.round(dy * S), TILE * S, TILE * S);
  }

  tileCtx(ctx, img, col, row, dx, dy) {
    ctx.drawImage(img, col * STEP, row * STEP, TILE, TILE, Math.round(dx), Math.round(dy), TILE, TILE);
  }

  draw(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W * S, H * S);
    if (!this.assetsReady) {
      this.drawFloorOnly();
      return;
    }
    this.drawRoom(now);

    // Todo lo que tiene profundidad se ordena por su «pie» (y) para que se tape bien.
    const items = [];
    DESKS.forEach((d, i) => {
      const owner = this.agents[i];
      items.push({ y: d.y + 12, draw: () => this.drawDesk(d, owner) });
      items.push({ y: d.y + 16, draw: () => this.drawChair(d) });
      items.push({ y: d.y + 33, draw: () => this.drawMonitor(d, owner, now) });
    });
    this.drawStaticSprites(items, now);
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
    this.drawFloorOnly();
    // Alfombra de la zona de descanso
    if (this.assetsReady) this.drawRug(240, 112);
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
    if (this.assetsReady) {
      this.tile(this.indoor, 18, 0, 64, 12);
      this.tile(this.indoor, 19, 12, 272, 12);
      this.tile(this.indoor, 20, 12, 288, 12);
    } else {
      this.px(66, 12, 14, 16, '#1f2937'); this.px(68, 14, 10, 12, '#c4b5fd'); this.px(70, 22, 6, 2, '#7c3aed');
      this.px(260, 13, 16, 14, '#1f2937'); this.px(262, 15, 12, 10, '#fed7aa');
    }
    this.px(181, 13, 12, 12, '#1f2937'); this.px(183, 15, 8, 8, '#f8fafc'); this.px(187, 17, 1, 4, '#111827'); this.px(187, 20, 3, 1, '#111827');
    // Pizarra con el tablero de tareas en directo
    this.drawWhiteboard();
    // Puerta
    this.px(236, 12, 20, 32, '#5b3a22');
    this.px(238, 14, 16, 30, '#7a4f2e');
    this.px(251, 28, 2, 2, '#fbbf24');
    // Cocina/café con sprites, vapor a mano
    if (this.assetsReady) {
      this.tile(this.indoor, 13, 14, 256, 12);
      this.tile(this.indoor, 13, 15, 256, 28);
      this.tile(this.indoor, 14, 14, 288, 20);
      this.tile(this.indoor, 14, 15, 288, 36);
      this.tile(this.indoor, 0, 12, 272, 28);
      this.tile(this.indoor, 1, 12, 304, 28);
    } else {
      this.px(266, 36, 50, 8, '#6b7280');
      this.px(296, 20, 14, 16, '#1f2937');
    }
    this.px(278, 30, 5, 6, '#e5e7eb');
    this.px(284, 32, 4, 4, '#fde68a');
    const steam = Math.floor(now / 260) % 3;
    for (let i = 0; i < 3; i++) this.px(279 + i * 3, 25 - ((steam + i) % 3) * 2, 1, 3, 'rgba(255,255,255,.55)');
  }

  drawFloorOnly() {
    this.px(0, WALL, W, H - WALL, '#c69b70');
    for (let y = WALL; y < H; y += 6) {
      this.px(0, y, W, 0.5, '#ac8059');
      const off = ((y / 6) % 2) * 20;
      for (let x = off; x < W; x += 40) this.px(x, y, 0.5, 6, '#ac8059');
      for (let x = (off + 13) % 40; x < W; x += 40) this.px(x, y + 2, 5, 0.5, 'rgba(255,255,255,.12)');
    }
  }

  drawRug(x, y) {
    for (let ry = 0; ry < 4; ry++) for (let rx = 0; rx < 4; rx++) this.tile(this.indoor, 23 + rx, 4 + ry, x + rx * 16, y + ry * 16);
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
    this.px(d.x + 17, d.y + 17, 14, 4, 'rgba(0,0,0,.16)');
    this.tile(this.indoor, 1, 3, d.x + 16, d.y + 16);
  }

  drawDesk(d, owner) {
    this.px(d.x + 2, d.y + 30, 44, 5, 'rgba(0,0,0,.18)');
    this.tile(this.indoor, 0, 0, d.x, d.y);
    this.tile(this.indoor, 1, 0, d.x + 16, d.y);
    this.tile(this.indoor, 2, 0, d.x + 32, d.y);
    this.tile(this.indoor, 0, 1, d.x, d.y + 16);
    this.tile(this.indoor, 1, 1, d.x + 16, d.y + 16);
    this.tile(this.indoor, 2, 1, d.x + 32, d.y + 16);
    this.px(d.x + 26, d.y + 13, 11, 2, '#d1d5db');
    this.px(d.x + 39, d.y + 12, 3, 3, '#f3f4f6');
    if (owner) {
      const role = this.roles[owner.role];
      this.px(d.x + 4, d.y + 22, 22, 5, role?.color || '#999');
      const ctx = this.ctx;
      ctx.font = `700 ${3.2 * S}px ui-sans-serif, system-ui`;
      ctx.fillStyle = '#111827';
      ctx.textBaseline = 'middle';
      ctx.fillText(owner.name.slice(0, 9), (d.x + 5) * S, (d.y + 24.7) * S);
    }
  }

  drawMonitor(d, owner, now) {
    const working = owner?.status === 'working';
    // Monitor
    this.px(d.x + 5, d.y + 2, 14, 10, '#111827');
    this.px(d.x + 6, d.y + 3, 12, 7, owner ? (working ? '#07111f' : '#1e293b') : '#374151');
    this.px(d.x + 7, d.y + 4, 4, 1, 'rgba(255,255,255,.35)');
    if (working) {
      const colors = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'];
      const t = Math.floor(now / 350);
      for (let i = 0; i < 4; i++) {
        const w = 2 + ((t + i * 7 + d.x) % 7);
        this.px(d.x + 7 + (i % 2) * 2, d.y + 4 + i * 1.5, w, 1, colors[(t + i) % colors.length]);
      }
    } else if (owner) {
      this.px(d.x + 10, d.y + 5, 4, 3, '#334155');
    }
    this.px(d.x + 12, d.y + 12, 3, 2, '#1f2937');
  }

  drawBookshelf(x, y) {
    this.px(x + 2, y + 30, 30, 4, 'rgba(0,0,0,.14)');
    this.tile(this.indoor, 12, 0, x, y);
    this.tile(this.indoor, 13, 0, x + 16, y);
    this.tile(this.indoor, 12, 1, x, y + 16);
    this.tile(this.indoor, 13, 1, x + 16, y + 16);
  }

  drawFloorLamp(x, y, now) {
    const glow = Math.floor(now / 900) % 2 ? 'rgba(254,240,138,.14)' : 'rgba(254,240,138,.09)';
    this.px(x - 7, y - 21, 20, 24, glow);
    this.tile(this.indoor, 20, 5, x, y - 16);
    this.tile(this.indoor, 20, 4, x, y - 32);
  }

  drawSofaBack(now) {
    this.px(254, 176, 50, 5, 'rgba(0,0,0,.18)');
    this.tile(this.indoor, 16, 8, 256, 160);
    this.tile(this.indoor, 17, 8, 272, 160);
    this.tile(this.indoor, 18, 8, 288, 160);
  }
  drawSofaFront() {
    this.tile(this.indoor, 16, 9, 256, 176);
    this.tile(this.indoor, 17, 9, 272, 176);
    this.tile(this.indoor, 18, 9, 288, 176);
  }
  drawPlant(x, y) {
    this.px(x + 3, y + 14, 10, 2, 'rgba(0,0,0,.16)');
    this.tile(this.indoor, 16, 0, x, y);
  }

  drawStaticSprites(items, now) {
    items.push({ y: 78, draw: () => this.drawBookshelf(272, 46) });
    items.push({ y: 78, draw: () => this.drawBookshelf(224, 46) });
    items.push({ y: 160, draw: () => this.drawFloorLamp(304, 144, now) });
    items.push({ y: 176, draw: () => this.drawSofaBack(now) });
    items.push({ y: 196, draw: () => this.drawSofaFront() });
    items.push({ y: 112, draw: () => this.drawPlant(224, 112) });
    items.push({ y: 208, draw: () => this.drawPlant(240, 176) });
    items.push({ y: 144, draw: () => this.drawRoundTable(272, 128) });
  }

  drawRoundTable(x, y) {
    this.tile(this.indoor, 1, 2, x, y - 16);
    this.tile(this.indoor, 0, 2, x, y + 16);
    this.tile(this.indoor, 2, 2, x - 16, y);
    this.tile(this.indoor, 3, 2, x + 32, y);
    this.tile(this.indoor, 3, 0, x, y);
    this.tile(this.indoor, 4, 0, x + 16, y);
    this.tile(this.indoor, 3, 1, x, y + 16);
    this.tile(this.indoor, 4, 1, x + 16, y + 16);
  }

  drawChar(a, c, now) {
    const h = hash(a.name + a.id);
    const x = c.x, y = c.y;
    const sitting = !c.moving && c.key === 'desk';
    const typing = sitting && a.status === 'working';
    const step = c.moving ? Math.floor(now / 140) % 2 : 0;
    const bob = c.moving ? (step ? -1.5 : 0) : (!typing ? Math.sin(now / 500 + h) * 0.5 : 0);
    const faceLeft = c.face === 'left';

    if (this.selected === a.id) {
      this.px(x - 8, y + 1, 16, 2, 'rgba(250,204,21,.75)');
      this.px(x - 6, y + 3, 12, 2, 'rgba(250,204,21,.35)');
    }
    this.px(x - 6, y + 2, 12, 3, 'rgba(0,0,0,.24)');

    const canvas = this.agentSprite(a, sitting ? 'back' : 'front');
    const dx = Math.round((x - 8) * S);
    const dy = Math.round((y - 16 + bob) * S);
    const ctx = this.ctx;
    ctx.save();
    if (faceLeft && !sitting) {
      ctx.translate(dx + TILE * S, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(canvas, 0, 0, TILE * S, TILE * S);
    } else {
      ctx.drawImage(canvas, dx, dy, TILE * S, TILE * S);
    }
    ctx.restore();

    if (typing) {
      const k = Math.floor(now / 160) % 2;
      this.px(x - 5, y - 5 - k, 4, 1.5, '#f1c7a3');
      this.px(x + 1, y - 5 - (1 - k), 4, 1.5, '#f1c7a3');
    }
    if (!c.moving && a.status !== 'working' && c.key?.startsWith('lounge')) this.px(x + 5, y - 7, 2, 2, '#f8fafc');
  }

  agentSprite(a, view) {
    const key = `${a.id}:${a.role}:${view}:${this.roles[a.role]?.color || ''}`;
    if (this.spriteCache.has(key)) return this.spriteCache.get(key);
    const h = hash(a.name + a.id);
    const canvas = document.createElement('canvas');
    canvas.width = TILE * S;
    canvas.height = TILE * S;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.scale(S, S);

    const skinRow = SKIN_ROWS[h % SKIN_ROWS.length];
    const shirtCol = 6 + ((h >> 3) % 4);
    const hairSet = HAIR_SETS[(h >> 5) % HAIR_SETS.length];
    const hairCol = view === 'back' ? 22 : hairSet.cols[(h >> 8) % hairSet.cols.length];
    const hairRow = hairSet.row + ((h >> 10) & 1);

    this.tileCtx(ctx, this.characters, view === 'back' ? 1 : 0, skinRow, 0, 0);
    this.drawTintedShirt(ctx, shirtCol, 0, this.roles[a.role]?.color || '#999999');
    this.tileCtx(ctx, this.characters, hairCol, hairRow, 0, 0);

    if (a.role === 'po') this.drawTie(ctx);
    if (a.role === 'back') this.drawHeadphones(ctx);
    if (a.role === 'front') this.tileCtx(ctx, this.characters, 28, 7, 0, 0);
    if (a.role === 'qa' && view !== 'back') this.drawGlasses(ctx);

    this.spriteCache.set(key, canvas);
    return canvas;
  }

  drawTintedShirt(ctx, col, row, color) {
    const tmp = document.createElement('canvas');
    tmp.width = TILE;
    tmp.height = TILE;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    this.tileCtx(tctx, this.characters, col, row, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = `${color}8c`;
    tctx.fillRect(0, 0, TILE, TILE);
    tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }

  drawTie(ctx) {
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(7, 7, 2, 5);
    ctx.fillStyle = '#be123c';
    ctx.fillRect(6, 11, 4, 1);
  }

  drawHeadphones(ctx) {
    ctx.fillStyle = '#111827';
    ctx.fillRect(4, 3, 1, 4);
    ctx.fillRect(11, 3, 1, 4);
    ctx.fillRect(5, 2, 6, 1);
  }

  drawGlasses(ctx) {
    ctx.fillStyle = 'rgba(15,23,42,.85)';
    ctx.fillRect(5, 5, 3, 2);
    ctx.fillRect(9, 5, 3, 2);
    ctx.fillRect(8, 6, 1, 1);
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
