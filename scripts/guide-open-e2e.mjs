#!/usr/bin/env node
// FT-205 (QA de FT-202/FT-204): botón «Abrir la pantalla Guía» del cajón, menú lateral sin «Guía», Ctrl+G, #guide-fab,
// onGuideClick, orden SSE `ui` hacia guide, recarga en la vista Guía y consola limpia. Con Chrome headless.
//   node scripts/guide-open-e2e.mjs [--shots /ruta]   # capturas «después» (y «antes» = commit anterior a a65efb2 en una copia temporal)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.resolve((() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : os.tmpdir() + '/ft205-shots'; })());
fs.mkdirSync(shotsDir, { recursive: true });
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('No encuentro Chrome'); process.exit(2); }

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copia «antes»: el repo con public/ tal como estaba antes del commit a65efb2 (FT-204/FT-202).
function beforeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft205-before-'));
  for (const d of ['server', 'public', 'bin']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  for (const f of ['public/app.js', 'public/index.html']) fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `a65efb2^:${f}`], { cwd: ROOT, maxBuffer: 1e8 }));
  return dir;
}

async function boot(root) {
  const port = 7600 + Math.floor(Math.random() * 300);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ft205-'));
  const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, AO_PORT: String(port), AO_TEST_ALLOW_UNLINKED: '1', AO_DATA_DIR: dataDir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  const api = async (method, p, body) => (await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
  return { base, api, stop: () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
async function openPage(base, query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 850 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); });
  await page.goto(`${base}/${query}`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  return { page, errors };
}
const st = (page) => page.evaluate(() => ({
  panelHidden: document.querySelector('#guide-panel')?.hidden,
  viewGuideHidden: document.querySelector('#view-guide')?.hidden,
  navGuide: [...document.querySelectorAll('.nav-item')].filter((b) => b.dataset.tab === 'guide' || /gu[ií]a/i.test(b.textContent)).length,
  openBtn: document.querySelectorAll('#guide-panel [data-g="open"]').length,
  openBtnVisible: !!document.querySelector('#guide-panel [data-g="open"]')?.offsetParent,
  chatPanel: document.querySelector('#guide-panel .g-pick')?.value || '',
  chatView: document.querySelector('#view-guide .g-pick')?.value || '',
  visibleViews: [...document.querySelectorAll('.view')].filter((v) => !v.hidden).map((v) => v.id),
}));
const ctrlG = async (page) => { await page.keyboard.down('Control'); await page.keyboard.press('g'); await page.keyboard.up('Control'); await sleep(500); };

try {
  // ───── «antes»
  const bdir = beforeCopy();
  const B = await boot(bdir);
  let { page: bp } = await openPage(B.base);
  await bp.screenshot({ path: path.join(shotsDir, 'antes-menu.png'), clip: { x: 0, y: 0, width: 360, height: 850 } });
  await bp.click('#guide-fab'); await sleep(900);
  await bp.screenshot({ path: path.join(shotsDir, 'antes-cajon.png') });
  const bs = await st(bp);
  check('ANTES: el menú tenía «Guía» y el cajón no tenía el botón', bs.navGuide >= 1 && bs.openBtn === 0, JSON.stringify({ navGuide: bs.navGuide, openBtn: bs.openBtn }));
  await bp.close(); B.stop(); fs.rmSync(bdir, { recursive: true, force: true });

  // ───── «después»
  const A = await boot(ROOT);
  const { page, errors } = await openPage(A.base);
  let s = await st(page);
  check('(c) el menú lateral no tiene «Guía»', s.navGuide === 0, `nav-items con Guía: ${s.navGuide}`);
  await page.screenshot({ path: path.join(shotsDir, 'despues-menu.png'), clip: { x: 0, y: 0, width: 360, height: 850 } });
  await page.click('#collapse'); await sleep(400);
  s = await st(page);
  check('(c) rail colapsado: sin «Guía»', s.navGuide === 0 && await page.evaluate(() => document.querySelector('#sidebar').classList.contains('collapsed')));
  await page.screenshot({ path: path.join(shotsDir, 'despues-menu-colapsado.png'), clip: { x: 0, y: 0, width: 200, height: 850 } });
  await page.click('#collapse'); await sleep(300);

  await page.click('#guide-fab'); await sleep(900);
  s = await st(page);
  check('(a) #guide-fab abre el cajón con el botón nuevo', s.panelHidden === false && s.openBtn === 1 && s.openBtnVisible);
  await page.screenshot({ path: path.join(shotsDir, 'despues-cajon.png') });
  // chat común: creamos un chat en el cajón y comprobamos que la vista lo muestra
  await page.evaluate(() => document.querySelector('#guide-panel [data-g="new"]').click()); await sleep(600);
  const bodyPanel = await page.evaluate(() => document.querySelector('#guide-panel')?.innerText.replace(/\s+/g, ' ').slice(0, 400));
  const chatBefore = (await st(page)).chatPanel;
  await page.evaluate(() => document.querySelector('#guide-panel [data-g="open"]').click()); await sleep(900);
  s = await st(page);
  check('(b) el botón abre la vista Guía y cierra el cajón', s.panelHidden === true && s.viewGuideHidden === false && s.visibleViews.join() === 'view-guide', JSON.stringify(s.visibleViews));
  const bodyView = await page.evaluate(() => document.querySelector('#view-guide')?.innerText.replace(/\s+/g, ' '));
  check('(b) mismo chat en la pantalla (select y texto de los sugeridos)', s.chatView === chatBefore && bodyView.includes('Créame una tarea para solucionar esto') && bodyPanel.includes('Entiendo lo que estás viendo'), `cajón=${chatBefore || '(nuevo)'} vista=${s.chatView || '(nuevo)'}`);
  await page.screenshot({ path: path.join(shotsDir, 'despues-vista-guia.png') });

  // (g) con la vista Guía abierta, el cajón no se abre (ni por fab ni por Ctrl+G) → el botón nuevo no aparece
  await page.evaluate(() => document.querySelector('#guide-fab').click()); await sleep(300);
  s = await st(page);
  check('(g) en la vista Guía el #guide-fab no abre el cajón', s.panelHidden === true && s.visibleViews.join() === 'view-guide');
  await ctrlG(page); s = await st(page);
  check('(g)/(d) en la vista Guía Ctrl+G no abre el cajón ni rompe', s.panelHidden === true && s.visibleViews.join() === 'view-guide');

  // (e) recargar en la vista Guía
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(1200);
  s = await st(page);
  check('(e) recarga en la vista Guía: UI coherente (una sola vista visible, sin cajón)', s.visibleViews.length === 1 && s.panelHidden === true, JSON.stringify(s.visibleViews));
  await page.screenshot({ path: path.join(shotsDir, 'despues-recarga.png') });
  const reloadView = await page.goto(`${A.base}/?view=guide`, { waitUntil: 'networkidle2' }).then(() => sleep(1200)).then(() => st(page));
  check('(e) ?view=guide abre la vista Guía', reloadView.visibleViews.join() === 'view-guide' && reloadView.viewGuideHidden === false);

  // (d) Ctrl+G desde la oficina
  await page.evaluate(() => document.querySelector('.nav-item[data-tab="office"]').click()); await sleep(600);
  await ctrlG(page); s = await st(page);
  check('(d) Ctrl+G abre el cajón (con botón nuevo)', s.panelHidden === false && s.openBtnVisible);
  await ctrlG(page); s = await st(page);
  check('(d) Ctrl+G otra vez lo cierra', s.panelHidden === true);

  // (d) onGuideClick (clic en el Guía de la oficina 3D) → showTab('guide')
  const hasHook = await page.evaluate(() => typeof window.aoOffice !== 'undefined');
  await page.click('#guide-fab'); await sleep(600);
  await page.evaluate(() => window.aoOffice.openFloor({ guide: true })); await sleep(800);
  s = await st(page);
  check('(d) onGuideClick (planta Guía de la oficina 3D) abre la vista y cierra el cajón', hasHook && s.visibleViews.join() === 'view-guide' && s.panelHidden === true, s.visibleViews.join());

  // (d) orden SSE ui → guide (con el cajón abierto: debe cerrarse y mostrar la vista)
  await page.evaluate(() => document.querySelector('.nav-item[data-tab="office"]').click()); await sleep(400);
  await page.click('#guide-fab'); await sleep(700);
  const clientId = await page.evaluate(() => window.CLIENT_ID || null);
  const r = await A.api('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'guide' } });
  await sleep(1000);
  s = await st(page);
  check('(d) orden SSE ui navigate→guide: abre la vista y cierra el cajón', s.viewGuideHidden === false && s.panelHidden === true && s.visibleViews.join() === 'view-guide', `tool=${JSON.stringify(r).slice(0, 120)} clientId=${clientId}`);
  // y de vuelta a otra vista
  await A.api('POST', '/api/guide/tool', { name: 'app.navigate', args: { view: 'tasks' } }); await sleep(800);
  s = await st(page);
  check('(d) navigate→tasks sale de la vista Guía', s.visibleViews.join() === 'view-tasks', s.visibleViews.join());

  // (d) pestaña guardada «guide» → oficina
  await page.evaluate(() => localStorage.setItem('ao:tab', 'guide'));
  await page.goto(A.base + '/', { waitUntil: 'networkidle2' }); await sleep(1200);
  s = await st(page);
  check('(e) ao:tab=guide guardado → vuelve a la oficina', s.visibleViews.join() === 'view-office', s.visibleViews.join());

  const real = errors.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarkerNotSet/i.test(e));
  check('(f) sin errores de consola/página', real.length === 0, real.slice(0, 5).join(' | '));
  if (errors.length !== real.length) console.log(`  · ignorados (WebGL/headless): ${errors.length - real.length}`);
  A.stop();
} catch (e) {
  console.error('✗ excepción:', e.stack || e); fails++;
} finally {
  await browser.close();
}
console.log(`\nCapturas en ${shotsDir}`);
console.log(fails ? `✗ ${fails} fallo(s)` : '✓ todo correcto');
process.exit(fails ? 1 : 0);
