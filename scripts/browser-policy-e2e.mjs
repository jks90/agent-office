#!/usr/bin/env node
// FT-116 · e2e de la seguridad del navegador del agente: dominios (allow/block/ask), controles destructivos, evaluate,
// datos no confiables, handoff (browser.requestHuman) y auditoría. Driver FAKE (AO_BROWSER=fake).
//
//   node scripts/browser-policy-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bpolicy-e2e-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });

let failed = 0, passed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');

let proc = null, serverLog = '';
const cleanup = () => { try { proc?.kill('SIGTERM'); } catch { /* parado */ } try { stub.close(); } catch { /* nada */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  section('classify (unidad)');
  const dataDir = path.join(tmp, 'unit');
  process.env.AO_DATA_DIR = dataDir;
  const store = await import('../server/store.js');
  const { classify, setBrowserPolicy } = await import('../server/browser/policy.js');
  store.get().settings.browserPolicy = undefined;
  check('file:// y chrome:// → block', classify('file:///etc/passwd').action === 'block' && classify('chrome://settings').action === 'block' && classify('about:config').action === 'block');
  check('about:blank → allow', classify('about:blank').action === 'allow');
  check('localhost, 127.0.0.1, 192.168.x y host sin punto → block', ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.5/', 'http://10.0.0.2/', 'http://intranet/', 'http://[::1]/'].every((u) => classify(u).action === 'block'), JSON.stringify(classify('http://[::1]/')));
  check('dominio sin regla → ask por defecto', classify('https://nuevo.test/x').action === 'ask');
  setBrowserPolicy({ default: 'ask', domains: { 'https://Bien.test/algo': 'allow', 'mal.test': 'block', 'pregunta.test': 'ask', localhost: 'allow' } });
  check('allow / block / ask por dominio y subdominios', classify('https://www.bien.test/').action === 'allow' && classify('https://mal.test/').action === 'block' && classify('https://a.mal.test/').action === 'block' && classify('https://pregunta.test/').action === 'ask');
  check('localhost permitido explícitamente → allow; 127.0.0.1 sigue block', classify('http://localhost:8080/').action === 'allow' && classify('http://127.0.0.1/').action === 'block');
  setBrowserPolicy({ default: 'allow' });
  check('default allow no abre la red local', classify('https://otro.test/').action === 'allow' && classify('http://10.1.1.1/').action === 'block');

  section('servidor (driver fake)');
  const dir = path.join(tmp, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { flowTestUrl: `http://127.0.0.1:${stubPort}`, maxParallel: 4, workspaceHostDir: path.join(tmp, 'sin-workspace'), browserPolicy: { default: 'ask', domains: { 'ok.test': 'allow', 'mal.test': 'block' } } } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dir, AO_GUIDE_FAKE: '1', AO_DESKTOP: 'fake', AO_BROWSER: 'fake', AO_BROWSER_WAIT_CONTROL_MS: '1500' } });
  proc.stdout.on('data', (d) => { serverLog += d; });
  proc.stderr.on('data', (d) => { serverLog += d; });
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ao-client': 'bp-e2e' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) }; };
  if (!(await until(async () => { try { return (await call('GET', '/api/state')).ok; } catch { return false; } }))) throw new Error(`El servidor no arrancó:\n${serverLog}`);
  await call('POST', '/api/settings', { guideProvider: 'fake' });
  const tool = (n, a = {}) => call('POST', '/api/guide/tool', { name: n, args: a });
  const pending = async () => (await call('GET', '/api/questions')).body.filter((q) => q.kind === 'confirm');
  // lanza la tool, responde la confirmación pendiente (si answer) y devuelve { res, asked }; sin answer comprueba que NO pregunta
  const withAnswer = async (n, a, answer) => {
    const p = tool(n, a);
    let asked = null;
    if (answer) { asked = await until(async () => (await pending())[0], 8000, 80); if (asked) await call('POST', `/api/questions/${asked.id}/answer`, { answer }); } else { await sleep(300); asked = (await pending())[0] || null; }
    return { res: await p, asked };
  };
  const audit = () => { try { return fs.readFileSync(path.join(dir, 'guide-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  section('dominios');
  const ok = await withAnswer('browser.navigate', { url: 'https://ok.test/uno' }, null);
  check('dominio allow → navega sin preguntar', ok.res.ok && !ok.asked, JSON.stringify(ok.res.body));
  const bl = await withAnswer('browser.navigate', { url: 'https://mal.test/' }, null);
  check('dominio block → 403 sin preguntar', bl.res.status === 403 && !bl.asked && /no permitido/.test(bl.res.body.error || ''), JSON.stringify(bl.res.body));
  for (const u of ['file:///etc/passwd', 'chrome://settings', 'http://127.0.0.1:7420/', 'http://localhost:3000/']) {
    const r = await tool('browser.navigate', { url: u });
    check(`${u} → 403/400`, [400, 403].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
  }
  const nw = await withAnswer('browser.tabs', { action: 'new', url: 'https://nuevo.test/a' }, 'No');
  check('dominio nuevo → confirmación 🛡; «No» → 403', nw.asked?.kind === 'confirm' && /nuevo\.test/.test(nw.asked.question) && nw.res.status === 403, JSON.stringify(nw.asked));
  const y1 = await withAnswer('browser.navigate', { url: 'https://nuevo.test/a' }, 'Sí');
  check('«Sí» → navega', y1.res.ok, JSON.stringify(y1.res.body));
  const y2 = await withAnswer('browser.navigate', { url: 'https://nuevo.test/b' }, null);
  check('2.ª vez en la misma sesión → sin preguntar', y2.res.ok && !y2.asked);
  // bloqueo vía ajustes en caliente
  await call('POST', '/api/settings', { browserPolicy: { domains: { 'ok.test': 'allow', 'mal.test': 'block', 'nuevo.test': 'block' } } });
  const sn = await tool('browser.snapshot');
  check('la pestaña activa pasa a estar bloqueada → snapshot 403', sn.status === 403, JSON.stringify(sn.body));
  const st = (await call('GET', '/api/state')).body.settings.browserPolicy;
  check('Ajustes guardan browserPolicy (default + dominios normalizados)', st?.default === 'ask' && st.domains['nuevo.test'] === 'block');
  await call('POST', '/api/settings', { browserPolicy: { default: 'ask', domains: { 'ok.test': 'allow', 'mal.test': 'block' } } });
  await tool('browser.navigate', { url: 'https://ok.test/login' });

  section('controles destructivos y evaluate');
  await tool('browser.snapshot');
  const cl = await withAnswer('browser.click', { ref: 'e3' }, 'No');
  check('click en «Enviar» → irreversible, «No» → 403', cl.asked && /Enviar/.test(cl.asked.context) && cl.res.status === 403);
  const en = await withAnswer('browser.click', { ref: 'e6' }, 'No');
  check('click en «Entrar» con campo de contraseña en la página → irreversible', en.asked && /contraseña\/pago/.test(en.asked.context) && en.res.status === 403, JSON.stringify(en.asked));
  const lk = await withAnswer('browser.click', { ref: 'e4' }, null);
  check('click en un enlace normal → sin confirmación', lk.res.ok && !lk.asked);
  const ts = await withAnswer('browser.type', { ref: 'e2', text: 'x', submit: true }, 'No');
  check('type con submit → irreversible', ts.asked && ts.res.status === 403);
  const SECRET = 'hunter2-FT116';
  const pw = await withAnswer('browser.type', { ref: 'e5', text: SECRET }, null);
  check('type en la contraseña sin que el usuario la diera en un chat (FT-137) → 403 sin 🛡', pw.res.status === 403 && !pw.asked, JSON.stringify(pw.res.body));
  await call('POST', '/api/settings', { guidePolicy: { execute: 'auto', write: 'auto' } });
  const ev = await withAnswer('browser.evaluate', { expression: 'document.title' }, 'No');
  check('evaluate pide confirmación SIEMPRE aun con write/execute en automático', ev.asked && /JavaScript arbitrario/.test(ev.asked.context) && ev.res.status === 403);
  const ev2 = await withAnswer('browser.evaluate', { expression: 'document.title' }, 'Sí');
  check('evaluate confirmado → valor', ev2.res.ok && ev2.res.body.value !== undefined);

  section('datos no confiables');
  const sp = await tool('browser.snapshot');
  check('snapshot: untrusted + aviso + delimitadores', sp.body.untrusted === true && /DATOS NO CONFIABLES/.test(sp.body.aviso) && /^<<<DATOS_WEB_NO_CONFIABLES\n/.test(sp.body.snapshot) && /\[e3\] button "Enviar"/.test(sp.body.snapshot), JSON.stringify(sp.body).slice(0, 200));
  for (const [n, a] of [['browser.find', { role: 'button' }], ['browser.console', {}], ['browser.network', {}]]) {
    const r = await tool(n, a);
    check(`${n} lleva el aviso de datos no confiables`, r.ok && r.body.untrusted === true && /DATOS NO CONFIABLES/.test(r.body.aviso || ''), JSON.stringify(r.body).slice(0, 160));
  }
  check('el prompt del Guía lo advierte', /DATOS NO CONFIABLES/.test(fs.readFileSync(path.join(ROOT, 'server/guide/prompt.js'), 'utf8')));

  section('handoff · browser.requestHuman');
  check('registrada (navigate)', (await call('GET', '/api/guide/tools')).body.some((t) => t.name === 'browser.requestHuman' && t.policy === 'navigate'));
  const h = tool('browser.requestHuman', { motivo: 'Resuelve el captcha' });
  const q = await until(async () => (await pending())[0], 8000, 80);
  check('crea una pregunta 🛡 con «Listo»/«Cancelar» y pasa el control al usuario', q && /captcha/.test(q.question) && q.options.join() === 'Listo,Cancelar', JSON.stringify(q));
  const during = (await call('GET', '/api/state')).body.browser;
  check('mientras espera: control=user, handoff listado y el agente en pausa (409)', during?.control === 'user' && (during.handoffs || []).length === 1 && (await tool('browser.click', { ref: 'e4' })).status === 409, JSON.stringify(during));
  await call('POST', `/api/questions/${q.id}/answer`, { answer: 'Listo' });
  const hr = { res: await h };
  check('«Listo» → done:true', hr.res.ok && hr.res.body.done === true, JSON.stringify(hr.res.body));
  const after = (await call('GET', '/api/state')).body.browser;
  check('después: control=agent y sin handoffs', after.control === 'agent' && after.handoffs.length === 0, JSON.stringify(after));
  const hc = await withAnswer('browser.requestHuman', { motivo: 'Inicia sesión' }, 'Cancelar');
  check('«Cancelar» → done:false', hc.res.ok && hc.res.body.done === false && hc.res.body.cancelled === true, JSON.stringify(hc.res.body));

  section('auditoría');
  const log = audit();
  check('cada llamada lleva la URL de la página (sin query)', log.filter((e) => e.tool === 'browser.snapshot').every((e) => typeof e.page === 'string' || e.page === null) && log.some((e) => e.tool === 'browser.click' && /ok\.test\/login/.test(e.page || '')));
  check('navegar a un dominio bloqueado queda como error 403 con la URL', log.some((e) => e.tool === 'browser.navigate' && e.status === 403 && /mal\.test/.test(e.args?.url || '')));
  check('click: ref + policy irreversible + denied', log.some((e) => e.tool === 'browser.click' && e.args?.ref === 'e3' && e.policy === 'irreversible' && e.result === 'denied'));
  const raw = fs.readFileSync(path.join(dir, 'guide-audit.jsonl'), 'utf8');
  check('el valor tecleado en la contraseña NO está en el audit (solo chars)', !raw.includes(SECRET) && /"chars":\d+/.test(raw));
} catch (e) {
  failed++;
  console.log(`\n✗ Error inesperado: ${e.stack || e}\n${serverLog.slice(-1500)}`);
}
console.log(`\n${passed}/${passed + failed} checks${failed ? ` · ${failed} FALLAN` : ''}`);
process.exit(failed ? 1 : 0);
