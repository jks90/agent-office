// 🪪 Identidad del agente: nace con él y NO cambia nunca (ni al renombrarlo, ni al copiarlo, ni al compartirlo).
// Lleva un uid global, su nombre de nacimiento y su físico (el muñeco 3D de la oficina). Renombrar es un «bautizo»:
// cambia agent.name y queda en agent.baptisms, pero identity.birthName sigue siendo el original.
// El fingerprint (sha256 de lo anterior) delata un paquete o un state.json retocado a mano.
import crypto from 'node:crypto';

export const VERSION = 1;
// Mismos GLB que public/office3d.js (CHAR_FILES) y en el mismo orden: los agentes antiguos conservan su muñeco.
export const CHARACTERS = ['female', 'male'].flatMap((g) => ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `character-${g}-${l}`));
export const OUTFITS = ['#ffffff', '#e05d5d', '#e8a33d', '#d9c94a', '#58b368', '#3fa7a0', '#4f86d9', '#7a62d6', '#c463b5', '#6b6f78', '#2f3441', '#b07a52'];
export const ACCESSORIES = ['none', 'none', 'glasses', 'cap', 'headphones', 'beanie', 'bowtie', 'scarf'];
export const EXTRA_COLORS = ['#2f3441', '#e05d5d', '#4f86d9', '#58b368', '#e8a33d', '#c463b5', '#f2f2f2', '#7a4b2a'];

// El mismo hash que office3d.js: con él se elegía antes el personaje (hash(name + id)).
export const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function rng(seed) { // mulberry32: mismo seed → mismo físico
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;

export function avatarFromSeed(seed) {
  const r = rng(seed);
  return {
    seed: seed >>> 0,
    base: pick(r, CHARACTERS),
    outfit: pick(r, OUTFITS),                 // tinte de la ropa (malla del cuerpo)
    accessory: pick(r, ACCESSORIES),
    accent: pick(r, EXTRA_COLORS),           // color del accesorio
    height: round2(0.92 + r() * 0.16),        // 0.92–1.08
    build: round2(0.92 + r() * 0.16),         // complexión (ancho)
  };
}

const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const core = (id) => ({ v: id.v, uid: id.uid, birthName: id.birthName, bornAt: id.bornAt, bornIn: id.bornIn || '', avatar: id.avatar });
export const fingerprintOf = (id) => crypto.createHash('sha256').update(canon(core(id))).digest('hex').slice(0, 24);

const seal = (id) => Object.freeze({ ...id, avatar: Object.freeze({ ...id.avatar }), fingerprint: fingerprintOf(id) });

export function newIdentity(birthName, { bornIn = '', seed = crypto.randomBytes(4).readUInt32LE(0), now = Date.now() } = {}) {
  return seal({ v: VERSION, uid: `ag_${crypto.randomUUID()}`, birthName: String(birthName || '').trim(), bornAt: new Date(now).toISOString(), bornIn, avatar: avatarFromSeed(seed) });
}

// Agentes de antes de la identidad: su muñeco de siempre (hash(name + id)), sin tinte ni accesorio.
export function legacyIdentity(agent) {
  return seal({ v: VERSION, uid: `ag_${crypto.randomUUID()}`, birthName: agent.name, bornAt: new Date(agent.createdAt || Date.now()).toISOString(), bornIn: '',
    avatar: { seed: hash(agent.name + agent.id), base: CHARACTERS[hash(agent.name + agent.id) % CHARACTERS.length], outfit: '', accessory: 'none', accent: '', height: 1, build: 1 } });
}

const HEX = /^(#[0-9a-f]{6})?$/i;
// Identidad que llega de fuera (paquete): solo se acepta con la forma correcta y el fingerprint intacto.
export function verify(x) {
  if (!x || typeof x !== 'object') return null;
  const a = x.avatar || {};
  const ok = x.v === VERSION && /^ag_[0-9a-f-]{36}$/.test(x.uid || '') && typeof x.birthName === 'string' && x.birthName.trim() && x.birthName.length <= 80
    && !Number.isNaN(Date.parse(x.bornAt)) && typeof (x.bornIn ?? '') === 'string' && String(x.bornIn ?? '').length <= 80
    && CHARACTERS.includes(a.base) && HEX.test(a.outfit ?? '') && HEX.test(a.accent ?? '') && ACCESSORIES.includes(a.accessory)
    && Number.isInteger(a.seed) && [a.height, a.build].every((n) => typeof n === 'number' && n >= 0.8 && n <= 1.2);
  if (!ok) return null;
  const clean = { v: x.v, uid: x.uid, birthName: x.birthName, bornAt: x.bornAt, bornIn: x.bornIn || '',
    avatar: { seed: a.seed, base: a.base, outfit: a.outfit || '', accessory: a.accessory, accent: a.accent || '', height: a.height, build: a.build } };
  return fingerprintOf(clean) === x.fingerprint ? seal(clean) : null;
}

export function cleanBaptisms(list) {
  return (Array.isArray(list) ? list : []).filter((b) => b && typeof b.to === 'string' && b.to.trim())
    .slice(-50).map((b) => ({ from: String(b.from || '').slice(0, 80), to: String(b.to).slice(0, 80), at: Number(b.at) || Date.now() }));
}

// Bautizo: el nombre cambia, la identidad no. Devuelve true si hubo cambio.
export function baptize(agent, name) {
  const to = String(name || '').trim();
  if (!to || to === agent.name) return false;
  (agent.baptisms ||= []).push({ from: agent.name, to, at: Date.now() });
  agent.baptisms = cleanBaptisms(agent.baptisms);
  agent.name = to;
  return true;
}

// Lo que viaja al compartir (paquete de agente o miembro de un equipo).
export const shareable = (agent) => agent.identity ? { identity: { ...agent.identity, avatar: { ...agent.identity.avatar } }, baptisms: cleanBaptisms(agent.baptisms) } : {};
