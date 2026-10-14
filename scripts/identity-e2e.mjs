#!/usr/bin/env node
// 🪪 Identidad inmutable del agente: muñeco isométrico (miniatura + oficina 3D) que no cambia al renombrar (bautizo),
// «nació como …» visible, ficha 🪪 con bautizos, y paquete exportar → importar con el mismo uid y muñeco.
// Servidor temporal (datos, catálogo y workspace en tmp) + Chrome headless. Capturas en resumen/identity-*.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(ROOT, 'resumen');
const port = 7890 + Math.floor(Math.random() * 80);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-identity-e2e-'));
const tmp = (n) => { const d = path.join(dataDir, n); fs.mkdirSync(d, { recursive: true }); return d; };
// Nunca el catálogo ni el workspace reales: un servidor temporal que los use escribe en los roles de verdad.
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ projects: [], agents: [], tasks: [], schema: 3,
  settings: { flowTestUrl: 'http://127.0.0.1:1', maxParallel: 1, catalogDir: tmp('catalog'), workspaceHostDir: tmp('ws') } }));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome/Chromium (AO_CHROME)'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} -> ${r.status} ${j.error || ''}`), { status: r.status });
  return j;
};
const stop = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } };
process.on('exit', stop);

let browser;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const project = await api('POST', '/api/projects', { name: 'Identidad', coordinator: false });
  for (const id of [...(project.team || [])]) await api('PATCH', `/api/projects/${project.id}/team`, { remove: [id] });
  const names = [['Berta', 'back'], ['Lola', 'front'], ['Xavi', 'qa'], ['Nora', 'back'], ['Teo', 'front'], ['Iris', 'qa']];
  const agents = [];
  for (const [name, role] of names) agents.push(await api('POST', '/api/agents', { name, role, engine: 'demo', projectId: project.id }));
  const berta = agents[0];
  check('nace con identidad (uid, birthName, físico)', /^ag_/.test(berta.identity?.uid) && berta.identity.birthName === 'Berta' && !!berta.identity.avatar?.base);

  // Bautizo por API
  const renamed = await api('PATCH', `/api/agents/${berta.id}`, { name: 'Contable' });
  check('bautizo: cambia el nombre, no la identidad', renamed.name === 'Contable' && JSON.stringify(renamed.identity) === JSON.stringify(berta.identity));
  check('bautizo queda en el historial', renamed.baptisms?.at(-1)?.from === 'Berta' && renamed.baptisms.at(-1).to === 'Contable');
  let blocked = 0; try { await api('PATCH', `/api/agents/${berta.id}`, { identity: { ...berta.identity, birthName: 'Otra' } }); } catch (e) { blocked = e.status; }
  check('la identidad no se puede cambiar (409)', blocked === 409, String(blocked));

  // Paquete: exportar → importar = mismo uid y muñeco
  const pkg = await api('POST', '/api/marketplace/export', { kind: 'agent', id: berta.id, scope: 'team', projectId: project.id });
  const imp = await api('POST', '/api/marketplace/import', { package: pkg, projectId: project.id });
  check('importado: id local nuevo, misma identidad', imp.agent.id !== berta.id && imp.agent.identity.uid === berta.identity.uid && imp.agent.identity.fingerprint === berta.identity.fingerprint);
  check('importado: conserva nombre y nacimiento', imp.agent.name === 'Contable' && imp.agent.identity.birthName === 'Berta');
  agents.push(imp.agent); // clon: misma identidad, también en la oficina

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice?.debugState().actors > 0, { timeout: 15000 });
  await page.addStyleTag({ content: '#suite-lock{display:none!important} body *{filter:none!important;backdrop-filter:none!important}' }); // sin flow-test: el aviso tapa la oficina
  await sleep(2500);
  await page.screenshot({ path: path.join(outDir, 'identity-office.png') });

  // Oficina 3D: accesorios colgados de la cabeza y ropa teñida (vertexColors) según la identidad
  const office = await page.evaluate(() => {
    const o = window.aoOffice; let acc = 0, tinted = 0;
    for (const a of o.actors.values()) a.group.traverse((m) => { if (m.name === 'accessory') acc++; if (m.isMesh && m.material?.vertexColors) tinted++; });
    return { actors: o.actors.size, acc, tinted };
  });
  const withAcc = agents.filter((a) => a.identity.avatar.accessory !== 'none').length;
  check('oficina: un muñeco por agente', office.actors === agents.length, JSON.stringify(office));
  check('oficina: accesorios según la identidad', office.acc === withAcc, `${office.acc} de ${withAcc}`);
  check('oficina: ropa teñida', office.tinted >= agents.length, JSON.stringify(office));

  // Agentes: miniaturas isométricas en los avatares y «nació como Berta»
  await page.click('[data-tab="agents"]');
  await page.waitForFunction(() => document.querySelectorAll('.avatar.has-doll img').length >= 3, { timeout: 15000 }).catch(() => {});
  const dolls = await page.evaluate(() => document.querySelectorAll('.avatar.has-doll img').length);
  check('avatares con muñeco isométrico', dolls >= 3, String(dolls));
  const born = await page.evaluate(() => [...document.querySelectorAll('.born')].map((e) => e.textContent).join('|'));
  check('se ve con qué nombre nació', /nació como «Berta»/.test(born), born);
  await page.screenshot({ path: path.join(outDir, 'identity-agents.png') });
  // Galería: las miniaturas isométricas en grande (una por identidad)
  await page.evaluate(() => {
    const seen = new Set(), box = document.createElement('div');
    box.id = 'doll-gallery'; box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1b2130;display:flex;flex-wrap:wrap;gap:16px;padding:24px;align-content:flex-start';
    for (const el of document.querySelectorAll('.avatar.has-doll')) {
      const src = el.querySelector('img').src; if (seen.has(src)) continue; seen.add(src);
      const name = el.closest('[data-org-toggle],[data-agent]')?.querySelector('b')?.textContent || '';
      box.insertAdjacentHTML('beforeend', `<figure style="margin:0;text-align:center;color:#ddd;font:13px sans-serif"><img src="${src}" style="width:256px;height:256px;background:#2a3245;border-radius:16px"><figcaption>${name}</figcaption></figure>`);
    }
    document.body.append(box);
  });
  await page.screenshot({ path: path.join(outDir, 'identity-gallery.png') });
  await page.evaluate(() => document.getElementById('doll-gallery').remove());

  // El muñeco no cambia al renombrar: misma miniatura antes y después
  const doll = (id) => page.evaluate((id) => document.querySelector(`.avatar[data-avatar="${id}"] img`)?.src || '', id);
  const before = await doll(agents[1].id);
  await api('PATCH', `/api/agents/${agents[1].id}`, { name: 'Lolita' });
  await page.waitForFunction((id) => [...document.querySelectorAll(`.avatar[data-avatar="${id}"]`)].some((e) => e.closest('[data-agent],[data-org-toggle]')?.textContent.includes('Lolita') && e.querySelector('img')), { timeout: 10000 }, agents[1].id).catch(() => {});
  const after = await doll(agents[1].id);
  check('renombrar no cambia el muñeco', before && before === after);

  // Ficha: sección 🪪 con nacimiento y bautizos
  await page.evaluate((id) => document.querySelector(`[data-org-toggle="${id}"]`)?.click(), berta.id);
  await sleep(200);
  await page.evaluate((id) => document.querySelector(`.top[data-agent="${id}"]`)?.click() || document.querySelector(`[data-agent="${id}"]`)?.click(), berta.id);
  await page.waitForSelector('#drawer [data-f=identity] .identity', { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => document.querySelector('#drawer [data-f=identity]')?.textContent.replace(/\s+/g, ' ') || '');
  check('ficha: nació como Berta y 1 bautizo', /Nació como\s*Berta/.test(card) && /1 bautizo/.test(card), card.slice(0, 160));
  await page.evaluate(() => document.querySelector('#drawer .baptisms')?.setAttribute('open', ''));
  await sleep(1200);
  await page.screenshot({ path: path.join(outDir, 'identity-drawer.png') });

  check('consola limpia', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++; console.error(e);
} finally {
  await browser?.close();
  console.log(failed ? `✗ ${failed} fallo(s)` : '✓ identidad OK');
  process.exit(failed ? 1 : 0);
}
