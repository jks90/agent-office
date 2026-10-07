// La oficina en 3D: escena low-poly isométrica con three.js y los assets Kenney (CC0).
// Misma API pública que la clase Office de office.js (constructor(canvas,{onAgentClick}), update(...)),
// para que app.js pueda elegir uno u otro sin más cambios.
//
// Dos modos (FT-46): `floor` (la sala del proyecto activo, con personajes) y `building` (el EDIFICIO:
// plantas abiertas por proyecto, con mini agentes visibles desde fuera y tarjetas de estado).
// `setMode(mode)` cambia entre ellos; `update()` acepta además {projects, allAgents, allTasks}.
// FT-47/FT-71: `setMode` hace una transición corta de cámara (≤ 400 ms, ninguna con prefers-reduced-motion), la planta
// del proyecto activo (`update({projectId})`) va resaltada en el edificio y el canvas se enfoca al hacer clic (Esc en app.js).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { layoutFloor, recommendedFloorSize, toVisualState } from './office-layout.js';
import { V3, pickLayout, zonesV3, layoutV3, routeV3, ambientPos } from './office-v3.js'; // FT-149: planta por zonas (oficina v3)

// ── Geometría de la sala (en unidades Kenney; los modelos son pequeños ≈ 0,7 m/u) ──
const RX = 13, RZ = 9, WALL_H = 1.29;
const CENTER = new THREE.Vector3(RX / 2, 0, RZ / 2);
const DEFAULT_FLOOR_SIZE = recommendedFloorSize(0);
const floorCenter = (size = DEFAULT_FLOOR_SIZE) => new THREE.Vector3(size.rx / 2, 0, size.rz / 2);
const doorFor = (size = DEFAULT_FLOOR_SIZE) => ({ x: Math.min(size.rx - 0.9, Math.max(0.8, size.rx * 0.58)), z: 0.5 });
const spineXFor = (size = DEFAULT_FLOOR_SIZE) => Math.min(size.rx - 1.0, Math.max(3.5, size.rx * 0.58));
const SPEED = 1.7;                    // unidades/s
const CHAR_H = 0.66;                  // altura objetivo del personaje (FT-78 v2: ~30 % menor que antes, proporción de la referencia)

// 8 mesas en 2 filas de 4, a la izquierda. El agente se sienta en el lado +z mirando al monitor (-z).
const DESK_COLS = [1.2, 2.8, 4.4, 6.0];
const DESK_ROWS = [2.3, 4.6];
const DESKS = [];
for (const z of DESK_ROWS) for (const x of DESK_COLS) DESKS.push({ x, z });
const seatOf = (d) => ({ x: d.x, z: d.z + 0.5, corr: d.z + 0.5 });

const BOARD_SPOTS = [{ x: 3.0, z: 1.1, corr: null }, { x: 4.2, z: 1.1, corr: null }];
const BOARD_LEGACY = { x: 4.15, y: 0.92, z: 0.09, w: 3.5, h: 1.25 };
const BOARD_V3 = { x: 12.4, y: 0.95, z: 3.55, w: 1.75, h: 0.92 }; // FT-149: tablero compacto de pie, de cara a la cámara
let BOARD = BOARD_LEGACY;
const hexInt = (s) => parseInt(String(s).replace('#', ''), 16); // FT-78 v2: Kanban grande, foco funcional

const BASE_ZONE_STYLE = {
  development: { label: 'Desarrollo', color: 0xd6c3ff, x: 1.9, z: 2.35, w: 3.2, d: 3.25, labelX: 0.75, labelZ: 0.75 },
  qa: { label: 'QA', color: 0xb8f0c4, x: 5.15, z: 2.35, w: 3.0, d: 3.25, labelX: 7.85, labelZ: 0.75 },
  docs: { label: 'Documentación', color: 0xb9ddff, x: 2.65, z: 4.85, w: 4.3, d: 1.25, labelX: 0.85, labelZ: 5.75 },
  review: { label: 'Revisión', color: 0xffd36b, x: 7.1, z: 4.25, w: 2.1, d: 2.4, labelX: 8.75, labelZ: 3.05 },
  meeting: { label: 'Reuniones', color: 0xffbbc1, x: 5.45, z: 5.1, w: 2.2, d: 1.0, labelX: 4.15, labelZ: 6.05 },
  idle: { label: 'Descanso', color: 0x9fd8c3, x: 7.45, z: 5.05, w: 1.25, d: 0.95, labelX: 8.85, labelZ: 5.95 },
  board: { label: 'Kanban', color: 0xc9d6df, x: 4.15, z: 1.0, w: 2.8, d: 1.25, labelX: 3.25, labelZ: 0.35 },
};

function zonesFor(size = DEFAULT_FLOOR_SIZE) {
  const extraX = Math.max(0, size.rx - DEFAULT_FLOOR_SIZE.rx);
  const extraZ = Math.max(0, size.rz - DEFAULT_FLOOR_SIZE.rz);
  const zones = {};
  for (const [id, z] of Object.entries(BASE_ZONE_STYLE)) {
    const right = ['qa', 'review', 'idle'].includes(id);
    const lower = ['docs', 'meeting', 'idle'].includes(id);
    zones[id] = {
      ...z,
      x: z.x + (right ? extraX : extraX * 0.35),
      z: z.z + (lower ? extraZ : extraZ * 0.25),
      labelX: z.labelX + (right ? extraX : extraX * 0.35),
      labelZ: z.labelZ + (lower ? extraZ : extraZ * 0.25),
      w: z.w + (id === 'development' || id === 'qa' ? extraX * 0.35 : id === 'docs' ? extraX * 0.55 : 0),
      d: z.d + (id === 'development' || id === 'qa' ? extraZ * 0.35 : 0),
    };
  }
  return zones;
}

// FT-124: «mi mesa». Iconos por tipo de aviso (mismos que 🔔 Para ti) en el orden del desglose de la burbuja.
const MINE_NONE = { total: 0, counts: {}, items: [] };
const MINE_ICON = [['question', '❓'], ['review', '✋'], ['cut', '⚠️'], ['failed', '❌'], ['manual', '👤'], ['quota', '⏸'], ['coord', '🧑‍✈️']];
const mineText = (m) => m.total ? `🔔 ${m.total} · ${MINE_ICON.filter(([k]) => m.counts[k]).map(([k, i]) => i + m.counts[k]).join(' ')}` : '✅ nada te espera';
// La mesa va en la franja libre a la derecha de QA (sigue a floorZones, así que se adapta al tamaño de la planta).
const deskSpot = (zones) => ({ x: zones.qa.x + zones.qa.w / 2 + 0.8, z: 1.7 });

const STATE_COLOR = {
  working: 0x2f80ed, waiting: 0xf6c744, reviewing: 0xef8f35,
  blocked: 0xd9a21b, failed: 0xe33b3b, idle: 0x94a3b8,
};

// Zona de descanso y sitios donde deambulan los que no trabajan.
const LOUNGE = [
  { x: 7.25, z: 5.05, sit: true }, { x: 7.8, z: 5.05, sit: true },
  { x: 7.5, z: 4.45 }, { x: 5.45, z: 5.1, sit: true },
];

// FT-148: solo los LIBRES pasean, y solo por descanso/recreo (café, nevera, planta, charla). Oficina viva: a dónde van los que no tienen tarea y qué hacen allí (gesto repetido y/o pose sujetando algo).
// `face`: hacia dónde miran al llegar (π = al fondo). Solo se quedan quietos si su motor no tiene cuota.
const WANDER_SPOTS = [
  { id: 'cafe', label: '☕ Café', x: 6.55, z: 1.05, face: Math.PI, gesture: 'interact-right', hold: 'holding-right', stay: [6, 10] },
  { id: 'nevera', label: '🥤 Nevera', x: 7.75, z: 1.15, face: Math.PI, gesture: 'interact-right', hold: 'holding-right', stay: [4, 7] },
  { id: 'planta', label: '🪴 Regando', x: 6.15, z: 4.05, face: Math.PI, gesture: 'interact-right', stay: [3, 6] },
  { id: 'charla', label: '💬 Charlando', x: 5.45, z: 4.55, face: 0, gesture: 'emote-yes', stay: [6, 11] },
];
const rand = (a, b) => a + Math.random() * (b - a);
// Brazos al frente (pose de «holding-both» de los Kenney): base del tecleo.
const ARM_FWD_L = new THREE.Quaternion(0, 0.5, 0, -0.866);
const ARM_FWD_R = new THREE.Quaternion(0, -0.5, 0, -0.866);
const BONES = ['torso', 'head', 'arm-left', 'arm-right'];

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const CHAR_FILES = [];
for (const g of ['female', 'male']) for (const l of ['a', 'b', 'c', 'd', 'e', 'f']) CHAR_FILES.push(`character-${g}-${l}`);

const MINT = 0x9fd8c3, WOOD = 0xd8b48a, SCREEN_ON = 0x8fe3c7, WALL_TINT = 0xe9f0e8;

// ── Edificio (FT-46): una planta por proyecto con equipo ──
const SLAB_H = 0.14;                         // losa entre plantas
// FT-77 v2 (fiel a la referencia): UN edificio — plantas alineadas en un solo eje, paredes más altas que en la sala para que
// el interior se vea por el frente abierto, y solo una losa fina entre plantas (18–30 px en 1920×1080).
const BWALL_H = 3.15;                        // altura de pared de una planta del edificio (FT-81: ≥170 px a 1920×1080; con 2,4 salían 141 px)
const FLOOR_GAP = 0.2;                       // aire entre plantas (losa vista ≥ 18 px)
const FLOOR_H = BWALL_H + SLAB_H + FLOOR_GAP; // altura de una planta (pared + losa + aire)
const FLOOR_Z_STEP = 0;                      // un único eje vertical (antes las plantas avanzaban en diagonal)
const BUILDING_CAM_DIR = [1, 0.62, 1];       // cámara algo más baja que la de la sala: se ve dentro de cada planta
const CORE_W = 1.35;                         // núcleo de escalera/ascensor a la derecha del edificio
const MAX_FLOORS = 12;                       // tope visual; el resto se agrupa en una planta «+N»
const FLOOR_BOX = [DEFAULT_FLOOR_SIZE.rx, WALL_H, DEFAULT_FLOOR_SIZE.rz]; // fallback de encuadre para `floor`
const BUILDING_FLOOR_SIZE = { kind: 'building', rx: 9.2, rz: 3.9 }; // v2: plantas anchas y poco profundas, como en la referencia (todo el interior a la vista)
const GUIDE_FLOOR_SIZE = { kind: 'guide', rx: 5.8, rz: 4.0 };
const WINDOW_ON = 0xffd36b, WALL_PAUSED = 0xd6dad6, SLAB_COLOR = 0xc9d2cc, INTERIOR = 0xf1e5d4, HOVER = 0x3ad0a0;
const HOVER_K = 0.22, ACTIVE_K = 0.1;            // intensidad del resalte: planta bajo el ratón / planta del proyecto activo (FT-47)
const CAM_MS = 380;                              // duración de la transición de cámara edificio ↔ planta (FT-47)
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Mobiliario estático: {model, x, z, ry(rad), tint(hex)}. Se apoya solo en el suelo (base y=0).
const FURNITURE = [
  // Descanso compacto dentro de su módulo; nada queda suelto fuera de las zonas (FT-69).
  { model: 'rugRectangle', x: 7.45, z: 5.05, ry: 0, tint: MINT },
  { model: 'loungeSofa', x: 7.45, z: 5.12, ry: Math.PI, tint: MINT },
  { model: 'tableCoffee', x: 7.45, z: 4.52, ry: 0, tint: WOOD },
  { model: 'pottedPlant', x: 7.95, z: 4.1, ry: 0 },
  { model: 'lampRoundFloor', x: 6.85, z: 5.15, ry: 0 },
  // Café y archivo pegados al kanban para rellenar el módulo central.
  { model: 'kitchenCabinet', x: 6.55, z: 0.55, ry: 0 },
  { model: 'kitchenCabinet', x: 7.1, z: 0.55, ry: 0 },
  { model: 'kitchenFridge', x: 7.75, z: 0.6, ry: 0 },
  // Estantería contra la pared del fondo
  { model: 'bookcaseOpen', x: 1.0, z: 0.45, ry: 0 },
  // Mesa de reuniones
  { model: 'tableRound', x: 5.45, z: 5.1, ry: 0, tint: WOOD },
  // Plantas y útiles dentro de módulos.
  { model: 'plantSmall1', x: 0.55, z: 4.75, ry: 0 },
  { model: 'plantSmall2', x: 3.25, z: 5.15, ry: 0 },
  { model: 'plantSmall3', x: 7.95, z: 2.95, ry: 0 },
  { model: 'trashcan', x: 3.35, z: 3.05, ry: 0 },
  { model: 'coatRackStanding', x: 5.95, z: 0.6, ry: 0 },
  // FT-78 v2: densidad de la referencia — estanterías contra la pared izquierda, plantas grandes en las esquinas de zona
  { model: 'bookcaseClosedWide', x: 0.3, z: 1.6, ry: Math.PI / 2 },
  { model: 'bookcaseClosed', x: 0.3, z: 2.75, ry: Math.PI / 2 },
  { model: 'bookcaseClosedWide', x: 0.3, z: 4.55, ry: Math.PI / 2 },
  { model: 'pottedPlant', x: 0.45, z: 0.45, ry: 0 },
  { model: 'pottedPlant', x: 3.3, z: 0.55, ry: 0 },
  { model: 'pottedPlant', x: 8.3, z: 0.6, ry: 0 },
  { model: 'pottedPlant', x: 0.45, z: 3.6, ry: 0 },
  { model: 'pottedPlant', x: 6.15, z: 3.65, ry: 0 },
  { model: 'sideTableDrawers', x: 4.35, z: 4.5, ry: 0, tint: WOOD },
];
// La cafetera va encima del primer armario (altura real se ajusta al cargar).
const ON_TOP = [{ model: 'kitchenCoffeeMachine', x: 6.55, z: 0.55, onModel: 'kitchenCabinet' }];
// Sillas de la mesa de reuniones
const MEETING_CHAIRS = [
  { model: 'chair', x: 5.45, z: 5.45, ry: Math.PI },
  { model: 'chair', x: 4.95, z: 5.1, ry: Math.PI / 2 },
  { model: 'chair', x: 5.95, z: 5.1, ry: -Math.PI / 2 },
];

const FURNITURE_NEEDED = new Set([
  'desk', 'chairDesk', 'computerScreen', 'computerKeyboard', 'computerMouse',
  'wall', 'wallWindow', 'wallDoorway',
  'bookcaseClosedWide', 'bookcaseClosed', 'plantSmall2', 'laptop', 'sideTableDrawers', 'lampSquareFloor', // FT-78 v2: densidad
  ...FURNITURE.map((f) => f.model), ...ON_TOP.map((f) => f.model), ...MEETING_CHAIRS.map((f) => f.model),
]);

const FURN_DIR = 'assets/3d/furniture/';
const CHAR_DIR = 'assets/3d/characters/';

