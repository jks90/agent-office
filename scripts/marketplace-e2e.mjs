// FT-141 · e2e del Marketplace: exportar/importar rol, skill y agente, round-trip, public sin memoria, secreto bloquea.
// Uso: node scripts/marketplace-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mkt-'));
process.env.AO_DATA_DIR = path.join(tmp, 'data');
const store = await import('../server/store.js');
const mkt = await import('../server/marketplace.js');
const memory = await import('../server/memory.js');
const team = await import('../server/team.js');
const roles = await import('../server/roles.js');
let n = 0; const ok = (m) => console.log(`✓ ${++n} ${m}`);
const rejects = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return e; } assert.fail(`debía fallar: ${re}`); };

// Catálogo A (origen) con un rol, una skill con script y un agente con memoria.
const cat = (x) => path.join(tmp, x);
const setCat = (x) => { store.get().settings.catalogDir = cat(x); };
setCat('catA');
fs.mkdirSync(cat('catA/roles'), { recursive: true });
fs.writeFileSync(cat('catA/roles/revisor.md'), `---\nname: revisor\ndescription: Revisa código\nkind: qa\n---\n\nEres un revisor. Mira ${os.homedir()}/proyecto/x.\n`);
fs.mkdirSync(cat('catA/skills/hola/scripts'), { recursive: true });
fs.mkdirSync(cat('catA/skills/hola/node_modules/x'), { recursive: true });
fs.writeFileSync(cat('catA/skills/hola/SKILL.md'), '---\nname: hola\ndescription: Saluda\n---\nDi hola.\n');
fs.writeFileSync(cat('catA/skills/hola/scripts/run.sh'), '#!/bin/sh\necho hola\n', { mode: 0o755 });
fs.writeFileSync(cat('catA/skills/hola/node_modules/x/i.js'), 'x');
fs.writeFileSync(cat('catA/skills/hola/big.bin'), Buffer.alloc(600 * 1024, 1));
fs.mkdirSync(cat('catA/skills/solo'), { recursive: true });
fs.writeFileSync(cat('catA/skills/solo/SKILL.md'), '---\nname: solo\ndescription: Solo texto\n---\nNada.\n');

const proj = { id: 'p1', name: 'P', repos: [], team: [] };
store.get().projects.push(proj);
const ag = team.hire({ projectId: 'p1', name: 'Rev Uno', role: 'revisor', engine: 'claude', model: 'sonnet' });
memory.write('p1', ag.id, '- usar tabs\n- ver /home/zed/app\n');
memory.write('p1', null, '- el repo usa pnpm\n');

// 1 · rol
const rp = mkt.exportPackage('role', 'revisor', 'public');
assert.equal(rp.format, 'ao-pkg/1'); assert.equal(rp.kind, 'role'); assert.equal(rp.memory, undefined);
assert(!Buffer.from(rp.files[0].content, 'base64').toString().includes(os.homedir()), 'ruta del usuario saneada');
assert(Buffer.from(rp.files[0].content, 'base64').toString().includes('{{HOME}}'));
ok('rol exportado y saneado');

