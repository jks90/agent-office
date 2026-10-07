// FT-142 · e2e del Marketplace con flow-test y nube simulados: publicar (team/public), listar, instalar,
// actualizar, sin vincular, 🛡 de código y proyecto de memoria. Uso: node scripts/marketplace-cloud-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mkc-'));
process.env.AO_DATA_DIR = path.join(tmp, 'data');
const store = await import('../server/store.js');
const cloud = await import('../server/marketplace-cloud.js');
const memory = await import('../server/memory.js');
const team = await import('../server/team.js');
const tools = await import('../server/guide/tools.js');
let n = 0; const ok = (m) => console.log(`✓ ${++n} ${m}`);
const rejects = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return e; } assert.fail(`debía fallar: ${re}`); };

// ── flow-test simulado: /account-link/marketplace/* → «nube» en memoria ──
const items = []; let linked = true; let seq = 0;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (s, o) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (!u.pathname.startsWith('/account-link/marketplace')) return send(404, { error: 'no' });
  if (!linked) return send(401, { error: 'sin vincular' });
  const id = u.pathname.split('/')[3];
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && !id) {
      const q = (u.searchParams.get('q') || '').toLowerCase(); const kind = u.searchParams.get('kind');
      return send(200, items.filter((i) => i.scope === u.searchParams.get('scope') && (!kind || i.kind === kind) && (!q || i.name.includes(q)) && (i.scope === 'team' || i.mine || i.status === 'approved')).map(({ package: _p, ...i }) => i));
    }
    if (req.method === 'GET') { const it = items.find((i) => i.id === id); if (!it) return send(404, { error: 'no existe' }); const { package: pkg, ...item } = it; return send(200, { item, package: pkg }); }
    if (req.method === 'POST') {
      const { scope, package: pkg } = JSON.parse(body);
      if (scope === 'public' && pkg.memory) return send(422, { error: 'memoria en público' });
      const it = { id: `m${++seq}`, scope, kind: pkg.kind, name: pkg.name, version: pkg.version, summary: pkg.summary, author: pkg.author, orgName: 'boss-test', hasMemory: !!pkg.memory, downloads: 0, status: scope === 'public' ? 'pending' : 'approved', mine: true, package: pkg };
      items.push(it); return send(200, { item: { ...it, package: undefined } });
    }
    return send(405, {});
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
store.get().settings.flowTestUrl = `http://127.0.0.1:${fake.address().port}`;

// ── catálogo local: rol, skill con código y agente con memoria ──
const cat = (x) => path.join(tmp, x);
store.get().settings.catalogDir = cat('catA');
fs.mkdirSync(cat('catA/roles'), { recursive: true });
fs.writeFileSync(cat('catA/roles/revisor.md'), '---\nname: revisor\ndescription: Revisa código\nkind: qa\n---\n\nEres un revisor.\n');
fs.mkdirSync(cat('catA/skills/hola/scripts'), { recursive: true });
fs.writeFileSync(cat('catA/skills/hola/SKILL.md'), '---\nname: hola\ndescription: Saluda\n---\nDi hola.\n');
fs.writeFileSync(cat('catA/skills/hola/scripts/run.sh'), '#!/bin/sh\necho hola\n', { mode: 0o755 });
store.get().projects.push({ id: 'p1', name: 'P', repos: [], team: [] });
const ag = team.hire({ projectId: 'p1', name: 'Rev Uno', role: 'revisor', engine: 'claude', model: 'sonnet' });
memory.write('p1', ag.id, '- usar tabs\n');

