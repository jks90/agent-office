#!/usr/bin/env node
// e2e de FT-63 · evitar la compactación automática: medir el contexto, pedir notas al pasar el umbral, relanzar con ellas
// y mandar al PO las tareas grandes. Servidor temporal + `claude` FALSO (AO_CLAUDE_BIN) que reporta uso creciente y, al recibir
// la instrucción de compactar por stdin, escribe NOTAS.md y termina su turno. Sin red ni CLIs reales:  node scripts/compact-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as compact from '../server/compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

console.log('Funciones puras');
check('umbral por defecto 62 %', compact.threshold(undefined) === 0.62);
check('umbral 0 = apagado', compact.threshold(0) === 0);
check('umbral en porcentaje (70) → 0.7', compact.threshold(70) === 0.7);
check('ventana de 200k por defecto y 1M con [1m]', compact.windowOf({}, 'sonnet') === 200_000 && compact.windowOf({}, 'sonnet[1m]') === 1_000_000);
check('contexto: 130k/200k ≥ 62 %', compact.reached({ used: 130_000 }, 'sonnet', 0.62) && !compact.reached({ used: 100_000 }, 'sonnet', 0.62));
check('Codex informa `ctx` en vez de `used`', compact.reached({ ctx: 200_000, limit: 272_000 }, 'gpt-5', 0.62));
check('sin cifras de contexto no hay medida', compact.contextShare({}, 'sonnet') === null);
check('tarea con 7 puntos enumerados es grande', !!compact.bigTaskReason({ title: 'x', description: Array.from({ length: 7 }, (_, i) => `${i + 1}. pieza`).join('\n') }));
check('tarea con dos «y además» es grande', !!compact.bigTaskReason({ title: 'x', description: 'Haz A y además B. Y además C.' }));
check('tarea corta no es grande', compact.bigTaskReason({ title: 'Arreglar el botón', description: 'Cambiar el color.' }) === null);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-compact-'));
const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), claudeDir = path.join(tmp, 'claude');
for (const d of [dataDir, home, repo, claudeDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-falso', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });

// claude falso. Primer mensaje de usuario = prompt. Plan → responde con 2 tareas. Trabajo con «RETOMAS» → termina. Trabajo normal →
// usa 50k, 100k y 130k tokens de contexto (62 % de 200k = 124k) y espera la instrucción de compactar para escribir NOTAS.md.
const promptsLog = path.join(tmp, 'prompts.jsonl'), msgsLog = path.join(tmp, 'msgs.jsonl');
const fake = path.join(tmp, 'claude-fake.mjs');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
if (!process.argv.includes('-p')) { console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : '2.1.300 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const text = (m) => (m.message?.content || []).map((c) => c.text || '').join('');
let n = 0;
const rl = readline.createInterface({ input: process.stdin });
const asst = (id, tokens) => out({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'trabajando' }], usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 20 } } });
rl.on('line', async (line) => {
  const m = JSON.parse(line); const t = text(m); n++;
  if (n === 1) {
    fs.appendFileSync(${JSON.stringify(promptsLog)}, JSON.stringify(t) + '\\n');
    out({ type: 'system', subtype: 'init', session_id: 'sess-' + Date.now(), model: 'sonnet', tools: [] });
    if (/Divide el objetivo/.test(t)) { out({ type: 'result', subtype: 'success', is_error: false, result: '\`\`\`json\\n[{"title":"Parte A","description":"a","role":"back","dependsOn":[]},{"title":"Parte B","description":"b","role":"back","dependsOn":[0]}]\\n\`\`\`', total_cost_usd: 0.01 }); return; }
    if (/RETOMAS LA TAREA/.test(t)) { fs.appendFileSync('avance.txt', 'segundo segmento\\n'); asst('m9', 30000); out({ type: 'result', subtype: 'success', is_error: false, result: 'Terminado con notas', total_cost_usd: 0.02 }); return; }
    fs.writeFileSync('avance.txt', 'primer segmento\\n');
    for (const [i, k] of [50000, 100000, 130000].entries()) { await new Promise((r) => setTimeout(r, 300)); asst('m' + i, k); }
    setTimeout(() => { out({ type: 'result', subtype: 'success', is_error: false, result: 'Terminado sin compactar', total_cost_usd: 0.03 }); }, 6000); // si nadie pide notas, acaba solo
    return;
  }
  fs.appendFileSync(${JSON.stringify(msgsLog)}, JSON.stringify(t) + '\\n');
  if (/NOTAS\\.md/.test(t)) {
    fs.writeFileSync('NOTAS.md', 'HECHO: primer segmento. FALTA: el segundo segmento (marca-notas-123).\\n');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Notas escritas', total_cost_usd: 0.03 });
  }
});
rl.on('close', () => process.exit(0));
`, { mode: 0o755 });

const stubPort = await freePort();
const stub = http.createServer((req, res) => {
  if (req.url === '/access') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: 'licensed', plan: 'e2e' }));
  res.writeHead(404).end('{}');
}).listen(stubPort, '127.0.0.1');
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { maxParallel: 1, workspaceHostDir: path.join(tmp, 'sin-workspace'), flowTestUrl: `http://127.0.0.1:${stubPort}` } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fake, AO_RTK: 'off', CLAUDE_CONFIG_DIR: claudeDir };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server.kill('SIGTERM'); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

