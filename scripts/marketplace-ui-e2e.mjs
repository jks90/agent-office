// FT-142 · e2e de UI del Marketplace: vista 🛒 (team/público, filtro, 🧠, pendiente), sin vincular, ⬆ Publicar en
// roles/skills/agentes con previsualización e ⬇ Instalar con 🛡. flow-test simulado. Uso: node scripts/marketplace-ui-e2e.mjs [captura.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mku-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
if (!chrome) { console.log('SKIP: sin Chrome/Chromium (AO_CHROME)'); process.exit(0); }
let n = 0; const ok = (m) => console.log(`✓ ${++n} ${m}`);

const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const file = (p, s) => ({ path: p, content: b64(s), sha256: sha(s) });
const skillPkg = { format: 'ao-pkg/1', kind: 'skill', name: 'saluda', version: '1.0.0', summary: 'Saluda', author: { name: 'Ana' }, files: [file('SKILL.md', '---\nname: saluda\ndescription: Saluda\n---\nHola\n'), file('scripts/run.sh', '#!/bin/sh\necho hi\n')], meta: { hasCode: true } };
const items = [
  { id: 'm1', scope: 'team', kind: 'skill', name: 'saluda', version: '1.0.0', summary: 'Saluda', author: { name: 'Ana' }, orgName: 'boss-test', hasMemory: false, downloads: 3, status: 'approved', package: skillPkg },
  { id: 'm2', scope: 'team', kind: 'agent', name: 'rev-uno', version: '2.0.0', summary: 'Revisor con memoria', author: { name: 'Ana' }, orgName: 'boss-test', hasMemory: true, downloads: 1, status: 'approved', package: { ...skillPkg, kind: 'agent', name: 'rev-uno', files: [], meta: { role: 'qa' }, memory: { agent: '- tabs' } } },
  { id: 'm3', scope: 'public', kind: 'role', name: 'poeta', version: '0.1.0', summary: 'Escribe versos', author: { name: 'Ana' }, orgName: 'boss-test', hasMemory: false, downloads: 0, status: 'pending', package: skillPkg },
];
let linked = true; const posted = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (s, o) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  const id = u.pathname.split('/')[3]; let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!linked) return send(409, { error: 'vincula la instalación a tu cuenta FlowTest' });
    if (req.method === 'POST') { posted.push(JSON.parse(body)); return send(200, { item: { id: 'new' } }); }
    if (!id) { const k = u.searchParams.get('kind'); return send(200, items.filter((i) => i.scope === u.searchParams.get('scope') && (!k || i.kind === k)).map(({ package: _p, ...i }) => i)); }
    const it = items.find((i) => i.id === id); const { package: pkg, ...item } = it; send(200, { item, package: pkg });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