export class Office3D {
  constructor(canvas, { onAgentClick, onFloorClick, onGuideClick, onMineClick } = {}) {
    this.cv = canvas;
    this.onMineClick = onMineClick;     // FT-124: clic en «mi mesa» o su burbuja → app.js abre 🔔 Para ti filtrado por (projectId)
    this.mine = MINE_NONE;              // FT-124: lo que espera al usuario en el proyecto activo (lo calcula app.js con inboxItems)
    this.mineByProject = {};
    this.waitOn = new Map();            // agentId → 'question' | 'review' (agentes que esperan al usuario)
    this.onAgentClick = onAgentClick;
    this.onGuideClick = onGuideClick;   // clic en la planta Dirección / Guía → app.js abre la pestaña del Guía
    this.onFloorClick = onFloorClick;   // clic en una planta del edificio → (projectId); app.js entra en esa planta (FT-47)
    this.agents = [];
    this.tasks = [];
    this.questions = [];
    this.roles = {};
    this.title = '';
    this.selected = null;
    this.actors = new Map();       // agentId → { group, mixer, actions, nav... }
    this.miniActors = [];          // muñecos del modo edificio (vivos, como los de la planta)
    this.bAnim = null;             // ascensor, árboles y sombrilla del edificio
    this.furnCache = new Map();    // nombre → gltf.scene (prototipo para clonar)
    this.charCache = new Map();    // nombre → gltf
    this.workstations = [];        // { x,z,screenMats[] }
    this.ready = false;
    this.boardSig = '';
    this.floorLayout = null;
    this.currentFloorSize = DEFAULT_FLOOR_SIZE;
    this.floorZones = zonesFor(this.currentFloorSize);
    this.v3 = null;                // FT-149: contrato de planta activo (null = planta heredada, >8 agentes)
    this.furnSig = '';
    this.visualAgents = [];
    this.hoverActor = null;
    // Modo edificio (FT-46)
    this.mode = 'floor';
    this.projects = []; this.allAgents = []; this.allTasks = [];
    this.floors = [];              // [{projectId, name, working, queued, review, running, agents, grouped?}]
    this.floorsSig = '';
    this.floorGroups = [];         // Group por planta, con userData {mats[], label}
    this.hoverFloor = -1;
    this.activeProjectId = null;   // proyecto del desplegable: su planta va resaltada en el edificio (FT-47)
    this.camAnim = null;           // transición de cámara en curso {from, to, t0} (FT-47)
    this.camCenter = floorCenter(this.currentFloorSize);
    this.officeLevel = 'floor';     // FT-71: building → floor → agent en una sola escena.
    this.metrics = { frames: 0, fps: 0, fpsT0: performance.now(), lastRebuildMs: 0, lastFloorCount: 0 };
    canvas.dataset.officeMode = 'floor';
    canvas.dataset.officeLevel = 'floor';
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;   // enfocable: Esc con el canvas enfocado vuelve al edificio (FT-47, en app.js)

    canvas.style.imageRendering = 'auto';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf1f5f0);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 200);
    this.setupLights();
    // Todo lo de la sala cuelga de `room` y lo del edificio de `building`: cambiar de modo es ocultar uno y enseñar el otro.
    this.room = new THREE.Group();
    this.building = new THREE.Group();
    this.building.visible = false;
    this.scene.add(this.room, this.building);
    this.rebuildFloorGeometry();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    canvas.addEventListener('pointerdown', (e) => this.onPointer(e, true));
    canvas.addEventListener('pointermove', (e) => this.onPointer(e, false));
    canvas.addEventListener('keydown', (e) => this.onKey(e));

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
    dir.shadow.mapSize.set(1024, 1024);
    const s = Math.max(RX, RZ) * 0.7;
    const sc = dir.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = 0.5; sc.far = 40;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.02;
    this.scene.add(dir, dir.target);
  }

  buildFloor() {
    const size = this.currentFloorSize || DEFAULT_FLOOR_SIZE;
    const geo = new THREE.PlaneGeometry(size.rx, size.rz);
    const mat = new THREE.MeshStandardMaterial({ color: this.v3 ? hexInt(V3.palette.floor) : 0xf4efe6, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(size.rx / 2, 0, size.rz / 2);
    floor.receiveShadow = true;
    this.room.add(floor);
  }

  buildZones() {
    this.zoneLabels = [];
    // FT-78 v2: casi alfombras (opacidad 13 %) con un borde fino del color de la zona, como en la referencia
    const rugMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.94, metalness: 0, transparent: true, opacity: 0.13, depthWrite: false });
    if (this.v3) return this.buildZonesV3();
    for (const [zone, z] of Object.entries(this.floorZones || zonesFor(this.currentFloorSize))) {
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(z.w, z.d), rugMat(z.color));
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(z.x, 0.012, z.z);
      rug.receiveShadow = true;
      this.room.add(rug);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(z.w, z.d)), new THREE.LineBasicMaterial({ color: z.color, transparent: true, opacity: 0.85 }));
      edge.rotation.x = -Math.PI / 2; edge.position.set(z.x, 0.016, z.z); this.room.add(edge);
      if (zone === 'development' || zone === 'qa' || zone === 'review') {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(z.w, 0.18, 0.06),
          new THREE.MeshStandardMaterial({ color: 0xc9d2cc, roughness: 0.9 }));
        rail.position.set(z.x, 0.1, z.z - z.d / 2);
        rail.castShadow = true;
        this.room.add(rail);
      }
    }
  }

  // ── FT-149 · Oficina v3: planta por zonas (docs/oficina-v3/planta.md) ──────────────────────
  // Entrada de los que llegan: la puerta de recepción del contrato; en la planta heredada, la puerta de siempre.
  entryPoint() {
    const d = this.v3?.anchors.find((a) => a.id === 'reception-door');
    return d ? { x: d.x, z: d.z - 0.3 } : doorFor(this.currentFloorSize);
  }

  // Rótulos permanentes: uno por zona del contrato activo (se recrean solo si cambia el conjunto de zonas).
  syncZoneLabels() {
    if (!this.labelRoot) return;
    const ids = Object.keys(this.floorZones || {});
    if (ids.join() === this.zoneSig) return;
    this.zoneSig = ids.join();
    for (const { el } of this.zoneLabelEls || []) el.remove();
    this.zoneLabelEls = ids.map((id) => {
      const el = document.createElement('div');
      el.className = 'o3d-el o3d-zone';
      el.textContent = this.floorZones[id].label;
      el.dataset.zone = id;
      this.labelRoot.appendChild(el);
      return { id, el };
    });
  }

  // Suelo de cada zona con su material (moqueta/baldosa/madera) y borde del color del TIPO de zona (el estado no pinta suelo).
  buildZonesV3() {
    this.zoneLabels = [];
    const css = (n) => '#' + n.toString(16).padStart(6, '0');
    const mkTex = (kind, fill, accent, w, d) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = fill; g.fillRect(0, 0, 64, 64);
      g.strokeStyle = accent; g.globalAlpha = 0.22; g.lineWidth = 1;
      const step = kind === 'tile' ? 32 : kind === 'wood' ? 16 : 8;
      for (let i = 0; i <= 64; i += step) {
        if (kind !== 'wood') { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); }
        g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke();
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(w, d); tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const strip = (w, d, x, z, color, y) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, y, z); this.room.add(m);
    };
    const border = (z, inset, t) => {
      const w = z.w - inset * 2, d = z.d - inset * 2;
      strip(w, t, z.x, z.z - d / 2 + t / 2, z.color, 0.022); strip(w, t, z.x, z.z + d / 2 - t / 2, z.color, 0.022);
      strip(t, d, z.x - w / 2 + t / 2, z.z, z.color, 0.022); strip(t, d, z.x + w / 2 - t / 2, z.z, z.color, 0.022);
    };
    for (const z of Object.values(this.floorZones)) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(z.w, z.d),
        new THREE.MeshStandardMaterial({ map: mkTex(z.floor, css(z.fill), css(z.color), z.w, z.d), roughness: 0.95, metalness: 0 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(z.x, 0.012, z.z); floor.receiveShadow = true;
      this.room.add(floor);
      border(z, 0.02, 0.06);
      if (z.type === 'user' || z.paletteOverride) border(z, 0.14, 0.05); // «Tú»: borde doble dorado
    }
  }

  // Paredes bajas (0,8 u) solo en el fondo y a la izquierda; frente y derecha abiertos a la cámara. Sala de reuniones acristalada.
  buildWallsV3(size) {
    const col = hexInt(V3.palette.floor);
    const wall = (w, h, d, x, z, color, opts = {}) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts }));
      m.position.set(x, h / 2, z); m.castShadow = !opts.transparent; this.room.add(m);
    };
    wall(size.rx, 0.8, 0.12, size.rx / 2, -0.06, WALL_TINT);
    wall(0.12, 0.8, size.rz, -0.06, size.rz / 2, WALL_TINT);
    const mz = this.floorZones.meeting, door = this.v3.anchors.find((a) => a.id === 'meeting-door');
    if (!mz) return;
    const glass = { color: hexInt(V3.palette.glass), transparent: true, opacity: 0.3, depthWrite: false };
    const zF = mz.z + mz.d / 2, x0 = mz.x - mz.w / 2, x1 = mz.x + mz.w / 2, g0 = door.x - door.w / 2, g1 = door.x + door.w / 2;
    wall(g0 - x0, 0.55, 0.05, (x0 + g0) / 2, zF, 0, glass);
    if (x1 > g1) wall(x1 - g1, 0.55, 0.05, (g1 + x1) / 2, zF, 0, glass);
    wall(0.05, 0.55, mz.d, x1, mz.z, 0, glass);
  }

  buildFurnitureV3() {
    const A = this.v3.anchors, get = (id) => A.find((a) => a.id === id);
    const box = (w, h, d, c, x, z, y = 0, ry = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
      m.position.set(x, y + h / 2, z); m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true; this.room.add(m); return m;
    };
    const WOODC = hexInt(V3.palette.wood);
    // Despacho del PO: mesa propia, monitor y silla (vacío salvo que haya un PO real).
    const pd = get('po-desk'), pc = get('po-chair');
    const desk = this.place('desk', pd.x, pd.z, { ry: 0 });
    if (desk) { const top = this.topOf(desk); const s = this.place('computerScreen', pd.x, pd.z - 0.1, { ry: 0 }); if (s) s.position.y = top; }
    this.place('chairDesk', pc.x, pc.z, { ry: 0 });
    // Reuniones: mesa y cuatro sillas.
    const mt = get('meeting-table');
    if (mt) {
      box(mt.w, 0.06, mt.d, WOODC, mt.x, mt.z, 0.42);
      box(0.12, 0.42, 0.12, 0x8a6a45, mt.x, mt.z);
      for (const c of A.filter((a) => a.id.startsWith('meeting-chair'))) this.place('chairDesk', c.x, c.z, { ry: c.rotationY });
    }
    // Café / descanso: mostrador con máquina, mesa con silla y sofá de dos plazas.
    const cc = get('coffee-counter'), cm = get('coffee-machine'), ct = get('cafe-table'), cch = get('cafe-chair');
    if (cc) box(cc.w, 0.45, cc.d, WOODC, cc.x, cc.z);
    if (cm) { const m = this.place('kitchenCoffeeMachine', cm.x, cm.z, { ry: Math.PI }); if (m) m.position.y = 0.45; }
    if (ct) { box(ct.w, 0.05, ct.d, WOODC, ct.x, ct.z, 0.4); box(0.1, 0.4, 0.1, 0x8a6a45, ct.x, ct.z); }
    if (cch) this.place('chairDesk', cch.x, cch.z + 0.55, { ry: 0 });
    for (const id of ['idle-sofa', 'recreation-sofa']) { const s = get(id); if (s) this.place('loungeSofa', s.x, s.z, { ry: Math.PI, tint: hexInt(V3.palette.rest.accent) }); }
    // Recreo: futbolín (tablero verde, laterales de madera, barras).
    const fb = get('foosball');
    if (fb) {
      const g = new THREE.Group(); g.position.set(fb.x, 0, fb.z); g.rotation.y = fb.rotationY; this.room.add(g);
      const add = (w, h, d, c, y, x = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })); m.position.set(x, y + h / 2, z); m.castShadow = true; g.add(m); };
      add(fb.w, 0.08, fb.d, 0x2f7d5b, 0.38); add(fb.w, 0.14, 0.06, WOODC, 0.38, 0, fb.d / 2 - 0.03); add(fb.w, 0.14, 0.06, WOODC, 0.38, 0, -fb.d / 2 + 0.03);
      add(0.06, 0.14, fb.d, WOODC, 0.38, fb.w / 2 - 0.03); add(0.06, 0.14, fb.d, WOODC, 0.38, -fb.w / 2 + 0.03);
      for (const lx of [-0.4, 0, 0.4]) add(0.04, 0.04, fb.d + 0.3, 0xb0b8c0, 0.54, lx);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0.08, 0.38, 0.08, 0x8a6a45, 0, sx * (fb.w / 2 - 0.1), sz * (fb.d / 2 - 0.1));
    }
    // Recepción: mostrador y felpudo en la puerta; plantas solo en bordes.
    const rc = get('reception-counter'), em = get('entry-mat');
    if (rc) box(rc.w, 0.5, rc.d, WOODC, rc.x, rc.z);
    if (em) box(em.w, 0.02, em.d, 0x6b5a45, em.x, em.z);
    this.place('pottedPlant', 0.5, this.v3.floor.rz - 0.5, { ry: 0 });
    this.place('pottedPlant', this.v3.floor.rx - 0.5, this.floorZones.board.z - this.floorZones.board.d / 2 - 0.4, { ry: 0 });
    // Tablero Kanban: pie central bajo el panel.
    box(0.08, BOARD.y - BOARD.h / 2, 0.08, 0x8a6a45, BOARD.x - BOARD.w / 2 + 0.15, BOARD.z);
    box(0.08, BOARD.y - BOARD.h / 2, 0.08, 0x8a6a45, BOARD.x + BOARD.w / 2 - 0.15, BOARD.z);
  }

  // Personajes de AMBIENTE (visita y limpieza): decorativos, no son agentes ni cuentan en nada; gris rayado + rombo + rótulo AMBIENTE.
  syncAmbient() {
    for (const o of this.ambientChars || []) { o.el.remove(); }
    this.ambientChars = [];
    if (!this.v3 || !this.labelRoot) return;
    const cv = document.createElement('canvas'); cv.width = cv.height = 16;
    const g = cv.getContext('2d');
    g.fillStyle = V3.palette.ambient.fill; g.fillRect(0, 0, 16, 16);
    g.strokeStyle = V3.palette.ambient.outline; g.lineWidth = 3;
    for (const k of [-16, 0, 16]) { g.beginPath(); g.moveTo(k, 16); g.lineTo(k + 16, 0); g.stroke(); }
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, 3);
    for (const ch of V3.ambient.characters) {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.4, 14), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
      body.position.y = 0.3; body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), new THREE.MeshStandardMaterial({ color: hexInt(V3.palette.ambient.fill), roughness: 0.9 }));
      head.position.y = 0.6;
      const mark = new THREE.Mesh(new THREE.OctahedronGeometry(0.1), new THREE.MeshBasicMaterial({ color: hexInt(V3.palette.ambient.outline) }));
      mark.position.y = 0.86; mark.scale.y = 1.4;
      grp.add(body, head, mark);
      this.room.add(grp);
      const el = document.createElement('div'); el.className = 'o3d-el o3d-ambient'; el.textContent = ch.label;
      this.labelRoot.appendChild(el);
      this.ambientChars.push({ ch, grp, el });
    }
  }

  updateAmbient(now) {
    const still = reducedMotion();
    for (const o of this.ambientChars || []) {
      const p = ambientPos(this.v3, o.ch, now, still);
      o.grp.position.set(p.x, still ? 0 : Math.abs(Math.sin(now * 6)) * 0.03, p.z);
      o.grp.rotation.y = p.ang;
      const s = this.project(p.x, 1.15, p.z);
      o.el.style.left = s.x + 'px'; o.el.style.top = s.y + 'px'; o.el.style.opacity = s.visible ? '1' : '0';
    }
  }

  // Leyenda plegable (interruptor): tipo de suelo = tipo de zona; indicador del agente = estado; ambiente aparte.
  buildLegend() {
    const P = V3.palette, st = P.states;
    const sw = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'o3d-legend-btn'; btn.textContent = '🗺 Leyenda'; btn.setAttribute('aria-expanded', 'false');
    const box = document.createElement('div'); box.className = 'o3d-legend'; box.hidden = true;
    box.innerHTML = `<b>El color del suelo es el TIPO de zona; el indicador del agente es su ESTADO</b><div>`
      + sw(P.work.fill, 'Trabajo · QA · reuniones') + sw(P.waiting.fill, 'Kanban / espera · recepción') + sw(P.rest.fill, 'Café · recreo')
      + sw(P.key.fill, 'PO · despacho') + sw(P.user.fill, 'Tú · avisos') + '</div><div>'
      + sw(st.working, 'trabajando') + sw(st.waiting, 'en cola') + sw(st.reviewing, 'revisando') + sw(st.blocked, 'bloqueado') + sw(st.failed, 'fallo') + sw(st.idle, 'libre')
      + '</div><small>◇ AMBIENTE (gris rayado): visita y limpieza, solo decorativos; no cuentan como equipo.</small>';
    const on = (v) => { box.hidden = !v; btn.setAttribute('aria-expanded', String(v)); try { localStorage.setItem('ao.office.legend', v ? '1' : '0'); } catch { /* sin almacenamiento */ } };
    btn.addEventListener('click', () => on(box.hidden));
    let saved = false; try { saved = localStorage.getItem('ao.office.legend') === '1'; } catch { /* sin almacenamiento */ }
    on(saved);
    this.wrap.append(btn, box);
    this.legendEls = [btn, box];
  }

  // FT-124: la mesa del usuario («Tú»): tablero, avatar naranja (distinto de los agentes) y la pila de papeles de sus avisos.
  buildMyDesk() {
    const ua = this.v3?.anchors.find((a) => a.id === 'user-desk');
    const s = ua ? { x: ua.x, z: ua.z } : deskSpot(this.floorZones || zonesFor(this.currentFloorSize));
    const dw = ua ? ua.w : 1.1; // FT-149: la mesa «Tú» es más ancha que las demás (1,85 u)
    this.deskPos = s;
    const g = new THREE.Group();
    const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
    const box = (w, h, d, c, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c)); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    box(dw, 0.06, 0.6, 0xb98a5a, s.x, 0.42, s.z);
    box(0.06, 0.4, 0.55, 0x8a6a45, s.x - dw / 2 + 0.05, 0.2, s.z);
    box(0.06, 0.4, 0.55, 0x8a6a45, s.x + dw / 2 - 0.05, 0.2, s.z);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.4, 14), mat(0xff7a1a)); body.position.set(s.x, 0.32, s.z - 0.55); body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), mat(0xffd7b0)); head.position.set(s.x, 0.62, s.z - 0.55); g.add(head);
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 4), mat(0xffc400)); hat.position.set(s.x, 0.82, s.z - 0.55); g.add(hat); // corona: «el jefe»
    this.deskPapers = new THREE.Group(); this.deskPapers.position.set(s.x - 0.25, 0.45, s.z + 0.02); g.add(this.deskPapers);
    this.deskN = -1;
    this.room.add(g);
    this.syncDeskPapers();
  }

  // Pila de papeles proporcional a los avisos (máx. 14 hojas, ligeramente desordenadas).
  syncDeskPapers() {
    const n = Math.min(14, this.mine?.total || 0);
    if (!this.deskPapers || n === this.deskN) return;
    this.deskN = n;
    this.deskPapers.clear();
    for (let i = 0; i < n; i++) {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.22), new THREE.MeshStandardMaterial({ color: i % 3 ? 0xffffff : 0xfff3c4, roughness: 0.9 }));
      sheet.position.set(((i * 7) % 5 - 2) * 0.008, 0.007 + i * 0.013, ((i * 3) % 5 - 2) * 0.008);
      sheet.rotation.y = ((i * 5) % 7 - 3) * 0.05;
      this.deskPapers.add(sheet);
    }
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
    this.room.add(frame, panel);
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
      const count = this.tasks.filter((t) => status === 'todo' ? t.status === 'todo' : t.status === status).length;
      ctx.fillStyle = color; ctx.font = '800 48px system-ui, sans-serif';
      ctx.fillText(String(count), cx + 14, 64);
      ctx.fillStyle = '#64748b'; ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillText(status.toUpperCase(), cx + 16, 112);
      const list = this.tasks.filter((t) => t.status === status || (status === 'todo' && t.status === 'failed'));
      list.slice(0, 8).forEach((t, k) => {
        const sx = cx + 10 + (k % 2) * (cw / 2 - 4), sy = 138 + Math.floor(k / 2) * 30;
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
      this.rebuildFloorGeometry();
      this.ready = true;
      this.rebuildFloors();        // si ya estamos en modo edificio, ahora que hay paredes que clonar
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

  // `parent` (por defecto la sala) permite colocar el mismo mueble en una planta del edificio (FT-46).
  place(name, x, z, opts = {}, parent = this.room) {
    const obj = this.instance(name, opts);
    if (!obj) return null;
    obj.position.x = x; obj.position.z = z;
    parent.add(obj);
    return obj;
  }

  topOf(obj) { return new THREE.Box3().setFromObject(obj).max.y; }

  buildWalls() {
    const size = this.currentFloorSize || DEFAULT_FLOOR_SIZE;
    if (this.v3) return this.buildWallsV3(size);
    const door = doorFor(size);
    const wallBox = this.furnCache.get('wall') && new THREE.Box3().setFromObject(this.furnCache.get('wall'));
    const seg = wallBox ? Math.max(0.5, wallBox.getSize(new THREE.Vector3()).x) : 1;
    // Pared del fondo (z=0), a lo largo de x. Con una ventana y una puerta.
    const nBack = Math.ceil(size.rx / seg);
    for (let i = 0; i < nBack; i++) {
      const x = i * seg + seg / 2;
      let model = 'wall';
      if (i === 1 || i === Math.max(2, nBack - 2)) model = 'wallWindow';
      if (i === Math.floor(door.x / seg)) model = 'wallDoorway';
      this.place(model, Math.min(x, size.rx - seg / 2), 0, { ry: 0, tint: model === 'wall' ? WALL_TINT : undefined });
    }
    // Pared izquierda (x=0), a lo largo de z, girada 90°.
    const nLeft = Math.ceil(size.rz / seg);
    for (let i = 0; i < nLeft; i++) {
      const z = i * seg + seg / 2;
      const model = (i === 2 || i === Math.max(3, nLeft - 2)) ? 'wallWindow' : 'wall';
      this.place(model, 0, Math.min(z, size.rz - seg / 2), { ry: Math.PI / 2, tint: model === 'wall' ? WALL_TINT : undefined });
    }
  }

  rebuildFloorGeometry() {
    this.room.clear();
    this.workstations = [];
    this.v3 = this.currentFloorSize.v3 ? V3.layouts.find((l) => l.id === this.currentFloorSize.v3) : null;
    BOARD = this.v3 ? BOARD_V3 : BOARD_LEGACY;
    this.floorZones = this.v3 ? zonesV3(this.v3) : zonesFor(this.currentFloorSize);
    this.syncZoneLabels();
    this.syncAmbient();
    this.buildFloor();
    this.buildZones();
    this.buildBoard();
    this.buildMyDesk();
    if (this.furnCache.size) {
      this.buildWalls();
      this.buildWorkstations();
      this.buildFurniture();
      if (this.v3) this.buildFurnitureV3();
    }
  }

  buildWorkstations() {
    const list = this.v3 ? (this.floorLayout?.usedDesks || []).map(({ desk }) => ({ x: desk.x, z: desk.z })) : DESKS;
    list.forEach((d) => {
      const desk = this.place('desk', d.x, d.z, { ry: 0 });
      if (!desk) return;
      const top = this.topOf(desk);
      const screen = this.place('computerScreen', d.x - 0.16, d.z - 0.11, { ry: 0.22 });
      const screen2 = this.place('computerScreen', d.x + 0.2, d.z - 0.1, { ry: -0.28 }); // FT-78 v2: doble monitor
      if (screen2) screen2.position.y = top;
      const kb = this.place('computerKeyboard', d.x, d.z + 0.04, { ry: 0 });
      const mouse = this.place('computerMouse', d.x + 0.22, d.z + 0.05, { ry: 0 });
      for (const o of [screen, kb, mouse]) if (o) o.position.y = top;
      // Silla del escritorio, el agente se sienta encima mirando al monitor (-z).
      this.place('chairDesk', d.x, d.z + (this.v3 ? 0.55 : 0.5), { ry: 0 });
      // Materiales de la pantalla, para encenderla cuando se trabaja.
      const screenMats = [];
      if (screen) screen.traverse((m) => {
        if (m.isMesh) { const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const mt of mats) { mt.emissive && screenMats.push(mt); } }
      });
      this.workstations.push({ x: d.x, z: d.z, screenMats });
    });
  }

  buildFurniture() {
    if (this.v3) return;
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
  // `agents`/`tasks` son los del proyecto activo (modo `floor`); `projects`/`allAgents`/`allTasks`, todo el
  // estado, para el edificio (modo `building`, FT-46). Si no llegan, se conservan los últimos.
  // `projectId` (FT-47) es el proyecto activo del desplegable: en el edificio su planta va resaltada.
  update({ agents, tasks, questions, roles, title, selected, projects, allAgents, allTasks, projectId, quota, bubbles, mine, mineByProject }) {
    if (bubbles !== undefined) this.bubbleMode = bubbles === 'al pasar' ? 'al pasar' : 'todas'; // FT-123
    if (mine !== undefined) { // FT-124
      this.mine = mine || MINE_NONE;
      this.waitOn = new Map();
      for (const i of this.mine.items || []) if (i.agentId && !this.waitOn.has(i.agentId)) this.waitOn.set(i.agentId, i.kind === 'question' ? 'question' : 'review');
    }
    if (mineByProject !== undefined) this.mineByProject = mineByProject || {};
    if (quota !== undefined) this.quota = quota || {};
    this.agents = agents || [];
    this.tasks = tasks || [];
    this.questions = questions || [];
    this.roles = roles || {};
    this.title = title || '';
    this.selected = selected;
    if (projects) this.projects = projects;
    if (allAgents) this.allAgents = allAgents;
    if (allTasks) this.allTasks = allTasks;
    const activeChanged = projectId !== undefined && projectId !== this.activeProjectId;
    if (projectId !== undefined) this.activeProjectId = projectId || null;
    for (const [id, a] of this.actors) if (!this.agents.some((g) => g.id === id)) { this.scene.remove(a.group); this.actors.delete(id); this.removeLabel(id); }
    this.visualAgents = this.agents.map((a) => toVisualState(a, this.tasks, this.questions));
    const lay3 = pickLayout(this.visualAgents.length);
    if (lay3) this.floorLayout = layoutV3(this.visualAgents, new Map(this.agents.map((a) => [a.id, a.role])), lay3, this.floorLayout);
    else this.floorLayout = layoutFloor(this.visualAgents, { tasks: this.tasks, questions: this.questions }, this.floorLayout);
    const nextSize = this.floorLayout?.size || recommendedFloorSize(this.visualAgents.length);
    const sig3 = this.floorLayout?.sig || '';
    if (nextSize.kind !== this.currentFloorSize.kind || sig3 !== this.furnSig) {
      this.furnSig = sig3;
      this.currentFloorSize = nextSize;
      this.rebuildFloorGeometry();
      if (this.mode === 'floor') this.resize();
    } else this.currentFloorSize = nextSize;
    const sig = JSON.stringify(this.tasks.map((t) => [t.id, t.status, t.updatedAt]));
    if (sig !== this.boardSig) { this.boardSig = sig; this.drawBoard(); }
    this.syncDeskPapers();
    this.rebuildFloors();
    if (activeChanged) this.refreshFloorTint();
  }

  // ── Modo edificio (FT-46) ────────────────────────────────────────────────────
  // Cambiar de modo es ocultar un grupo y enseñar el otro, y llevar la cámara del encuadre viejo al nuevo con una
  // transición corta (FT-47; ninguna si el usuario prefiere menos movimiento o aún no corre el bucle de render).
  setMode(mode) {
    mode = mode === 'building' ? 'building' : 'floor';
    if (mode === this.mode) return;
    const from = this.captureFrame();
    this.mode = mode;
    if (mode === 'building') this.selected = null;
    this.officeLevel = mode;
    this.cv.dataset.officeMode = mode;
    this.cv.dataset.officeLevel = mode;
    const b = mode === 'building';
    this.room.visible = !b;
    this.building.visible = b;
    this.labelRoot.classList.toggle('building', b);   // el CSS esconde las etiquetas que no son del modo
    // Los personajes y sus etiquetas solo viven en la sala; step() los vuelve a enseñar al volver a `floor`.
    for (const a of this.actors.values()) if (b) a.group.visible = false;
    if (b) { for (const id of [...this.labelEls.keys()]) this.removeLabel(id); this.boardLabel.style.opacity = '0'; }
    this.setHover(-1);
    this.cv.style.cursor = 'default';
    this.floorsSig = '';
    this.camAnim = null;
    this.rebuildFloors();
    this.resize();
    if (this.running && !reducedMotion()) this.camAnim = { from, to: this.captureFrame(), t0: performance.now() };
  }

  focusAgent(id) {
    if (!id) return;
    const from = this.captureFrame();
    if (this.mode !== 'floor') {
      this.mode = 'floor';
      this.cv.dataset.officeMode = 'floor';
      this.room.visible = true;
      this.building.visible = false;
      this.labelRoot?.classList.toggle('building', false);
      this.floorsSig = '';
    }
    this.selected = id;
    this.officeLevel = 'agent';
    this.cv.dataset.officeLevel = 'agent';
    this.setHover(-1);
    this.resize();
    if (this.running && !reducedMotion()) this.camAnim = { from, to: this.captureFrame(), t0: performance.now() };
  }

  clearAgentFocus() {
    if (this.officeLevel !== 'agent' && !this.selected) return;
    const from = this.captureFrame();
    this.selected = null;
    this.officeLevel = this.mode;
    this.cv.dataset.officeLevel = this.officeLevel;
    this.resize();
    if (this.running && !reducedMotion()) this.camAnim = { from, to: this.captureFrame(), t0: performance.now() };
  }

  guideFloor() {
    const qs = this.questions || [];
    const conversing = qs.length > 0;
    const po = this.allAgents.find((a) => /po|product|manager|lead|guide/i.test(a.role || '') || /po\b|product owner/i.test(a.name || ''));
    return {
      projectId: null, name: 'Dirección / Guía', agents: po ? 2 : 1,
      working: conversing ? 1 : 0, queued: 0, review: qs.length, failed: 0, running: true,
      guide: { status: conversing ? 'conversando' : 'escuchando', po: po ? { id: po.id, name: po.name || 'PO', role: po.role || 'po' } : null },
    };
  }

  // Plantas del edificio: proyectos con equipo, de más antiguo (planta baja) a más nuevo (arriba), más Dirección/Guía arriba (FT-70).
  computeFloors() {
    const maxProjectFloors = Math.max(1, MAX_FLOORS - 1);
    const list = this.projects
      .map((p) => { const ids = new Set(p.team || []); return { p, team: this.allAgents.filter((a) => ids.has(a.id)) }; })
      .filter(({ p, team }) => (p.team || []).length > 0 || team.length > 0)
      .sort((a, b) => (a.p.createdAt || 0) - (b.p.createdAt || 0))
      .map(({ p, team }) => {
        const ts = this.allTasks.filter((t) => t.projectId === p.id);
        const visual = team.map((a) => toVisualState(a, ts, this.questions));
        return {
          projectId: p.id, name: p.name || '', agents: team.length, team,
          miniAgents: visual.slice(0, 12),
          working: visual.filter((a) => a.status === 'working').length,
          queued: ts.filter((t) => t.status === 'todo').length,
          review: ts.filter((t) => t.status === 'review').length,
          failed: ts.filter((t) => t.status === 'failed').length,
          running: !!p.running,
          mine: this.mineByProject?.[p.id] || 0, // FT-124: avisos 🔔 que esperan al usuario en esta planta
        };
      });
    if (list.length > maxProjectFloors) {
      const rest = list.splice(maxProjectFloors - 1);
      const sum = (k) => rest.reduce((n, f) => n + f[k], 0);
      list.push({ projectId: null, name: `+${rest.length} proyectos`, agents: sum('agents'), working: sum('working'),
        queued: sum('queued'), review: sum('review'), failed: sum('failed'), running: rest.some((f) => f.running), grouped: rest.length, miniAgents: [] });
    }
    list.push(this.guideFloor());
    return list;
  }

  // Reconstruye las plantas solo si cambia su firma (lista de proyectos con equipo + contadores), nunca por frame.
  rebuildFloors() {
    if (this.mode !== 'building' || !this.ready) return;
    const t0 = performance.now();
    const floors = this.computeFloors();
    const sig = JSON.stringify(floors);
    if (sig === this.floorsSig) return;
    const before = this.floors.length;
    this.floorsSig = sig;
    this.floors = floors;
    this.clearBuilding();
    floors.forEach((f, i) => this.buildFloorBlock(f, i));
    this.buildStructure(floors.length);
    this.metrics.lastRebuildMs = +(performance.now() - t0).toFixed(1);
    this.metrics.lastFloorCount = floors.length;
    if (floors.length !== before) this.resize();   // la caja a encuadrar cambia de altura
    this.refreshFloorTint();
    this.updateFloorLabels();
  }

  clearBuilding() {
    this.building.traverse((m) => {
      if (!m.isMesh) return;
      for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) mt?.dispose?.();
      if (m.userData.ownGeo) m.geometry.dispose();     // las geometrías de los clones son del prototipo: no se tocan
    });
    this.building.clear();
    this.miniActors = []; this.bAnim = null;
    for (const g of this.floorGroups) g.userData.label?.remove();
    this.floorGroups = [];
    this.hoverFloor = -1;
  }

  // Estructura común del edificio (FT-77 v2, panel 1 de la referencia): núcleo de escalera/ascensor a la derecha, azotea con
  // pretil, sombrilla y plantas, y planta baja con zócalo, árboles y un aparcamiento. No es clicable (sin index) ni cambia de tinte.
  buildStructure(n) {
    if (!n) return;
    const s = BUILDING_FLOOR_SIZE, H = n * FLOOR_H;
    const grp = new THREE.Group(); grp.userData = { structure: true };
    const box = (w, h, d, color, x, y, z, rough = 0.9) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: rough })); m.userData.ownGeo = true; m.position.set(x, y, z); grp.add(m); return m; };
    // Núcleo (fachada lateral con ventanas en franja)
    box(CORE_W, H + 0.5, s.rz * 0.4, 0xb9c2c9, s.rx + CORE_W / 2, (H + 0.5) / 2, s.rz * 0.2); // al fondo: no tapa el extremo de las plantas
    for (let k = 0; k < n; k++) box(0.04, 0.5, s.rz * 0.3, 0x5b6c7a, s.rx + CORE_W + 0.02, k * FLOOR_H + SLAB_H + BWALL_H * 0.55, s.rz * 0.2, 0.4);
    // Ascensor panorámico en la cara del núcleo que mira a la cámara: guía + cabina iluminada que va de planta en planta
    const liftX = s.rx + CORE_W / 2, liftZ = s.rz * 0.4 + 0.1;
    box(0.06, H + 0.4, 0.06, 0x64748b, liftX - 0.34, (H + 0.4) / 2, liftZ - 0.04, 0.5);
    box(0.06, H + 0.4, 0.06, 0x64748b, liftX + 0.34, (H + 0.4) / 2, liftZ - 0.04, 0.5);
    const cabin = box(0.6, 0.78, 0.18, 0xfef3c7, liftX, SLAB_H + 0.42, liftZ, 0.3);
    cabin.material.emissive = new THREE.Color(0xfbbf24); cabin.material.emissiveIntensity = 0.55;
    this.bAnim = { cabin, n, floorH: FLOOR_H, base: SLAB_H + 0.42, floor: 0, target: 0, wait: 2, crowns: [], umb: null };
    // Azotea: losa, pretil y terraza
    const roofY = H;
    box(s.rx + 0.3, SLAB_H, s.rz + 0.3, 0xc9d2cc, s.rx / 2, roofY + SLAB_H / 2, s.rz / 2);
    for (const [w, d, x, z] of [[s.rx + 0.3, 0.12, s.rx / 2, -0.09], [s.rx + 0.3, 0.12, s.rx / 2, s.rz + 0.09], [0.12, s.rz + 0.3, -0.09, s.rz / 2], [0.12, s.rz + 0.3, s.rx + 0.09, s.rz / 2]]) box(w, 0.3, d, 0xaeb7b1, x, roofY + SLAB_H + 0.15, z);
    const pole = box(0.05, 1.0, 0.05, 0x6b7280, s.rx * 0.62, roofY + SLAB_H + 0.5, s.rz * 0.5);
    const umb = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.32, 10), new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.8 })); umb.userData.ownGeo = true; umb.position.set(pole.position.x, roofY + SLAB_H + 1.05, pole.position.z); grp.add(umb); this.bAnim.umb = umb;
    this.building.add(grp);
    for (const [m, x, z, ry] of [['tableRound', s.rx * 0.62, s.rz * 0.5, 0], ['chair', s.rx * 0.62, s.rz * 0.5 + 0.7, Math.PI], ['chair', s.rx * 0.62 - 0.7, s.rz * 0.5, Math.PI / 2], ['pottedPlant', 0.6, 0.6, 0], ['pottedPlant', s.rx - 0.6, s.rz - 0.6, 0], ['loungeSofa', 2.0, s.rz * 0.55, Math.PI, MINT]]) {
      const o = this.place(m, x, z, { ry, tint: m === 'loungeSofa' ? MINT : undefined }, grp); if (o) o.position.y += roofY + SLAB_H;
    }
    // Planta baja: zócalo, acera, árboles y aparcamiento delante a la derecha
    box(s.rx + CORE_W + 3.2, 0.12, s.rz + 3.2, 0xb8c4b0, (s.rx + CORE_W) / 2, -0.07, s.rz / 2 + 0.6);
    box(3.6, 0.04, 2.6, 0x6b7280, s.rx + CORE_W + 0.2, 0.0, s.rz + 1.4, 0.95);
    for (const [x, z, c] of [[s.rx + CORE_W - 0.6, s.rz + 1.0, 0xdc2626], [s.rx + CORE_W + 0.9, s.rz + 1.7, 0xe5e7eb]]) { box(1.05, 0.32, 0.55, c, x, 0.2, z, 0.5); box(0.6, 0.22, 0.5, 0x94a3b8, x - 0.05, 0.47, z, 0.3); }
    for (const [x, z] of [[-0.9, s.rz + 0.9], [-0.9, 1.0], [s.rx * 0.45, s.rz + 1.3]]) {
      const tr = box(0.14, 0.7, 0.14, 0x8b5a2b, x, 0.35, z); const crown = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), new THREE.MeshStandardMaterial({ color: 0x4f9d5d, roughness: 0.9 })); crown.userData.ownGeo = true; crown.position.set(x, 1.0, z); grp.add(crown); void tr; this.bAnim.crowns.push(crown);
    }
  }

  wallSeg() {
    const proto = this.furnCache.get('wall');
    return proto ? Math.max(0.5, new THREE.Box3().setFromObject(proto).getSize(new THREE.Vector3()).x) : 1;
  }

  buildingFloorSize(f) {
    return BUILDING_FLOOR_SIZE; // v2: mismo tamaño y eje para todas (Dirección incluida)
  }

  // Muebles reales (Kenney) en la planta del edificio, en la misma escala que la oficina: Desarrollo al fondo, QA a la derecha,
  // Kanban en la pared del fondo, reuniones y descanso delante (FT-77 v2, como el panel 1 de la referencia).
  static BLDG = {
    dev: [[1.0, 1.2], [2.2, 1.2], [3.4, 1.2], [1.0, 2.5], [2.2, 2.5]],
    qa: [[7.05, 1.2], [8.2, 1.2]],
    review: [6.95, 2.55], board: [5.15, 2.0], meeting: [3.55, 3.05], sofa: [8.45, 3.35], wait: [[4.6, 2.75], [5.2, 2.75], [5.8, 2.75]],
  };
  placeIn(g, model, x, z, opts = {}) {
    const o = this.place(model, x, z, opts, g);
    if (o) { o.position.y += SLAB_H; o.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } }); }
    return o;
  }
  addMiniFurniture(g, i, f, own, size = BUILDING_FLOOR_SIZE) {
    const B = Office3D.BLDG, y = SLAB_H;
    const screens = [];
    const desk = ([x, z], lit) => {
      const d = this.placeIn(g, 'desk', x, z); if (!d) return;
      const top = this.topOf(d);
      const sc = this.placeIn(g, 'computerScreen', x, z - 0.11); if (sc) { sc.position.y = top; sc.traverse((m) => { if (m.isMesh && lit) for (const mt of [].concat(m.material)) if (mt.emissive) screens.push(mt); }); }
      const kb = this.placeIn(g, 'computerKeyboard', x, z + 0.04); if (kb) kb.position.y = top;
      this.placeIn(g, 'chairDesk', x, z + 0.5);
    };
    const nDesks = Math.min(B.dev.length + B.qa.length, Math.max(4, f.agents + 1));
    [...B.dev, ...B.qa].slice(0, nDesks).forEach((p, k) => desk(p, k < f.working));
    for (const mt of screens) { mt.emissive.setHex(SCREEN_ON); mt.emissiveIntensity = 0.8; }
    // Kanban en la pared del fondo con columnas de color y contadores reales (TODO · DOING · REVIEW · DONE)
    const [bx, bz] = B.board;
    // Exenta y baja: con la cámara del edificio la losa de arriba tapa la pared del fondo (FT-77 v2)
    const BY = 0.78;
    const frame = own(new THREE.BoxGeometry(2.0, 0.78, 0.06), new THREE.MeshStandardMaterial({ color: 0x2f3a45, roughness: 0.6 })); frame.position.set(bx, y + BY, bz); g.add(frame);
    for (const lx of [-0.9, 0.9]) { const leg = own(new THREE.BoxGeometry(0.05, BY, 0.05), new THREE.MeshStandardMaterial({ color: 0x475569 })); leg.position.set(bx + lx, y + BY / 2, bz); g.add(leg); }
    const cols = [0x93c5fd, 0xfcd34d, 0xfdba74, 0x86efac];
    const counts = [f.queued, f.working, f.review, f.done || 0];
    cols.forEach((c, k) => {
      const panel = own(new THREE.BoxGeometry(0.42, 0.64, 0.02), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.8 })); panel.position.set(bx - 0.72 + k * 0.48, y + BY, bz + 0.04); g.add(panel);
      const head = own(new THREE.BoxGeometry(0.42, 0.09, 0.025), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25 })); head.position.set(bx - 0.72 + k * 0.48, y + BY + 0.27, bz + 0.05); g.add(head);
      for (let n = 0; n < Math.min(3, counts[k]); n++) { const note = own(new THREE.BoxGeometry(0.3, 0.1, 0.02), new THREE.MeshStandardMaterial({ color: c })); note.position.set(bx - 0.72 + k * 0.48, y + BY + 0.12 - n * 0.14, bz + 0.06); g.add(note); }
    });
    // Revisión (puesto con lupa), reuniones, descanso y decoración
    desk(B.review, false);
    this.placeIn(g, 'tableRound', B.meeting[0], B.meeting[1], { tint: WOOD });
    for (const [dx, dz, ry] of [[0, 0.7, Math.PI], [-0.7, 0, Math.PI / 2], [0.7, 0, -Math.PI / 2]]) this.placeIn(g, 'chair', B.meeting[0] + dx, B.meeting[1] + dz, { ry });
    this.placeIn(g, 'loungeSofa', B.sofa[0], B.sofa[1], { ry: Math.PI, tint: MINT });
    this.placeIn(g, 'tableCoffee', B.sofa[0], B.sofa[1] - 0.7, { tint: WOOD });
    this.placeIn(g, 'bookcaseOpen', 0.4, 3.2, { ry: Math.PI / 2 });
    for (const [x, z, m] of [[0.45, 0.4, 'pottedPlant'], [6.6, 0.35, 'plantSmall1'], [size.rx - 0.45, 1.9, 'pottedPlant'], [3.0, 3.45, 'plantSmall3']]) this.placeIn(g, m, x, z);
    if (f.guide) { this.placeIn(g, 'kitchenCabinet', 8.6, 2.2, { ry: -Math.PI / 2 }); }
  }

  // Personaje real en miniatura, posado (sentado al PC, de pie…) sin animarlo cada frame: el mixer se avanza una vez.
  addMiniChar(g, visual, x, z, ry, own, sit) {
    const file = CHAR_FILES[hash((visual.name || '') + visual.id) % CHAR_FILES.length];
    const gltf = this.charCache.get(file);
    if (!gltf) return this.addMiniAgent(g, visual, x, z, own, 0.9);
    const model = skeletonClone(gltf.scene);
    const box = new THREE.Box3().setFromObject(model);
    const sc = (CHAR_H * 1.32) / (box.getSize(new THREE.Vector3()).y || 1); // en el edificio se mantiene la escala de FT-77 v2
    model.scale.setScalar(sc);
    model.position.set(x, SLAB_H - box.min.y * sc + (sit ? 0.05 : 0), z);
    model.rotation.y = ry;
    model.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
    const mixer = new THREE.AnimationMixer(model);
    const clip = gltf.animations.find((c) => c.name === (sit ? 'sit' : 'idle')) || gltf.animations[0];
    if (clip) { mixer.clipAction(clip).play(); mixer.update(0.4); }
    g.add(model);
    // Vivo como en la planta (teclear, respirar, mirar, gestos); quieto solo si su motor no tiene cuota
    const a = { mixer, actions: {}, current: clip ? mixer.clipAction(clip) : null, clip: clip?.name || null, bones: {}, sitSpot: !!sit, moving: false,
      phase: Math.random() * 10, nextGesture: Math.random() * 6, emote: null, wander: null, visual, base: clip?.name || null,
      amp: 1.8, model, home: { x, z, ry, sit: !!sit, y: model.position.y }, standY: SLAB_H - box.min.y * sc, dot: null, ring: null,
      walk: null, nextWalk: 3 + Math.random() * 8 };
    for (const c of gltf.animations) { const act = mixer.clipAction(c); if (/^emote|^pick-up|^jump|^interact/.test(c.name)) { act.loop = THREE.LoopOnce; act.clampWhenFinished = true; } a.actions[c.name] = act; }
    for (const n of BONES) { const b = model.getObjectByName(n); if (b) a.bones[n] = { b, rest: b.quaternion.clone() }; }
    this.miniActors.push(a);
    // Indicador de estado sobre la cabeza (verde trabajando, amarillo esperando, violeta revisión, rojo fallo…)
    const col = STATE_COLOR[visual.status] || 0x94a3b8;
    const dot = own(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: col }));
    dot.position.set(x, SLAB_H + CHAR_H * 1.32 + 0.18, z); g.add(dot);
    if (this.miniActors.at(-1)?.model === model) this.miniActors.at(-1).dot = dot;
    if (visual.status === 'failed') { const ring = own(new THREE.TorusGeometry(0.13, 0.025, 6, 16), new THREE.MeshBasicMaterial({ color: 0xff3030 })); ring.rotation.x = Math.PI / 2; ring.position.copy(dot.position); g.add(ring); }
  }

  addMiniAgent(g, visual, x, z, own, scale = 1) {
    const col = STATE_COLOR[visual.status] || 0x64748b;
    const body = own(new THREE.CapsuleGeometry(0.13 * scale, 0.28 * scale, 4, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.72 }));
    body.position.set(x, SLAB_H + 0.35 * scale, z); body.rotation.y = Math.PI; g.add(body);
    const head = own(new THREE.SphereGeometry(0.12 * scale, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.8 }));
    head.position.set(x, SLAB_H + 0.65 * scale, z); g.add(head);
  }

  // Cada agente va donde dice su estado (como en la planta): trabajando → su puesto (sentado), revisión → puesto de revisión,
  // esperando/bloqueado → de pie junto al Kanban, fallido → su puesto con aro rojo, libre → zona de descanso.
  addMiniAgents(g, f, own, size = BUILDING_FLOOR_SIZE) {
    const B = Office3D.BLDG;
    const desks = [...B.dev, ...B.qa];
    let d = 0, w = 0, idle = 0;
    (f.miniAgents || []).forEach((a) => {
      let x, z, ry = Math.PI, sit = false;
      if (a.status === 'working' || a.status === 'failed') { const p = desks[d++ % desks.length]; x = p[0]; z = p[1] + 0.5; sit = a.status === 'working'; }
      else if (a.status === 'reviewing') { x = B.review[0]; z = B.review[1] + 0.5; sit = true; }
      else if (a.status === 'waiting' || a.status === 'blocked') { const p = B.wait[w++ % B.wait.length]; x = p[0]; z = p[1] + 0.35; }
      else { x = B.sofa[0] - 0.55 + (idle % 3) * 0.55; z = B.sofa[1] + 0.05; ry = Math.PI; sit = idle < 3; idle++; }
      this.addMiniChar(g, a, x, z, ry, own, sit);
      g.userData.agentMarks.push({ id: a.id, name: a.name, status: a.status, role: a.role, x, y: SLAB_H + 0.55, z });
    });
  }

  addGuideFloor(g, f, own, size = BUILDING_FLOOR_SIZE) {
    this.addMiniFurniture(g, 0, { ...f, agents: 2, working: f.guide?.status === 'conversando' ? 1 : 0 }, own, size);
    this.addMiniChar(g, { id: 'guide', name: 'Guía', status: f.guide?.status === 'conversando' ? 'working' : 'idle' }, Office3D.BLDG.dev[0][0], Office3D.BLDG.dev[0][1] + 0.5, Math.PI, own, true);
    if (f.guide?.po) this.addMiniChar(g, { id: 'po', name: 'PO', status: 'reviewing' }, Office3D.BLDG.review[0], Office3D.BLDG.review[1] + 0.5, Math.PI, own, true);
  }

  // Una planta = losa + suelo claro + paredes de fondo/izquierda; frontal y derecha quedan abiertas (FT-70).
  buildFloorBlock(f, i) {
    const g = new THREE.Group();
    const size = this.buildingFloorSize(f);
    g.position.y = i * FLOOR_H;
    g.position.x = 0;
    g.position.z = (this.floors.length - 1 - i) * FLOOR_Z_STEP; // 0: todas en el mismo eje (FT-77 v2)
    g.userData = { index: i, mats: [], label: null, size, agentMarks: [] };
    const own = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.userData.ownGeo = true; g.userData.mats.push(mat); return m; };
    const slab = own(new THREE.BoxGeometry(size.rx + 0.3, SLAB_H, size.rz + 0.3), new THREE.MeshStandardMaterial({ color: SLAB_COLOR, roughness: 0.9 }));
    slab.position.set(size.rx / 2, SLAB_H / 2, size.rz / 2);
    g.add(slab);
    const inner = own(new THREE.BoxGeometry(size.rx - 0.1, 0.05, size.rz - 0.1), new THREE.MeshStandardMaterial({ color: f.guide ? 0xe9f4ee : INTERIOR, roughness: 1 }));
    inner.position.set(size.rx / 2, SLAB_H + 0.025, size.rz / 2);
    g.add(inner);
    const seg = this.wallSeg();
    const tint = f.running ? WALL_TINT : WALL_PAUSED;
    const glass = [];
    const addWall = (model, x, z, ry) => {
      const obj = this.place(model, x, z, { ry, tint: model === 'wall' ? tint : undefined }, g);
      if (!obj) return;
      obj.position.y = SLAB_H;
      obj.scale.y *= BWALL_H / WALL_H; // paredes más altas que en la sala: interior visible por el frente abierto (v2)
      obj.traverse((m) => {
        if (!m.isMesh) return;
        m.castShadow = false; m.receiveShadow = false;   // cientos de paredes: sin sombras
        for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) (mt.name === 'glass' ? glass : g.userData.mats).push(mt);
      });
    };
    // Solo fondo (z=0) e izquierda (x=0): frontal y derecha quedan abiertas hacia cámara.
    const nFront = Math.ceil(size.rx / seg), nSide = Math.ceil(size.rz / seg);
    for (let k = 0; k < nFront; k++) addWall(k % 2 ? 'wallWindow' : 'wall', Math.min(k * seg + seg / 2, size.rx - seg / 2), 0, Math.PI);
    for (let k = 0; k < nSide; k++) addWall(k % 2 ? 'wallWindow' : 'wall', 0, Math.min(k * seg + seg / 2, size.rz - seg / 2), -Math.PI / 2);
    // Ventanas encendidas (como las pantallas): tantas como agentes trabajando, repartidas por la fachada.
    const lit = Math.min(f.working, glass.length);
    const stride = lit ? glass.length / lit : 0;
    const on = new Set(); for (let k = 0; k < lit; k++) on.add(Math.floor(k * stride));
    glass.forEach((mt, k) => {
      if (on.has(k)) { mt.color.setHex(WINDOW_ON); mt.emissive.setHex(WINDOW_ON); mt.emissiveIntensity = 1.3; mt.transparent = false; mt.opacity = 1; }
      else { mt.color.setHex(0x5b6c7a); mt.emissive.setHex(0x000000); mt.emissiveIntensity = 0; }
    });
    if (f.guide) this.addGuideFloor(g, f, own, size);
    else { this.addMiniFurniture(g, i, f, own, size); this.addMiniAgents(g, f, own, size); }
    // Pilar en la esquina abierta (frente-derecha): ayuda a leer el conjunto como UN edificio (v2)
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xd9dfe3, roughness: 0.85 });
    const pillar = own(new THREE.BoxGeometry(0.22, BWALL_H, 0.22), pillarMat); pillar.position.set(size.rx - 0.11, SLAB_H + BWALL_H / 2, size.rz - 0.11); g.add(pillar);
    this.building.add(g);
    this.floorGroups.push(g);
    // Etiqueta HTML de la planta (como las de los personajes), a la derecha del edificio.
    const el = document.createElement('div');
    el.className = 'o3d-el o3d-floor' + (f.projectId ? '' : ' grouped') + (f.guide ? ' guide' : '');
    const parts = f.guide ? [`${f.guide.status}`, `${f.review} decisiones`] : [`${f.working} trabajando`, `${f.queued} en cola`, `${f.review} en revisión`, `${f.failed} fallidos`];
    // Tarjeta tipo referencia: «P3» + nombre y, debajo, las métricas con su punto de color (FT-77 v2)
    const esc2 = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const line2 = f.guide ? `<span class="m"><i style="background:#34d399"></i>${esc2(f.guide.status)} · ${f.review} decisiones</span>`
      : `<span class="m"><i style="background:#34d399"></i>${f.working} trabajando · ${f.queued} en cola</span>${f.review ? `<span class="m"><i style="background:#fbbf24"></i>${f.review} en revisión</span>` : ''}${f.failed ? `<span class="m bad"><i style="background:#f87171"></i>${f.failed} fallidos</span>` : ''}`;
    el.innerHTML = `<b class="pn">P${i + 1}</b><span class="body"><span class="n">${f.running ? '' : '⏸ '}${esc2(f.name)}</span>${line2}</span>${f.mine ? `<b class="mine" title="Te esperan ${f.mine} cosas en este proyecto">${f.mine}</b>` : ''}`;
    el.title = `${f.running ? '' : '⏸ '}${f.name} · ${parts.join(' · ')}`; // texto completo (lo usan el tooltip y las pruebas)
    el.dataset.floor = String(i);
    if (f.projectId) el.dataset.projectId = f.projectId;
    this.labelRoot.appendChild(el);
    g.userData.label = el;
  }

  updateFloorLabels() {
    for (const g of this.floorGroups) {
      const el = g.userData.label;
      if (!el) continue;
      // Esquina derecha abierta: con la cámara en (1,1,1) es el punto más a la derecha en pantalla.
      const size = g.userData.size || BUILDING_FLOOR_SIZE;
      const p = this.project(g.position.x + size.rx + CORE_W + 0.4, g.position.y + SLAB_H + BWALL_H * 0.5, g.position.z + size.rz * 0.2);
      // Si la etiqueta no cabe a la derecha del edificio (lienzo estrecho, texto largo), se pega al borde del lienzo (FT-48).
      const w = el.offsetWidth || 0, cw = this.cv.clientWidth || 0;
      el.style.left = (cw && p.x + w + 8 > cw ? Math.max(8, cw - 8 - w) : p.x) + 'px';
      el.style.top = p.y + 'px';
      el.style.opacity = p.visible ? '1' : '0';
      el.classList.toggle('hover', g.userData.index === this.hoverFloor);
      el.classList.toggle('active', this.isActiveFloor(g.userData.index));
    }
  }

  isActiveFloor(i) { const f = this.floors[i]; return !!(f?.projectId && f.projectId === this.activeProjectId); }

  // Resalte de las plantas: la que está bajo el ratón (fuerte) y la del proyecto activo (suave) (FT-47).
  refreshFloorTint() {
    this.floorGroups.forEach((g, i) => {
      const k = i === this.hoverFloor ? HOVER_K : this.isActiveFloor(i) ? ACTIVE_K : 0;
      for (const mt of g.userData.mats) if (mt.emissive) { mt.emissive.setHex(k ? HOVER : 0x000000); mt.emissiveIntensity = k; }
      g.userData.label?.classList.toggle('active', this.isActiveFloor(i));
    });
  }

  setHover(i) {
    if (i === this.hoverFloor) return;
    this.hoverFloor = i;
    this.refreshFloorTint();
  }

  pickFloor(e) {
    const r = this.cv.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.building, true)[0];
    let o = hit?.object;
    while (o && o.parent !== this.building) o = o.parent;
    return o ? o.userData.index : -1;
  }

  // Rectángulo de la planta `i` en pantalla (px del viewport): caja envolvente de su grupo proyectada con la cámara (FT-48).
  floorScreenRect(i) {
    const full = this.floorFullScreenRect(i);
    const g = this.floorGroups[i];
    if (!full || !g) return null;
    const size = g.userData.size || BUILDING_FLOOR_SIZE;
    const cy = this.project(g.position.x + size.rx / 2, g.position.y + SLAB_H + BWALL_H / 2, g.position.z + size.rz / 2).y;
    const h = Math.min(full.h, Math.max(42, (this.cv.clientHeight || 480) / Math.max(10, this.floors.length * 3.2)));
    return { x: full.x, y: cy - h / 2, w: full.w, h };
  }

  floorFullScreenRect(i) {
    const g = this.floorGroups[i];
    if (!g) return null;
    this.camera.updateMatrixWorld();
    g.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(g), r = this.cv.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const v = new THREE.Vector3(x, y, z).project(this.camera);
      const px = r.left + (v.x + 1) / 2 * r.width, py = r.top + (1 - v.y) / 2 * r.height;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  buildingAgentVisibility(i) {
    const g = this.floorGroups[i];
    if (!g) return [];
    const cv = this.cv.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    this.building.updateWorldMatrix(true, true);
    return (g.userData.agentMarks || []).map((a) => {
      const world = new THREE.Vector3(a.x, a.y, a.z).applyMatrix4(g.matrixWorld);
      const ndc = world.clone().project(this.camera);
      const screen = { x: cv.left + (ndc.x + 1) / 2 * cv.width, y: cv.top + (1 - ndc.y) / 2 * cv.height };
      const fullRect = this.floorFullScreenRect(i);
      const inRect = !!fullRect && screen.x >= fullRect.x && screen.x <= fullRect.x + fullRect.w && screen.y >= fullRect.y && screen.y <= fullRect.y + fullRect.h;
      // Cámara ortográfica: los rayos de visión son PARALELOS a la dirección de vista (no salen de camera.position). Se lanza el
      // rayo desde «delante» del agente hacia él con esa dirección (corregido en FT-77 v2, con la cámara más baja del edificio).
      const vd = new THREE.Vector3(); this.camera.getWorldDirection(vd);
      const back = 60, origin = world.clone().addScaledVector(vd, -back);
      this.raycaster.set(origin, vd);
      const hit = this.raycaster.intersectObject(this.building, true).find((h) => h.distance < back - 0.05 && this.floorAncestor(h.object) !== g);
      return { ...a, screen, inRect, clearSight: !hit, blockedBy: hit ? this.floorAncestor(hit.object)?.userData.index ?? null : null };
    });
  }

  floorAncestor(o) {
    while (o && o.parent !== this.building) o = o.parent;
    return o || null;
  }

  // Para QA: `canvas.dataset.officeMode` y este resumen de lo que se pinta.
  debugState() {
    const slots = {};
    for (const v of this.visualAgents) {
      const s = this.floorLayout?.slots?.[v.id];
      const a = this.actors.get(v.id);
      if (s) slots[v.id] = { zone: s.zone, module: s.module, slot: s.index, x: s.x, z: s.z, status: v.status, key: a?.key || null, moving: !!a?.moving, ax: a ? +a.x.toFixed(2) : null, az: a ? +a.z.toFixed(2) : null, sit: !!a?.sitSpot, wander: a?.wander?.id || null };
    }
    const tu = {}; // FT-148: los que esperan al usuario no tienen slot de planta
    for (const [id] of this.waitOn || []) { const a = this.actors.get(id); if (a) tu[id] = { ax: +a.x.toFixed(2), az: +a.z.toFixed(2), moving: !!a.moving, key: a.key }; }
    return {
      deskPos: this.deskPos ? { x: this.deskPos.x, z: this.deskPos.z } : null, waiting: tu,
      mode: this.mode, officeLevel: this.officeLevel, selectedAgentId: this.selected || null, activeProjectId: this.activeProjectId, hoverFloor: this.hoverFloor, hoverActor: this.hoverActor, animating: !!this.camAnim,
      camera: { center: { x: +this.camCenter.x.toFixed(3), y: +this.camCenter.y.toFixed(3), z: +this.camCenter.z.toFixed(3) }, span: +(this.camera.top - this.camera.bottom).toFixed(3) },
      actors: this.actors.size,
      metrics: { fps: this.metrics.fps, lastRebuildMs: this.metrics.lastRebuildMs, lastFloorCount: this.metrics.lastFloorCount },
      zones: Object.fromEntries(Object.entries(this.floorZones || {}).map(([id, z]) => [id, { label: z.label, x: z.x, z: z.z, w: z.w, d: z.d }])),
      slots,
      floorSize: this.floorLayout?.size || null,
      floors: this.floors.map(({ projectId, name, working, queued, review, failed, running, guide, miniAgents }, i) => ({
        projectId, name, working, queued, review, failed, running,
        guide: guide || null,
        visibleAgents: this.mode === 'building' ? this.buildingAgentVisibility(i) : (miniAgents?.map((a) => ({ id: a.id, name: a.name, status: a.status, role: a.role })) || []),
        screen: this.mode === 'building' ? this.floorScreenRect(i) : null,
      })),
    };
  }

  // ── Personajes ──────────────────────────────────────────────────────────────
  spawnActor(agent, index, now) {
    const file = CHAR_FILES[hash(agent.name + agent.id) % CHAR_FILES.length];
    const gltf = this.charCache.get(file);
    const group = new THREE.Group();
    const a = {
      group, x: this.entryPoint().x, z: this.entryPoint().z, corr: null, path: [], key: null, moving: false,
      loungeSpot: index, enterAt: now + this.queuedCount(now) * 0.9, nextWander: Infinity,
      angle: Math.PI, targetAngle: Math.PI, mixer: null, actions: {}, clip: null, current: null,
      emote: null, lastEmote: null, sitSpot: false,
      wander: null, nextGesture: 0, phase: Math.random() * 10, bones: null,
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
      a.bones = {};
      for (const n of BONES) { const b = model.getObjectByName(n); if (b) a.bones[n] = { b, rest: b.quaternion.clone() }; }
    }
    // Disco del color del rol bajo los pies.
    const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
    const col = new THREE.Color(STATE_COLOR[visual.status] || this.roles[agent.role]?.color || '#888');
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
    const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
    // FT-148: si espera al usuario (❓/✋), junto a la mesa «Tú» (hueco según su orden entre los que esperan).
    if (this.waitOn?.has(agent.id) && this.deskPos) {
      const k = [...this.waitOn.keys()].sort().indexOf(agent.id);
      return { key: 'tu:' + k, zone: 'tu', x: this.deskPos.x - 0.6 + (k % 3) * 0.6, z: this.deskPos.z + 0.75 + Math.floor(k / 3) * 0.5, corr: null, sit: false, status: visual.status };
    }
    const w = visual.status === 'idle' ? a?.wander : null; // FT-148: los paseos son solo de los libres
    if (w) return { key: 'wander:' + w.id, zone: 'wander', x: w.x, z: w.z, corr: null, sit: false, status: visual.status };
    const s = this.floorLayout?.slots?.[agent.id];
    if (s) return {
      key: `${s.zone}:${s.module}:${s.index}:${visual.status}`,
      zone: s.zone, x: s.x, z: s.z, corr: s.z,
      sit: ['development', 'qa', 'docs', 'review', 'meeting', 'po', 'idle'].includes(s.zone) && visual.status !== 'waiting',
      status: visual.status,
    };
    const spot = a?.loungeSpot ?? index;
    const l = LOUNGE[spot % LOUNGE.length];
    return { key: 'lounge' + (spot % LOUNGE.length), zone: 'idle', x: l.x, z: l.z, corr: null, sit: !!l.sit, status: visual.status };
  }

  route(c, t) {
    if (this.v3) {
      // FT-149: por los pasillos del contrato; el recién llegado (sin dest) sale de recepción por el pasillo sur
      const from = c.dest ? { ...c.dest, x: c.x, z: c.dest.z } : { zone: 'reception', x: c.x, z: c.z };
      return routeV3(this.v3, from, t);
    }
    const pts = [];
    const za = c.corr ?? c.z;
    const zb = t.corr ?? t.z;
    if (c.corr != null) pts.push({ x: c.x, z: za });
    const spineX = spineXFor(this.currentFloorSize);
    if (Math.abs(c.x - t.x) > 0.05 || Math.abs(za - zb) > 0.05) pts.push({ x: spineX, z: za }, { x: spineX, z: zb }, { x: t.x, z: zb });
    if (t.corr != null) pts.push({ x: t.x, z: t.z });
    return pts;
  }

  // ¿Puede moverse? Solo se quedan quietos si su motor no tiene cuota (o la tarea espera por cuota) o si están en pausa.
  hasFuel(agent, visual) {
    if (agent.status === 'paused' || agent.quotaPaused || agent.quotaBlocked) return false;
    const task = visual.taskId && this.tasks.find((t) => t.id === visual.taskId);
    if (task && (task.quotaPaused || task.quotaBlocked)) return false;
    const engine = agent.activeEngine || agent.engine;
    const out = (e) => !!this.quota?.[e]?.limitReached;
    if (engine === 'auto') return !(out('claude') && out('codex'));
    return !out(engine);
  }

  // Los que no tienen tarea dan vueltas por la oficina: café, libros, kanban, charla…
  planWander(agent, a, visual, fuel, now) {
    if (this.v3 || visual.status !== 'idle' || !fuel) { a.wander = null; a.nextWander = Infinity; return; }
    if (a.nextWander === Infinity) a.nextWander = now + rand(2, 9);
    const w = a.wander;
    if (w) {
      if (!a.moving && a.key === 'wander:' + w.id && w.until == null) { w.until = now + rand(...w.stay); a.targetAngle = w.face; a.nextGesture = now + 0.3; }
      if (w.until != null && now > w.until) { a.wander = null; a.nextWander = now + rand(7, 16); }
      return;
    }
    if (a.moving || now < a.nextWander) return;
    const busy = new Set([...this.actors.values()].map((o) => o.wander?.id).filter(Boolean));
    const free = WANDER_SPOTS.filter((s) => !busy.has(s.id) && s.id !== a.lastWander);
    if (!free.length) { a.nextWander = now + rand(4, 8); return; }
    const s = free[Math.floor(Math.random() * free.length)];
    a.wander = { ...s, until: null };
    a.lastWander = s.id;
  }

  step(dt, now) {
    // Al montar la vista o cambiar de proyecto no hay nadie: cada uno aparece ya en su sitio, sin «entrar a trabajar».
    const fresh = this.actors.size === 0;
    this.agents.forEach((agent, i) => {
      let a = this.actors.get(agent.id);
      if (!a) {
        a = this.spawnActor(agent, i, now);
        if (fresh) {
          const t0 = this.targetFor(agent, i, a);
          Object.assign(a, { x: t0.x, z: t0.z, key: t0.key, dest: t0, corr: t0.corr, sitSpot: !!t0.sit, enterAt: now, path: [] });
          if (t0.sit) a.angle = a.targetAngle = Math.PI;
        }
      }
      if (now < a.enterAt) { a.group.visible = false; return; }
      a.group.visible = true;

      const vis0 = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
      a.fuel = this.hasFuel(agent, vis0);
      this.planWander(agent, a, vis0, a.fuel, now);

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
        else if (a.wander && a.key === 'wander:' + a.wander.id) a.targetAngle = a.wander.face;
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

      const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
      // Posición y giro.
      let y = 0;
      if (a.sitSpot && !a.moving && ['working', 'reviewing', 'blocked'].includes(visual.status)) y = 0.2;
      else if (a.sitSpot && !a.moving) y = 0.24;
      a.group.position.set(a.x, y, a.z);
      let da = a.targetAngle - a.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      a.angle += da * Math.min(1, dt * 10);
      a.group.rotation.y = a.angle;

      // Color del disco (más intenso si seleccionado).
      if (a.disc) {
        a.disc.material.color.setHex(STATE_COLOR[visual.status] || 0x888888);
        a.disc.material.opacity = this.selected === agent.id || visual.status === 'failed' ? 0.95 : 0.58;
      }

      // Animación: clip del estado y, encima, movimiento procedural de huesos (respirar, mirar, teclear).
      this.scheduleGesture(a, visual, now);
      this.playClip(a, this.chooseClip(a, agent, now));
      if (a.bones) for (const { b, rest } of Object.values(a.bones)) b.quaternion.copy(rest);
      if (a.mixer) a.mixer.update(dt);
      this.livePose(a, visual, now);

      // Encender la pantalla de su mesa cuando trabaja sentado.
      // (el encendido se resuelve abajo en refreshScreens)
      a._ws = (visual.status === 'working' && !a.moving) ? this.nearestWorkstation(a.x, a.z) : -1;
    });
    this.refreshScreens();
  }

  // Modo edificio: los muñecos hacen lo mismo que en la planta (sin desplazarse) y el edificio respira: ascensor, árboles, sombrilla.
  stepBuilding(dt, now) {
    if (reducedMotion()) return;
    for (const a of this.miniActors) {
      const v = a.visual;
      a.fuel = !this.quota?.[v.tool]?.limitReached;
      this.miniWalk(a, v, dt, now);
      this.scheduleGesture(a, v, now);
      const rest = a.moving ? 'walk' : a.sitSpot ? 'sit' : 'idle';
      const name = a.emote && now < a.emote.until && a.actions[a.emote.name] ? a.emote.name : (a.actions[rest] ? rest : a.base);
      if (name && a.clip !== name) this.playClip(a, name);
      for (const { b, rest } of Object.values(a.bones)) b.quaternion.copy(rest);
      a.mixer.update(dt);
      this.livePose(a, v, now);
    }
    const B = this.bAnim;
    if (!B) return;
    // Ascensor: espera unos segundos, elige otra planta y va hacia ella
    const y = B.cabin.position.y, goal = B.base + B.target * B.floorH;
    if (Math.abs(goal - y) > 0.01) B.cabin.position.y += Math.sign(goal - y) * Math.min(Math.abs(goal - y), dt * 1.6);
    else if ((B.wait -= dt) <= 0) { B.target = B.n > 1 ? (B.target + 1 + Math.floor(Math.random() * (B.n - 1))) % B.n : 0; B.wait = 2 + Math.random() * 4; } // siempre a OTRA planta
    B.crowns.forEach((c, i) => { c.rotation.z = Math.sin(now * 0.9 + i * 1.7) * 0.05; c.rotation.x = Math.sin(now * 0.7 + i) * 0.04; });
    if (B.umb) B.umb.rotation.y += dt * 0.15;
  }

  // Edificio: los libres se levantan del sofá y dan una vuelta por su planta (kanban, mesa de reuniones, revisión, una mesa
  // vacía…), hacen allí su gesto y vuelven. Coordenadas locales de la planta (Office3D.BLDG).
  miniWalk(a, v, dt, now) {
    if (v.status !== 'idle' || !a.fuel || !a.model) { a.moving = false; return; }
    const B = Office3D.BLDG, m = a.model;
    const SPOTS = [ // FT-148: solo descanso/recreo (el sofá y la zona de charla), nunca kanban/revisión/mesas de trabajo
      { id: 'charla', x: B.sofa[0] - 0.8, z: B.sofa[1] + 0.2, face: Math.PI, gesture: 'emote-yes' },
      { id: 'cafe', x: B.sofa[0] - 0.8, z: B.sofa[1] - 0.5, face: Math.PI, gesture: 'interact-right' },
    ];
    const W = a.walk;
    if (!W) {
      if (now < a.nextWalk) return;
      const s = SPOTS[Math.floor(Math.random() * SPOTS.length)];
      a.walk = { to: s, phase: 'go', until: 0 }; a.wander = null; a.sitSpot = false;
      m.position.y = a.standY;
      return;
    }
    const tgt = W.phase === 'back' ? { x: a.home.x, z: a.home.z } : W.to;
    if (W.phase === 'go' || W.phase === 'back') {
      const dx = tgt.x - m.position.x, dz = tgt.z - m.position.z, d = Math.hypot(dx, dz), step = dt * 1.1;
      a.moving = true;
      m.rotation.y = Math.atan2(dx, dz);
      if (d > step) { m.position.x += (dx / d) * step; m.position.z += (dz / d) * step; }
      else {
        m.position.x = tgt.x; m.position.z = tgt.z; a.moving = false;
        if (W.phase === 'go') { W.phase = 'stay'; W.until = now + 4 + Math.random() * 5; m.rotation.y = W.to.face; a.wander = { id: W.to.id, gesture: W.to.gesture }; a.key = 'wander:' + W.to.id; a.nextGesture = now + 0.3; }
        else { a.walk = null; a.wander = null; a.sitSpot = a.home.sit; m.position.y = a.home.y; m.rotation.y = a.home.ry; a.nextWalk = now + 8 + Math.random() * 14; }
      }
    } else if (now > W.until) { W.phase = 'back'; a.wander = null; a.key = null; }
    if (a.dot) { a.dot.position.x = m.position.x; a.dot.position.z = m.position.z; }
  }

  nearestWorkstation(x, z) {
    let bi = -1, bd = Infinity;
    this.workstations.forEach((ws, i) => { const d = Math.hypot(ws.x - x, ws.z - z); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }

  refreshScreens() {
    const on = new Set();
    for (const a of this.actors.values()) if (a._ws >= 0) on.add(a._ws);
    this.workstations.forEach((ws, i) => {
      const lit = on.has(i);
      for (const mt of ws.screenMats) { mt.emissive.setHex(lit ? SCREEN_ON : 0x000000); mt.emissiveIntensity = lit ? 1.6 : 0; }
    });
  }

  // Gestos sueltos cada pocos segundos según lo que hacen (señalar el kanban, coger la taza, asentir en la charla…).
  scheduleGesture(a, visual, now) {
    if (!a.fuel || a.moving || (a.emote && now < a.emote.until) || now < a.nextGesture) return;
    let name = null;
    const w = a.wander;
    if (w && a.key === 'wander:' + w.id) name = w.gesture;
    else if (visual.status === 'waiting' || visual.status === 'blocked') name = 'interact-right';
    else if (visual.status === 'idle' && !a.sitSpot) name = Math.random() < 0.5 ? 'emote-yes' : 'interact-left';
    a.nextGesture = now + (w ? rand(2.2, 4) : rand(5, 11));
    if (name && a.actions[name]) a.emote = { name, until: now + (a.actions[name].getClip().duration || 1) + 0.15 };
  }

  // Capa procedural sobre el clip (los huesos se resetean a reposo antes de cada mixer.update).
  livePose(a, visual, now) {
    const B = a.bones;
    if (!B || !a.fuel || a.moving) return;
    const t = now + a.phase;
    const K = a.amp || 1;                                                    // el edificio exagera: los muñecos son diminutos
    const torso = B.torso?.b, head = B.head?.b, armL = B['arm-left']?.b, armR = B['arm-right']?.b;
    if (torso) torso.rotation.x += Math.sin(t * 1.9) * 0.025 * K;           // respirar
    const gesturing = a.emote && now < a.emote.until;
    if (visual.status === 'working' && a.sitSpot) {
      // Teclear con pausas para «pensar» (≈1,5 s de cada 7): brazos al frente y golpecitos alternos.
      const thinking = (t % 7) > 5.5;
      if (armL && armR) {
        armL.quaternion.copy(ARM_FWD_L); armR.quaternion.copy(ARM_FWD_R);
        const k = thinking ? 0 : 0.22 * K;
        // El brazo va a lo largo de su eje X local: girar en Z sube/baja la mano (signo opuesto en cada lado).
        armL.rotateZ(-0.3 + Math.max(0, Math.sin(t * 14)) * k);
        armR.rotateZ(0.3 - Math.max(0, Math.sin(t * 14 + 1.7)) * k);
      }
      if (head) { head.rotation.x += thinking ? -0.18 * K : 0.06 + Math.sin(t * 0.9) * 0.04 * K; head.rotation.y += Math.sin(t * 0.35) * 0.22 * K; }
      if (torso) torso.rotation.x += 0.08;                                    // inclinado hacia la pantalla
    } else if (!gesturing && head) {
      // Mirar alrededor: más tranquilo sentado, más curioso de pie.
      const amp = (a.sitSpot ? 0.3 : 0.45) * K;
      head.rotation.y += Math.sin(t * 0.45) * amp + Math.sin(t * 1.3) * 0.08 * K;
      head.rotation.x += Math.sin(t * 0.6) * 0.06 - (visual.status === 'waiting' ? 0.12 : 0);
    }
  }

  chooseClip(a, agent, now) {
    if (a.emote && now < a.emote.until && a.actions[a.emote.name]) return a.emote.name;
    if (a.moving) return a.actions.walk ? 'walk' : 'idle';
    const w = a.wander;
    if (w?.hold && a.key === 'wander:' + w.id && a.actions[w.hold]) return w.hold;
    const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
    if (a.sitSpot && ['working', 'reviewing', 'blocked'].includes(visual.status)) return a.actions.sit ? 'sit' : 'idle';
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
      .o3d-pill.compact{width:12px;height:12px;padding:0;border-radius:999px;color:transparent;overflow:hidden}
      .o3d-pill.waiting{background:#fff4bf}.o3d-pill.reviewing{background:#fed7aa}.o3d-pill.blocked{background:#fde68a}.o3d-pill.failed{background:#fee2e2}.o3d-pill.idle{background:#e2e8f0}
      .o3d-pill.sel{outline:2px solid #f6c744;outline-offset:1px}
      .o3d-bubble{font-size:11px;font-weight:600;color:#1f2937;background:rgba(255,255,255,.95);border:1px solid rgba(0,0,0,.08);
        border-radius:9px;padding:3px 8px;box-shadow:0 2px 6px rgba(0,0,0,.2);max-width:190px}
      .o3d-bubble.full{overflow:hidden;text-overflow:ellipsis}
      .o3d-bubble::after{content:'';position:absolute;left:50%;top:100%;width:1px;height:var(--lead,0px);background:rgba(71,85,105,.7)}
      .o3d-bubble.plan{background:#f5f3ff;color:#4c1d95;border-color:#c4b5fd}
      .o3d-bubble.review{background:#fff7ed;color:#9a3412;border-color:#fdba74}
      .o3d-bubble.error{background:#fef2f2;color:#991b1b;border-color:#fca5a5}
      .o3d-board{font-size:12px;font-weight:700;color:#334155;background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.1);
        border-radius:8px;padding:3px 10px;box-shadow:0 2px 6px rgba(0,0,0,.18)}
      .o3d-zone{font-size:12px;font-weight:800;color:#1f2937;border:1px solid transparent;border-radius:999px;padding:4px 12px;box-shadow:0 2px 6px rgba(0,0,0,.18);transform:translate(-50%,-50%);white-space:nowrap}
      .o3d-floor{display:flex;align-items:center;gap:8px;font-size:12px;color:#e5e7eb;background:rgba(17,24,39,.88);border:1px solid rgba(148,163,184,.25);border-radius:10px;padding:7px 11px;transform:translate(0,-50%);white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.25);min-width:190px}
      .o3d-floor .pn{font-size:11px;color:#94a3b8;font-weight:700;min-width:20px}
      .o3d-floor .body{display:flex;flex-direction:column;gap:2px}
      .o3d-floor .n{font-weight:700;font-size:13px;color:#f8fafc}
      .o3d-floor .m{font-size:11px;color:#cbd5e1;display:flex;align-items:center;gap:5px}
      .o3d-floor .m i{width:7px;height:7px;border-radius:50%;display:inline-block}
      .o3d-floor .m.bad{color:#fca5a5}
      .o3d-floor .mine{margin-left:auto;min-width:18px;height:18px;border-radius:9px;background:#f97316;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 5px}
      .o3d-bubble.me,.o3d-pill.me{pointer-events:auto;cursor:pointer}
      .o3d-bubble.me{background:#fff7ed;color:#9a3412;border-color:#fb923c;font-weight:700}
      .o3d-bubble.me.calm{background:#f0fdf4;color:#166534;border-color:#86efac}
      .o3d-mine-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
      .o3d-labels.building .o3d-mine-lines{display:none}
      .o3d-floor.hover{outline:2px solid #3ad0a0;outline-offset:1px}
      .o3d-floor.active{border-color:#3ad0a0;box-shadow:0 0 0 2px rgba(58,208,160,.45),0 2px 10px rgba(0,0,0,.3)}
      .o3d-floor.grouped{color:#64748b;font-style:italic}
      .o3d-floor.guide{background:rgba(6,40,30,.9);border-color:rgba(52,211,153,.45)}
      .o3d-labels:not(.building) .o3d-floor,.o3d-labels.building .o3d-pill,.o3d-labels.building .o3d-bubble,.o3d-labels.building .o3d-board,.o3d-labels.building .o3d-zone,.o3d-labels.building .o3d-ambient{display:none}
      .o3d-ambient{font-size:10px;font-weight:700;letter-spacing:.04em;color:#475569;background:repeating-linear-gradient(135deg,#cfd7df 0 6px,#e6ebf0 6px 12px);border:1px dashed #657586;border-radius:6px;padding:1px 7px}
      .o3d-zone.v3{color:#203247}
      .o3d-legend-btn{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:5;font:700 12px system-ui,sans-serif;color:#f3f6fa;background:#1c293c;border:1px solid #53677D;border-radius:999px;padding:5px 14px;cursor:pointer}
      .o3d-legend{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:5;max-width:min(720px,90%);font:12px system-ui,sans-serif;color:#f3f6fa;background:rgba(28,41,60,.96);border:1px solid #53677D;border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:6px}
      .o3d-legend[hidden]{display:none}
      .o3d-legend div{display:flex;flex-wrap:wrap;gap:4px 14px}
      .o3d-legend span{display:inline-flex;align-items:center;gap:5px}
      .o3d-legend i{width:12px;height:12px;border-radius:3px;border:1px solid #53677D;display:inline-block}
      .o3d-legend small{color:#cbd5e1}`;
    document.head.appendChild(style);
    this.labelRoot = document.createElement('div');
    this.labelRoot.className = 'o3d-labels';   // con la clase `building` solo se ven las etiquetas de las plantas (FT-47)
    (wrap || document.body).appendChild(this.labelRoot);
    this.labelEls = new Map();
    this.mineSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); // FT-124: líneas discontinuas agente → mi mesa
    this.mineSvg.setAttribute('class', 'o3d-mine-lines');
    this.mineLines = new Map();
    this.labelRoot.appendChild(this.mineSvg);
    this.boardLabel = document.createElement('div');
    this.boardLabel.className = 'o3d-el o3d-board';
    this.labelRoot.appendChild(this.boardLabel);
    this.zoneLabelEls = []; this.zoneSig = '';
    this.syncZoneLabels();
    this.buildLegend();
  }

  removeLabel(id) { const e = this.labelEls.get(id); if (e) { e.pill.remove(); e.bubble.remove(); this.labelEls.delete(id); } }

  labelFor(id) {
    let e = this.labelEls.get(id);
    if (!e) {
      const pill = document.createElement('div'); pill.className = 'o3d-el o3d-pill';
      const bubble = document.createElement('div'); bubble.className = 'o3d-el o3d-bubble';
      this.labelRoot.append(pill, bubble);
      e = { pill, bubble, text: null }; this.labelEls.set(id, e);
    }
    return e;
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
  }

  // FT-125: casco convexo (px del lienzo) del volumen de la planta: suelo + paredes. Los paneles de los márgenes no lo pisan nunca.
  floorHull() {
    const sz = this.currentFloorSize || DEFAULT_FLOOR_SIZE, pts = [];
    for (const x of [0, sz.rx]) for (const y of [0, WALL_H]) for (const z of [0, sz.rz]) { const p = this.project(x, y, z); if (p.visible) pts.push(p); }
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (list) => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
    return pts.length < 3 ? [] : [...half(pts), ...half(pts.slice().reverse())];
  }

  // FT-125: cajas (px del lienzo) de lo que se ve flotando sobre la planta: burbujas, píldoras de zona y título de la pizarra.
  obstacles() {
    const out = [];
    for (const { el } of this.zoneLabelEls || []) if (el.style.opacity === '1') out.push(this.boxOf(el, 0.5, 0.5));
    if (this.boardLabel.style.opacity === '1') out.push(this.boxOf(this.boardLabel, 0.5, 1));
    for (const e of this.labelEls.values()) {
      if (e.pos && e.bubble.style.opacity === '1') { const x = parseFloat(e.bubble.style.left) || 0, y = parseFloat(e.bubble.style.top) || 0; out.push({ l: x - e.w / 2, r: x + e.w / 2, t: y - e.h, b: y }); }
    }
    return out;
  }

  updateLabels(now) {
    if (this.legendEls) for (const e of this.legendEls) e.style.display = this.v3 && this.mode === 'floor' ? '' : 'none';
    if (this.v3) this.updateAmbient(now);
    const actorMarks = this.agents.map((agent) => {
      const a = this.actors.get(agent.id);
      return a?.group.visible ? this.project(a.x, 0.7, a.z) : null;
    }).filter((p) => p?.visible);
    for (const { id, el } of this.zoneLabelEls || []) {
      const z = this.floorZones[id];
      if (!z) { el.style.opacity = '0'; continue; }
      // FT-78 v2: anclada DENTRO de su zona (esquina del fondo-izquierda), por encima del suelo; píldora del color de la zona
      // QA queda delante del Kanban: su píldora va a la esquina del fondo-derecha; la del Kanban, bajo la pizarra.
      if (z.v3) {
        // FT-149: rótulo horizontal en el borde posterior de la zona (ancla del contrato); el del Kanban baja bajo el tablero
        const p3 = this.project(z.labelAnchor.x, id === 'board' ? 0.05 : z.labelAnchor.y, z.labelAnchor.z + (id === 'board' ? 0.45 : 0));
        if (!el.dataset.c) { el.classList.add('v3'); el.style.background = '#' + z.fill.toString(16).padStart(6, '0'); el.style.borderColor = '#' + z.color.toString(16).padStart(6, '0'); el.dataset.c = '1'; }
        el.style.left = p3.x + 'px'; el.style.top = p3.y + 'px'; el.style.opacity = p3.visible ? '1' : '0';
        continue;
      }
      const ax = id === 'qa' ? z.x + z.w / 2 - Math.min(0.75, z.w * 0.3) : z.x - z.w / 2 + Math.min(0.9, z.w * 0.3);
      const p = id === 'board' ? this.project(BOARD.x - BOARD.w / 2 + 0.55, BOARD.y - BOARD.h / 2 - 0.12, BOARD.z + 0.12)
        : this.project(ax, 0.5, z.z - z.d / 2 + 0.3);
      if (!el.dataset.c) { const c = '#' + z.color.toString(16).padStart(6, '0'); el.style.background = c; el.style.borderColor = c; el.dataset.c = c; }
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.style.opacity = p.visible ? '1' : '0';
    }
    // Pizarra: título + pendientes.
    const pend = this.tasks.filter((t) => t.status === 'todo' || t.status === 'failed').length;
    const bp = this.project(BOARD.x, BOARD.y + BOARD.h / 2 + 0.09, BOARD.z); // borde superior del marco
    this.boardLabel.textContent = `${this.title || 'Proyecto'} · ${pend} pendientes`;
    this.boardLabel.style.left = bp.x + 'px';
    this.boardLabel.style.top = (bp.y - 76) + 'px'; // FT-78 v2: encima de la pizarra, sin tapar «Por hacer»
    this.boardLabel.style.opacity = bp.visible && !this.v3 ? '1' : '0'; // FT-149: en v3 el título y los pendientes van en el rótulo de la zona Kanban
    if (this.v3) { const zl = this.zoneLabelEls?.find((o) => o.id === 'board'); if (zl) zl.el.textContent = `${this.floorZones.board.label} · ${pend} pendientes`; }

    const seen = new Set();
    this.agents.forEach((agent) => {
      const a = this.actors.get(agent.id);
      if (!a || !a.group.visible) return;
      seen.add(agent.id);
      const e = this.labelFor(agent.id);
      const head = this.project(a.x, 1.15, a.z);
      const foot = this.project(a.x, 0.02, a.z);
      const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
      const expanded = this.selected === agent.id || this.hoverActor === agent.id || visual.status === 'failed';
      e.pill.textContent = expanded ? agent.name : ' ';
      e.pill.className = `o3d-el o3d-pill ${visual.status}${expanded ? '' : ' compact'}`;
      e.pill.classList.toggle('sel', this.selected === agent.id);
      e.pill.style.left = foot.x + 'px';
      e.pill.style.top = (foot.y + 4) + 'px';
      e.pill.style.opacity = foot.visible ? '1' : '0';

      const { text, kind, full } = this.bubbleText(agent, a, now);
      e.pos = null;
      if (text) {
        // FT-123: solo se toca el DOM si el texto o la clase cambian (la posición sí se escribe cada frame, tras apilar)
        const cls = 'o3d-el o3d-bubble' + (kind ? ' ' + kind : '') + (full ? ' full' : '');
        if (e.text !== text) { e.bubble.textContent = text; e.text = text; e.w = 0; }
        if (e.cls !== cls) { e.bubble.className = cls; e.cls = cls; e.w = 0; }
        if (!e.w) { e.w = e.bubble.offsetWidth || 60; e.h = e.bubble.offsetHeight || 20; }
        e.pos = { x: head.x, y: head.y - 2, vis: head.visible, hover: !!full };
      } else if (e.text !== null) { e.text = null; e.bubble.style.opacity = '0'; }
    });
    this.updateDesk(seen);
    this.stackBubbles();
    for (const id of this.labelEls.keys()) if (!seen.has(id)) this.removeLabel(id);
  }

  // FT-124: píldora «Tú» + burbuja de avisos de mi mesa (entra en stackBubbles como una más) y líneas de los agentes que me esperan.
  updateDesk(seen) {
    if (!this.deskPos) return;
    const d = this.deskPos, m = this.mine || MINE_NONE;
    seen.add('__me');
    const e = this.labelFor('__me');
    if (!e.wired) {
      e.wired = true;
      for (const el of [e.bubble, e.pill]) { el.classList.add('me'); el.addEventListener('click', () => this.onMineClick?.(this.activeProjectId)); }
      e.pill.textContent = 'Tú'; e.pill.className = 'o3d-el o3d-pill me';
      e.bubble.dataset.me = '1';
    }
    const text = mineText(m), cls = 'o3d-el o3d-bubble me' + (m.total ? '' : ' calm');
    if (e.text !== text) { e.bubble.textContent = text; e.text = text; e.w = 0; }
    if (e.cls !== cls) { e.bubble.className = cls; e.cls = cls; e.w = 0; }
    if (!e.w) { e.w = e.bubble.offsetWidth || 60; e.h = e.bubble.offsetHeight || 20; }
    const head = this.project(d.x, 1.05, d.z - 0.55), foot = this.project(d.x, 0.02, d.z + 0.3);
    e.pill.style.left = foot.x + 'px'; e.pill.style.top = (foot.y + 4) + 'px'; e.pill.style.opacity = foot.visible ? '1' : '0';
    e.pos = { x: head.x, y: head.y - 2, vis: head.visible, hover: false };
    // líneas discontinuas: una por agente que espera al usuario
    const target = this.project(d.x, 0.6, d.z - 0.2);
    for (const [id, kind] of this.waitOn) {
      const a = this.actors.get(id);
      if (!a?.group.visible) continue;
      let ln = this.mineLines.get(id);
      if (!ln) {
        ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('stroke-dasharray', '7 5'); ln.setAttribute('stroke-width', '2.5'); ln.setAttribute('stroke-linecap', 'round');
        ln.dataset.agent = id; this.mineSvg.appendChild(ln); this.mineLines.set(id, ln);
      }
      const p = this.project(a.x, 0.7, a.z);
      ln.setAttribute('stroke', kind === 'question' ? '#f97316' : '#d97706');
      ln.dataset.kind = kind;
      ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); ln.setAttribute('x2', target.x); ln.setAttribute('y2', target.y);
      ln.style.opacity = p.visible && target.visible ? '0.9' : '0';
    }
    for (const [id, ln] of this.mineLines) if (!this.waitOn.has(id) || !this.actors.get(id)?.group.visible) { ln.remove(); this.mineLines.delete(id); }
  }

  nearDesk(e) {
    if (!this.deskPos) return false;
    const r = this.cv.getBoundingClientRect(), p = this.project(this.deskPos.x, 0.5, this.deskPos.z);
    return p.visible && Math.hypot((e.clientX - r.left) - p.x, (e.clientY - r.top) - p.y) < 55;
  }

  // FT-123: anti-solape. Ordena las burbujas de abajo arriba y sube cada una hasta que no pise a otra ni a las píldoras de zona/pizarra;
  // si hubo que subirla, una línea fina la une a su avatar (--lead). Las que no tienen sitio visible quedan en su posición.
  stackBubbles() {
    const obst = [];
    for (const { el } of this.zoneLabelEls || []) if (el.style.opacity === '1') obst.push(this.boxOf(el, 0.5, 0.5));
    if (this.boardLabel.style.opacity === '1') obst.push(this.boxOf(this.boardLabel, 0.5, 1));
    const list = [...this.labelEls.values()].filter((e) => e.pos).sort((p, q) => q.pos.y - p.pos.y);
    const placed = [];
    for (const e of list) {
      const w = e.w, h = e.h;
      let y = e.pos.y;
      const hit = (b) => e.pos.x - w / 2 < b.r && e.pos.x + w / 2 > b.l && y - h < b.b && y > b.t;
      for (let i = 0; i < 40; i++) {
        const o = obst.find(hit) || placed.find(hit);
        if (!o) break;
        y = o.t - 2;
      }
      e.bubble.style.setProperty('--lead', Math.max(0, e.pos.y - y) + 'px');
      e.bubble.style.left = e.pos.x + 'px';
      e.bubble.style.top = y + 'px';
      e.bubble.style.opacity = e.pos.vis ? '1' : '0';
      e.bubble.style.zIndex = e.pos.hover ? '3' : '';
      placed.push({ l: e.pos.x - w / 2, r: e.pos.x + w / 2, t: y - h, b: y });
    }
  }

  boxOf(el, ax, ay) {
    if (el._bt !== el.textContent) { el._bt = el.textContent; el._w = el.offsetWidth; el._h = el.offsetHeight; }
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    return { l: x - el._w * ax, r: x + el._w * (1 - ax), t: y - el._h * ay, b: y + el._h * (1 - ay) };
  }

  bubbleText(agent, a, now) {
    const visual = this.visualAgents.find((v) => v.id === agent.id) || toVisualState(agent, this.tasks, this.questions);
    const hov = this.selected === agent.id || this.hoverActor === agent.id;
    if (a.moving && a.wander) return { text: '→ ' + a.wander.label, kind: '' };
    if (a.moving) return { text: '→ ' + ((this.floorZones || BASE_ZONE_STYLE)[a.dest?.zone]?.label || 'zona'), kind: '' };
    const codeOf = (id) => this.tasks.find((t) => t.id === id)?.code || ''; // FT-125: nunca el id interno de la tarea
    if (visual.status === 'failed') return { text: `⚠ ${codeOf(visual.taskId || agent.taskId) || 'tarea'} falló`, kind: 'error' };
    const wait = this.waitOn.get(agent.id); // FT-124: el agente espera al usuario
    if (wait) return { text: wait === 'question' ? '❓ te pregunta' : '✋ espera tu revisión', kind: 'review' };
    if (a.fuel === false && agent.status !== 'paused') return { text: '💤 sin cuota', kind: 'review' };
    if (a.wander && hov) return { text: a.wander.label, kind: '' };
    if (hov) {
      if (visual.status === 'blocked') return { text: 'Bloqueado', kind: 'review', full: true };
      if (visual.status === 'waiting') return { text: 'En cola', kind: 'plan', full: true };
      if (visual.status === 'reviewing') return { text: `✋ ${codeOf(visual.taskId || agent.taskId) || 'tarea'} en revisión`, kind: 'review', full: true };
      if (visual.status === 'working') return { text: visual.activity ? '✏️ ' + visual.activity : 'Trabajando…', kind: '', full: true };
    }
    if (this.bubbleMode === 'al pasar') return { text: null };
    // Burbuja compacta siempre visible (en móvil, solo icono + código)
    // FT-125: el código (FT-n) de la tarea, no su id interno; un agente libre no lleva código y sí su nombre.
    const free = !['blocked', 'waiting', 'reviewing', 'working'].includes(visual.status);
    const code = free ? '' : codeOf(visual.taskId || agent.taskId);
    const compact = this.cv.clientWidth < 640;
    const tag = (icon, label, kind) => ({ text: compact ? (code ? `${icon} ${code}` : icon) : [icon, code || (free ? agent.name : ''), label].filter(Boolean).join(' '), kind });
    if (visual.status === 'blocked') return tag('⛔', 'bloqueado', 'review');
    if (visual.status === 'waiting') return tag('⏳', 'en cola', 'plan');
    if (visual.status === 'reviewing') return tag('✋', 'en revisión', 'review');
    if (visual.status === 'working') return tag('✏️', 'editando…', '');
    return tag('☕', 'libre', '');
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
    // FT-71: los modelos low-poly tienen piezas finas; para teclado/ratón se usa un área visual estable alrededor del avatar.
    let best = null, bd = 90;
    for (const [id, a] of this.actors) {
      if (!a.group.visible) continue;
      const p = this.project(a.x, 0.65, a.z);
      if (!p.visible) continue;
      const d = Math.hypot((e.clientX - r.left) - p.x, (e.clientY - r.top) - p.y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best) return best;
    return null;
  }

  openFloor(f) { if (f?.guide) this.onGuideClick?.(); else if (f?.projectId) this.onFloorClick?.(f.projectId); }

  onPointer(e, click) {
    if (click) this.cv.focus({ preventScroll: true });   // para que Esc vuelva al edificio (FT-47)
    if (this.mode === 'building') {
      const i = this.pickFloor(e);
      const f = this.floors[i];
      const openable = !!f?.projectId || !!f?.guide; // la planta «+N» no se abre; la de Dirección abre el Guía
      this.setHover(openable ? i : -1);
      if (click && openable) this.openFloor(f);
      else this.cv.style.cursor = openable ? 'pointer' : 'default';
      return;
    }
    const id = this.pickActor(e);
    const desk = !id && this.nearDesk(e); // FT-124: clic en mi mesa → Para ti filtrado
    if (!click) this.hoverActor = id;
    if (click) { if (id) this.onAgentClick?.(id); else if (desk) this.onMineClick?.(this.activeProjectId); }
    else this.cv.style.cursor = id || desk ? 'pointer' : 'default';
  }

  onKey(e) {
    if (e.key !== 'Tab' && e.key !== 'Enter') return;
    if (this.mode === 'building') {
      const open = this.floors.map((f, i) => f.projectId || f.guide ? i : -1).filter((i) => i >= 0);
      if (!open.length) return;
      e.preventDefault();
      const pos = open.indexOf(this.hoverFloor);
      const next = open[(pos + (e.shiftKey ? open.length - 1 : 1)) % open.length];
      if (e.key === 'Tab') { this.setHover(next); this.cv.style.cursor = 'pointer'; this.updateFloorLabels(); }
      else if (this.hoverFloor >= 0) this.openFloor(this.floors[this.hoverFloor]);
      return;
    }
    const ids = this.agents.map((a) => a.id).filter((id) => this.actors.get(id)?.group.visible);
    if (!ids.length) return;
    e.preventDefault();
    const pos = ids.indexOf(this.hoverActor || this.selected);
    const next = ids[(pos + (e.shiftKey ? ids.length - 1 : 1)) % ids.length];
    if (e.key === 'Tab') this.hoverActor = next;
    else if (this.hoverActor || this.selected) this.onAgentClick?.(this.hoverActor || this.selected);
  }

  // ── Encuadre / bucle ──────────────────────────────────────────────────────────
  resize() {
    const w = this.cv.clientWidth || 320;
    let h = this.fitBuildingHeight(w);
    this.renderer.setSize(w, h, false);
    if (this.officeLevel === 'agent' && this.selected) this.frameAgentCamera(w / h, this.selected);
    else this.frameCamera(w / h, this.viewBox());
    if (this.camAnim) this.camAnim.to = this.captureFrame();   // en plena transición: el destino es el nuevo encuadre
    if (!this.running && this.renderer) this.renderer.render(this.scene, this.camera);
  }

  // Contrato visual (FT-77 v2): «scroll vertical antes que miniaturizar». En modo edificio, si con el alto disponible las plantas
  // quedarían por debajo de ~560 px de ancho, el lienzo crece en alto (y la vista hace scroll) hasta que midan ~620 px.
  fitBuildingHeight(w) {
    const wrap = this.cv.parentElement;
    const reset = () => { if (this.cv.style.height) { this.cv.style.height = ''; if (this.labelRoot) { this.labelRoot.style.height = ''; this.labelRoot.style.bottom = ''; } if (wrap) wrap.style.overflowY = ''; } };
    if (this.mode !== 'building' || this.officeLevel === 'agent' || !wrap || !this.floorGroups.length) { reset(); return this.cv.clientHeight || 208; }
    const avail = wrap.clientHeight || this.cv.clientHeight || 208;
    this.frameCamera(w / avail, this.viewBox());
    // Decisión del usuario (2026-10-06): el edificio cabe SIEMPRE en la vista, sin scroll; con muchas plantas cada una sale más
    // pequeña. (Antes, FT-77/81: si la planta bajaba de 560 px el lienzo crecía y aparecía scroll vertical.)
    reset();
    return avail;
  }
  // Ancho en px de la planta i para un lienzo de ancho w (proyección de su caja; no depende del tamaño CSS del lienzo).
  floorPxWidth(i, w) {
    const g = this.floorGroups[i];
    if (!g) return 0;
    this.camera.updateMatrixWorld(); g.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(g);
    let x0 = Infinity, x1 = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const v = new THREE.Vector3(x, y, z).project(this.camera); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); }
    return (x1 - x0) / 2 * w;
  }

  frameAgentCamera(aspect, id) {
    const a = this.actors.get(id);
    const s = this.floorLayout?.slots?.[id];
    const x = a?.x ?? s?.x ?? this.currentFloorSize.rx / 2;
    const z = a?.z ?? s?.z ?? this.currentFloorSize.rz / 2;
    const center = new THREE.Vector3(x, 0.72, z);
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    const cam = this.camera;
    cam.position.copy(center).addScaledVector(dir, 9);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    this.camCenter.copy(center);
    const halfH = 2.35, halfW = halfH * aspect;
    const drawerPx = Math.min(440, (this.cv.clientWidth || 0) * 0.42);
    const panelShift = drawerPx > 0 ? halfW * (drawerPx / (this.cv.clientWidth || 1)) * 0.9 : 0;
    cam.left = -halfW + panelShift; cam.right = halfW + panelShift; cam.top = halfH; cam.bottom = -halfH; cam.near = -20; cam.far = 30;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // Encuadre actual de la cámara (posición, centro al que mira y frustum), para interpolarlo (FT-47).
  captureFrame() {
    const c = this.camera;
    return { pos: c.position.clone(), center: this.camCenter.clone(), left: c.left, right: c.right, top: c.top, bottom: c.bottom, near: c.near, far: c.far };
  }

  applyFrame(f) {
    const c = this.camera;
    c.position.copy(f.pos);
    this.camCenter.copy(f.center);
    c.up.set(0, 1, 0);
    c.lookAt(f.center);
    c.left = f.left; c.right = f.right; c.top = f.top; c.bottom = f.bottom; c.near = f.near; c.far = f.far;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  // Un paso de la transición edificio ↔ planta: ease-out cúbico sobre todos los parámetros del encuadre.
  tickCamera(now) {
    const a = this.camAnim;
    if (!a) return;
    const k = Math.min(1, (now - a.t0) / CAM_MS);
    const e = 1 - Math.pow(1 - k, 3);
    const mix = (x, y) => x + (y - x) * e;
    this.applyFrame({
      pos: a.from.pos.clone().lerp(a.to.pos, e), center: a.from.center.clone().lerp(a.to.center, e),
      left: mix(a.from.left, a.to.left), right: mix(a.from.right, a.to.right), top: mix(a.from.top, a.to.top), bottom: mix(a.from.bottom, a.to.bottom),
      near: Math.min(a.from.near, a.to.near), far: Math.max(a.from.far, a.to.far),
    });
    if (k >= 1) { this.applyFrame(a.to); this.camAnim = null; }
  }

  // Caja [0..x]×[0..y]×[0..z] que debe caber en pantalla: la sala, o el edificio entero con su azotea.
  viewBox() {
    if (this.mode !== 'building') {
      const s = this.currentFloorSize || DEFAULT_FLOOR_SIZE;
      return [s.rx, WALL_H, s.rz];
    }
    const n = Math.max(1, this.floors.length);
    return [BUILDING_FLOOR_SIZE.rx + CORE_W, n * FLOOR_H + 1.3, BUILDING_FLOOR_SIZE.rz]; // + azotea con sombrilla
  }

  frameCamera(aspect, box = FLOOR_BOX) {
    const cam = this.camera;
    const [bx, by, bz] = box;
    const center = new THREE.Vector3(bx / 2, by / 2, bz / 2);
    const dir = (this.mode === 'building' ? new THREE.Vector3(...BUILDING_CAM_DIR) : new THREE.Vector3(1, 1, 1)).normalize();
    const radius = Math.hypot(bx, by, bz);
    cam.position.copy(center).addScaledVector(dir, radius * 2);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    this.camCenter.copy(center);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const cx of [0, bx]) for (const cy of [0, by]) for (const cz of [0, bz]) {
      const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    if (this.mode === 'building') maxX += 6.5;   // sitio a la derecha para las tarjetas de las plantas (secundarias a la escena)
    const margin = this.mode === 'building' ? 1.04 : 1.08; // edificio: margen corto, cabe sin scroll y aprovecha el alto (2026-10-06)
    let halfW = (maxX - minX) / 2 * margin, halfH = (maxY - minY) / 2 * margin;
    if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    cam.left = midX - halfW; cam.right = midX + halfW;
    cam.top = midY + halfH; cam.bottom = midY - halfH;
    cam.near = -maxZ - 5; cam.far = -minZ + 5;
    cam.updateProjectionMatrix();
  }

  // FT-148 (QA): avanza el reloj de la planta `seconds` simulados sin esperar al tiempo real.
  simulate(seconds, dt = 0.05) {
    if (this.mode === 'building') return;
    for (let i = 0; i < seconds / dt; i++) { this.elapsed += dt; this.step(dt, this.elapsed); }
  }

  frame() {
    const t = performance.now();
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.elapsed += dt;
    const now = this.elapsed;
    try {
      this.tickCamera(t);
      if (this.mode === 'building') { this.stepBuilding(dt, now); this.updateFloorLabels(); }
      else {
        this.step(dt, now); this.updateLabels(now);
        if (this.onLabelsTick && t - (this._lt || 0) > 400) { this._lt = t; this.onLabelsTick(); } // FT-125: recoloca los paneles de los márgenes
      }
    } catch (err) { /* nunca romper el bucle de render */ }
    this.renderer.render(this.scene, this.camera);
    this.metrics.frames++;
    if (t - this.metrics.fpsT0 >= 1000) {
      this.metrics.fps = Math.round(this.metrics.frames * 1000 / (t - this.metrics.fpsT0));
      this.metrics.frames = 0;
      this.metrics.fpsT0 = t;
    }
  }
}

export { Office3D as Office };
