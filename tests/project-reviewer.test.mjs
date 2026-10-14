// 🔎 Revisor del proyecto: la revisión auto-qa la hace un agente APARTE del equipo (su rol, su modelo, sus MCP), no el autor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-reviewer-'));
process.env.AO_TEST_ALLOW_UNLINKED = '1';
const store = await import('../server/store.js');
const team = await import('../server/team.js');
const review = await import('../server/review.js');
const { get } = store;

const p = await team.createProject({ name: 'Bancos test', engine: 'demo', coordinator: false, defaultTeam: false });
const author = team.hire({ projectId: p.id, name: 'Autora', role: 'back', engine: 'demo' });
const rev = team.hire({ projectId: p.id, name: 'Revisora', role: 'qa', engine: 'demo' });
test.after(() => { store.flush(); });

test('reviewerAgentId: solo un agente fichado en el proyecto', async () => {
  const fuera = team.hire({ name: 'Fuera', role: 'qa', engine: 'demo' });
  await assert.rejects(team.updateProject(p.id, { reviewerAgentId: fuera.id }), (e) => e.status === 400);
  await team.updateProject(p.id, { reviewerAgentId: rev.id, reviewPolicy: 'auto-qa' });
  assert.equal(get().projects.find((x) => x.id === p.id).reviewerAgentId, rev.id);
});

test('auto-qa con revisor del proyecto: revisa la revisora (no la autora) y vuelve a quedar libre', async () => {
  const t = team.createTask({ projectId: p.id, title: 'Conciliar', role: 'back' });
  Object.assign(t, { status: 'review', agentId: author.id, summary: 'Saldos: banco 100,00 € · Home 100,00 €', reviewAt: Date.now() });
  await team.autoReview(get().projects.find((x) => x.id === p.id), t);
  assert.equal(t.reviewLogAgent, rev.id);
  assert.notEqual(t.status, 'review'); // el revisor demo aprueba
  assert.equal(get().agents.find((a) => a.id === rev.id).status, 'idle');
});

test('verifyPrompt: pide comprobar el resultado con sus herramientas y lleva el resumen del autor', () => {
  const s = review.verifyPrompt({ code: 'BA-9', title: 'Conciliación', description: 'd', summary: 'Saldos banco vs Home' });
  assert.match(s, /agente distinto del autor/);
  assert.match(s, /Saldos banco vs Home/);
  assert.match(s, /"approve"/);
});

test('veredicto «human»: lo que falta solo lo puede hacer el usuario → se reconoce para no devolverla', () => {
  const v = review.parseVerdict('tabla…\n{"approve": false, "human": true, "reasons": ["falta SMS de Unicaja"], "feedback": "autoriza los 90 días", "pending": []}');
  assert.equal(v.approve, false); assert.equal(v.human, true);
  assert.equal(review.parseVerdict('{"approve": false, "reasons": [], "feedback": "x"}').human, false);
  assert.match(review.verifyPrompt({ code: 'X-1', title: 't', summary: 's' }), /"human": true/);
});
