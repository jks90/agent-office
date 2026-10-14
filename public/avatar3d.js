// 🪪 Muñeco del agente a partir de su identidad (server/identity.js): mismo GLB de Kenney, ropa teñida, accesorio,
// altura y complexión. Lo usan la oficina 3D (office3d.js) y las miniaturas isométricas de listas y fichas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const CHAR_DIR = 'assets/3d/characters/';
export const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const CHAR_FILES = ['female', 'male'].flatMap((g) => ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `character-${g}-${l}`));

// Físico del agente: el de su identidad; sin ella (estado antiguo), el de siempre (hash(name + id)) sin vestir.
export function avatarOf(agent) {
  const av = agent?.identity?.avatar;
  if (av && CHAR_FILES.includes(av.base)) return av;
  return { base: CHAR_FILES[hash((agent?.name || '') + (agent?.id || '')) % CHAR_FILES.length], outfit: '', accessory: 'none', accent: '', height: 1, build: 1 };
}

// Celdas del atlas colormap.png (512×512, filas de 128 px) que son PIEL: no se tiñen.
const SKIN = (px, py) => (py >= 256 && py < 384 && px < 64) || (py >= 384 && px >= 320);
const WHITE_U = 272 / 512; // celda blanca: el color lo pone el vértice

// Tiñe la ropa (malla del cuerpo): los vértices que no son piel pasan a la celda blanca y llevan el color del traje
// (el pantalón —huesos de pierna— un tono más oscuro). Los materiales se clonan: no afecta a otros muñecos.
function tint(model, outfit) {
  if (!outfit) return;
  const top = new THREE.Color(outfit), bottom = top.clone().multiplyScalar(0.55);
  model.traverse((m) => {
    if (!m.isMesh || !/body/i.test(m.name) || !m.geometry?.attributes?.uv) return;
    const g = m.geometry = m.geometry.clone();
    const uv = g.attributes.uv, n = uv.count, col = new Float32Array(n * 3);
    const legs = new Set((m.skeleton?.bones || []).map((b, i) => (/leg/i.test(b.name) ? i : -1)).filter((i) => i >= 0));
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    for (let i = 0; i < n; i++) {
      const px = uv.getX(i) * 512, py = uv.getY(i) * 512;
      let c = new THREE.Color(1, 1, 1);
      if (!SKIN(px, py)) {
        let leg = false;
        if (si && sw && legs.size) { let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } } leg = legs.has(best); }
        c = leg ? bottom : top;
        uv.setXY(i, WHITE_U, (384 + (((py % 128) + 128) % 128)) / 512);
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    uv.needsUpdate = true;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    m.material = (Array.isArray(m.material) ? m.material[0] : m.material).clone();
    m.material.vertexColors = true;
  });
}

// Accesorio con primitivas, colgado del hueso de la cabeza (sigue sus animaciones). Medidas relativas a la cabeza.
function accessory(model, kind, accent) {
  if (!kind || kind === 'none') return;
  const head = model.getObjectByName('head');
  const headMesh = model.getObjectByName('head-mesh');
  if (!head || !headMesh) return;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(headMesh);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const W = size.x, H = size.y, D = size.z;
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
  const acc = mat(accent || '#2f3441'), dark = mat('#22252c');
  const g = new THREE.Group(); g.name = 'accessory';
  const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; g.add(o); return o; };
  const front = c.z + D / 2; // los personajes de Kenney miran a +Z
  if (kind === 'glasses') {
    const r = W * 0.13, t = r * 0.22, y = c.y + H * 0.02;
    for (const s of [-1, 1]) add(new THREE.TorusGeometry(r, t, 6, 16), dark, c.x + s * W * 0.2, y, front + t);
    add(new THREE.BoxGeometry(W * 0.14, t * 1.4, t * 1.4), dark, c.x, y, front + t);
  } else if (kind === 'cap') {
    add(new THREE.SphereGeometry(W * 0.56, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), acc, c.x, box.max.y - H * 0.22, c.z);
    add(new THREE.BoxGeometry(W * 0.75, H * 0.05, D * 0.45), acc, c.x, box.max.y - H * 0.2, front + D * 0.12);
  } else if (kind === 'beanie') {
    add(new THREE.SphereGeometry(W * 0.57, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), acc, c.x, box.max.y - H * 0.25, c.z);
    add(new THREE.SphereGeometry(W * 0.12, 10, 8), mat('#f2f2f2'), c.x, box.max.y + H * 0.28, c.z);
  } else if (kind === 'headphones') {
    add(new THREE.TorusGeometry(W * 0.56, W * 0.05, 6, 20, Math.PI), acc, c.x, c.y, c.z);
    for (const s of [-1, 1]) add(new THREE.CylinderGeometry(H * 0.17, H * 0.17, W * 0.12, 14), acc, c.x + s * W * 0.55, c.y, c.z, 0, 0, Math.PI / 2);
  } else if (kind === 'bowtie' || kind === 'scarf') {
    const y = box.min.y - H * 0.04;
    if (kind === 'bowtie') for (const s of [-1, 1]) add(new THREE.ConeGeometry(H * 0.09, W * 0.2, 4), acc, c.x + s * W * 0.1, y, front - D * 0.05, 0, 0, s * Math.PI / 2);
    else add(new THREE.TorusGeometry(W * 0.36, H * 0.08, 8, 18), acc, c.x, y, c.z, Math.PI / 2);
  }
  model.add(g);
  head.attach(g); // conserva la posición actual (pose de reposo) y sigue a la cabeza
}

