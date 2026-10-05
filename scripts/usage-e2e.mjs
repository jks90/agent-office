#!/usr/bin/env node
// Prueba del consumo de tokens (FT-26): alimenta los trackers con eventos reales de `claude -p` (stream-json) y `codex exec --json`
// y comprueba las cifras. Sin red ni CLIs ni dependencias:  node scripts/usage-e2e.mjs
import { claudeTracker, codexTracker, addUsage } from '../server/usage.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ' — ' + detail}`); if (!ok) failed++; };
const asst = (id, u) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage: u } });

console.log('▸ Claude');
const c = claudeTracker();
check('evento sin uso → null', c.feed({ type: 'system', subtype: 'init' }) === null);
let u = c.feed(asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }));
check('un mensaje', u.input === 10 && u.output === 5 && u.cache === 1200 && u.total === 1215 && u.limit === null, JSON.stringify(u));
u = c.feed(asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })); // mismo id (otro bloque)
check('mismo message.id no duplica', u.total === 1215);
u = c.feed(asst('m2', { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 }));
check('segundo mensaje suma y ocupa el contexto de esa llamada', u.total === 1215 + 1224 && u.used === 1204, JSON.stringify(u));
u = c.feed({ type: 'result', total_cost_usd: 0.0123, usage: { input_tokens: 14, output_tokens: 25, cache_read_input_tokens: 2200, cache_creation_input_tokens: 200 }, modelUsage: { 'claude-sonnet': { contextWindow: 200000 } } });
check('result: total, límite y coste', u.input === 14 && u.output === 25 && u.cache === 2400 && u.total === 2439 && u.limit === 200000 && u.costUsd === 0.0123, JSON.stringify(u));
check('result sin usage → null', claudeTracker().feed({ type: 'result' }) === null);
check('basura no rompe', claudeTracker().feed({ type: 'assistant', message: { usage: { input_tokens: 'x', output_tokens: -3 } } }).total === 0);

console.log('▸ Codex');
const x = codexTracker();
check('evento ajeno → null', x.feed({ type: 'item.completed' }) === null && x.feed({ type: 'turn.completed' }) === null);
u = x.feed({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 } });
check('entrada sin caché = input − cached; salida ya incluye razonamiento', u.input === 200 && u.cache === 800 && u.output === 50 && u.total === 1050 && u.limit === null, JSON.stringify(u));
u = x.feed({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
check('varios turnos se acumulan', u.total === 1065);

console.log('▸ Intentos de una tarea');
const s = addUsage({ input: 1, output: 2, cache: 3, total: 6, costUsd: null }, { input: 10, output: 20, cache: 30, total: 60, limit: 100, used: 50, costUsd: 0.5 });
check('addUsage suma', s.total === 66 && s.limit === 100 && s.costUsd === 0.5);
check('addUsage(null, b) = b', addUsage(null, u) === u);

console.log(failed ? `\n${failed} fallo(s)` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
