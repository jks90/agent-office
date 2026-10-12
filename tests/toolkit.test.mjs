// 🧰 Herramientas de los agentes (server/toolkit.js + setRoleTools): kit del agente, prompt «úsalas primero», rastreo de uso con
// eventos de Claude y de Codex, acumulado por tarea, cifras con/sin y avisos de lo que se declara y no llega. Catálogo en un tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-toolkit-data-'));
const store = await import('../server/store.js');
const cat = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-toolkit-cat-'));
store.get().settings.catalogDir = cat;
const toolkit = await import('../server/toolkit.js');
const { setRoleTools, allRoles } = await import('../server/roles.js');
const real = (p) => fs.realpathSync(p);

// Catálogo: skill «flows» (enlace a una carpeta fuera) y «docx» (carpeta real); script «deploy»; MCP «home».
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-toolkit-ext-'));
fs.mkdirSync(path.join(ext, 'flows'));
fs.writeFileSync(path.join(ext, 'flows', 'SKILL.md'), '---\nname: flows\ndescription: Crear y ejecutar flows\n---\nCuerpo');
fs.mkdirSync(path.join(cat, 'skills', 'docx'), { recursive: true });
fs.writeFileSync(path.join(cat, 'skills', 'docx', 'SKILL.md'), '---\nname: docx\ndescription: Documentos Word\n---\nCuerpo');
fs.symlinkSync(path.join(ext, 'flows'), path.join(cat, 'skills', 'flows'));
const script = path.join(ext, 'deploy.mjs');
fs.writeFileSync(script, '// Despliega\n');
fs.writeFileSync(path.join(cat, 'scripts.json'), JSON.stringify([{ name: 'deploy', path: script, description: 'Despliega la app' }]));
fs.writeFileSync(path.join(cat, 'mcp.json'), JSON.stringify([{ name: 'home', description: 'Finanzas de casa' }]));
fs.mkdirSync(path.join(cat, 'roles'), { recursive: true });
fs.writeFileSync(path.join(cat, 'roles', 'qa-x.md'), '---\nname: qa-x\ndescription: QA\nkind: qa\ntools: Read, Bash\nskills: flows, fantasma\nscripts: deploy, gas\n---\n\nEres QA.\n');

test.after(() => store.flush());

test('kit: skills del rol + de la ficha (solo las del catálogo), MCP y scripts; nativas vs por ruta', () => {
  const role = allRoles()['qa-x'];
  const kit = toolkit.kitOf({ skills: ['docx'], mcps: ['home'] }, role, { nativeNames: ['flows'] });
  assert.deepEqual(kit.skills.map((s) => [s.name, s.native]), [['flows', true], ['docx', false]]);
  assert.equal(kit.skills[0].dir, real(path.join(ext, 'flows')));
  assert.deepEqual(kit.mcps, [{ name: 'home', description: 'Finanzas de casa' }]);
  assert.deepEqual(kit.scripts.map((s) => s.name), ['deploy']); // «gas» no está en el catálogo
  // Solo la skill por ruta y la carpeta del script se abren con --add-dir
  assert.deepEqual(toolkit.kitDirs(kit, '/tmp/no-es'), [real(path.join(cat, 'skills', 'docx')), ext]);
});

test('prompt: «úsalas primero», cómo usar cada skill y comandos de los scripts; vacío sin herramientas', () => {
  const kit = toolkit.kitOf({ skills: ['docx'], mcps: ['home'] }, allRoles()['qa-x'], { nativeNames: ['flows'] });
  const p = toolkit.promptBlock(kit);
  assert.match(p, /úsalas PRIMERO/);
  assert.match(p, /\*\*flows\*\* — Crear y ejecutar flows → herramienta Skill «flows»/);
  assert.match(p, new RegExp(`\\*\\*docx\\*\\* — Documentos Word → lee \`${real(path.join(cat, 'skills', 'docx'))}/SKILL.md\``));
  assert.match(p, /\*\*home\*\* — Finanzas de casa/);
  assert.match(p, new RegExp(`\\*\\*deploy\\*\\*: \`node ${script}\` — Despliega la app`));
  assert.equal(toolkit.promptBlock({ skills: [], mcps: [], scripts: [] }), '');
  assert.equal(p, toolkit.promptBlock(kit), 'estable: mismo kit → mismo texto (caché)');
});

