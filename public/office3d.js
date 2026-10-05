// La oficina en 3D: escena low-poly isométrica con three.js y los assets Kenney (CC0).
// Misma API pública que la clase Office de office.js (constructor(canvas,{onAgentClick}), update(...)),
// para que app.js pueda elegir uno u otro sin más cambios.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// ── Geometría de la sala (en unidades Kenney; los modelos son pequeños ≈ 0,7 m/u) ──
const RX = 13, RZ = 9, WALL_H = 1.29;
const CENTER = new THREE.Vector3(RX / 2, 0, RZ / 2);
const SPINE_X = 7.3;                  // pasillo vertical entre las mesas y la zona derecha
const DOOR = { x: 7.3, z: 0.5 };      // entran por aquí, de uno en uno
const SPEED = 1.7;                    // unidades/s
const CHAR_H = 0.95;                  // altura objetivo del personaje

// 8 mesas en 2 filas de 4, a la izquierda. El agente se sienta en el lado +z mirando al monitor (-z).
const DESK_COLS = [1.2, 2.8, 4.4, 6.0];
const DESK_ROWS = [2.3, 4.6];
const DESKS = [];
for (const z of DESK_ROWS) for (const x of DESK_COLS) DESKS.push({ x, z });
const seatOf = (d) => ({ x: d.x, z: d.z + 0.5, corr: d.z + 0.5 });

const BOARD_SPOTS = [{ x: 3.0, z: 1.1, corr: null }, { x: 4.2, z: 1.1, corr: null }];
const BOARD = { x: 3.6, y: 0.78, z: 0.09, w: 2.6, h: 0.92 };

// Zona de descanso y sitios donde deambulan los que no trabajan.
const LOUNGE = [
  { x: 9.95, z: 6.85, sit: true }, { x: 10.7, z: 6.85, sit: true },
  { x: 11.2, z: 1.7 }, { x: 12.1, z: 2.2 }, { x: 8.4, z: 7.0 },
  { x: 8.8, z: 3.4 }, { x: 10.4, z: 3.4 }, { x: 12.1, z: 6.7 },
];

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const CHAR_FILES = [];
for (const g of ['female', 'male']) for (const l of ['a', 'b', 'c', 'd', 'e', 'f']) CHAR_FILES.push(`character-${g}-${l}`);

const MINT = 0x9fd8c3, WOOD = 0xd8b48a, SCREEN_ON = 0x8fe3c7, WALL_TINT = 0xe9f0e8;

// Mobiliario estático: {model, x, z, ry(rad), tint(hex)}. Se apoya solo en el suelo (base y=0).
const FURNITURE = [
  // Zona de descanso (derecha-delante)
  { model: 'rugRectangle', x: 10.3, z: 6.4, ry: 0, tint: MINT },
  { model: 'loungeSofa', x: 10.3, z: 7.0, ry: Math.PI, tint: MINT },
  { model: 'tableCoffee', x: 10.3, z: 6.2, ry: 0, tint: WOOD },
  { model: 'pottedPlant', x: 12.3, z: 7.3, ry: 0 },
  { model: 'lampRoundFloor', x: 8.5, z: 7.3, ry: 0 },
  // Rincón del café (fondo-derecha)
  { model: 'kitchenCabinet', x: 10.0, z: 0.55, ry: 0 },
  { model: 'kitchenCabinet', x: 10.6, z: 0.55, ry: 0 },
  { model: 'kitchenFridge', x: 11.6, z: 0.6, ry: 0 },
  // Estantería contra la pared del fondo
  { model: 'bookcaseOpen', x: 8.5, z: 0.45, ry: 0 },
  // Mesa de reuniones
  { model: 'tableRound', x: 9.6, z: 3.4, ry: 0, tint: WOOD },
  // Plantas sueltas, papelera, perchero
  { model: 'plantSmall1', x: 0.6, z: 4.6, ry: 0 },
  { model: 'plantSmall2', x: 6.9, z: 7.0, ry: 0 },
  { model: 'plantSmall3', x: 12.4, z: 4.0, ry: 0 },
  { model: 'trashcan', x: 7.0, z: 2.7, ry: 0 },
  { model: 'coatRackStanding', x: 7.7, z: 0.6, ry: 0 },
];
// La cafetera va encima del primer armario (altura real se ajusta al cargar).
const ON_TOP = [{ model: 'kitchenCoffeeMachine', x: 10.0, z: 0.55, onModel: 'kitchenCabinet' }];
// Sillas de la mesa de reuniones
const MEETING_CHAIRS = [
  { model: 'chair', x: 9.6, z: 4.1, ry: Math.PI },
  { model: 'chair', x: 8.9, z: 3.4, ry: Math.PI / 2 },
  { model: 'chair', x: 10.3, z: 3.4, ry: -Math.PI / 2 },
];

