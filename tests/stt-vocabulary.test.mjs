// 🎤 Vocabulario del reconocedor de voz (server/guide/stt/index.js): palabras de la casa + proyectos, agentes, roles y el
// vocabulario extra de Ajustes, sin repetir y con tope de 600 caracteres (initial_prompt de Whisper / prompt de OpenAI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stt-voc-'));
const { vocabulary } = await import('../server/guide/stt/index.js');

test('vocabulario: casa + estado + extra, sin duplicados y con tope', () => {
  const s = { projects: [{ name: 'GestionLab' }, { name: 'flowtest' }], agents: [{ name: 'Vega' }, { name: 'Vega' }], roles: { qa: { label: 'QA' }, e: { label: 'Estratega Lp' } }, settings: { sttVocabulary: 'Revert, Uniswap\nHicham' } };
  const v = vocabulary(s).split(', ');
  for (const w of ['AgentOffice', 'flow-test', 'GestionLab', 'Vega', 'Estratega Lp', 'Revert', 'Uniswap', 'Hicham']) assert.ok(v.includes(w), w);
  assert.equal(v.filter((w) => w === 'Vega').length, 1);
  assert.equal(v.filter((w) => w === 'QA').length, 1);
  const big = { projects: Array.from({ length: 200 }, (_, i) => ({ name: `Proyecto número ${i}` })), agents: [], roles: {}, settings: {} };
  assert.ok(vocabulary(big).length <= 600);
});