test('rastreo: Claude (Skill, Read de la carpeta, Bash con el script, mcp__) y Codex (comando y mcp_tool_call)', () => {
  const kit = toolkit.kitOf({ skills: ['docx'], mcps: ['home'] }, allRoles()['qa-x'], { nativeNames: ['flows'] });
  const tr = toolkit.tracker(kit);
  const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  tr.feed(use('Skill', { skill: 'flows' }), 'claude');
  tr.feed(use('Read', { file_path: path.join(real(path.join(cat, 'skills', 'docx')), 'SKILL.md') }), 'claude');
  tr.feed(use('Bash', { command: `node ${script} --prod` }), 'claude');
  tr.feed(use('mcp__home__finanzas_resumen', {}), 'claude');
  tr.feed(use('Bash', { command: 'ls -la' }), 'claude');
  tr.feed({ type: 'item.completed', item: { type: 'command_execution', command: 'bash -lc "node deploy.mjs"' } }, 'codex');
  tr.feed({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'home', tool: 'x' } }, 'codex');
  assert.deepEqual(tr.used, { skills: { flows: 1, docx: 1 }, mcps: { home: 2 }, scripts: { deploy: 2 } });
});

test('record acumula entre intentos y usage compara con/sin del mismo rol', () => {
  const kit = toolkit.kitOf({}, allRoles()['qa-x'], { nativeNames: ['flows'] });
  const a = { status: 'done', role: 'qa-x', costUsd: 1 }, b = { status: 'done', role: 'qa-x', costUsd: 3 }, c = { status: 'todo', role: 'qa-x' };
  toolkit.record(a, kit, { skills: { flows: 2 }, mcps: {}, scripts: {} });
  toolkit.record(a, kit, { skills: { flows: 1 }, mcps: {}, scripts: { deploy: 1 } });
  toolkit.record(b, kit, { skills: {}, mcps: {}, scripts: {} });
  assert.equal(a.toolkit.used.skills.flows, 3);
  assert.deepEqual(a.toolkit.given.scripts, ['deploy']);
  const u = toolkit.usage([a, b, c]);
  assert.deepEqual(u.skills.flows, { given: 2, used: 1, uses: 3, avgWith: 1, avgWithout: 3, nWith: 1, nWithout: 1 });
  assert.equal(u.scripts.deploy.used, 1);
});

test('avisos: skill/script fuera del catálogo y rol con herramientas sin agentes', () => {
  const w = toolkit.warnings({ roles: allRoles(), agents: [{ name: 'Ana', role: 'qa-x', skills: ['nada'] }] });
  const txt = w.map((x) => `${x.owner}|${x.kind}|${x.name}`);
  assert.ok(txt.includes('rol qa-x|skills|fantasma') || txt.some((t) => t.endsWith('|skills|fantasma')), txt.join(' · '));
  assert.ok(txt.some((t) => t.endsWith('|scripts|gas')));
  assert.ok(txt.includes('agente Ana|skills|nada'));
  assert.ok(!w.some((x) => x.kind === 'rol' && x.name === 'qa-x'), 'tiene agente: no avisa');
  assert.ok(toolkit.warnings({ roles: allRoles(), agents: [] }).some((x) => x.kind === 'rol' && x.name === 'qa-x'));
});

test('setRoleTools cambia solo esa línea del frontmatter (tools y prompt intactos) y rechaza roles de serie', () => {
  setRoleTools('qa-x', 'mcps', ['home', 'home', '']);
  setRoleTools('qa-x', 'scripts', []);
  const text = fs.readFileSync(path.join(cat, 'roles', 'qa-x.md'), 'utf8');
  assert.match(text, /^tools: Read, Bash$/m);
  assert.match(text, /^mcps: home$/m);
  assert.doesNotMatch(text, /^scripts:/m);
  assert.match(text, /Eres QA\./);
  assert.deepEqual(allRoles()['qa-x'].mcps, ['home']);
  assert.throws(() => setRoleTools('qa', 'skills', ['flows']), (e) => e.status === 400);
  assert.throws(() => setRoleTools('qa-x', 'otra', []), (e) => e.status === 400);
});
