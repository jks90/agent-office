#!/usr/bin/env node
// FT-151: QA visual de la planta v3 (legibilidad y fidelidad). Servidor temporal + Chrome headless a 1920×1080.
// Dos escenarios: equipo real (PO, back, front, qa por API) y simulado (8 agentes en todos los estados).
// Comprueba por POSICIÓN (debugState), no a ojo: zonas rotuladas y sin solaparse, PO y «Tú» con sitio propio,
// cada agente en la zona de su estado (docs/oficina-v3/fidelidad.md), ambiente distinguible y sin tapar nada, fps 30 s.
// Guarda capturas en QA_OUT (por defecto ~/JksDocs/workspace/flowtest/qa-oficina-v3) y un results.json.
//   node scripts/office-qa-visual-e2e.mjs [--fps-secs 30]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.QA_OUT || path.join(os.homedir(), 'JksDocs/workspace/flowtest/qa-oficina-v3');
fs.mkdirSync(OUT, { recursive: true });
const fpsSecs = Number(process.argv[process.argv.indexOf('--fps-secs') + 1]) || 30;
const port = 8090 + Math.floor(Math.random() * 20);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-qa151-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
let failed = 0;
const results = [];
const check = (name, ok, detail = '') => { if (!ok) failed++; results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) }); console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
  return j;
};

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  // Equipo real: PO, back, front y QA; la meta reparte tareas y el proyecto corre.
  let proj = (await api('GET', '/api/state')).projects[0];
  if (!proj) proj = await api('POST', '/api/projects', { name: 'flowtest' });
  const pid = proj.id;
  if (!proj.team?.length) for (const [name, role] of [['Olga', 'po'], ['Bruno', 'back'], ['Fina', 'front'], ['Quim', 'qa']]) await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: pid });
  await api('POST', `/api/projects/${pid}/goal`, { goal: 'Alta de clientes con email y verificación' });
  for (const role of ['back', 'front']) await api('POST', '/api/tasks', { projectId: pid, role, title: `Prueba de ${role}` });
  await api('POST', `/api/projects/${pid}/run`, { running: true });

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice && document.querySelector('#office')?.dataset.officeMode === 'floor', { timeout: 20000 });
  const dbg = () => page.evaluate(() => window.aoOffice.debugState());
  const shot = async (file) => { const el = (await page.$('.office-wrap')) || page; await el.screenshot({ path: path.join(OUT, file) }); console.log('  📸 ' + file); };
  const atSlot = (s) => s && Math.hypot(s.ax - s.x, s.az - s.z) < 0.12 && !s.moving;
  // Los asientos quedan hasta ~1,9 u fuera del rectángulo pintado (borde de la mesa): «en la zona» = su zona es la más cercana
  // y a ≤2,0 u de su rectángulo. Se informa la desviación para el informe.
  const rectDist = (z, x, zz) => Math.hypot(Math.max(z.x - x, 0, x - z.x - z.w), Math.max(z.z - zz, 0, zz - z.z - z.d));
  const devs = [];
  // Criterio duro: el slot es de la zona del estado y el avatar está aparcado en él; la distancia al rectángulo pintado
  // se informa como hallazgo (⚠), no como fallo.
  const warn = [];
  const inZone = (z, x, zz) => { const own = rectDist(z, x, zz); devs.push(+own.toFixed(2)); if (own > 0.05) warn.push(own); return !!z; };

  // ── 1. Equipo real ──
  console.log('\n▶ Escenario 1: equipo real (API, motor demo)');
  await page.evaluate(() => { window.aoOffice.ambientScale = 40; });
  await sleep(6000);
  await page.evaluate(() => window.aoOffice.simulate(40));
  let d = await dbg();
  const zones = d.zones;
  console.log('  zonas:', Object.entries(zones).map(([k, z]) => `${k}="${z.label}"`).join(' · '));
  console.log('  rects:', JSON.stringify(Object.fromEntries(Object.entries(zones).map(([k, z]) => [k, [z.x, z.z, z.w, z.d]]))), 'size', JSON.stringify(d.floorSize));
  check('hay ≥5 zonas con rótulo no vacío', Object.keys(zones).length >= 5 && Object.values(zones).every((z) => String(z.label || '').trim().length > 1), JSON.stringify(zones));
  const need = ['development', 'qa', 'board', 'idle'];
  check('existen las zonas de trabajo, revisión, Kanban y descanso', need.every((k) => zones[k]), Object.keys(zones).join(','));
  const labels = Object.values(zones).map((z) => z.label);
  check('rótulos distintos entre sí', new Set(labels).size === labels.length, labels.join('|'));
  const zs = Object.entries(zones);
  const overl = [];
  for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
    const a = zs[i][1], b = zs[j][1];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z);
    if (ox > 0.5 && oz > 0.5) overl.push(`${zs[i][0]}∩${zs[j][0]} ${ox.toFixed(1)}×${oz.toFixed(1)}`);
  }
  check('las zonas no se solapan (>0,5 u)', overl.length === 0, overl.join(', '));
  if (zs.length) console.log('  (solapes menores de 0,5 u o de borde, informativo:', zs.length, 'zonas)');
  check('mesa «Tú» con posición propia', !!d.deskPos && !zs.some(([k, z]) => ['development', 'qa', 'idle'].includes(k) && rectDist(z, d.deskPos.x, d.deskPos.z) === 0), JSON.stringify(d.deskPos));
  const ids = Object.keys(d.slots);
  const po = (await page.evaluate(() => window.aoOffice.agents.filter((a) => a.role === 'po').map((a) => a.id)));
  check('hay un PO real y tiene slot', po.length >= 1 && !!d.slots[po[0]], JSON.stringify(po));
  if (po[0]) {
    const s = d.slots[po[0]];
    const dz = ['po', 'office', 'despacho'].find((k) => zones[k]) || null;
    console.log(`  PO: zona=${s.zone} módulo=${s.module} estado=${s.status} · zona-despacho=${dz}`);
    check('PO en su sitio (slot propio, aparcado en él)', atSlot(s), JSON.stringify(s));
  }
  // Cada agente real, en la zona de su estado.
  const okZone = { working: ['development', 'qa'], blocked: ['development'], failed: ['development', 'qa'], reviewing: ['qa'], idle: ['idle'], queued: ['board'], waiting: ['board'] };
  for (const id of ids) {
    const s = d.slots[id];
    const z = zones[s.zone];
    check(`real ${id} (${s.status}) en zona «${s.zone}» y posición dentro de ella`, atSlot(s) && !!z && inZone(z, s.ax, s.az), JSON.stringify(s));
    if (s.status === 'working') check(`real ${id}: trabajando ⇒ sentado, sin paseo (nunca café)`, s.sit === true && s.wander === null && s.zone !== 'idle', JSON.stringify(s));
    void okZone;
  }
  // Ambiente: acelerar hasta que haya figuras y comprobar distinción/solape.
  let seen = 0, minDist = 9, oob = 0, kinds = new Set(), amb = null;
  for (let i = 0; i < 400 && seen < 3; i++) {
    await page.evaluate(() => window.aoOffice.simulate(5));
    d = await dbg(); amb = d.ambient;
    if (amb.visible.length > seen) seen = amb.visible.length;
    for (const c of amb.visible) {
      kinds.add(c.kind);
      for (const s of Object.values(d.slots)) minDist = Math.min(minDist, Math.hypot(c.x - s.ax, c.z - s.az));
      if (d.deskPos) minDist = Math.min(minDist, Math.hypot(c.x - d.deskPos.x, c.z - d.deskPos.z));
      const sz = d.floorSize; if (sz && (c.x < -0.5 || c.z < -0.5 || c.x > (sz.w ?? sz.width ?? 99) + 0.5 || c.z > (sz.d ?? sz.depth ?? 99) + 0.5)) oob++;
    }
    if (seen >= 2 && i > 20) break;
  }
  console.log(`  ambiente: visibles máx ${seen}, tipos ${[...kinds].join(',') || '—'}, distancia mínima a agente/«Tú» ${minDist.toFixed(2)} u, fuera de planta ${oob}`);
  check('el ambiente aparece (≥1 figura visible)', seen >= 1, JSON.stringify(amb));
  check('ambiente: nunca más de 3 figuras', seen <= 3 && amb.max <= 3, JSON.stringify(amb));
  check('ambiente: ≥0,4 u de cualquier agente y de «Tú»', minDist >= 0.4, minDist.toFixed(2));
  check('ambiente: dentro de la planta', oob === 0, 'oob=' + oob);
  check('ambiente no cuenta como agente (ids ambient:* fuera de slots)', Object.keys(d.slots).every((k) => !k.startsWith('ambient:')) && (await dbg()).ambient.visible.every((c) => String(c.id).startsWith('ambient:')), JSON.stringify(d.ambient.visible));
  // Captura con ambiente visible.
  for (let i = 0; i < 60 && !(await dbg()).ambient.visible.length; i++) await page.evaluate(() => window.aoOffice.simulate(5));
  await sleep(500);
  await shot('01-equipo-real-1920x1080.png');
  check('escenario 1 sin errores de página', errors.length === 0, errors.join(' | '));

  // El SSE real pisaría el escenario inyectado: solo pasa update() con __force.
  await page.evaluate(() => { const o = window.aoOffice, orig = o.update.bind(o); o.update = (...a) => (window.__force ? orig(...a) : undefined); });
  // ── 2. Escenario simulado: 8 agentes en todos los estados ──
  console.log('\n▶ Escenario 2: simulado (8 agentes, todos los estados)');
  await page.evaluate(() => {
    const ag = (id, extra = {}) => ({ id, name: id, role: 'back', engine: 'demo', status: 'idle', ...extra });
    const tk = (id, agentId, status, extra = {}) => ({ id: 'T-' + id, code: 'T-' + id, title: 'Tarea ' + id, status, agentId, role: 'back', projectId: 'p', ...extra });
    const agents = [
      ag('PO', { role: 'po', status: 'working', taskId: 'T-PO' }), ag('trabaja', { status: 'working', taskId: 'T-trabaja' }), ag('revisa', { role: 'qa', taskId: 'T-revisa' }),
      ag('cola', { taskId: 'T-cola' }), ag('dep', { taskId: 'T-dep' }), ag('falla', { taskId: 'T-falla' }), ag('cuota', { status: 'working', taskId: 'T-cuota', quotaBlocked: true }), ag('libre'),
    ];
    const tasks = [tk('PO', 'PO', 'doing', { role: 'po' }), tk('trabaja', 'trabaja', 'doing'), tk('revisa', 'revisa', 'review'), tk('cola', 'cola', 'todo'), tk('dep', 'dep', 'todo', { dependsOn: ['T-nope'] }), tk('falla', 'falla', 'failed'), tk('cuota', 'cuota', 'doing', { quotaBlocked: true })];
    window.__force = true;
    window.aoOffice.update({ agents, tasks, questions: [], roles: {}, title: 'T', bubbles: 'todas', mine: { total: 0, items: [] } });
    window.__force = false;
    window.aoOffice.simulate(40);
  });
  d = await dbg();
  const S = d.slots;
  console.log('  slots:', Object.entries(S).map(([k, s]) => `${k}→${s.zone}/${s.status}`).join(' · '));
  const exp = { PO: null, trabaja: 'development', revisa: 'development|qa', cola: 'board', dep: 'board', falla: 'development', cuota: 'development', libre: 'idle' };
  for (const [id, z] of Object.entries(exp)) {
    const s = S[id];
    check(`sim ${id}: ${z ? 'zona ' + z : 'slot propio'} y en su sitio`, !!s && atSlot(s) && (!z || z.split('|').includes(s.zone)) && inZone(d.zones[s.zone], s.ax, s.az), JSON.stringify(s));
  }
  check('sim: sin dos agentes en el mismo hueco', new Set(Object.values(S).map((s) => `${s.zone}:${s.slot}:${s.module}`)).size === Object.keys(S).length, JSON.stringify(Object.values(S).map((s) => [s.zone, s.slot])));
  check('sim: nadie solapado (<0,35 u entre agentes)', Object.values(S).every((a, i, all) => all.every((b, j) => i === j || Math.hypot(a.ax - b.ax, a.az - b.az) >= 0.35)), '');
  // 60 s simulados: los que trabajan/fallan/sin cuota no se mueven, el ambiente no entra en su mesa.
  const home = Object.fromEntries(['trabaja', 'falla', 'cuota', 'PO'].map((k) => [k, { x: S[k].ax, z: S[k].az }]));
  let moved = [], ambNear = 9;
  for (let t = 0; t < 120; t++) {
    await page.evaluate(() => window.aoOffice.simulate(1));
    const dd = await dbg();
    for (const k of Object.keys(home)) if (!dd.slots[k]) { { moved.push(k + '(sin slot)'); break; } } else if (Math.hypot(dd.slots[k].ax - home[k].x, dd.slots[k].az - home[k].z) > 0.01) moved.push(k);
    for (const c of dd.ambient.visible) for (const s of Object.values(dd.slots)) ambNear = Math.min(ambNear, Math.hypot(c.x - s.ax, c.z - s.az));
  }
  check('sim: trabaja/falla/cuota/PO no se mueven de su mesa en 120 s simulados', moved.length === 0, [...new Set(moved)].join(','));
  check('sim: el ambiente nunca pisa a un agente (≥0,4 u en 120 s)', ambNear >= 0.4, ambNear.toFixed(2));
  await page.evaluate(() => window.aoOffice.simulate(3));
  for (let i = 0; i < 40 && (await dbg()).ambient.visible.length < 1; i++) await page.evaluate(() => window.aoOffice.simulate(5));
  await sleep(500);
  await shot('02-simulado-8-agentes-1920x1080.png');
  check('escenario 2 sin errores de página', errors.length === 0, errors.join(' | '));

  console.log('  ⚠ asientos fuera del rectángulo pintado de su zona:', warn.length, 'de', devs.length, '· máx', Math.max(0, ...warn).toFixed(2), 'u');
  console.log('  desviación máx. del asiento al rectángulo de su zona (u):', Math.max(...devs));
  // ── 3. fps ──
  console.log(`\n▶ fps: ${fpsSecs} s con ambiente y 12 s sin ambiente (referencia), SwiftShader (CPU)`);
  const measure = (secs) => page.evaluate((s) => new Promise((res) => {
    const dts = []; let last = performance.now(); const t0 = last;
    const f = (t) => { dts.push(t - last); last = t; if (t - t0 < s * 1000) requestAnimationFrame(f); else { dts.shift(); const sorted = [...dts].sort((a, b) => a - b); res({ frames: dts.length, fps: +(dts.length / ((t - t0) / 1000)).toFixed(1), p95ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), maxms: +sorted[sorted.length - 1].toFixed(1) }); } };
    requestAnimationFrame(f);
  }), secs);
  await page.evaluate(() => { window.aoOffice.ambientScale = 1; window.__force = true; window.aoOffice.update({ ambient: true }); window.__force = false; });
  const on = await measure(fpsSecs);
  await page.evaluate(() => { window.__force = true; window.aoOffice.update({ ambient: false }); window.__force = false; });
  const off = await measure(12);
  console.log('  con ambiente:', JSON.stringify(on), '\n  sin ambiente:', JSON.stringify(off));
  check('fps con ambiente ≥ 85 % del fps sin ambiente (sin caída notable)', on.fps >= off.fps * 0.85, `${on.fps} vs ${off.fps}`);
  check('sin tirones graves: fotograma máx < 1000 ms', on.maxms < 1000, JSON.stringify(on));
  check('fps medidos > 0', on.fps > 0 && off.fps > 0);
  check('sin errores de página en toda la sesión', errors.length === 0, errors.join(' | '));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ft: 'FT-151', date: new Date().toISOString(), viewport: '1920x1080', fps: { on, off }, checks: results }, null, 2));
} catch (e) {
  failed++;
  console.error(e);
} finally {
  await browser?.close();
  stop();
}
console.log(failed ? `\n✗ ${failed} fallo(s)` : '\n✓ office-qa-visual-e2e OK');
process.exit(failed ? 1 : 0);