try {
  await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 10_000);
  console.log('Compactar al pasar el umbral');
  const p = await call('POST', '/api/projects', { name: 'compact', repos: [{ key: 'demo', path: repo }], engine: 'claude' });
  if (!p.id) throw new Error('no pude crear el proyecto: ' + JSON.stringify(p));
  await call('POST', '/api/agents', { projectId: p.id, name: 'Ana', role: 'back', engine: 'claude', model: 'sonnet' });
  const t = await call('POST', '/api/tasks', { projectId: p.id, title: 'Tarea larga', description: 'Hazla.', role: 'back', repo: 'demo' });
  await call('POST', `/api/projects/${p.id}/run`, { running: true });
  const done = await until(async () => { const x = await task(t.id); return x?.status === 'review' || x?.status === 'failed' ? x : null; }, 30_000, 300);
  check('la tarea termina en Revisión', done?.status === 'review', JSON.stringify(done && { s: done.status, e: done.error }));
  const msgs = fs.existsSync(msgsLog) ? fs.readFileSync(msgsLog, 'utf8').trim().split('\n') : [];
  check('al pasar el 62 % se envía en caliente la instrucción de escribir NOTAS.md', msgs.some((m) => /NOTAS\.md/.test(m)), msgs.join(' | ').slice(0, 200));
  check('la instrucción va sin el envoltorio «el cliente añade…»', !msgs.some((m) => /El cliente \(quien revisa/.test(m)));
  const prompts = fs.readFileSync(promptsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('se lanzaron 2 segmentos', prompts.length === 2, String(prompts.length));
  check('el segundo prompt lleva las notas del agente', /RETOMAS LA TAREA/.test(prompts[1] || '') && /marca-notas-123/.test(prompts[1] || ''));
  check('el primer prompt no lleva notas', !/RETOMAS LA TAREA/.test(prompts[0] || ''));
  check('la tarea cuenta 1 compactación y no deja notas colgando', done?.compactions === 1 && done?.compactNotes === undefined);
  check('el coste suma los dos segmentos', Math.abs((done?.costUsd || 0) - 0.05) < 0.001, String(done?.costUsd));
  let files = '', branchLog = '';
  try { files = execFileSync('git', ['ls-tree', '-r', '--name-only', done.branch], { cwd: repo, encoding: 'utf8' }); branchLog = execFileSync('git', ['show', `${done.branch}:avance.txt`], { cwd: repo, encoding: 'utf8' }); } catch (e) { files = String(e.message); }
  check('NOTAS.md no acaba en la rama', !/NOTAS\.md/.test(files), files);
  check('el trabajo de los dos segmentos está en la rama', /primer segmento[\s\S]*segundo segmento/.test(branchLog), branchLog);
  check('evento AgentResumed {reason:"compact"}', ((await call('GET', `/api/events?taskId=${t.id}`)) || []).some?.((e) => e.type === 'AgentResumed' && e.data?.reason === 'compact'));

  console.log('Tarea grande → al PO');
  await call('POST', '/api/agents', { projectId: p.id, name: 'Pau', role: 'po', engine: 'claude', model: 'sonnet' });
  const big = await call('POST', '/api/tasks', { projectId: p.id, title: 'Hazlo todo', description: Array.from({ length: 7 }, (_, i) => `${i + 1}. pieza ${i + 1}`).join('\n'), role: 'back', repo: 'demo' });
  const moved = await until(async () => { const x = await task(big.id); return x?.splitInto ? x : null; }, 15_000);
  check('la tarea grande no se lanza: queda en Backlog enlazada al plan', moved?.status === 'backlog' && !!moved.splitInto && /puntos enumerados/.test(moved.sizeHint || ''), JSON.stringify(moved && { s: moved.status, h: moved.sizeHint, ev: ((await call('GET', `/api/events?taskId=${big.id}`)) || []).map?.((e) => e.type) }));
  const plan = moved && (await task(moved.splitInto));
  check('se creó una tarea «Planificar:» para el PO', /^Planificar:/.test(plan?.title || '') && plan?.kind === 'plan');
  const planDone = await until(async () => (await task(moved.splitInto))?.status === 'done', 20_000, 300);
  check('el PO la trocea en tareas pequeñas', !!planDone && (await state()).tasks.filter((x) => /^Parte [AB]$/.test(x.title)).length === 2);
  check('las tareas troceadas no se vuelven a evaluar', (await state()).tasks.filter((x) => /^Parte [AB]$/.test(x.title)).every((x) => x.sizeChecked === true));
} catch (e) { failed++; console.error('Error:', e.message); }
console.log(failed ? `✗ ${failed} fallos` : '✓ todo bien');
process.exit(failed ? 1 : 0);
