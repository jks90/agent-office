// FT-144 · QA de extremo a extremo del Marketplace con TODO REAL en local: flow-accounts (BD flowaccounts_test),
// dos flow-test (orgs desechables A y B vinculadas por token), AgentOffice (servidores hijos, motor demo) y
// moderación en el admin. Nunca toca «empresatest» ni el catálogo real (catalogDir temporal en state.json).
// Uso: node scripts/marketplace-qa-e2e.mjs [carpetaCapturas]
//   env: ACCOUNTS_DIR (worktree/checkout de flow-accounts con .env.test), FLOWTEST_DIR (flow-test con server/index.js)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACC = process.env.ACCOUNTS_DIR || path.join(ROOT, '..', 'FT-144.accounts');
const FT = process.env.FLOWTEST_DIR || path.join(ROOT, '..', 'FT-144.flow-test');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-qa-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0, fails = 0;
const check = (cond, m, extra = '') => { console.log(cond ? '✓' : '✗', ++n, m, cond ? '' : extra); if (!cond) fails++; };
const procs = [];
const spawnP = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p; };
const waitUp = async (url, p) => { for (let i = 0; i < 120; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* aún no */ } if (p.exitCode !== null) throw new Error('proceso caído:\n' + p.log.slice(-800)); await sleep(250); } throw new Error('no arrancó ' + url + '\n' + p.log.slice(-800)); };
const MINE = (l) => (Array.isArray(l) ? l : []).filter((i) => ['revisor-qa', 'saluda-qa'].includes(i.name) && String(i.orgName).toLowerCase().replace(/ /g, '-') === A_SLUG); // la BD de test puede traer público de otras ejecuciones
const uniq = () => crypto.randomBytes(3).toString('hex');
const b64 = (s) => Buffer.from(s).toString('base64');

