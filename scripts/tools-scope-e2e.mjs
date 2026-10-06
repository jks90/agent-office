#!/usr/bin/env node
// e2e de las herramientas acotadas por rol y del prompt ordenado para la caché (FT-59). Sin dependencias nuevas:
//
//   node scripts/tools-scope-e2e.mjs
//
// Arranca `server/index.js` con AO_DATA_DIR/HOME temporales y binarios falsos (AO_CLAUDE_BIN / AO_CODEX_BIN) que VUELCAN sus
// argumentos y el prompt a ficheros. Una tarea por rol (dev, qa, docs, docs con `tools:` propio) y motor (claude, codex); comprueba
// --tools/--allowedTools/MCP en Claude, los `-c tools.*` en Codex y que la parte estable del prompt va ANTES de la tarea y es idéntica.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeScope } from '../server/engines/toolscope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tools-e2e-'));
const dataDir = path.join(tmp, 'data'), homeDir = path.join(tmp, 'home'), dump = path.join(tmp, 'dump'), ws = path.join(tmp, 'ws');
for (const d of [homeDir, dump, path.join(ws, '_agentes', 'roles')]) fs.mkdirSync(d, { recursive: true });

let failed = 0;
const section = (t) => console.log(`\n▸ ${t}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ' — ' + detail}`); if (!ok) failed++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ── unidad: el alcance por rol ──
section('claudeScope (unidad)');
const sc = (o) => claudeScope(o);
check('dev: lo de siempre (Edit/Write/MultiEdit + todo el shell), sin MCP', ['Edit', 'Write', 'MultiEdit', 'TodoWrite'].every((t) => sc({ kind: 'dev' }).builtin.includes(t)) && !sc({ kind: 'dev' }).mcp);
check('docs: Edit/Write + shell de lectura + MCP; sin npm/curl', sc({ kind: 'docs' }).builtin.includes('Edit') && sc({ kind: 'docs' }).mcp && !sc({ kind: 'docs' }).allowed.includes('Bash(npm *)') && sc({ kind: 'docs' }).allowed.includes('Bash(grep *)'));
check('qa: Write (scripts) pero sin Edit/MultiEdit; shell de pruebas y MCP', sc({ kind: 'qa' }).builtin.includes('Write') && !sc({ kind: 'qa' }).builtin.includes('Edit') && sc({ kind: 'qa' }).allowed.includes('Bash(npm *)') && sc({ kind: 'qa' }).mcp);
check('planner (y mode=plan): solo lectura + ao-ask, sin Edit/Write/MCP', (() => { const p = sc({ kind: 'dev', mode: 'plan' }); return !p.builtin.includes('Edit') && !p.builtin.includes('Write') && !p.mcp && p.allowed.some((r) => r.includes('ao-ask.mjs')); })());
check('nadie lleva WebFetch/WebSearch/NotebookEdit/Task por defecto', ['dev', 'qa', 'docs', 'planner'].every((k) => !sc({ kind: k }).builtin.some((t) => ['WebFetch', 'WebSearch', 'NotebookEdit', 'Task'].includes(t))));
check('`tools:` del rol sustituye las integradas; Bash(x) añade regla; skills → Skill', (() => { const s = sc({ kind: 'docs', roleTools: ['Read', 'Bash', 'Bash(make *)'], hasSkills: true }); return JSON.stringify(s.builtin) === '["Read","Bash","Skill"]' && s.allowed.includes('Bash(make *)') && !s.allowed.includes('Edit'); })());

// ── binarios falsos ──
const fakeBin = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/usr/bin/env node\nconst fs=require('node:fs');const DUMP=${JSON.stringify(dump)};\n${body}`); fs.chmodSync(f, 0o755); return f; };
const fakeClaude = fakeBin('claude', `
let input='';process.stdin.on('data',(d)=>{input+=d;if(input.includes('\\n')&&!global.s){global.s=1;
  const u={input_tokens:5,output_tokens:5,cache_creation_input_tokens:1234,cache_read_input_tokens:0};
  fs.writeFileSync(DUMP+'/claude-'+Date.now()+Math.random()+'.json',JSON.stringify({args:process.argv.slice(2),prompt:JSON.parse(input.split('\\n')[0]).message.content[0].text}));
  const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
  out({type:'system',subtype:'init',model:'fake',tools:[],session_id:'s1'});
  out({type:'assistant',message:{id:'m1',content:[{type:'text',text:'hecho'}],usage:u}});
  out({type:'result',result:'ok',is_error:false,total_cost_usd:0,session_id:'s1',usage:u});}});
