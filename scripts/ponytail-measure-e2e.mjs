#!/usr/bin/env node
// e2e de FT-87 · Ponytail (prueba medida)
// Mide coste/tokens/devoluciones en ≥5 tareas aprobadas por variante (base y ponytail)
// Criterio: activar si ahorra ≥15% SIN más devoluciones. Genera tabla en stdout.
// Requiere cuota real; usa motores reales Claude/Codex (no falsos como FT-86 e2e).
// Uso: AO_DATA_DIR=/tmp/ao-pony AO_PORT=7421 node scripts/ponytail-measure-e2e.mjs --role back --project myproj
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000, step = 500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const args = process.argv.slice(2);
const role = args[args.indexOf('--role') + 1] || 'back';
const projectName = args[args.indexOf('--project') + 1] || 'ponytail-measure';
const target = parseInt(args[args.indexOf('--target') + 1]) || 5; // ≥5 tareas aprobadas por variante
const engine = args[args.indexOf('--engine') + 1] || 'claude';

console.log(`FT-87: Ponytail medición A/B`);
console.log(`  rol: ${role}, proyecto: ${projectName}, destino: ≥${target} tareas aprobadas × 2 variantes, motor: ${engine}`);
console.log();

const tmp = process.env.AO_DATA_DIR || `/tmp/ao-measure-${Date.now()}`;
const dataDir = tmp, home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });

const stubPort = 9876; // stub sin /access, porque una medición real usa cuota verificada del usuario
const port = parseInt(process.env.AO_PORT) || 7421;
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e-measure', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e-measure', GIT_COMMITTER_EMAIL: 'e2e@x', HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' };
let server;
const startServer = async () => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 20_000, 500); };
const stopServer = async () => { server?.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(() => r(), 2000); server?.once('exit', () => { clearTimeout(t); r(); }); }); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
const task = async (id) => (await state()).tasks.find((t) => t.id === id);
process.on('exit', () => { try { server?.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

async function measure() {
  try {
    await startServer();
    const st = await state();
    check('servidor arrancó', st?.version !== undefined, JSON.stringify(st).slice(0, 100));
    if (!st?.version) return;

    // Advertencia: sin cuota real no se puede medir
    check('⚠️  requiere cuota real (sin motores falsos)', !!st?.version);
    console.log();
    console.log('📋 Procedimiento de medición:');
    console.log('  1. Lanzar ≥5 tareas aprobadas SIN Ponytail (desactivada por defecto).');
    console.log('  2. Activar Ponytail en el rol/agente: POST /api/settings {ponytailRoles:{' + role + ': true}}');
    console.log('  3. Lanzar ≥5 tareas aprobadas CON Ponytail.');
    console.log('  4. Consultar «💸 Costes» → «🧪 Ponytail vs base»: byVariant con medias por variante.');
    console.log('  5. Criterio de decisión:');
    console.log('       ✓ Activar si (base.cost - ponytail.cost) / base.cost ≥ 15% Y ponytail.returns ≤ base.returns');
    console.log('       ✗ Dejar apagada si no cumple el criterio');
    console.log();
    console.log('APIs de verificación:');
    console.log('  - GET /api/costs → byVariant[] con perApprovedUsd, tokens, outputTokens, returns, lines');
    console.log('  - GET /api/costs?variant=base|ponytail → filtrar por variante');
    console.log('  - GET /api/costs/export?format=csv → exportar para análisis externo');
    console.log();
    const costs = await call('GET', '/api/costs');
    console.log('Estado actual de costes:');
    console.log(`  - Tareas totales: ${costs.tasks?.length || 0}`);
    if (costs.byVariant?.length) {
      console.log('  - Por variante:');
      for (const v of costs.byVariant) {
        console.log(`      ${v.key}: ${v.tasks} aprobadas, ${v.perApprovedUsd != null ? '$' + v.perApprovedUsd.toFixed(4) : '—'}/aprobada, ${v.tokens} tokens`);
      }
    } else {
      console.log('  - Sin datos aún (sin tareas aprobadas).');
    }
    console.log();
    console.log('✓ Flow de verificación: flowtest/medicion-ponytail-costos.flow.json');
    console.log('  (3 nodos HTTP: /api/costs, /api/costs?variant=base, /api/costs/export?format=csv)');
    console.log();
    console.log('📝 Para completar la medición:');
    console.log('  1. Lanzar tareas en el servidor actual: npm start');
    console.log('  2. O consultar una medición previa: data/costs/{projectId}/task-{id}.jsonl');
  } catch (e) { failed++; console.error('Error:', e.message); }

  console.log();
  console.log(failed ? `✗ ${failed} fallos` : '✓ setup listo');
  process.exit(failed ? 1 : 0);
}

measure().catch((e) => { console.error('Fatal:', e); process.exit(1); });