// ── flow-accounts local (BD de test) ──
const AP = 7191; const A_URL = `http://127.0.0.1:${AP}`;
const envFile = Object.fromEntries(fs.readFileSync(path.join(ACC, '.env.test'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const accounts = spawnP(process.execPath, ['server.js'], { cwd: ACC, env: { ...process.env, ...envFile, PORT: String(AP), INBOUND_PORT: '2591', MAIN_HOST: `localhost:${AP}`, PUBLIC_URL: A_URL, EMAIL_MODE: 'console', ADMIN_TOKEN: 'qa-admin', AUTO_PROVISION: 'off', ADMIN_USER: 'qa-admin', ADMIN_PASSWORD: 'QaAdmin-2026!', ADMIN_SESSION_TTL: '600', ORG_KEEP_AWAKE: '' } });
const ADM = { authorization: 'Bearer qa-admin', 'content-type': 'application/json' };
let browser, db, A_SLUG;
const done = async (code) => { try { browser?.close(); } catch { /* ya */ } try { await db?.end(); } catch { /* ya */ } procs.forEach((p) => { try { p.kill('SIGTERM'); } catch { /* ya */ } }); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

/** Cliente con cookie-jar mínimo contra flow-accounts. */
function jar() { let ck = ''; return async (m, p, b, h = {}) => { const r = await fetch(A_URL + p, { method: m, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: ck, ...h }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) ck = [ck, ...sc.map((s) => s.split(';')[0])].filter(Boolean).join('; '); return { status: r.status, json: await r.json().catch(() => ({})) }; }; }
async function newOrg(label) {
  const c = jar(); const email = `qa${uniq()}@t.local`;
  const reg = await c('POST', '/api/register', { email, password: 'Passw0rd!', orgName: `QA144 ${label} ${uniq()}` });
  const [rows] = await db.query('SELECT id FROM tickets WHERE type=? AND used=0 ORDER BY exp DESC LIMIT 1', ['verify']);
  await c('GET', `/verify?token=${rows[0].id}`);
  await fetch(`${A_URL}/api/admin/org/${reg.json.org}/comp`, { method: 'POST', headers: ADM, body: JSON.stringify({ plan: 'business', seats: 2 }) });
  await c('POST', '/api/login', { email, password: 'Passw0rd!' });
  const tok = (await c('POST', '/api/me/link-token', { label: 'qa144' })).json.token;
  return { slug: reg.json.org, token: tok };
}
const mkFlowTest = (port, token, tag) => { const dir = path.join(tmp, 'ft-' + tag); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.account-link'), token); return spawnP(process.execPath, ['server/index.js'], { cwd: FT, env: { ...process.env, PORT: String(port), FLOW_FLOWS_DIR: dir, FLOW_LICENSE_SERVER: A_URL, FLOW_AGENTS_TOKEN: 'qa-ao', FLOW_CLOUD_MANAGED: '' } }); };

/** AgentOffice hijo con catálogo temporal y flow-test indicado; devuelve cliente API. */
async function mkAO(tag, port, ftPort) {
  const data = path.join(tmp, 'ao-' + tag); const cat = path.join(tmp, 'cat-' + tag);
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(cat, 'roles'), { recursive: true }); fs.mkdirSync(path.join(cat, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ settings: { catalogDir: cat, workspaceHostDir: path.join(tmp, 'ws-' + tag), flowTestUrl: `http://127.0.0.1:${ftPort}`, maxParallel: 1 } }));
  const p = spawnP(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_PORT: String(port), AO_DATA_DIR: data, FLOW_AGENTS_TOKEN: 'qa-ao' } });
  const base = `http://127.0.0.1:${port}`; await waitUp(base + '/api/state', p);
  const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', 'x-ao-token': 'qa-ao' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  return { api, cat, base, port, p };
}

try {
  await waitUp(`${A_URL}/health`, accounts);
  const mysql = createRequire(path.join(ACC, 'package.json'))('mysql2/promise');
  db = await mysql.createPool(envFile.DATABASE_URL);
  const A = await newOrg('A'); A_SLUG = A.slug; const B = await newOrg('B');
  check(!!A.token && !!B.token && A.slug !== B.slug, `orgs desechables ${A.slug} (autora) y ${B.slug} (otra org) vinculadas`);
  const ftA = mkFlowTest(3971, A.token, 'a'); const ftB = mkFlowTest(3972, B.token, 'b');
  await waitUp('http://127.0.0.1:3971/access', ftA); await waitUp('http://127.0.0.1:3972/access', ftB);
  const gate = async (port, m, p, b) => { const r = await fetch(`http://127.0.0.1:${port}/account-link/marketplace${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

  // ── AgentOffice de la org A: catálogo con rol, skill con código y agente con memoria ──
  const aoA = await mkAO('a', 7691, 3971);
  fs.writeFileSync(path.join(aoA.cat, 'roles/revisor-qa.md'), '---\nname: revisor-qa\ndescription: Revisor de QA\nkind: qa\n---\n\nEres un revisor de QA meticuloso.\n');
  fs.mkdirSync(path.join(aoA.cat, 'skills/saluda-qa/scripts'), { recursive: true });
  fs.writeFileSync(path.join(aoA.cat, 'skills/saluda-qa/SKILL.md'), '---\nname: saluda-qa\ndescription: Saluda\n---\nDi hola.\n');
  fs.writeFileSync(path.join(aoA.cat, 'skills/saluda-qa/scripts/run.sh'), '#!/bin/sh\necho hola\n', { mode: 0o755 });
  const proj = (await aoA.api('GET', '/api/state')).j.projects[0] || (await aoA.api('POST', '/api/projects', { name: 'Demo' })).j;
  const ag = (await aoA.api('POST', '/api/agents', { name: 'Olga QA', role: 'revisor-qa', engine: 'demo', projectId: proj.id })).j;
  const MEM = '- Preferencia: usar tabs. QA144-memoria-del-agente';
  await aoA.api('PUT', `/api/memory/${proj.id}?agent=${ag.id}`, { text: MEM });
  check((await aoA.api('GET', '/api/marketplace/status')).j.linked === true, 'AgentOffice A ve flow-test A vinculado a la nube local');

  // 1 · publicar en TEAM: rol, skill con código y agente con memoria
  const pub = (b) => aoA.api('POST', '/api/marketplace/publish', b);
  const rTeam = await pub({ kind: 'role', id: 'revisor-qa', scope: 'team', version: '1.0.0', summary: 'Revisor QA' });
  const sTeam = await pub({ kind: 'skill', id: 'saluda-qa', scope: 'team', version: '1.0.0', summary: 'Saluda' });
  const gTeam = await pub({ kind: 'agent', id: ag.id, scope: 'team', version: '1.0.0', summary: 'Olga con memoria' });
  check([rTeam, sTeam, gTeam].every((r) => r.s === 200 && r.j.pending === false), 'publicar rol + skill + agente en team → visibles al momento', JSON.stringify([rTeam.j, sTeam.j, gTeam.j]));
  const listA = (await aoA.api('GET', '/api/marketplace/items?scope=team')).j;
  check(listA.length === 3 && listA.find((i) => i.kind === 'agent')?.hasMemory === true, 'lista team de A: 3 elementos y el agente con 🧠');

  // 2 · publicar en PÚBLICO: rol y skill quedan pendientes; agente rechazado en local
  const rPub = await pub({ kind: 'role', id: 'revisor-qa', scope: 'public', version: '1.0.0', summary: 'Revisor QA público' });
  const sPub = await pub({ kind: 'skill', id: 'saluda-qa', scope: 'public', version: '1.0.0', summary: 'Saluda público' });
  check(rPub.j.pending === true && sPub.j.pending === true, 'rol y skill en público → pending', JSON.stringify([rPub.j, sPub.j]));
  const gPub = await pub({ kind: 'agent', id: ag.id, scope: 'public' });
  check(gPub.s >= 400 && /equipo/.test(gPub.j.error || ''), 'AgentOffice rechaza agente en público', JSON.stringify(gPub));

  // 3 · la nube rechaza memoria y secretos en público (saltándose AgentOffice, directo a la puerta de flow-test)
  const file = (p, t) => ({ path: p, content: b64(t), sha256: crypto.createHash('sha256').update(t).digest('hex') });
  const base = { format: 'ao-pkg/1', kind: 'role', name: 'qa-malo', version: '1.0.0', summary: 'x', author: { name: 'QA' } };
  const mem = await gate(3971, 'POST', '', { scope: 'public', package: { ...base, files: [file('role.md', '# rol')], memory: { agent: '# secreto' } } });
  check(mem.s === 422, 'nube: público con memory → 422', JSON.stringify(mem));
  const agp = await gate(3971, 'POST', '', { scope: 'public', package: { ...base, kind: 'agent', files: [file('role.md', '# rol')] } });
  check(agp.s === 422, 'nube: público con kind agent → 422', JSON.stringify(agp));
  const SECRET = 'sk-' + 'A'.repeat(30);
  const sec = await gate(3971, 'POST', '', { scope: 'public', package: { ...base, name: 'qa-secreto', files: [file('role.md', `usa la clave ${SECRET}`)] } });
  check(sec.s === 422 && !JSON.stringify(sec.j).includes(SECRET), 'nube: público con token sk- → 422 sin repetir el secreto', JSON.stringify(sec));
  const secT = await gate(3971, 'POST', '', { scope: 'team', package: { ...base, name: 'qa-team-ok', files: [file('role.md', '# rol')] } });
  check(secT.s === 200 || secT.s === 201, 'nube: el mismo rol limpio sí entra en team', JSON.stringify(secT));

  // 4 · moderación: lo público propio sale pendiente en A; B no ve nada (ni team ni público)
  const pubA = MINE((await aoA.api('GET', '/api/marketplace/items?scope=public')).j);
  check(pubA.length === 2 && pubA.every((i) => i.status === 'pending'), 'A ve sus 2 públicos como pending', JSON.stringify(pubA.map((i) => i.status)));
  const aoB = await mkAO('b', 7692, 3972);
  const bPub0 = MINE((await aoB.api('GET', '/api/marketplace/items?scope=public')).j);
  const bTeam = (await aoB.api('GET', '/api/marketplace/items?scope=team')).j;
  check(Array.isArray(bPub0) && bPub0.length === 0, 'org B: lo público pendiente NO se ve hasta moderar', JSON.stringify(bPub0));
  check(Array.isArray(bTeam) && bTeam.length === 0, 'org B: no ve el team de A');
  const teamIdA = listA.find((i) => i.kind === 'agent').id;
  const peek = await aoB.api('GET', `/api/marketplace/items/${teamIdA}`);
  check(peek.s >= 400, `org B: pedir por id un elemento team de A falla (${peek.s})`, JSON.stringify(peek.j).slice(0, 200));
  const peekPub = await aoB.api('GET', `/api/marketplace/items/${pubA[0].id}`);
  check(peekPub.s >= 400, `org B: pedir por id un público pendiente falla (${peekPub.s})`);

  // 5 · admin: cola, revisión y aprobación (+ capturas)
  const q = await (await fetch(`${A_URL}/api/admin/marketplace?status=pending`, { headers: ADM })).json();
  const mine = (Array.isArray(q) ? q : q.items || []).filter((i) => pubA.some((p) => p.id === i.id));
  check(mine.length === 2, 'admin: la cola de moderación contiene los 2 pendientes de A', JSON.stringify(q).slice(0, 200));
  if (chrome && shots) {
    browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 860 } });
    const pg = await browser.newPage(); await pg.goto(`${A_URL}/admin.html`);
    await pg.evaluate(async () => { await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'qa-admin', password: 'QaAdmin-2026!' }) }); });
    await pg.goto(`${A_URL}/admin.html`); await sleep(800);
    await pg.evaluate(() => document.querySelector('[data-sec="mk"]')?.click()); await sleep(1200);
    await pg.evaluate(() => { const h = [...document.querySelectorAll('summary,h2,h3,.head,div')].reverse().find((e) => /Marketplace público/.test(e.textContent) && e.children.length < 6); h?.click(); }); await sleep(1500);
    await pg.screenshot({ path: path.join(shots, '01-admin-cola-moderacion.png') });
  }
  for (const it of mine) {
    const det = await (await fetch(`${A_URL}/api/admin/marketplace/${it.id}`, { headers: ADM })).json();
    check(JSON.stringify(det).length > 50, `admin: detalle de «${it.name}» (${it.kind}) con ficheros y escáner`);
    const ap = await fetch(`${A_URL}/api/admin/marketplace/${it.id}/approve`, { method: 'POST', headers: ADM, body: '{}' });
    check(ap.status === 200, `admin: aprobar «${it.name}»`, String(ap.status));
  }

  // 6 · otra org (B) ahora ve lo público y no lo team; instalar con 🛡 en su AgentOffice
  const bPub = MINE((await aoB.api('GET', '/api/marketplace/items?scope=public')).j);
  check(bPub.length === 2 && bPub.every((i) => i.status === 'published' || i.status === 'approved'), 'org B: tras aprobar ve los 2 públicos', JSON.stringify(bPub.map((i) => i.status)));
  check((await aoB.api('GET', '/api/marketplace/items?scope=team')).j.length === 0, 'org B sigue sin ver el team de A');
  const sk = bPub.find((i) => i.kind === 'skill'); const ro = bPub.find((i) => i.kind === 'role');
  const noConfirm = await aoB.api('POST', `/api/marketplace/items/${sk.id}/install`, {});
  check(noConfirm.s >= 400 && noConfirm.j.needsConfirm === 'code' && !fs.existsSync(path.join(aoB.cat, 'skills')) || (noConfirm.j.needsConfirm === 'code' && fs.readdirSync(path.join(aoB.cat, 'skills')).length === 0), 'instalar skill con código sin 🛡 → exige confirmar y no escribe nada', JSON.stringify(noConfirm.j).slice(0, 200));
  const yes = await aoB.api('POST', `/api/marketplace/items/${sk.id}/install`, { confirmCode: true });
  check(yes.s === 200 && fs.existsSync(path.join(aoB.cat, 'skills')) && fs.readdirSync(path.join(aoB.cat, 'skills')).length === 1, 'instalar skill con confirmCode → escrita en el catálogo de B', JSON.stringify(yes.j).slice(0, 200));
  const rIns = await aoB.api('POST', `/api/marketplace/items/${ro.id}/install`, {});
  check(rIns.s === 200, 'org B instala el rol público', JSON.stringify(rIns.j).slice(0, 200));
  const dl = await db.query('SELECT downloads FROM marketplace_items WHERE id=?', [sk.id]);
  check(Number(dl[0][0]?.downloads) >= 1, 'downloads incrementado en la nube');

  // 7 · instalar el AGENTE de team en otro AgentOffice de la MISMA org (A2) y comprobar que conserva su memoria
  const aoC = await mkAO('c', 7693, 3971);
  const projC = (await aoC.api('GET', '/api/state')).j.projects[0] || (await aoC.api('POST', '/api/projects', { name: 'Demo C' })).j;
  const needP = await aoC.api('POST', `/api/marketplace/items/${teamIdA}/install`, {});
  check(needP.s >= 400 && needP.j.needsConfirm === 'project', 'instalar agente exige elegir proyecto para su memoria', JSON.stringify(needP.j).slice(0, 200));
  const ins = await aoC.api('POST', `/api/marketplace/items/${teamIdA}/install`, { projectId: projC.id, agentName: 'Olga clon' });
  check(ins.s === 200 && ins.j.kind === 'agent', 'agente instalado en el proyecto elegido', JSON.stringify(ins.j).slice(0, 200));
  const clone = (await aoC.api('GET', '/api/state')).j.agents.find((a) => a.name === 'Olga clon');
  const mc = clone ? (await aoC.api('GET', `/api/memory/${projC.id}?agent=${clone.id}`)).j.text : '';
  check(!!clone && mc.includes('QA144-memoria-del-agente'), 'el agente instalado conserva su memoria', mc);
  if (browser && shots) {
    for (const [ao, tab, file] of [[aoC, 'team', '02-agentoffice-org-A-instalado-team.png'], [aoB, 'public', '03-agentoffice-org-B-publico.png']]) {
      const pg = await browser.newPage(); await pg.setViewport({ width: 1280, height: 860 });
      await pg.goto(ao.base); await pg.waitForSelector('[data-tab="marketplace"]'); await sleep(600); await pg.keyboard.press('Escape');
      await pg.evaluate(() => document.querySelector('[data-tab="marketplace"]').click()); await sleep(1500);
      if (tab === 'public') { await pg.evaluate(() => [...document.querySelectorAll('button,[data-scope]')].find((b) => /Público/.test(b.textContent))?.click()); await sleep(1200); }
      await pg.screenshot({ path: path.join(shots, file) });
    }
  }
  // 8 · la org autora puede retirar lo suyo; B no puede borrar lo de A
  const delB = await aoB.api('DELETE', `/api/marketplace/items/${teamIdA}`);
  check(delB.s >= 400, 'org B no puede retirar un elemento de A', JSON.stringify(delB.j).slice(0, 150));
  const delA = await aoA.api('DELETE', `/api/marketplace/items/${teamIdA}`);
  check(delA.s === 200, 'org A retira su agente de team', JSON.stringify(delA.j).slice(0, 150));
} catch (e) { console.log('✗ excepción:', e.stack || e); fails++; }
console.log(fails ? `\n✗ ${fails} fallos de ${n}` : `\n✓ marketplace-qa OK (${n} comprobaciones)`);
await done(fails ? 1 : 0);