process.stdin.on('end',()=>process.exit(0));`);
const fakeCodex = fakeBin('codex', `
let input='';process.stdin.on('data',(d)=>input+=d);process.stdin.on('end',()=>{
  fs.writeFileSync(DUMP+'/codex-'+Date.now()+Math.random()+'.json',JSON.stringify({args:process.argv.slice(2),prompt:input}));
  const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
  out({type:'item.completed',item:{id:'i1',type:'agent_message',text:'ok'}});
  out({type:'turn.completed',usage:{input_tokens:3000,cached_input_tokens:0,output_tokens:5}});});`);

// roles de catálogo: un documentalista y otro con `tools:` propio
fs.writeFileSync(path.join(ws, '_agentes', 'roles', 'docu.md'), '---\nname: docu\nkind: docs\n---\n\nEres documentalista.\n');
fs.writeFileSync(path.join(ws, '_agentes', 'roles', 'docu-min.md'), '---\nname: docu-min\nkind: docs\ntools: Read, Grep, Bash\n---\n\nEres documentalista mínimo.\n');

const GIT_ENV = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@local', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@local' };
const repos = {}; // un repo por motor (los códigos de tarea/ramas se repetirían entre proyectos sobre el mismo repo)
for (const e of ['claude', 'codex']) {
  const dir = repos[e] = path.join(tmp, `repo-${e}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), '# repo e2e\n'); git('add', '-A'); git('commit', '-q', '-m', 'init');
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { workspaceHostDir: ws, maxParallel: 1 } }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, HOME: homeDir, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_CLAUDE_BIN: fakeClaude, AO_CODEX_BIN: fakeCodex, AO_RTK: 'off' } });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* ya parado */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { ok: r.ok, body: await r.json().catch(() => ({})) }; };
const state = async () => (await call('GET', '/api/state')).body;

