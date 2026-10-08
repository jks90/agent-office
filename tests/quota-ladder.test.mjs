// FT-160 · quota-pause (FT-66) y model-ladder (FT-60): lógica pura, sin red ni CLIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isQuotaError, resetFromText, detectQuotaHit } from '../server/quota-pause.js';
import { ladderFor, ladders, pick, historyText, normalizeLadder, codexCheapModel, MAX_ESCALATIONS, TOP } from '../server/model-ladder.js';

test('quota: reconoce los mensajes de límite y no los errores normales', () => {
  for (const m of ['Claude AI usage limit reached|1759780800', 'You hit your limit', '429 Too Many Requests', 'weekly limit', 'quota exceeded']) assert.ok(isQuotaError(m), m);
  for (const m of ['', null, undefined, 'SyntaxError: unexpected token', 'tests failed']) assert.ok(!isQuotaError(m), String(m));
});

test('quota: hora de reinicio (epoch, relativa, absoluta) con reloj inyectado', () => {
  const now = new Date(2026, 9, 8, 10, 0, 0).getTime();
  assert.equal(resetFromText('limit reached|1759780800', now), 1759780800 * 1000);
  assert.equal(resetFromText('limit reached|1759780800000', now), 1759780800000);
  assert.equal(resetFromText('try again in 2 hours', now), now + 2 * 3600e3);
  assert.equal(resetFromText('try again in 45 minutes', now), now + 45 * 60e3);
  assert.equal(new Date(resetFromText('resets 7pm', now)).getHours(), 19);
  const next = new Date(resetFromText('resets at 8:30 AM', now)); // ya pasó hoy → mañana
  assert.equal(next.getDate(), 9);
  assert.equal(next.getMinutes(), 30);
  assert.equal(resetFromText('resets at 25:00', now), null);
  assert.equal(resetFromText('sin hora', now), null);
});

test('quota: detectQuotaHit', () => {
  assert.deepEqual(detectQuotaHit('todo bien'), { hit: false });
  assert.deepEqual(detectQuotaHit('usage limit reached, try again in 1 hour', 0), { hit: true, resetsAt: 3600e3 });
  assert.deepEqual(detectQuotaHit('rate limit', 0), { hit: true, resetsAt: null });
});

const noHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ladder-'));

test('escalera: de serie, de Ajustes (filtrada por motor) y vacía para otros motores', () => {
  assert.deepEqual(ladderFor('claude', {}, noHome), ['haiku', 'sonnet']);
  assert.deepEqual(ladderFor('codex', {}, noHome), [TOP.codex]); // sin models_cache.json: un solo peldaño
  assert.deepEqual(ladderFor('claude', { modelLadder: { claude: 'haiku > opus, gpt-5' } }, noHome), ['haiku', 'opus']);
  assert.deepEqual(ladderFor('local', {}, noHome), []);
  assert.deepEqual(normalizeLadder(['sonnet', 'gpt-5.5', ' '], 'claude'), ['sonnet']);
  assert.deepEqual(Object.keys(ladders({}, noHome)), ['claude', 'codex']);
});

test('escalera: modelo barato de Codex desde models_cache.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-codexhome-'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.5' }, { slug: 'gpt-5.5-mini' }, { slug: 'gpt-mini-hidden', visibility: 'hide' }] }));
  assert.equal(codexCheapModel(home), 'gpt-5.5-mini');
  assert.deepEqual(ladderFor('codex', {}, home), ['gpt-5.5-mini', TOP.codex]);
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), '{no json');
  assert.equal(codexCheapModel(home), null);
});

test('pick: empieza barato, planificación arriba, minModel y escalado con tope', () => {
  const lad = ['haiku', 'sonnet'];
  assert.deepEqual(pick('claude', lad), { model: 'haiku', level: 0, why: 'barato' });
  assert.deepEqual(pick('claude', lad, { plan: true }), { model: 'sonnet', level: 1, why: 'plan' });
  assert.deepEqual(pick('claude', lad, { floor: 'sonnet' }), { model: 'sonnet', level: 1, why: 'minModel' });
  assert.deepEqual(pick('claude', lad, { escalations: 1 }), { model: 'sonnet', level: 1, why: 'escalada' });
  assert.equal(pick('claude', lad, { escalations: 99 }).level, 1); // nunca sale de la escalera
  assert.equal(pick('claude', ['a', 'b', 'c', 'd'], { escalations: 99 }).level, MAX_ESCALATIONS);
  assert.equal(pick('claude', lad, { floor: 'opus' }).model, 'opus');        // fuera de la escalera, mismo motor
  assert.equal(pick('claude', lad, { floor: 'gpt-5.5' }).model, 'sonnet');   // de otro motor → techo
  assert.equal(pick('codex', ['mini', 'gpt-5.5'], { floor: 'sonnet', all: { claude: lad } }).level, 1); // «sonnet» = 2.º peldaño
  assert.equal(pick('claude', []), null);
});

test('historyText: sin repetidos consecutivos', () => {
  assert.equal(historyText([{ model: 'haiku' }, { model: 'haiku' }, { model: 'sonnet' }, {}]), 'haiku → sonnet');
  assert.equal(historyText(), '');
});