// 1 · vista previa: ficheros y saneado; agente solo team
const pv = cloud.previewPublish({ kind: 'skill', id: 'hola', scope: 'public' });
assert.deepEqual(pv.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.sh']); assert.equal(pv.hasCode, true); assert.equal(pv.memory, null);
const pa = cloud.previewPublish({ kind: 'agent', id: ag.id, scope: 'team' });
assert.match(pa.memory.sample, /usar tabs/);
await rejects(Promise.resolve().then(() => cloud.previewPublish({ kind: 'agent', id: ag.id, scope: 'public' })), /solo se comparten dentro del equipo/);
ok('previsualización: ficheros, código, memoria; agente solo team');

// 2 · publicar: team visible, public pendiente; el resumen y la versión se respetan
const rt = await cloud.publish({ kind: 'role', id: 'revisor', scope: 'team', version: '1.2.0', summary: 'Mi revisor' });
assert.equal(rt.version, '1.2.0'); assert.equal(rt.pending, false);
const rs = await cloud.publish({ kind: 'skill', id: 'hola', scope: 'public' });
assert.equal(rs.pending, true);
await cloud.publish({ kind: 'agent', id: ag.id, scope: 'team' });
await rejects(cloud.publish({ kind: 'role', id: 'revisor', scope: 'team', version: 'x' }), /semver/);
ok('publicar team/public (pendiente) y versión inválida');

// 3 · lista con filtros; lo público propio sale pendiente
const lt = await cloud.search({ scope: 'team' });
assert.equal(lt.length, 2); assert(lt.some((i) => i.kind === 'agent' && i.hasMemory));
assert.equal((await cloud.search({ scope: 'team', kind: 'role' })).length, 1);
assert.equal((await cloud.search({ scope: 'team', q: 'zzz' })).length, 0);
assert.equal((await cloud.search({ scope: 'public' }))[0].status, 'pending');
await rejects(cloud.search({ scope: 'nada' }), /Ámbito/);
ok('búsqueda por ámbito, tipo y texto; pendiente de moderación');

// 4 · instalar: skill con código pide 🛡; rol llega al catálogo B; actualizar
store.get().settings.catalogDir = cat('catB');
const skillId = (await cloud.search({ scope: 'public' }))[0].id;
const insp = await cloud.inspectItem(skillId);
assert.equal(insp.info.hasCode, true); assert.equal(insp.files.length, 2);
const e1 = await rejects(cloud.install(skillId, {}), /código ejecutable/); assert.equal(e1.needsConfirm, 'code');
assert(!fs.existsSync(cat('catB/skills/hola')), 'sin confirmar no se escribe nada');
await cloud.install(skillId, { confirmCode: true });
assert(fs.existsSync(cat('catB/skills/hola/scripts/run.sh')));
const roleId = lt.find((i) => i.kind === 'role').id;
await cloud.install(roleId, {});
assert(fs.existsSync(cat('catB/roles/marketplace/boss-test/revisor.md')));
const again = (await cloud.search({ scope: 'team', kind: 'role' }))[0];
assert.equal(again.installedVersion, '1.2.0'); assert.equal(again.update, false);
items.find((i) => i.id === roleId).version = '1.3.0';
assert.equal((await cloud.search({ scope: 'team', kind: 'role' }))[0].update, true);
await rejects(cloud.install(roleId, {}), /Ya existe/);
await cloud.install(roleId, { overwrite: true });
ok('instalar skill (🛡), rol y actualizar');

// 5 · agente: exige proyecto para la memoria y la deja ahí
const agentId = lt.find((i) => i.kind === 'agent').id;
assert.equal((await cloud.inspectItem(agentId)).info.hasMemory, true);
const e2 = await rejects(cloud.install(agentId, {}), /proyecto/); assert.equal(e2.needsConfirm, 'project');
const ri = await cloud.install(agentId, { projectId: 'p1', agentName: 'Clon' });
assert.equal(ri.kind, 'agent');
const clon = store.get().agents.find((a) => a.name === 'Clon');
assert(clon && /usar tabs/.test(memory.read('p1', clon.id)));
ok('agente instalado con su memoria en el proyecto elegido');

// 6 · sin vincular: aviso claro con enlace; flow-test caído → 502
linked = false;
const e3 = await rejects(cloud.search({ scope: 'team' }), /vinculada/);
assert.equal(e3.unlinked, true); assert.match(e3.linkUrl, /\/account-link$/); assert.equal(e3.status, 412);
assert.equal((await cloud.status()).linked, false);
linked = true; assert.equal((await cloud.status()).linked, true);
fake.close(); fake.closeAllConnections?.();
await rejects(cloud.search({ scope: 'team' }), /flow-test no responde/);
ok('sin vincular (412 + enlace) y flow-test caído (502)');

// 7 · herramientas del Guía registradas; install siempre 🛡 (irreversible)
const names = tools.tools.map((t) => t.name);
assert(names.includes('marketplace.search') && names.includes('marketplace.install'));
assert.equal(tools.tools.find((t) => t.name === 'marketplace.search').policy, 'read');
store.get().settings.flowTestUrl = 'http://127.0.0.1:1';
ok('tools marketplace.search / marketplace.install registradas');
console.log(`\n${n}/7 OK`);
process.exit(0);