// 2 · skill (sin node_modules ni binarios > 512 KB; trae código)
const sp = mkt.exportPackage('skill', 'hola', 'public');
assert.deepEqual(sp.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.sh']);
assert.equal(sp.meta.hasCode, true); assert.deepEqual(sp.meta.skipped, ['big.bin']);
assert.equal(mkt.exportPackage('skill', 'solo', 'public').meta.hasCode, false);
ok('skill exportada, hasCode marcado');

// 3 · agente: solo team, con memoria; public lo rechaza
rejects(() => mkt.exportPackage('agent', ag.id, 'public'), /solo se comparten dentro del equipo/);
const ap = mkt.exportPackage('agent', ag.id, 'team');
assert.match(ap.memory.agent, /usar tabs/); assert(!ap.memory.agent.includes('/home/zed')); assert.match(ap.memory.project, /pnpm/);
assert.equal(ap.meta.engine, 'claude');
ok('agente team con memoria saneada');

// 4 · public nunca lleva memoria
assert.equal(mkt.exportPackage('role', 'revisor', 'public').memory, undefined);
assert(!JSON.stringify(mkt.exportPackage('skill', 'solo', 'public')).includes('"memory"'));
ok('public sin memoria');

// 5 · un secreto bloquea la exportación
fs.writeFileSync(cat('catA/skills/solo/notas.md'), 'clave: sk-abcdefghijklmnopqrstuvwx\n');
const e = rejects(() => mkt.exportPackage('skill', 'solo', 'public'), /bloqueada.*clave sk- en notas\.md/);
assert.equal(e.status, 422); assert(!e.message.includes('abcdefghijkl'), 'no filtra el valor');
fs.unlinkSync(cat('catA/skills/solo/notas.md'));
memory.write('p1', ag.id, '- token ghp_abcdefghijklmnopqrstuvwxyz0123\n');
rejects(() => mkt.exportPackage('agent', ag.id, 'team'), /token GitHub en memoria\/agent/);
memory.write('p1', ag.id, '- usar tabs\n- ver /home/zed/app\n');
ok('secreto detectado bloquea');

// 6 · importar en un catálogo vacío B y round-trip
setCat('catB');
rejects(() => mkt.importPackage({ ...rp, files: [{ ...rp.files[0], sha256: 'x' }] }), /sha256 no coincide/);
const ri = mkt.importPackage(rp, { org: 'boss-flowtest' });
assert(fs.existsSync(cat('catB/roles/marketplace/boss-flowtest/revisor.md')));
rejects(() => mkt.importPackage(rp, { org: 'boss-flowtest' }), /confirma para sobrescribirlo/);
mkt.importPackage(rp, { org: 'boss-flowtest', overwrite: true });
assert.equal(roles.allRoles().revisor?.kind, 'qa');
assert.deepEqual(mkt.exportPackage('role', 'revisor', 'public').files, rp.files);
ok('rol: importado, no sobrescribe sin confirmar, round-trip idéntico');

const e2 = rejects(() => mkt.importPackage(sp), /código ejecutable/); assert.equal(e2.needsConfirm, 'code');
mkt.importPackage(sp, { confirmCode: true });
assert(fs.statSync(cat('catB/skills/hola/scripts/run.sh')).mode & 0o111, 'conserva ejecutable');
rejects(() => mkt.importPackage(sp, { confirmCode: true }), /confirma para sobrescribirla/);
assert.deepEqual(mkt.exportPackage('skill', 'hola', 'public').files, sp.files);
assert.equal(mkt.installed()['skill:hola'].version, sp.version);
ok('skill: sha verificado, 🛡 por código, round-trip idéntico, versión registrada');

// agente: importar en el banquillo con memoria en el proyecto elegido
rejects(() => mkt.importPackage(ap), /Elige el proyecto/);
store.get().projects.push({ id: 'p2', name: 'Q', repos: [], team: [] });
const before = store.get().agents.length;
const out = mkt.importPackage(ap, { projectId: 'p2', agentName: 'Rev Dos' });
assert.equal(store.get().agents.length, before + 1);
assert(!store.get().projects.some((p) => p.team.includes(out.agent.id)), 'en el banquillo');
assert.equal(out.agent.role, 'revisor'); assert.equal(out.agent.engine, 'claude');
assert.equal(memory.read('p2', out.agent.id), '- usar tabs\n- ver ' + os.homedir() + '/app\n');
assert.match(memory.read('p2', null), /pnpm/);
const ap2 = mkt.exportPackage('agent', out.agent.id, 'team', { projectId: 'p2' });
assert.deepEqual(ap2.memory, ap.memory); assert.deepEqual(ap2.files, ap.files); assert.deepEqual(ap2.meta, { ...ap.meta, agentName: 'Rev Dos' });
ok('agente: banquillo + memoria en el proyecto elegido, round-trip idéntico');

// 7 · el cliente se protege solo: path traversal, nombres, topes y enlaces → 422 y nada escrito fuera del catálogo
const mkf = (p, text = 'x') => { const b = Buffer.from(text); return { path: p, content: b.toString('base64'), sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const skillOk = mkf('SKILL.md', '---\nname: evil\ndescription: d\n---\nok\n');
const mkp = (files, extra = {}) => ({ format: 'ao-pkg/1', kind: 'skill', name: 'evil', version: '1.0.0', summary: '', author: { name: 'x' }, files, meta: {}, ...extra });
const before422 = (pkg, opts = {}) => { const er = rejects(() => mkt.importPackage(pkg, { confirmCode: true, overwrite: true, ...opts }), /./); assert.equal(er.status, 422, er.message); };
for (const bad of ['../x', '/etc/x', 'a/../../x', 'a\\..\\x', 'a/./../../x', 'ok\0.txt']) before422(mkp([skillOk, mkf(bad)]));
assert(!fs.existsSync(cat('catB/skills/evil')), 'no escribe a medias (SKILL.md válido antes del malo)');
assert(!fs.existsSync(cat('x')) && !fs.existsSync(path.join(cat('catB'), 'x')) && !fs.existsSync('/etc/x'));
for (const name of ['../evil', '..', '.', 'a/b', '', '-x']) before422(mkp([skillOk], { name }));
before422(mkp([skillOk]), { org: '../fuera' }); // la org solo afecta a roles
before422({ ...rp, name: '../evil' });
before422({ ...rp }, { org: '../../fuera' });
assert(!fs.existsSync(cat('catB/evil')) && !fs.existsSync(cat('fuera')));
before422(mkp([skillOk, ...Array.from({ length: 200 }, (_, i) => mkf(`f${i}.txt`))])); // > 200 ficheros
before422(mkp([skillOk, mkf('big.txt', 'a'.repeat(512 * 1024 + 1))])); // fichero > 512 KB
before422(mkp([skillOk, { ...mkf('c.txt'), sha256: 'bad' }]));
before422(mkp([skillOk, skillOk])); // repetido
// destino symlink (skill) y directorio de org symlink (rol): nada se escribe en el destino real
const outside = cat('outside'); fs.mkdirSync(outside);
fs.symlinkSync(outside, cat('catB/skills/lnk'));
before422(mkp([skillOk], { name: 'lnk' }));
fs.mkdirSync(cat('catB/roles/marketplace'), { recursive: true });
fs.symlinkSync(outside, cat('catB/roles/marketplace/org-link'));
before422({ ...rp, name: 'zz' }, { org: 'org-link' });
assert.deepEqual(fs.readdirSync(outside), [], 'nada escrito tras el enlace');
ok('path traversal, nombres, topes, sha y symlinks → 422 sin escribir');

store.flush?.();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nOK · ${n} comprobaciones`);
process.exit(0);
