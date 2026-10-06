#!/usr/bin/env node
// e2e de los adjuntos del chat del Guía (FT-90): pegar (Ctrl+V), arrastrar y soltar, botón «Adjuntar», quitar, límites,
// envío con referencias y chat solo texto. Proveedor `fake` (AO_GUIDE_FAKE=1): hace eco del prompt, así que el eco
// demuestra que al agente le llega la ruta guardada. Usa puppeteer-core (devDependency) y Chrome (AO_CHROME).
//
//   node scripts/guide-attach-e2e.mjs [captura.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-attach-e2e-'));
const dataDir = path.join(tmp, 'data'), homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_GUIDE_FAKE: '1', AO_FLOWTEST_URL: `http://127.0.0.1:${stubPort}` } });
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(200); } }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
try {
  await api('POST', '/api/settings', { guideProvider: 'fake' });
  const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
  if (!check('hay Chrome/Chromium (AO_CHROME)', !!chrome)) throw new Error('sin Chrome');
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/?view=guide`);
    await page.waitForSelector('#view-guide textarea');
    const R = '#view-guide';
    const chips = () => page.$$eval(`${R} .g-chip`, (c) => c.map((x) => ({ img: !!x.querySelector('img'), name: x.querySelector('.g-cname').textContent })));
    const waitChips = async (n) => { for (let i = 0; i < 50; i++) { if ((await chips()).length === n) return true; await sleep(100); } return false; };
    // Construye un File en la página y lo entrega por el evento indicado.
    const fire = (kind, name, type, bytes) => page.evaluate((kind, name, type, bytes, sel) => {
      const f = new File([new Uint8Array(bytes)], name, { type });
      const dt = new DataTransfer(); dt.items.add(f);
      if (kind === 'paste') { const ev = new Event('paste', { bubbles: true, cancelable: true }); ev.clipboardData = dt; document.querySelector(sel + ' textarea').dispatchEvent(ev); }
      else if (kind === 'drop') { const main = document.querySelector(sel + ' .g-main'); main.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt })); window.__dragOn = main.classList.contains('drag'); main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); }
    }, kind, name, type, [...bytes], R);

    // 1) Ctrl+V de una imagen (con texto ya escrito: el texto pegado no se toca)
    await page.type(`${R} textarea`, 'mira esto');
    await fire('paste', 'captura.png', 'image/png', PNG);
    check('pegar imagen → adjunto con miniatura', await waitChips(1) && (await chips())[0].img);
    check('el texto de la caja sigue igual', (await page.$eval(`${R} textarea`, (t) => t.value)) === 'mira esto');
    // 2) Arrastrar y soltar un fichero de texto
    await fire('drop', 'notas.txt', 'text/plain', Buffer.from('hola desde el adjunto'));
    check('indicación visual al arrastrar', await page.evaluate(() => window.__dragOn === true));
    check('soltar fichero → adjunto sin miniatura', await waitChips(2) && !(await chips())[1].img && (await chips())[1].name === 'notas.txt');
    check('la indicación desaparece al soltar', await page.$eval(`${R} .g-main`, (m) => !m.classList.contains('drag')));
    // 3) Botón «Adjuntar» (múltiples)
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(`${R} .g-clip`)]);
    const f1 = path.join(tmp, 'a.txt'), f2 = path.join(tmp, 'b.txt');
    fs.writeFileSync(f1, 'a'); fs.writeFileSync(f2, 'b');
    await chooser.accept([f1, f2]);
    check('botón Adjuntar añade varios', await waitChips(4));
    // 4) Quitar uno
    await page.click(`${R} .g-chip:last-child button`);
    check('quitar un adjunto', await waitChips(3));
    // 5) Límites en cliente: demasiado grande y demasiados
    const toasts = () => page.$$eval('.toast', (t) => t.map((x) => x.textContent));
    await page.evaluate((sel) => { const dt = new DataTransfer(); const f = new File(['x'], 'enorme.bin'); Object.defineProperty(f, 'size', { value: 26e6 }); dt.items.add(f); document.querySelector(sel + ' .g-main').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); }, R);
    await sleep(300);
    check('fichero > 25 MB rechazado con mensaje', (await toasts()).some((t) => /demasiado grande/.test(t)) && (await chips()).length === 3, JSON.stringify(await toasts()));
    await page.evaluate((sel) => { const dt = new DataTransfer(); for (let i = 0; i < 8; i++) dt.items.add(new File(['x'], `m${i}.txt`)); document.querySelector(sel + ' .g-main').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); }, R);
    await sleep(300);
    check('más de 10 adjuntos rechazado con mensaje', (await toasts()).some((t) => /Máximo 10/.test(t)) && (await chips()).length === 3);
    await page.screenshot({ path: process.argv[2] || path.join(tmp, 'attach.png') });
    // 6) Enviar: la lista se vacía, el mensaje muestra los adjuntos y el agente recibe las rutas
    await page.focus(`${R} textarea`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${R} .g-msg.assistant`, { timeout: 15000 });
    check('tras enviar la lista queda vacía', (await chips()).length === 0);
    const html = await page.$eval(`${R} .g-msg.user`, (m) => m.innerHTML);
    check('el historial muestra miniatura y ficheros', /<img/.test(html) && /notas\.txt/.test(html), html.slice(0, 200));
    const echo = await page.$eval(`${R} .g-msg.assistant`, (m) => m.textContent);
    const up = path.join(dataDir, 'uploads');
    check('el agente recibe las rutas guardadas', echo.includes(up) && echo.includes('notas.txt') && echo.includes('captura.png'), echo.slice(0, 200));
    const files = fs.readdirSync(up).flatMap((d) => fs.readdirSync(path.join(up, d)));
    check('el servidor guardó los ficheros', files.includes('captura.png') && files.includes('notas.txt'));
    // 7) Solo texto sigue igual
    await page.waitForFunction((s) => !document.querySelector(s + ' .g-typing') && !document.querySelector(s + ' textarea').disabled, {}, R);
    await page.type(`${R} textarea`, 'solo texto');
    await page.keyboard.press('Enter');
    await page.waitForFunction((s) => [...document.querySelectorAll(s + ' .g-msg.assistant')].some((m) => m.textContent.includes('fake: solo texto')), { timeout: 15000 }, R);
    check('chat solo con texto (Intro envía)', !(await page.$$eval(`${R} .g-msg.user`, (m) => m.at(-1).innerHTML.includes('g-files'))));
    check('sin errores de página', !errors.length, errors.join(' | '));
  } finally { await browser.close(); }
  // Servidor: path traversal y límites
  const bad = await api('POST', '/api/guide/chat', { text: 'x', attachments: [{ path: '/etc/passwd' }] });
  check('ruta fuera de data/uploads → 400', bad.status === 400);
} catch (e) { failed++; console.log('  ✗', e.message); }
server.kill(); stub.close();
console.log(failed ? `\n✗ ${failed} fallos` : '\n✓ todo bien');
process.exit(failed ? 1 : 0);
