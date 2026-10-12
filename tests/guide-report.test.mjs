// 📮 Guía: cambiar el modelo de un agente/rol (siempre con permiso) y reportar al admin lo que no puede hacer.
// flow-test simulado (fetchImpl): ninguna prueba envía nada de verdad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-greport-'));
const store = await import('../server/store.js');
const cat = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-greport-cat-'));
store.get().settings.catalogDir = cat;
store.get().settings.flowTestUrl = 'http://flow.test';
const report = await import('../server/guide/report.js');
const { setRoleModel, allRoles } = await import('../server/roles.js');
const { tools } = await import('../server/guide/tools.js');

test.after(() => store.flush());

const fake = (status, body, seen = []) => async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return { ok: status < 400, status, json: async () => body }; };

test('guide.report solo ofrece: no envía hasta que el usuario pulsa', async () => {
  const o = report.offer({ title: 'Cambiar modelo de un rol de serie', request: 'pon qa en sonnet', reason: 'role.update → 403' }, { chatId: 'c1', where: 'vista agents' });
  assert.equal(o.offered, true);
  assert.equal(report.list()[o.reportId].status, 'offered');
  const seen = [];
  const r = await report.send(o.reportId, { fetchImpl: fake(200, { ok: true, id: 'R1', delivered: true }, seen) });
  assert.equal(r.status, 'sent');
  assert.equal(seen[0].url, 'http://flow.test/feedback');
  assert.match(seen[0].body.title, /^🧭 Guía no pudo: Cambiar modelo/);
  assert.match(seen[0].body.description, /pon qa en sonnet[\s\S]*role\.update → 403[\s\S]*vista agents/);
  assert.deepEqual(Object.keys(r).sort(), ['id', 'status', 'title'], 'la UI solo recibe el estado');
  const again = await report.send(o.reportId, { fetchImpl: () => { throw new Error('no debe reenviar'); } });
  assert.equal(again.status, 'sent');
});

test('si flow-test lo rechaza (trial 402) o no responde → «no se pudo» y se puede reintentar', async () => {
  const o = report.offer({ title: 'x', request: 'y', reason: 'z' });
  assert.equal((await report.send(o.reportId, { fetchImpl: fake(402, { error: 'Pro', gated: true }) })).status, 'failed');
  assert.equal((await report.send(o.reportId, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).status, 'failed');
  assert.equal((await report.send(o.reportId, { fetchImpl: fake(200, { ok: true, queued: true }) })).status, 'sent', 'en la cola de flow-test ya cuenta como enviado');
  await assert.rejects(report.send('nope'), (e) => e.status === 404);
  assert.throws(() => report.offer({ title: ' ' }), (e) => e.status === 400);
});

test('role.update: cambia solo la línea model: de un rol del catálogo; los de serie → 403', () => {
  fs.mkdirSync(path.join(cat, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(cat, 'roles', 'qa-suite.md'), '---\nname: qa-suite\ndescription: QA\nkind: qa\nmodel: claude-haiku-4-5-20251001\nskills: flows\n---\n\nPrompt del QA\n');
  const r = setRoleModel('qa-suite', 'claude-sonnet-5-5');
  assert.deepEqual(r, { role: 'qa-suite', from: 'claude-haiku-4-5-20251001', to: 'claude-sonnet-5-5' });
  const txt = fs.readFileSync(path.join(cat, 'roles', 'qa-suite.md'), 'utf8');
  assert.match(txt, /model: claude-sonnet-5-5/); assert.doesNotMatch(txt, /haiku/); assert.match(txt, /skills: flows[\s\S]*Prompt del QA/);
  assert.equal(allRoles()['qa-suite'].model, 'claude-sonnet-5-5');
  assert.throws(() => setRoleModel('back', 'sonnet'), (e) => e.status === 403);
  assert.throws(() => setRoleModel('qa-suite', 'rm -rf /'), (e) => e.status === 400);
});

test('agent.update y role.update piden SIEMPRE permiso (irreversible, sin «Sí, siempre»); guide.report no', async () => {
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  store.get().agents.push({ id: 'ag1', name: 'Vera', role: 'qa-suite', engine: 'claude', model: '' });
  const d1 = await by['agent.update'].dynamic({ agentId: 'Vera', model: 'claude-sonnet-5-5' });
  assert.equal(d1.policy, 'irreversible'); assert.match(d1.context, /Después: claude · claude-sonnet-5-5/);
  const d2 = await by['role.update'].dynamic({ role: 'qa-suite', model: 'sonnet' });
  assert.equal(d2.policy, 'irreversible'); assert.match(d2.context, /Agentes con este rol: Vera/);
  assert.equal(by['guide.report'].policy, 'read');
});
