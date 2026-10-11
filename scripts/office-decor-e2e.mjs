#!/usr/bin/env node
// AO-5: comparar decoración de team-2/team-8 en Chrome; --before conserva las capturas de referencia.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = process.argv.includes('--before');
const stage = before ? 'before' : 'after';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-decor-'));
const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((p) => p && fs.existsSync(p));
assert.ok(chrome, 'Chrome/Chromium disponible (AO_CHROME)');
const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const stub = http.createServer((req, res) => {
  res.writeHead(req.url === '/access' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(req.url === '/access' ? JSON.stringify({ mode: 'licensed', plan: 'e2e' }) : '{}');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
// Datos aislados: el fixture no depende del workspace ni de proyectos reales.
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: path.join(tmp, 'workspace'), flowTestUrl: `http://127.0.0.1:${stub.address().port}` } }));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_DATA_DIR: tmp }, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.aoOffice?.ready, { timeout: 30000 });
  for (const n of (before ? [2, 8] : [2, 4, 6, 8])) {
    await page.evaluate((n) => {
      const agents = Array.from({ length: n }, (_, i) => ({ id: `decor-${i}`, name: `Agente ${i + 1}`, role: 'back', engine: 'demo', status: 'working', taskId: `AO-5-${i}`, projectId: 'ao5' }));
      const tasks = agents.map((a) => ({ id: a.taskId, code: a.taskId, title: 'Decoración de oficina', status: 'doing', agentId: a.id, projectId: 'ao5' }));
      const o = window.aoOffice;
      o.setMode('floor');
      o.update({ agents, tasks, questions: [], roles: {}, title: 'AO-5', projectId: 'ao5', selected: null, bubbles: 'todas' });
      o.simulate(40);
      o.resize();
    }, n);
    await sleep(1500);
    const layout = await page.evaluate(() => window.aoOffice.v3?.id);
    assert.equal(layout, `team-${n}`);
    if (!before) {
      const validation = await page.evaluate(async () => {
        const { Box3 } = await import('three');
        const { default: decor } = await import('/office-decor.js');
        const o = window.aoOffice, layout = o.v3;
        const group = o.scene.getObjectByName('office-decor-v3');
        if (!group) return ['falta el grupo office-decor-v3'];
        const issues = [];
        const expected = decor.items.filter((item) => item.mounting !== 'existing').reduce((n, item) => n + (item.placements[layout.id]?.length || 0), 0);
        if (group.children.length !== expected) issues.push(`objetos renderizados ${group.children.length}, esperados ${expected}`);
        group.updateWorldMatrix(true, true);
        const overlap = (box, r) => Math.min(box.max.x, r.x + r.w / 2) - Math.max(box.min.x, r.x - r.w / 2) > 0.01 && Math.min(box.max.z, r.z + r.d / 2) - Math.max(box.min.z, r.z - r.d / 2) > 0.01;
        for (const object of group.children) {
          const item = decor.items.find((item) => item.id === object.userData.decorId);
          if (!item) { issues.push(`objeto sin entrada de catálogo: ${object.name}`); continue; }
          const box = new Box3().setFromObject(object);
          if (box.isEmpty()) { issues.push(`${item.id}: geometría vacía`); continue; }
          if (item.mounting !== 'floor') continue;
          if (box.min.x < -0.01 || box.min.z < -0.01 || box.max.x > layout.floor.rx + 0.01 || box.max.z > layout.floor.rz + 0.01) issues.push(`${item.id}: fuera de planta`);
          for (const w of layout.walkways) if (overlap(box, w)) issues.push(`${item.id}: invade pasillo ${w.id}`);
          for (const a of layout.anchors) if (overlap(box, a)) issues.push(`${item.id}: invade ${a.id}`);
        }
        return issues;
      });
      assert.deepEqual(validation, [], `${layout}: decoración dentro de planta y libre de pasos y anclajes`);
    }
    if (n === 2 || n === 8) {
      const shot = path.join(os.tmpdir(), `AO-5-${stage}-team-${n}.png`);
      await (await page.$('.office-wrap')).screenshot({ path: shot });
      console.log(`✓ ${layout}: ${shot}`);
    } else console.log(`✓ ${layout}: geometría y pasos libres`);
  }
  assert.deepEqual(errors, [], 'sin errores de consola o página');
  console.log(`AO-5 office-decor-e2e ${stage} OK`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
