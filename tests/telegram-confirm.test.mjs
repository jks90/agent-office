// FT-170: confirmaciones de Telegram con ✅/❌, chat ajeno, timeout de 12 h y reinicio (fetch simulado, reloj simulado).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tg-'));
process.env.AO_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ enabled: true, botToken: '123:SECRETO', chatIds: ['42'] }));
const tg = await import('../server/telegram.js');
const store = await import('../server/store.js');

let t = 1_000_000, updates = [], calls = [], nextMsg = 100;
tg._setClock(() => t);
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop(), body = JSON.parse(init.body);
  calls.push({ method, body });
  let result = true;
  if (method === 'sendMessage') result = { message_id: nextMsg++ };
  if (method === 'getUpdates') { result = updates.filter((u) => u.update_id >= body.offset); }
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
const cb = (uid, chat, data) => ({ update_id: uid, callback_query: { id: `q${uid}`, data, message: { chat: { id: Number(chat) } } } });
const sent = (m) => calls.filter((c) => c.method === m);
const logs = [];
store.bus.on('log', (e) => { if (e.agentId === 'telegram') logs.push(e.line); });

test('✅ publica, edita el mensaje, responde el callback y el texto no lleva el token', async () => {
  calls = [];
  assert.equal(await tg.sendConfirm('¿Publicar el post?', 'a1'), 1);
  const m = sent('sendMessage')[0].body;
  assert.deepEqual(m.reply_markup.inline_keyboard[0].map((b) => b.text), ['✅ Publicar', '❌ No']);
  assert.ok(!JSON.stringify(m).includes('SECRETO'));
  const p = tg.waitConfirm('a1');
  updates = [cb(1, 42, 'ao:yes:a1')];
  await tg.pollOnce();
  assert.equal(await p, 'yes');
  assert.equal(sent('answerCallbackQuery').length, 1);
  assert.match(sent('editMessageText')[0].body.text, /Publicado/);
});

test('❌ devuelve no', async () => {
  await tg.sendConfirm('¿Otro?', 'b1');
  const p = tg.waitConfirm('b1');
  updates = [cb(2, 42, 'ao:no:b1')];
  await tg.pollOnce();
  assert.equal(await p, 'no');
});

test('chat ajeno ignorado y registrado; sigue pendiente; offset avanza', async () => {
  await tg.sendConfirm('¿Tercero?', 'c1');
  logs.length = 0; calls = [];
  updates = [cb(3, 999, 'ao:yes:c1')];
  await tg.pollOnce();
  assert.ok(logs.some((l) => /chat ajeno \(999\)/.test(l)));
  assert.equal(sent('answerCallbackQuery').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'telegram-confirms.json'), 'utf8')).items.c1.status, 'pending');
  await tg.pollOnce();
  assert.equal(sent('getUpdates').at(-1).body.offset, 4);
});

test('reinicio con la confirmación pendiente: se retoma y responde ✅', async () => {
  const tg2 = await import('../server/telegram.js?reinicio');
  tg2._setClock(() => t);
  const p = tg2.waitConfirm('c1');
  updates = [cb(4, 42, 'ao:yes:c1')];
  await tg2.pollOnce();
  assert.equal(await p, 'yes');
});

test('12 h sin respuesta → timeout, no publica y marca el mensaje caducado', async () => {
  await tg.sendConfirm('¿Cuarto?', 'd1');
  const p = tg.waitConfirm('d1');
  t += 12 * 3600e3 - 1;
  await tg.pollOnce();
  assert.equal(await Promise.race([p, Promise.resolve('pendiente')]), 'pendiente');
  t += 1; calls = [];
  await tg.pollOnce();
  assert.equal(await p, 'timeout');
  assert.match(sent('editMessageText')[0].body.text, /Caducado/);
  assert.equal(await tg.waitConfirm('d1'), 'timeout');
  assert.equal(await tg.waitConfirm('desconocida'), 'timeout');
});
