// FT-161 · contraseñas del Guía (server/guide/secrets.js): autorización, enmascarado y que no toquen disco/logs/eventos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sec-sx-'));
process.env.AO_DATA_DIR = tmp;
const store = await import('../../server/store.js');
const sx = await import('../../server/guide/secrets.js');
const gp = await import('../../server/guide/policy.js');

const msgs = [{ role: 'user', text: 'entra con la clave Zx9$tr0ngPass y listo' }, { role: 'assistant', text: 'vale, Inventada123' }];
sx.bind('c1', () => msgs);

test('authorize: solo valores que escribió el usuario en ESE chat', () => {
  assert.equal(sx.authorize('c1', 'Zx9$tr0ngPass'), true);
  assert.equal(sx.authorize('c1', 'Zx9$tr0ngPass'), true); // ya conocido
  assert.equal(sx.authorize('c1', 'Inventada123'), false, 'lo dicho por el asistente no cuenta');
  assert.equal(sx.authorize('c1', 'otra-cosa'), false);
  for (const v of ['', null, undefined]) assert.equal(sx.authorize('c1', v), false);
  assert.equal(sx.authorize('c2', 'Zx9$tr0ngPass'), false, 'chat sin registrar');
  assert.equal(sx.authorize(undefined, 'Zx9$tr0ngPass'), false);
});

test('mask: sustituye texto plano y la forma escapada en JSON; no toca otros chats', () => {
  assert.equal(sx.mask('c1', 'pass=Zx9$tr0ngPass fin'), `pass=${sx.MASK} fin`);
  const withQuote = { role: 'user', text: 'mi clave es a"b\\c9Z' };
  sx.bind('c3', () => [withQuote]);
  assert.ok(sx.authorize('c3', 'a"b\\c9Z'));
  const json = JSON.stringify({ args: { value: 'a"b\\c9Z' } });
  assert.ok(!sx.mask('c3', json).includes('c9Z'));
  assert.equal(sx.mask('c2', 'Zx9$tr0ngPass'), 'Zx9$tr0ngPass');
  assert.equal(sx.mask('c1', null), '');
  assert.equal(sx.has('c1'), true);
  assert.equal(sx.has('nadie'), false);
});

test('forget borra los valores conocidos', () => {
  sx.forget('c1');
  assert.equal(sx.has('c1'), false);
  assert.equal(sx.mask('c1', 'Zx9$tr0ngPass'), 'Zx9$tr0ngPass');
});

test('un secreto no llega a disco: la confirmación enmascarada y el estado no lo contienen', async () => {
  sx.bind('c4', () => [{ role: 'user', text: 'clave Sup3rSecreta!99' }]);
  assert.ok(sx.authorize('c4', 'Sup3rSecreta!99'));
  const questions = await import('../../server/questions.js');
  const args = { ref: 'e1', text: 'Sup3rSecreta!99' };
  const tool = { name: 'browser.type', policy: 'write', description: 'teclea' };
  const p = gp.gate(tool, args, { modalArgs: JSON.parse(sx.mask('c4', JSON.stringify(args))), chatId: 'c4' });
  const q = questions.list().find((x) => x.kind === 'confirm');
  assert.ok(q && !q.context.includes('Sup3rSecreta'), 'el modal no enseña el valor');
  const logs = []; store.bus.on('log', (l) => logs.push(JSON.stringify(l)));
  questions.answer(q.id, 'Sí');
  await p;
  store.flush();
  gp.audit({ tool: tool.name, args: JSON.parse(sx.mask('c4', JSON.stringify(args))) });
  const all = fs.readdirSync(tmp).map((f) => fs.readFileSync(path.join(tmp, f), 'utf8')).join('\n') + logs.join('\n') + JSON.stringify(store.get());
  assert.ok(!all.includes('Sup3rSecreta'), 'ni en state.json, ni en el audit, ni en logs');
});

test('permisos: los ficheros de datos no son legibles por otros usuarios', { todo: 'BUG FT-161: state.json y guide-audit.jsonl se crean con el umask por defecto (0644), legibles por otros usuarios' }, () => {
  store.changed(); store.flush();
  gp.audit({ tool: 'x' });
  for (const f of ['state.json', 'guide-audit.jsonl']) {
    const p = path.join(tmp, f);
    if (!fs.existsSync(p)) continue;
    assert.equal(fs.statSync(p).mode & 0o077, 0, `${f} debería ser 0600`);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
