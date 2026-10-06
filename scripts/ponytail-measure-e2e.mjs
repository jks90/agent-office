#!/usr/bin/env node
// e2e informativo de FT-87 · Ponytail (prueba medida)
// Muestra el procedimiento de medición A/B y el estado actual de costes sin ejecutar tareas.
// La medición real requiere cuota; usa motores reales Claude/Codex con ≥5 tareas aprobadas por variante.
// Criterio de decisión: activar si ahorra ≥15% SIN más devoluciones; si no, dejar apagada.
// Uso: node scripts/ponytail-measure-e2e.mjs [--role back] [--project myproj]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000, step = 500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

// Helper robusto para parsing de argumentos: devuelve undefined si el flag no existe
const getArg = (flag) => {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
};

const args = process.argv.slice(2);
const role = getArg('--role') ?? 'back';
const projectName = getArg('--project') ?? 'ponytail-measure';
const target = parseInt(getArg('--target') ?? '5'); // ≥5 tareas aprobadas por variante

console.log(`📊 FT-87: Ponytail (prueba medida)`);
console.log(`   Configuración: rol="${role}", proyecto="${projectName}", destino=≥${target} tareas/variante`);
console.log();

const tmp = process.env.AO_DATA_DIR || `/tmp/ao-measure-${Date.now()}`;
const dataDir = tmp, home = path.join(tmp, 'home');
for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });

const port = parseInt(process.env.AO_PORT) || 7420;
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e-info', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e-info', GIT_COMMITTER_EMAIL: 'e2e@x', HOME: home, AO_PORT: String(port), AO_HOST: '127.0.0.1', AO_DATA_DIR: dataDir, AO_RTK: 'off' };
let server;
const startServer = async () => { server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' }); await until(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 15_000, 300); };
const stopServer = async () => { server?.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(() => r(), 1500); server?.once('exit', () => { clearTimeout(t); r(); }); }); };
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json().catch(() => ({})); };
const state = () => call('GET', '/api/state');
process.on('exit', () => { try { server?.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nada */ } });

async function showInfo() {
  try {
    await startServer();
    const st = await state();
    check('servidor arrancó', st?.version !== undefined);
    if (!st?.version) return;

    console.log('📋 Procedimiento de medición A/B:');
    console.log();
    console.log('  1️⃣  Fase BASE (≥' + target + ' tareas aprobadas SIN Ponytail):');
    console.log('      - Ponytail desactivada por defecto.');
    console.log('      - Lanzar tareas similares y aprobarlas.');
    console.log('      - Telemetría registra variant="base" en cada una.');
    console.log();
    console.log('  2️⃣  Activar Ponytail (opción del rol):');
    console.log('      curl -X POST ' + base + '/api/settings \\');
    console.log('        -H "content-type: application/json" \\');
    console.log('        -d \'{"ponytailRoles":{"' + role + '":true}}\'');
    console.log();
    console.log('  3️⃣  Fase PONYTAIL (≥' + target + ' tareas aprobadas CON Ponytail):');
    console.log('      - Lanzar tareas similares con Ponytail activo.');
    console.log('      - Telemetría registra variant="ponytail".');
    console.log();
    console.log('  4️⃣  Tabla de resultados («💸 Costes» → «🧪 Ponytail vs base»):');
    console.log('      Métrica             │ Base   │ Ponytail │ Δ');
    console.log('      ────────────────────┼────────┼──────────┼───');
    console.log('      Tareas aprobadas    │ X      │ X        │');
    console.log('      $/aprobada          │ A      │ B        │ (A-B)/A×100%');
    console.log('      Tokens              │ T₁     │ T₂       │');
    console.log('      Salida tokens       │ O₁     │ O₂       │');
    console.log('      Devoluciones        │ D₁     │ D₂       │');
    console.log('      Líneas diff         │ L₁     │ L₂       │');
    console.log();
    console.log('  5️⃣  Criterio de decisión:');
    console.log('      ✓ ACTIVAR si: (base.cost - ponytail.cost) / base.cost ≥ 15%');
    console.log('                     Y ponytail.returns ≤ base.returns');
    console.log('      ✗ DEJAR APAGADA si no cumple los dos requisitos');
    console.log();
    console.log('APIs de telemetría:');
    console.log('  - GET /api/costs                → {tasks[], byVariant[{key, tasks, perApprovedUsd, tokens, outputTokens, returns, lines}]}');
    console.log('  - GET /api/costs?variant=base   → filtrar solo base');
    console.log('  - GET /api/costs?variant=ponytail → filtrar solo ponytail');
    console.log('  - GET /api/costs/export?format=csv → exportar para análisis externo');
    console.log();
    const costs = await call('GET', '/api/costs');
    console.log('📈 Estado actual de costes:');
    console.log(`   Tareas totales: ${costs.tasks?.length || 0}`);
    if (costs.byVariant?.length > 0) {
      console.log('   Por variante:');
      for (const v of costs.byVariant) {
        const cost = v.perApprovedUsd != null ? '$' + v.perApprovedUsd.toFixed(4) : '—';
        const tokens = v.tokens != null ? v.tokens : '—';
        console.log(`     • ${v.key}: ${v.tasks} aprobadas, ${cost}/aprobada, ${tokens} tokens`);
      }
    } else {
      console.log('   Sin datos aún (sin tareas aprobadas).');
    }
    console.log();
    console.log('✓ Recursos:');
    console.log('  - Flow de verificación: flowtest/medicion-ponytail-costos.flow.json');
    console.log('    (3 nodos HTTP con asserts en byVariant, filtro y CSV)');
    console.log('  - Documentación: flows/flowtest/README-FT-87.md (en flow-test workspace)');
    console.log('  - E2E de implementación: scripts/ponytail-e2e.mjs (26 checks, pasa)');
    console.log();
  } catch (e) { failed++; console.error('Error:', e.message); }

  console.log(failed ? `✗ ${failed} error(es)` : '✓ información mostrada');
  process.exit(failed ? 1 : 0);
}

showInfo().catch((e) => { console.error('Fatal:', e); process.exit(1); });