const port = 7600 + Math.floor(Math.random() * 100);
const dataDir = path.join(tmp, 'data'); const cat = path.join(tmp, 'cat');
fs.mkdirSync(path.join(cat, 'roles'), { recursive: true }); fs.mkdirSync(path.join(cat, 'skills/mia'), { recursive: true });
fs.writeFileSync(path.join(cat, 'roles/revisor.md'), '---\nname: revisor\ndescription: Revisa\nkind: qa\n---\n\nEres revisor.\n');
fs.writeFileSync(path.join(cat, 'skills/mia/SKILL.md'), '---\nname: mia\ndescription: Mía\n---\nTexto\n');
// Catálogo y workspace temporales ANTES de arrancar: instalar nunca debe tocar el catálogo real del usuario.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { catalogDir: cat, workspaceHostDir: path.join(tmp, 'ws'), flowTestUrl: `http://127.0.0.1:${fake.address().port}`, maxParallel: 1 } }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: dataDir }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
let browser;
const done = (code) => { try { server.kill('SIGTERM'); } catch { /* ya */ } fake.close(); fake.closeAllConnections?.(); browser?.close().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.equal((await api('GET', '/api/skills')).j.catalogDir, cat, 'catálogo temporal');
  const demo = (await api('GET', '/api/state')).j.projects[0] || (await api('POST', '/api/projects', { name: 'Demo' })).j;
  await api('POST', '/api/agents', { name: 'Olga', role: 'revisor', engine: 'demo', projectId: demo.id });

  // API: estado vinculado y 412 sin vincular
  assert.equal((await api('GET', '/api/marketplace/status')).j.linked, true);
  linked = false;
  const nl = await api('GET', '/api/marketplace/items?scope=team');
  assert.equal(nl.s, 412); assert.equal(nl.j.unlinked, true); assert.match(nl.j.linkUrl, /account-link/);
  ok('API: sin vincular → 412 con enlace');

  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--window-size=1280,900'], defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tab="marketplace"]');
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const dlgOpen = () => page.waitForFunction(() => document.querySelector('#dialog')?.open);
  const esc = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#dialog')?.open); };

  await click('[data-tab="marketplace"]');
  await page.waitForSelector('.mp-unlinked a');
  assert.match(await page.$eval('.mp-unlinked', (e) => e.textContent), /vincul/i);
  ok('UI: aviso sin vincular con enlace');

  linked = true;
  await click('[data-mp-reload]');
  await page.waitForFunction(() => document.querySelectorAll('.mp-card').length === 2);
  const txt = await page.$eval('#mp-list', (e) => e.textContent);
  assert(txt.includes('🧠') && txt.includes('saluda') && txt.includes('rev-uno'));
  await click('[data-mp-tab="public"]');
  await page.waitForFunction(() => /pendiente de moderación/.test(document.querySelector('#mp-list')?.textContent || ''));
  await click('[data-mp-tab="team"]');
  await page.waitForFunction(() => document.querySelectorAll('.mp-card').length === 2);
  await page.select('#mp-kind', 'agent');
  await page.waitForFunction(() => document.querySelectorAll('.mp-card').length === 1);
  await page.select('#mp-kind', '');
  await page.waitForFunction(() => document.querySelectorAll('.mp-card').length === 2);
  if (shot) await page.screenshot({ path: shot });
  ok('UI: pestañas team/público, filtro por tipo, 🧠 y pendiente de moderación');

  // Instalar skill con código → 🛡 obligatorio y lista de ficheros
  await click('[data-mp-install="m1"]');
  await dlgOpen();
  const d = await page.$eval('#dialog', (e) => e.textContent);
  assert(d.includes('scripts/run.sh') && d.includes('🛡'));
  assert(await page.$eval('#dialog input[name=confirmCode]', (e) => e.required));
  await page.evaluate(() => { document.querySelector('#dialog input[name=confirmCode]').checked = true; document.querySelector('#dialog form').requestSubmit(); });
  await page.waitForFunction(() => !document.querySelector('#dialog')?.open);
  assert(fs.existsSync(path.join(cat, 'skills/saluda/scripts/run.sh')));
  ok('UI: instalar skill con código pide 🛡 y la instala');

  // Instalar agente → proyecto obligatorio
  await click('[data-mp-install="m2"]');
  await dlgOpen();
  assert(await page.$eval('#dialog select[name=projectId]', (e) => e.required));
  await esc();
  ok('UI: instalar agente pide proyecto destino');

  // Publicar desde el catálogo de roles y skills y desde la ficha del agente
  // los roles y el banquillo viven en Marketplace ▸ 🔒 Privado, con las mismas tarjetas
  await click('[data-mp-tab="private"]');
  await page.waitForSelector('#mp-list [data-mp-pub^="role:"]');
  assert(!(await page.$('#view-agents #roles')) && !(await page.$('#view-agents #bench')));
  ok('UI: 🔒 Privado lista los roles como tarjetas del marketplace (y ya no están en Agentes)');
  await click('[data-tab="agents"]');
  await page.waitForSelector('[data-mp-pub^="skill:"]');
  assert(await page.$('[data-mp-pub^="agent:"]'));
  await click('[data-mp-pub="skill:mia"]');
  await dlgOpen();
  await page.waitForFunction(() => /SKILL\.md/.test(document.querySelector('#mp-prev')?.textContent || ''));
  assert.equal(await page.$eval('#mp-ver', (e) => e.value), '1.0.0');
  await page.select('#mp-scope', 'public');
  await page.evaluate(() => document.querySelector('#dialog form').requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#dialog')?.open);
  assert.equal(posted.at(-1).scope, 'public'); assert.equal(posted.at(-1).package.name, 'mia');
  ok('UI: ⬆ Publicar skill con previsualización y ámbito público');

  const agentBtn = await page.$eval('[data-mp-pub^="agent:"]', (e) => e.dataset.mpPub);
  await click(`[data-mp-pub="${agentBtn}"]`);
  await dlgOpen();
  await page.waitForFunction(() => /fichero/.test(document.querySelector('#mp-prev')?.textContent || ''));
  assert.deepEqual(await page.$$eval('#mp-scope option', (o) => o.map((x) => x.value)), ['team']);
  await esc();
  ok('UI: publicar agente solo ofrece team');

  assert.deepEqual(errs, []);
  ok('sin excepciones en la UI');
  console.log(`\n${n} OK`);
  done(0);
} catch (e) { console.error('✗', e.message); done(1); }