const FURNITURE_NEEDED = new Set([
  'desk', 'chairDesk', 'computerScreen', 'computerKeyboard', 'computerMouse',
  'wall', 'wallWindow', 'wallDoorway',
  ...FURNITURE.map((f) => f.model), ...ON_TOP.map((f) => f.model), ...MEETING_CHAIRS.map((f) => f.model),
]);

const FURN_DIR = 'assets/3d/furniture/';
const CHAR_DIR = 'assets/3d/characters/';

export class Office3D {
  constructor(canvas, { onAgentClick } = {}) {
    this.cv = canvas;
    this.onAgentClick = onAgentClick;
    this.agents = [];
    this.tasks = [];
    this.roles = {};
    this.title = '';
    this.selected = null;
    this.actors = new Map();       // agentId → { group, mixer, actions, nav... }
    this.furnCache = new Map();    // nombre → gltf.scene (prototipo para clonar)
    this.charCache = new Map();    // nombre → gltf
    this.workstations = [];        // { x,z,screenMats[] }
    this.ready = false;
    this.boardSig = '';

    canvas.style.imageRendering = 'auto';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf1f5f0);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 200);
    this.setupLights();
    this.buildFloor();
    this.buildBoard();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    canvas.addEventListener('pointerdown', (e) => this.onPointer(e, true));
    canvas.addEventListener('pointermove', (e) => this.onPointer(e, false));

    this.buildLabels();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);

    this.last = performance.now();
    this.elapsed = 0;
    this.running = false;
    this.renderer.render(this.scene, this.camera);   // habitación vacía mientras cargan los assets
    this.loadAll();
  }

  // ── Escena base ────────────────────────────────────────────────────────────
  setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd4ddd2, 1.05);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff4e2, 1.75);
    dir.position.set(RX * 0.62, 9, RZ * 0.72);
    dir.target.position.copy(CENTER);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const s = Math.max(RX, RZ) * 0.7;
    const sc = dir.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = 0.5; sc.far = 40;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.02;
    this.scene.add(dir, dir.target);
  }

  buildFloor() {
    const geo = new THREE.PlaneGeometry(RX, RZ);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(RX / 2, 0, RZ / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  buildBoard() {
    // Pizarra Kanban: un panel con marco cuya cara es un CanvasTexture pintado a mano.
    this.boardCanvas = document.createElement('canvas');
    this.boardCanvas.width = 512; this.boardCanvas.height = 268;
    this.boardTex = new THREE.CanvasTexture(this.boardCanvas);
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD.w + 0.18, BOARD.h + 0.18, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x5c6b63, roughness: 0.8 }));
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD.w, BOARD.h),
      new THREE.MeshBasicMaterial({ map: this.boardTex }));
    frame.position.set(BOARD.x, BOARD.y, BOARD.z);
    panel.position.set(BOARD.x, BOARD.y, BOARD.z + 0.05);
    frame.castShadow = true;
    this.scene.add(frame, panel);
    this.drawBoard();
  }

  drawBoard() {
    const ctx = this.boardCanvas.getContext('2d');
    const W = 512, H = 268;
    ctx.fillStyle = '#fbfdfb'; ctx.fillRect(0, 0, W, H);
    const cols = [['todo', 'Por hacer', '#f6c744'], ['doing', 'En curso', '#5b9be0'],
      ['review', 'Revisión', '#ef9a4a'], ['done', 'Hecho', '#56c06a']];
    const cw = W / 4;
    ctx.textBaseline = 'top';
    cols.forEach(([status, label, color], i) => {
      const cx = i * cw;
      if (i) { ctx.strokeStyle = '#e2e8e2'; ctx.beginPath(); ctx.moveTo(cx, 8); ctx.lineTo(cx, H - 8); ctx.stroke(); }
      ctx.fillStyle = color; ctx.fillRect(cx + 8, 10, cw - 16, 8);
      ctx.fillStyle = '#334155'; ctx.font = '700 18px system-ui, sans-serif';
      ctx.fillText(label, cx + 10, 24);
      const list = this.tasks.filter((t) => t.status === status || (status === 'todo' && t.status === 'failed'));
      list.slice(0, 8).forEach((t, k) => {
        const sx = cx + 10 + (k % 2) * (cw / 2 - 4), sy = 52 + Math.floor(k / 2) * 34;
        const pw = cw / 2 - 14, ph = 28;
        ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(sx + 2, sy + 2, pw, ph);
        ctx.fillStyle = t.status === 'failed' ? '#f07167' : color;
        ctx.fillRect(sx, sy, pw, ph);
        ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(sx, sy, pw, 3);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(sx + 6, sy + 10, pw - 18, 3); ctx.fillRect(sx + 6, sy + 17, pw - 28, 3);
      });
    });
    this.boardTex.needsUpdate = true;
  }

  // ── Carga de assets ──────────────────────────────────────────────────────────
  loadAll() {
    const loader = new GLTFLoader();
    const load = (url) => new Promise((res) => loader.load(url, (g) => res(g), undefined, () => res(null)));
    const furnJobs = [...FURNITURE_NEEDED].map(async (name) => {
      const g = await load(FURN_DIR + name + '.glb');
      if (g) this.furnCache.set(name, g.scene);
    });
    const charJobs = CHAR_FILES.map(async (name) => {
      const g = await load(CHAR_DIR + name + '.glb');
      if (g) this.charCache.set(name, g);
    });
    Promise.all([...furnJobs, ...charJobs]).then(() => {
      this.buildWalls();
      this.buildWorkstations();
      this.buildFurniture();
      this.ready = true;
      this.renderer.render(this.scene, this.camera);
      // El bucle de animación continuo impide que Chrome headless alcance «networkidle2»
      // (la captura se queda esperando). Lo arrancamos un poco después de que la red se calme.
      setTimeout(() => { this.running = true; this.renderer.setAnimationLoop(() => this.frame()); }, 900);
    });
  }

  // Clona un mueble centrado en su huella (x,z) y apoyado en el suelo (y=0), con sombras
  // y, si procede, tintado. Devuelve un Group para que (x,z) sea siempre el centro.
  instance(name, { tint, ry = 0 } = {}) {
    const proto = this.furnCache.get(name);
    if (!proto) return null;
    const inner = proto.clone(true);
    // clone(true) comparte los materiales entre instancias; los clonamos para poder
    // tintarlos o encender pantallas sin afectar a las demás copias.
    inner.traverse((m) => {
      if (m.isMesh) {
        if (m.material) {
          m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
          if (tint != null) for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) if (mt.color) mt.color.setHex(tint);
        }
        m.castShadow = true; m.receiveShadow = true;
      }
    });
    inner.rotation.y = ry;
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const c = box.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);  // centro de la huella en el origen, base en y=0
    const group = new THREE.Group();
    group.add(inner);
    return group;
  }

  place(name, x, z, opts = {}) {
    const obj = this.instance(name, opts);
    if (!obj) return null;
    obj.position.x = x; obj.position.z = z;
    this.scene.add(obj);
    return obj;
  }

  topOf(obj) { return new THREE.Box3().setFromObject(obj).max.y; }

  buildWalls() {
    const wallBox = this.furnCache.get('wall') && new THREE.Box3().setFromObject(this.furnCache.get('wall'));
    const seg = wallBox ? Math.max(0.5, wallBox.getSize(new THREE.Vector3()).x) : 1;
    // Pared del fondo (z=0), a lo largo de x. Con una ventana y una puerta.
    const nBack = Math.ceil(RX / seg);
    for (let i = 0; i < nBack; i++) {
      const x = i * seg + seg / 2;
      let model = 'wall';
      if (i === 1 || i === 8) model = 'wallWindow';
      if (i === Math.floor(DOOR.x / seg)) model = 'wallDoorway';
      this.place(model, Math.min(x, RX - seg / 2), 0, { ry: 0, tint: model === 'wall' ? WALL_TINT : undefined });
    }
    // Pared izquierda (x=0), a lo largo de z, girada 90°.
    const nLeft = Math.ceil(RZ / seg);
    for (let i = 0; i < nLeft; i++) {
      const z = i * seg + seg / 2;
      const model = (i === 2 || i === 5) ? 'wallWindow' : 'wall';
      this.place(model, 0, Math.min(z, RZ - seg / 2), { ry: Math.PI / 2, tint: model === 'wall' ? WALL_TINT : undefined });
    }
  }

  buildWorkstations() {
    DESKS.forEach((d) => {
      const desk = this.place('desk', d.x, d.z, { ry: 0 });
      if (!desk) return;
      const top = this.topOf(desk);
      const screen = this.place('computerScreen', d.x, d.z - 0.11, { ry: 0 });
      const kb = this.place('computerKeyboard', d.x, d.z + 0.04, { ry: 0 });
      const mouse = this.place('computerMouse', d.x + 0.22, d.z + 0.05, { ry: 0 });
      for (const o of [screen, kb, mouse]) if (o) o.position.y = top;
      // Silla del escritorio, el agente se sienta encima mirando al monitor (-z).
      this.place('chairDesk', d.x, d.z + 0.5, { ry: 0 });
      // Materiales de la pantalla, para encenderla cuando se trabaja.
      const screenMats = [];
      if (screen) screen.traverse((m) => {
        if (m.isMesh) { const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const mt of mats) { mt.emissive && screenMats.push(mt); } }
      });
      this.workstations.push({ x: d.x, z: d.z, screenMats });
    });
  }

  buildFurniture() {
    const placed = {};
    for (const f of FURNITURE) placed[f.model] = this.place(f.model, f.x, f.z, { ry: f.ry, tint: f.tint });
    for (const f of MEETING_CHAIRS) this.place(f.model, f.x, f.z, { ry: f.ry });
    for (const f of ON_TOP) {
      const base = placed[f.onModel];
      const o = this.place(f.model, f.x, f.z);
      if (o && base) o.position.y = this.topOf(base);
    }
  }

  // ── API pública ──────────────────────────────────────────────────────────────
  update({ agents, tasks, roles, title, selected }) {
    this.agents = agents || [];
    this.tasks = tasks || [];
    this.roles = roles || {};
    this.title = title || '';
    this.selected = selected;
    for (const [id, a] of this.actors) if (!this.agents.some((g) => g.id === id)) { this.scene.remove(a.group); this.actors.delete(id); this.removeLabel(id); }
    const sig = JSON.stringify(this.tasks.map((t) => [t.id, t.status]));
    if (sig !== this.boardSig) { this.boardSig = sig; this.drawBoard(); }
  }

  // ── Personajes ──────────────────────────────────────────────────────────────
  spawnActor(agent, index, now) {
    const file = CHAR_FILES[hash(agent.name + agent.id) % CHAR_FILES.length];
    const gltf = this.charCache.get(file);
    const group = new THREE.Group();
    const a = {
      group, x: DOOR.x, z: DOOR.z, corr: null, path: [], key: null, moving: false,
      loungeSpot: index, enterAt: now + this.queuedCount(now) * 0.9, nextWander: now + 8 + Math.random() * 12,
      angle: Math.PI, targetAngle: Math.PI, mixer: null, actions: {}, clip: null, current: null,
      emote: null, lastEmote: null, sitSpot: false,
    };
    if (gltf) {
      const model = skeletonClone(gltf.scene);
      const box = new THREE.Box3().setFromObject(model);
      const h = box.getSize(new THREE.Vector3()).y || 1;
      const scale = CHAR_H / h;
      model.scale.setScalar(scale);
      model.position.y = -box.min.y * scale;
      model.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
      group.add(model);
      a.mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) {
        const act = a.mixer.clipAction(clip);
        if (/^emote|^pick-up|^jump|^interact/.test(clip.name)) { act.loop = THREE.LoopOnce; act.clampWhenFinished = true; }
        a.actions[clip.name] = act;
      }
    }
    // Disco del color del rol bajo los pies.
    const col = new THREE.Color(this.roles[agent.role]?.color || '#888');
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 24),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    group.add(disc);
    a.disc = disc;
    group.position.set(a.x, 0, a.z);
    group.visible = false;
    this.scene.add(group);
    this.actors.set(agent.id, a);
    return a;
  }

  queuedCount(now) { return [...this.actors.values()].filter((o) => o.enterAt >= now).length; }

  targetFor(agent, index, a) {
    const task = this.tasks.find((t) => t.id === agent.taskId);
    if (agent.status === 'paused' && task?.kind === 'plan') return { key: 'board', ...BOARD_SPOTS[index % 2] };
    if (agent.status === 'working' && task?.kind === 'plan') return { key: 'board', ...BOARD_SPOTS[index % 2] };
    if (agent.status === 'working' || agent.status === 'paused') return { key: 'desk', ...seatOf(DESKS[index % DESKS.length]) };
    const spot = a?.loungeSpot ?? index;
    const s = LOUNGE[spot % LOUNGE.length];
    return { key: 'lounge' + (spot % LOUNGE.length), x: s.x, z: s.z, corr: null, sit: !!s.sit };
  }

  route(c, t) {
    const pts = [];
    const za = c.corr ?? c.z;
    const zb = t.corr ?? t.z;
    if (c.corr != null) pts.push({ x: c.x, z: za });
    if (Math.abs(c.x - t.x) > 0.05 || Math.abs(za - zb) > 0.05) pts.push({ x: SPINE_X, z: za }, { x: SPINE_X, z: zb }, { x: t.x, z: zb });
    if (t.corr != null) pts.push({ x: t.x, z: t.z });
    return pts;
  }

  step(dt, now) {
    this.agents.forEach((agent, i) => {
      let a = this.actors.get(agent.id);
      if (!a) a = this.spawnActor(agent, i, now);
      if (now < a.enterAt) { a.group.visible = false; return; }
      a.group.visible = true;

      if (agent.status !== 'working' && now > a.nextWander && !a.moving) {
        const taken = new Set([...this.actors.values()].map((o) => o.loungeSpot));
        const free = LOUNGE.map((_, k) => k).filter((k) => !taken.has(k));
        if (free.length) a.loungeSpot = free[Math.floor(Math.random() * free.length)];
        a.nextWander = now + 10 + Math.random() * 15;
      }

      const t = this.targetFor(agent, i, a);
      if (t.key !== a.key) { a.path = this.route(a, t); a.key = t.key; a.corr = null; a.dest = t; a.sitSpot = !!t.sit; }

      if (a.path.length) {
        const p = a.path[0];
        const dx = p.x - a.x, dz = p.z - a.z;
        const d = Math.hypot(dx, dz);
        const mv = SPEED * dt;
        if (d > 0.01) a.targetAngle = Math.atan2(dx, dz);
        if (d <= mv) { a.x = p.x; a.z = p.z; a.path.shift(); } else { a.x += (dx / d) * mv; a.z += (dz / d) * mv; }
        a.moving = true;
        if (!a.path.length) a.corr = a.dest.corr;
      } else {
        a.moving = false;
        // En reposo miran al fondo (-z): el que trabaja a su monitor, el PO a la pizarra.
        if (a.key === 'desk' || a.key === 'board' || a.sitSpot) a.targetAngle = Math.PI;
      }

      // Emotes al llegar según el estado de su tarea.
      if (!a.moving) {
        const fail = this.tasks.find((x) => x.agentId === agent.id && x.status === 'failed');
        const rev = this.tasks.find((x) => x.agentId === agent.id && x.status === 'review');
        const ev = fail ? 'no:' + fail.id : rev ? 'yes:' + rev.id : null;
        if (ev && a.lastEmote !== ev && a.actions[fail ? 'emote-no' : 'emote-yes']) {
          a.lastEmote = ev; a.emote = { name: fail ? 'emote-no' : 'emote-yes', until: now + 1.3 };
        }
        if (!ev) a.lastEmote = null;
      }

      // Posición y giro.
      let y = 0;
      if (a.key === 'desk' && (agent.status === 'working' || agent.status === 'paused') && !a.moving) y = 0.2;
      else if (a.sitSpot && !a.moving) y = 0.24;
      a.group.position.set(a.x, y, a.z);
      let da = a.targetAngle - a.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      a.angle += da * Math.min(1, dt * 10);
      a.group.rotation.y = a.angle;

      // Color del disco (más intenso si seleccionado).
      if (a.disc) a.disc.material.opacity = this.selected === agent.id ? 0.95 : 0.5;

      // Animación.
      this.playClip(a, this.chooseClip(a, agent, now));
      if (a.mixer) a.mixer.update(dt);

      // Encender la pantalla de su mesa cuando trabaja sentado.
      const ws = (a.key === 'desk') ? this.workstations[i % this.workstations.length] : null;
      // (el encendido se resuelve abajo en refreshScreens)
      a._ws = (a.key === 'desk' && (agent.status === 'working' || agent.status === 'paused') && !a.moving) ? i % this.workstations.length : -1;
    });
    this.refreshScreens();
  }

  refreshScreens() {
    const on = new Set();
    for (const a of this.actors.values()) if (a._ws >= 0) on.add(a._ws);
    this.workstations.forEach((ws, i) => {
      const lit = on.has(i);
      for (const mt of ws.screenMats) { mt.emissive.setHex(lit ? SCREEN_ON : 0x000000); mt.emissiveIntensity = lit ? 1.6 : 0; }
    });
  }

  chooseClip(a, agent, now) {
    if (a.emote && now < a.emote.until && a.actions[a.emote.name]) return a.emote.name;
    if (a.moving) return a.actions.walk ? 'walk' : 'idle';
    if (a.key === 'desk' && (agent.status === 'working' || agent.status === 'paused')) return a.actions.sit ? 'sit' : 'idle';
    if (a.sitSpot) return a.actions.sit ? 'sit' : 'idle';
    return a.actions.idle ? 'idle' : (Object.keys(a.actions)[0] || null);
  }

  playClip(a, name) {
    if (!name || !a.mixer || a.clip === name) return;
    const next = a.actions[name];
    if (!next) return;
    const prev = a.current;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.25).play();
    if (prev && prev !== next) prev.fadeOut(0.25);
    a.current = next; a.clip = name;
  }

  // ── Etiquetas HTML ────────────────────────────────────────────────────────────
  buildLabels() {
    const wrap = this.cv.closest('.office-wrap') || this.cv.parentElement;
    if (wrap && getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    this.wrap = wrap;
    const style = document.createElement('style');
    style.textContent = `
      .o3d-labels{position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:system-ui,sans-serif}
      .o3d-el{position:absolute;transform:translate(-50%,-100%);white-space:nowrap;transition:opacity .2s}
      .o3d-pill{font-size:11px;font-weight:600;color:#1f2937;background:rgba(255,255,255,.88);border:1px solid rgba(0,0,0,.1);
        border-radius:999px;padding:1px 8px;box-shadow:0 1px 3px rgba(0,0,0,.18);transform:translate(-50%,0)}
      .o3d-pill.sel{outline:2px solid #f6c744;outline-offset:1px}
      .o3d-bubble{font-size:11px;font-weight:600;color:#1f2937;background:rgba(255,255,255,.95);border:1px solid rgba(0,0,0,.08);
        border-radius:9px;padding:3px 8px;box-shadow:0 2px 6px rgba(0,0,0,.2);max-width:190px;overflow:hidden;text-overflow:ellipsis}
      .o3d-bubble.plan{background:#f5f3ff;color:#4c1d95;border-color:#c4b5fd}
      .o3d-bubble.review{background:#fff7ed;color:#9a3412;border-color:#fdba74}
      .o3d-bubble.error{background:#fef2f2;color:#991b1b;border-color:#fca5a5}
      .o3d-board{font-size:12px;font-weight:700;color:#334155;background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.1);
        border-radius:8px;padding:3px 10px;box-shadow:0 2px 6px rgba(0,0,0,.18)}`;
    document.head.appendChild(style);
    this.labelRoot = document.createElement('div');
    this.labelRoot.className = 'o3d-labels';
    (wrap || document.body).appendChild(this.labelRoot);
    this.labelEls = new Map();
    this.boardLabel = document.createElement('div');
    this.boardLabel.className = 'o3d-el o3d-board';
    this.labelRoot.appendChild(this.boardLabel);
  }

  removeLabel(id) { const e = this.labelEls.get(id); if (e) { e.pill.remove(); e.bubble.remove(); this.labelEls.delete(id); } }

  labelFor(id) {
    let e = this.labelEls.get(id);
    if (!e) {
      const pill = document.createElement('div'); pill.className = 'o3d-el o3d-pill';
      const bubble = document.createElement('div'); bubble.className = 'o3d-el o3d-bubble';
      this.labelRoot.append(pill, bubble);
      e = { pill, bubble }; this.labelEls.set(id, e);
    }
    return e;
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
  }

  updateLabels(now) {
    // Pizarra: título + pendientes.
    const pend = this.tasks.filter((t) => t.status === 'todo' || t.status === 'failed').length;
    const bp = this.project(BOARD.x, BOARD.y + BOARD.h / 2 + 0.25, BOARD.z);
    this.boardLabel.textContent = `${this.title || 'Proyecto'} · ${pend} pendientes`;
    this.boardLabel.style.left = bp.x + 'px';
    this.boardLabel.style.top = bp.y + 'px';
    this.boardLabel.style.opacity = bp.visible ? '1' : '0';

    const seen = new Set();
    this.agents.forEach((agent) => {
      const a = this.actors.get(agent.id);
      if (!a || !a.group.visible) return;
      seen.add(agent.id);
      const e = this.labelFor(agent.id);
      const head = this.project(a.x, 1.15, a.z);
      const foot = this.project(a.x, 0.02, a.z);
      e.pill.textContent = agent.name;
      e.pill.classList.toggle('sel', this.selected === agent.id);
      e.pill.style.left = foot.x + 'px';
      e.pill.style.top = (foot.y + 4) + 'px';
      e.pill.style.opacity = foot.visible ? '1' : '0';

      const { text, kind } = this.bubbleText(agent, a, now);
      if (text) {
        e.bubble.textContent = text;
        e.bubble.className = 'o3d-el o3d-bubble' + (kind ? ' ' + kind : '');
        e.bubble.style.left = head.x + 'px';
        e.bubble.style.top = (head.y - 2) + 'px';
        e.bubble.style.opacity = head.visible ? '1' : '0';
      } else e.bubble.style.opacity = '0';
    });
    for (const id of this.labelEls.keys()) if (!seen.has(id)) this.removeLabel(id);
  }

  bubbleText(agent, a, now) {
    const review = this.tasks.find((t) => t.agentId === agent.id && t.status === 'review');
    const failed = this.tasks.find((t) => t.agentId === agent.id && t.status === 'failed');
    if (agent.status === 'paused' && !a.moving) return { text: '⏸ En pausa', kind: 'review' };
    if (agent.status === 'working' || agent.status === 'paused') {
      if (a.moving) return { text: a.key === 'board' ? '🗂 Voy a la pizarra' : '→ A mi mesa', kind: '' };
      if (a.key === 'board') return { text: '🗂 Planificando…', kind: 'plan' };
      return { text: agent.activity ? '✏️ ' + agent.activity : 'Trabajando…', kind: '' };
    }
    if (failed && !a.moving) return { text: `⚠ #${failed.id} falló`, kind: 'error' };
    if (review && !a.moving) return { text: `✋ #${review.id} en revisión`, kind: 'review' };
    if (!a.moving && Math.floor(now / 2.4 + hash(agent.id)) % 5 === 0) return { text: '☕', kind: '' };
    return { text: null };
  }

  // ── Clic / hover ──────────────────────────────────────────────────────────────
  pickActor(e) {
    const r = this.cv.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const [id, a] of this.actors) {
      if (!a.group.visible) continue;
      const hit = this.raycaster.intersectObject(a.group, true);
      if (hit.length) return id;
    }
    return null;
  }

  onPointer(e, click) {
    const id = this.pickActor(e);
    if (click) { if (id) this.onAgentClick?.(id); }
    else this.cv.style.cursor = id ? 'pointer' : 'default';
  }

  // ── Encuadre / bucle ──────────────────────────────────────────────────────────
  resize() {
    const w = this.cv.clientWidth || 320, h = this.cv.clientHeight || 208;
    this.renderer.setSize(w, h, false);
    this.frameCamera(w / h);
    if (!this.running && this.renderer) this.renderer.render(this.scene, this.camera);
  }

  frameCamera(aspect) {
    const cam = this.camera;
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    const radius = Math.hypot(RX, WALL_H, RZ);
    cam.position.copy(CENTER).addScaledVector(dir, radius * 2);
    cam.up.set(0, 1, 0);
    cam.lookAt(CENTER);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const cx of [0, RX]) for (const cy of [0, WALL_H]) for (const cz of [0, RZ]) {
      const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    const margin = 1.08;
    let halfW = (maxX - minX) / 2 * margin, halfH = (maxY - minY) / 2 * margin;
    if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    cam.left = midX - halfW; cam.right = midX + halfW;
    cam.top = midY + halfH; cam.bottom = midY - halfH;
    cam.near = -maxZ - 5; cam.far = -minZ + 5;
    cam.updateProjectionMatrix();
  }

  frame() {
    const t = performance.now();
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.elapsed += dt;
    const now = this.elapsed;
    try {
      this.step(dt, now);
      this.updateLabels(now);
    } catch (err) { /* nunca romper el bucle de render */ }
    this.renderer.render(this.scene, this.camera);
  }
}

export { Office3D as Office };
