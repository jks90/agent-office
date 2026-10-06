#!/usr/bin/env node
// FT-62 · pruebas unitarias del detector de atascos (server/stuck.js): cada señal y los reinicios por edición.
import { createDetector, limits } from '../server/stuck.js';
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
let id = 0;
const run = (d, tool, key, ok = true) => { const callId = 'c' + ++id; const a = d.feed({ phase: 'started', callId, tool, key }); const b = d.feed({ phase: 'finished', callId, ok }); return a || b; };
const L = limits({});

let d = createDetector({ limits: L });
check('misma orden 2 veces: sin señal', !run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls'));
check('3.ª vez: señal', /repite la orden «ls»/.test(run(d, 'Bash', 'ls') || ''));
d = createDetector({ limits: L });
run(d, 'Read', '/a.js'); run(d, 'Read', '/a.js'); run(d, 'Edit', null);
check('editar reinicia las repeticiones', !run(d, 'Read', '/a.js'));
d = createDetector({ limits: L });
run(d, 'Read', '/a.js'); run(d, 'Read', '/a.js');
check('3.ª lectura del mismo fichero: señal', /relee \/a\.js/.test(run(d, 'Read', '/a.js') || ''));
d = createDetector({ limits: L });
const errs = [1, 2, 3, 4].map((i) => run(d, 'Grep', null, false));
check('4 errores seguidos: señal en el 4.º', !errs[2] && /4 errores/.test(errs[3] || ''), JSON.stringify(errs));
d = createDetector({ limits: L });
run(d, 'Grep', null, false); run(d, 'Grep', null, false); run(d, 'Grep', null, true);
check('un acierto corta la racha de errores', !run(d, 'Grep', null, false));
d = createDetector({ limits: L });
const e2e = [1, 2, 3].map(() => run(d, 'Bash', 'node scripts/x-e2e.mjs', false));
check('e2e fallando igual 3 veces: señal', /falla igual por 3/.test(e2e.find(Boolean) || ''), JSON.stringify(e2e));
d = createDetector({ limits: L, isCode: true });
let sig = null; for (let i = 0; i < 25 && !sig; i++) sig = run(d, 'Grep', null);
check('25 pasos sin editar en tarea de código: señal', /25 pasos/.test(sig || ''), String(sig));
d = createDetector({ limits: L, isCode: false });
sig = null; for (let i = 0; i < 40; i++) sig = sig || run(d, 'Grep', null);
check('tarea que no es de código (QA/docs): sin esa señal', !sig);
d = createDetector({ limits: { ...L, enabled: false } });
check('desactivado en Ajustes: nunca señal', !run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls') && !run(d, 'Bash', 'ls'));
let state = 'A';
d = createDetector({ limits: L, probe: async () => state });
let t = 0, r = null;
for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000); // 1.ª ventana: fija el estado de referencia
check('1.ª ventana de tokens: solo referencia', r === null);
for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000);
check('100 k/turno con el worktree igual: señal', /100 k tokens por turno/.test(r || ''), String(r));
state = 'B';
for (let i = 0; i < 4; i++) r = await d.usage(t += 100_000);
check('si el worktree cambió: sin señal', r === null);
console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
