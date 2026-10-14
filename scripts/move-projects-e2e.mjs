// ⇄ e2e: mover una tarea, copiar una programada y mover un agente entre dos proyectos desde la UI (Chrome headless,
// servidor temporal con motor demo y proyectos sin carpeta). Uso: node scripts/move-projects-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../server/browser/cdp.js';
const PORT = 7400 + Math.floor(Math.random() * 300);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-move-e2e-'));
const srv = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), env: { ...process.env, AO_PORT: String(PORT), AO_DATA_DIR: dataDir, AO_AUTOUPDATE: 'off', AO_TEST_ALLOW_UNLINKED: '1' }, stdio: 'ignore' });
const B = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { await fetch(B + '/api/version'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };
const api = (m, p, b) => fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const A = await api('POST', '/api/projects', { name: 'Alfa', engine: 'demo', coordinator: false });
const Bp = await api('POST', '/api/projects', { name: 'Beta', engine: 'demo', coordinator: false, defaultTeam: false });
const t = await api('POST', '/api/tasks', { projectId: A.id, title: 'Tarea viajera', role: 'back', status: 'backlog' });
const sch = await api('POST', `/api/projects/${A.id}/schedules`, { title: 'Diaria', role: 'back', at: '09:00' });
const st0 = await api('GET', '/api/state'); const ag = st0.projects.find((p) => p.id === A.id).team[0];
const b = await puppeteer.launch({ executablePath: findBrowser(), headless: true });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
await p.evaluateOnNewDocument((id) => localStorage.setItem('ao:project', id), A.id);
await p.goto(B + '/?view=tasks', { waitUntil: 'networkidle2' });
const pick = async () => { await p.waitForSelector('#dialog[open] select[name="to"]'); await p.select('#dialog select[name="to"]', Bp.id); await p.evaluate(() => [...document.querySelectorAll('#dialog button')].find((x) => x.textContent === 'Aceptar').click()); await new Promise((r) => setTimeout(r, 800)); };
// tarea
await p.evaluate((id) => document.querySelector(`[data-xproj="${id}"]`).click(), t.id); await pick();
// programada
await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Programadas/.test(x.textContent)).click()); await p.waitForSelector('[data-sched-xcopy]'); await p.evaluate(() => document.querySelector('[data-sched-xcopy]').click()); await pick();
await p.keyboard.press('Escape');
// agente
await p.goto(B + '/?view=agents', { waitUntil: 'networkidle2' }); await p.evaluate((id) => document.querySelector(`[data-agent="${id}"]`)?.click(), ag); await p.waitForSelector(`[data-agent-xmove="${ag}"]`, { timeout: 5000 }).catch(() => {});
const hasAgentBtn = await p.evaluate((id) => !!document.querySelector(`[data-agent-xmove="${id}"]`), ag);
if (hasAgentBtn) { await p.evaluate((id) => document.querySelector(`[data-agent-xmove="${id}"]`).click(), ag); await pick(); }
const st = await api('GET', '/api/state');
const tt = st.tasks.find((x) => x.id === t.id);
check(tt.projectId === Bp.id && tt.code !== t.code, `tarea movida a Beta como ${tt.code} (antes ${t.code})`);
const sa = st.projects.find((x) => x.id === A.id).schedules, sb = st.projects.find((x) => x.id === Bp.id).schedules;
check(sa.length === 1 && sb.length === 1 && sb[0].enabled === false, 'programada copiada a Beta y pausada; sigue en Alfa');
check(hasAgentBtn && st.projects.find((x) => x.id === Bp.id).team.includes(ag) && !st.projects.find((x) => x.id === A.id).team.includes(ag), 'agente movido de Alfa a Beta desde su cajón');
await b.close();
srv.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
