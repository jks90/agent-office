// FT-161 · Policy Layer del Guía (server/guide/policy.js) y detección de controles destructivos (guide/tools.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sec-gp-'));
process.env.AO_DATA_DIR = tmp;
const store = await import('../../server/store.js');
const questions = await import('../../server/questions.js');
const gp = await import('../../server/guide/policy.js');
const tools = await import('../../server/guide/tools.js');

const pending = () => questions.list().filter((q) => q.kind === 'confirm');
const reply = (txt) => questions.answer(pending()[0].id, txt);
const T = (policy, extra = {}) => ({ name: 'x.y', policy, description: 'd', ...extra });
const reset = () => { delete store.get().settings.guidePolicy; };

test('modeOf: read/navigate auto, irreversible siempre confirm, execute/write según Ajustes', () => {
  reset();
  assert.equal(gp.modeOf('read'), 'auto');
  assert.equal(gp.modeOf('navigate'), 'auto');
  assert.equal(gp.modeOf('irreversible'), 'confirm');
  assert.equal(gp.modeOf('execute'), 'auto');
  assert.equal(gp.modeOf('write'), 'confirm');
  assert.equal(gp.modeOf('inventada'), 'auto');
  gp.setPolicy({ execute: 'confirm', write: 'auto' });
  assert.equal(gp.modeOf('execute'), 'confirm');
  assert.equal(gp.modeOf('write'), 'auto');
  assert.equal(gp.modeOf('irreversible'), 'confirm', 'ningún ajuste relaja irreversible');
});

test('setPolicy ignora valores inválidos y claves ajenas', () => {
  reset();
  const p = gp.setPolicy({ execute: 'nunca', write: 7, irreversible: 'auto', guideInputFallback: 'sí' });
  assert.deepEqual(p, { execute: 'auto', write: 'confirm', guideInputFallback: false });
  assert.equal(gp.setPolicy({ guideInputFallback: true }).guideInputFallback, true);
  store.get().settings.guidePolicy = { execute: 'rarísimo' };
  assert.equal(gp.getPolicy().execute, 'auto');
});

test('gate: una tool read pasa sin preguntar', async () => {
  reset();
  assert.deepEqual(await gp.gate(T('read'), {}), { mode: 'auto', confirmed: null });
  assert.equal(pending().length, 0);
});

test('gate: irreversible pide confirmación; "No" devuelve confirmed:false', async () => {
  const p = gp.gate(T('irreversible', { name: 'task.delete' }), { id: 'abc' });
  assert.equal(pending().length, 1);
  assert.match(pending()[0].question, /task\.delete/);
  reply('No');
  assert.deepEqual(await p, { mode: 'confirm', confirmed: false });
  const p2 = gp.gate(T('irreversible', { name: 'task.delete' }), { id: 'abc' });
  reply('Sí');
  assert.equal((await p2).confirmed, true);
});

test('gate: confirmOnce pregunta la primera vez por chat y luego no; sin clave pregunta siempre', async () => {
  reset();
  const t = T('read', { name: 'desktop.look', confirmOnce: true });
  const a = gp.gate(t, {}, { chatId: 'chatA' }); reply('Sí');
  assert.equal((await a).mode, 'confirmOnce');
  assert.equal((await gp.gate(t, {}, { chatId: 'chatA' })).mode, 'auto');
  const b = gp.gate(t, {}, { chatId: 'chatB' }); assert.equal(pending().length, 1); reply('Sí'); await b;
  for (let i = 0; i < 2; i++) { const c = gp.gate(t, {}); assert.equal(pending().length, 1); reply('Sí'); await c; }
  const d = gp.gate(t, {}, { chatId: 'chatC' }); reply('No'); await d;
  const e = gp.gate(t, {}, { chatId: 'chatC' }); assert.equal(pending().length, 1, 'un "No" no memoriza'); reply('No'); await e;
});

test('gate: el modal usa los args enmascarados, no los reales, y los resume', async () => {
  const p = gp.gate(T('write'), { password: 'REAL-SECRETO' }, { modalArgs: { password: '••••••', largo: 'x'.repeat(500) } });
  const ctx = pending()[0].context;
  assert.ok(!ctx.includes('REAL-SECRETO'));
  assert.ok(ctx.includes('••••••') && ctx.includes('500 car.'));
  reply('No'); await p;
});

test('summarize recorta cadenas, listas, profundidad y no revienta con tipos raros', () => {
  assert.equal(gp.summarize('x'.repeat(200)).endsWith('(200 car.)'), true);
  assert.equal(gp.summarize(Array.from({ length: 30 }, (_, i) => i)).length, 11);
  assert.equal(Object.keys(gp.summarize(Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])))).length, 20);
  assert.equal(gp.summarize({ a: { b: { c: { d: 1 } } } }).a.b.c, '{…}');
  assert.equal(gp.summarize(null), null);
  assert.equal(gp.summarize(undefined), undefined);
  assert.equal(gp.summarize(5), 5);
});

test('audit: añade líneas JSON y no lanza aunque el directorio sea imposible', () => {
  gp.audit({ tool: 'a', ok: true });
  gp.audit({ tool: 'b' });
  const lines = fs.readFileSync(path.join(tmp, 'guide-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.tool), ['a', 'b']);
  assert.doesNotThrow(() => gp.audit({ circular: (() => { const o = {}; o.o = o; return o; })() }));
});

test('isDestructive: controles de enviar/pagar/borrar piden confirmación; los neutros no', () => {
  for (const name of ['Eliminar cuenta', 'Enviar', 'PAGAR ahora', 'Delete', 'Submit order', 'Confirmar pedido', 'Aceptar', 'Publicar', 'Vaciar papelera', 'Descartar cambios', 'Sobrescribir', 'Envíar']) {
    assert.equal(tools.isDestructive({ name }), true, name);
  }
  for (const name of ['Cancelar', 'Siguiente', 'Buscar', 'Atrás', '', 'Resend-free', 'Compartir']) assert.equal(tools.isDestructive({ name }), false, name);
  assert.equal(tools.isDestructive({ name: 'OK', role: 'Delete' }), true);
  for (const n of [null, undefined, {}]) assert.equal(tools.isDestructive(n), false);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