// Viste un clon del GLB según el físico (antes de escalarlo a la escena). Devuelve el factor de escala por ejes.
export function dress(model, av) {
  tint(model, av.outfit);
  accessory(model, av.accessory, av.accent);
  return { h: av.height || 1, w: av.build || 1 };
}

// ── Miniatura isométrica (listas, fichas): un solo renderer fuera de pantalla y caché por fingerprint ────────────────
const cache = new Map(), pending = new Map(), gltfs = new Map();
let rig = null;
const loadChar = (name) => {
  if (!gltfs.has(name)) gltfs.set(name, new Promise((res) => new GLTFLoader().load(CHAR_DIR + name + '.glb', res, undefined, () => res(null))));
  return gltfs.get(name);
};
function getRig() {
  if (rig) return rig;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(128, 128, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); scene.add(sun);
  const camera = new THREE.OrthographicCamera(-0.6, 0.6, 0.6, -0.6, 0.1, 50);
  camera.position.set(4, 3.3, 4); camera.lookAt(0, 0.5, 0); // vista isométrica, como la oficina
  rig = { renderer, scene, camera };
  return rig;
}

// dataURL PNG del muñeco (o null si no hay WebGL). key: fingerprint de la identidad (o id del agente si no tiene).
export function thumbnail(agent) {
  const key = agent?.identity?.fingerprint || `legacy:${agent?.name}:${agent?.id}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);
  const av = avatarOf(agent);
  const job = loadChar(av.base).then((gltf) => {
    if (!gltf) return null;
    const { renderer, scene, camera } = getRig();
    const model = skeletonClone(gltf.scene);
    const k = dress(model, av);
    const mixer = new THREE.AnimationMixer(model);
    const idle = gltf.animations.find((c) => c.name === 'idle') || gltf.animations[0];
    if (idle) { mixer.clipAction(idle).play(); mixer.update(0.3); }
    const box = new THREE.Box3().setFromObject(model);
    const h = box.getSize(new THREE.Vector3()).y || 1;
    const s = 1 / h;
    model.scale.set(s * k.w, s * k.h, s * k.w);
    model.position.y = -box.min.y * s * k.h;
    scene.add(model);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(model);
    model.traverse((m) => { if (m.isMesh) { m.geometry?.dispose?.(); } });
    cache.set(key, url);
    return url;
  }).catch(() => null).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

// Rellena los <span class="avatar" data-avatar="<agentId>"> con su miniatura (la inicial queda si no hay WebGL).
export function hydrateAvatars(root, agents) {
  for (const el of root.querySelectorAll('.avatar[data-avatar]:not([data-avatar-done])')) {
    const a = agents.find((x) => x.id === el.dataset.avatar);
    if (!a) continue;
    el.setAttribute('data-avatar-done', '');
    thumbnail(a).then((url) => {
      if (!url || !el.isConnected) return;
      el.classList.add('has-doll');
      el.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    });
  }
}