try {
  if (!(await until(async () => { try { return (await call('GET', '/api/state')).ok; } catch { return false; } }, 10_000, 100))) throw new Error('El servidor no arrancó:\n' + serverLog);
  const cases = [['back', 'dev'], ['qa', 'qa'], ['docu', 'docs'], ['docu-min', 'docs']];
  const names = {};
  // un proyecto por motor: la tarea la coge el primer agente libre del rol, y así cada rol cae en el motor que toca
  for (const engine of ['claude', 'codex']) {
    const P = (await call('POST', '/api/projects', { name: `e2e-tools-${engine}`, repoPath: repos[engine], engine })).body;
    for (const [role] of cases) {
      const name = `${role.replace('-', '')}${engine}`;
      names[`${engine}/${role}`] = name;
      await call('POST', '/api/agents', { projectId: P.id, name, role, engine });
    }
    // una tarea cada vez (el guardarraíl compara git status de los checkouts principales)
    for (const [role] of cases) {
      const key = `${engine}/${role}`;
      const t = (await call('POST', '/api/tasks', { projectId: P.id, title: `Título ${key}`, role, description: 'e2e FT-59' })).body;
      await call('POST', `/api/projects/${P.id}/run`, { running: true });
      const done = await until(async () => { const x = (await state()).tasks.find((y) => y.id === t.id); return x && ['review', 'failed', 'done'].includes(x.status) ? x : null; });
      await call('POST', `/api/projects/${P.id}/run`, { running: false });
      check(`${key}: la tarea termina`, done?.status === 'review', JSON.stringify([done?.status, done?.error]));
    }
  }
  // cada volcado se identifica por la línea «Tarea X: título» (el bloque de memoria puede colar títulos de otras tareas)
  const dumps = fs.readdirSync(dump).map((f) => ({ engine: f.split('-')[0], ...JSON.parse(fs.readFileSync(path.join(dump, f), 'utf8')) }));
  const rd = (engine, role) => dumps.find((d) => d.engine === engine && new RegExp(`^Tarea \\S+: Título ${engine}/${role}$`, 'm').test(d.prompt)) || null;
  const after = (a, flag) => { const i = a.indexOf(flag); if (i < 0) return []; const out = []; for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; };

  section('Claude: --tools / --allowedTools / MCP por rol');
  const arg = {}; for (const [role] of cases) arg[role] = rd('claude', role)?.args || [];
  const tl = (role) => (after(arg[role], '--tools')[0] || '').split(',');
  const al = (role) => after(arg[role], '--allowedTools');
  const mcp = (role) => JSON.parse(after(arg[role], '--mcp-config')[0] || '{}').mcpServers || {};
  check('dev: --tools con Edit/Write y sin WebFetch/WebSearch/NotebookEdit/Task', tl('back').includes('Edit') && tl('back').includes('Write') && !tl('back').some((t) => ['WebFetch', 'WebSearch', 'NotebookEdit', 'Task'].includes(t)), tl('back').join());
  check('dev: sin MCP flow-test', !mcp('back')['flow-test'] && !al('back').includes('mcp__flow-test'));
  check('qa: sin Edit, con Write; MCP flow-test permitido', !tl('qa').includes('Edit') && tl('qa').includes('Write') && !!mcp('qa')['flow-test'] && al('qa').includes('mcp__flow-test'), tl('qa').join());
  check('qa: shell de pruebas (npm, node)', al('qa').includes('Bash(npm *)') && al('qa').includes('Bash(node *)'));
  check('docs: Edit/Write + MCP; shell solo de lectura (grep sí, npm/curl no)', tl('docu').includes('Edit') && al('docu').includes('Bash(grep *)') && !al('docu').includes('Bash(npm *)') && !al('docu').includes('Bash(curl *)') && !!mcp('docu')['flow-test'], tl('docu').join());
  check('docs con `tools:` en el frontmatter: --tools = Read,Grep,Bash', tl('docu-min').join() === 'Read,Grep,Bash', tl('docu-min').join());
  check('--tools y --allowedTools coherentes (ninguna regla de una herramienta no enviada)', cases.every(([role]) => al(role).filter((r) => !r.startsWith('mcp__')).every((r) => tl(role).includes(r.replace(/\(.*$/, '')))));

  section('Codex: -c por rol');
  for (const [role] of cases) {
    const a = rd('codex', role)?.args || [];
    const cs = a.map((x, i) => (a[i - 1] === '-c' ? x : null)).filter(Boolean);
    check(`${role}: tools.web_search=false`, cs.includes('tools.web_search=false'), cs.join());
    if (role === 'docu') check('docs: tools.view_image=false (sin imágenes)', cs.includes('tools.view_image=false'));
    if (role === 'back' || role === 'qa') check(`${role}: conserva view_image`, !cs.includes('tools.view_image=false'));
    if (role === 'qa' || role === 'docu') check(`${role}: MCP flow_test configurado`, cs.some((x) => x.startsWith('mcp_servers.flow_test.url=')));
  }

  section('Prompt: lo estable primero, igual en todas las tareas; lo variable al final');
  const MARK = '════════ TAREA';
  for (const engine of ['claude', 'codex']) {
    const ps = Object.keys(names).filter((k) => k.startsWith(engine)).map((k) => rd(engine, k.split('/')[1])?.prompt || '');
    const stable = ps.map((p) => p.slice(0, p.indexOf(MARK)));
    // codex antepone el system del rol (distinto por rol): el prefijo estable es lo que va tras él
    const tail = engine === 'codex' ? stable.map((s) => s.slice(s.indexOf('Carpeta del proyecto') >= 0 ? s.indexOf('Carpeta del proyecto') : s.indexOf('Trabajas en una copia'))) : stable;
    check(`${engine}: marca de tarea presente y bloque estable idéntico entre ${ps.length} tareas`, ps.every((p) => p.includes(MARK)) && tail.every((s) => s === tail[0] && s.length > 200), tail.map((s) => s.length).join());
    check(`${engine}: economía, briefing y reglas ANTES de la tarea; título, descripción y rama DESPUÉS`, ps.every((p) => { const m = p.indexOf(MARK); return p.indexOf('Gasta pocos tokens') < m && p.indexOf('PREGUNTAR AL CLIENTE') < m && p.indexOf('Título ') > m && p.indexOf('e2e FT-59') > m; }));
    check(`${engine}: nada de ids/ramas/fechas en la parte estable`, stable.every((s) => !/ao\/FT-|FT-\d+|\d{4}-\d\d-\d\dT/.test(s.replace(/«[^»]*»/g, '').replace(/\S*ao-ask\.mjs/g, ''))), stable.map((x) => x.replace(/\S*ao-ask\.mjs/g, '').match(/.{40}(?:ao\/FT-\d+|FT-\d+|\d{4}-\d\d-\d\dT)/)?.[0]).find(Boolean));
  }
} catch (e) {
  failed++; console.log('  ✗ ' + (e.stack || e));
}
console.log(failed ? `\n${failed} fallo(s)\n${serverLog.slice(-1500)}` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
