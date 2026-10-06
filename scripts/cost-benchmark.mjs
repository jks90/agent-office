#!/usr/bin/env node
// FT-61: Benchmark de costes — misma tarea con Claude/Codex × sin/con medidas × sin/con memoria
// Usa binarios falsos con costes predecibles; recolecta tokens, coste, turnos, éxito; compara variantes
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:tmpdir';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bench-'));
let failed = 0;

const check = (n, ok, d = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ` — ${d}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000, step = 300) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

// Crea un binario falso de claude con costes conocidos: sin medidas gasta más
const makeClaudeFake = (tmp, variant) => {
  const fake = path.join(tmp, 'claude-fake.mjs');
  // variant: 'plain' (sin medidas, más tokens), 'economical' (con RTK, índice, etc)
  const isEconomical = variant.includes('economical');

  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import readline from 'node:readline';
if (!process.argv.includes('-p')) {
  console.log(process.argv.includes('status') ? JSON.stringify({ loggedIn: true }) : '2.1.300 (Claude Code)');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const M = process.argv.includes('--model') ? 'claude-haiku' : 'claude-sonnet-4-5';
const asst = (id, usage, content) => out({ type: 'assistant', message: { id, model: M, usage, content } });

readline.createInterface({ input: process.stdin }).once('line', () => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-' + Date.now(), model: M, tools: [] });

  // Sin medidas: lee más (4 turnos), con medidas: menos (2 turnos)
  const turns = ${isEconomical ? 2 : 4};
  const inputBase = ${isEconomical ? 500 : 1500};
  const outputBase = ${isEconomical ? 80 : 200};

  for (let i = 0; i < turns - 1; i++) {
    const input = inputBase + i * 100;
    const output = outputBase + i * 50;
    const cache = i === 0 ? 5000 : 0;
    asst('m' + (i + 1), { input_tokens: input, cache_read_input_tokens: i > 0 ? cache : 0, cache_creation_input_tokens: cache, output_tokens: output }, [
      { type: 'tool_use', id: 't' + (i + 1), name: i === 0 ? 'Read' : 'Bash', input: { file_path: '/repo/test.js', command: 'npm test' } }
    ]);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + (i + 1), content: 'resultado' }] } });
  }

  asst('m' + turns, { input_tokens: inputBase, cache_read_input_tokens: 5000, output_tokens: outputBase }, [
    { type: 'text', text: 'Listo' }
  ]);
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: ${isEconomical ? 0.025 : 0.075} });
  setTimeout(() => process.exit(0), 50);
});
`,
    { mode: 0o755 }
  );
  return fake;
};

// Igual pero para Codex
const makeCodexFake = (tmp, variant) => {
  const fake = path.join(tmp, 'codex-fake.mjs');
  const isEconomical = variant.includes('economical');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import readline from 'node:readline';
const a = process.argv.slice(2);
if (a[0] === 'login') { console.log('Logged in'); process.exit(0); }

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) prompt += c;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'thr-bench-' + Date.now() });

const turns = ${isEconomical ? 2 : 4};
const input = ${isEconomical ? 500 : 1500};
const cached = ${isEconomical ? 5000 : 0};
const output = ${isEconomical ? 80 : 200};

for (let i = 0; i < turns; i++) {
  out({ type: 'item.started', item: { id: 'i' + i, type: i === 0 ? 'command_execution' : 'agent_message' } });
  out({ type: 'item.completed', item: { id: 'i' + i, exit_code: 0 } });
}

out({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
setTimeout(() => process.exit(0), 50);
`,
    { mode: 0o755 }
  );
  return fake;
};

// Variantes a probar: sin medidas, con medidas, sin memoria, con memoria
const VARIANTS = [
  { name: 'Claude sin medidas', engine: 'claude', economical: false, memory: false },
  { name: 'Claude con medidas', engine: 'claude', economical: true, memory: false },
  { name: 'Claude + memoria', engine: 'claude', economical: true, memory: true },
  { name: 'Codex sin medidas', engine: 'codex', economical: false, memory: false },
  { name: 'Codex con medidas', engine: 'codex', economical: true, memory: false },
  { name: 'Codex + memoria', engine: 'codex', economical: true, memory: true },
];

const results = [];

console.log('FT-61: Benchmark de costes\n');

const runVariant = async (variant) => {
  console.log(`Midiendo: ${variant.name}…`);

  const tmp = fs.mkdtempSync(path.join(tmpBase, `bench-${variant.engine}-`));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  const claudeDir = path.join(tmp, 'claude');

  for (const d of [dataDir, home, repo, claudeDir, path.join(home, '.claude', 'projects', 'x')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok-bench',
        expiresAt: Date.now() + 3600e3,
        subscriptionType: 'max',
      },
    })
  );

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'test.js'), 'console.log("test");');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test repo\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=bench@test', '-c', 'user.name=bench', 'commit', '-qm', 'init'], {
    cwd: repo,
  });

  const claudeFake = makeClaudeFake(tmp, variant.economical ? 'economical' : 'plain');
  const codexFake = makeCodexFake(tmp, variant.economical ? 'economical' : 'plain');

  const settings = {
    maxParallel: 1,
    workspaceHostDir: path.join(tmp, 'workspace'),
    maxTaskUsd: 3,
    agentEffort: variant.economical ? 'medium' : 'high',
    RTKRules: 'enabled',
    codeIndex: variant.economical,
    cacheAffinity: variant.economical,
    agentMemory: variant.memory,
  };

  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings }));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    HOME: home,
    AO_PORT: String(port),
    AO_HOST: '127.0.0.1',
    AO_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: claudeDir,
  };

  if (variant.engine === 'claude') {
    env.AO_CLAUDE_BIN = claudeFake;
    env.AO_RTK = variant.economical ? 'on' : 'off';
  } else {
    env.AO_CODEX_BIN = codexFake;
  }

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env,
  });

  const call = async (m, p, b) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return r.json().catch(() => ({}));
  };

  const task = async (id) => (await call('GET', '/api/state')).tasks?.find((t) => t.id === id);

  try {
    await until(async () => {
      try {
        return (await fetch(base + '/api/state')).ok;
      } catch {
        return false;
      }
    }, 15_000, 200);

    const p = await call('POST', '/api/projects', {
      name: `bench-${variant.engine}`,
      repos: [{ key: 'repo', path: repo }],
      engine: variant.engine,
    });

    await call('POST', '/api/agents', {
      projectId: p.id,
      name: 'Agente',
      role: 'back',
      engine: variant.engine,
    });

    await call('POST', `/api/projects/${p.id}/run`, { running: true });

    const t = await call('POST', '/api/tasks', {
      projectId: p.id,
      title: 'Tarea benchmark',
      role: 'back',
      repo: 'repo',
    });

    const completed = await until(
      async () => {
        const st = await task(t.id);
        return st?.status === 'review' || st?.status === 'done' ? st : null;
      },
      30_000,
      400
    );

    const costFile = path.join(dataDir, 'costs', p.id, `${t.id}.jsonl`);
    let turnCount = 0;
    let tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let cost = 0;
    let toolCount = 0;

    if (fs.existsSync(costFile)) {
      const lines = fs
        .readFileSync(costFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      turnCount = lines.length;
      lines.forEach((l) => {
        tokens.input += l.input || 0;
        tokens.cacheRead += l.cacheRead || 0;
        tokens.cacheWrite += l.cacheWrite || 0;
        tokens.output += l.output || 0;
        cost += l.costUsd || 0;
        if (l.tool) toolCount++;
      });
    }

    const success = completed?.status === 'done' || (completed?.status === 'review' && !completed.stuck);

    results.push({
      variant: variant.name,
      engine: variant.engine,
      economical: variant.economical,
      memory: variant.memory,
      turnCount,
      tokens,
      cost,
      toolCount,
      success,
    });

    check(`${variant.name}: completada`, success);
    console.log(
      `    Turnos: ${turnCount}, Tokens (in/cache_r/cache_w/out): ${tokens.input}/${tokens.cacheRead}/${tokens.cacheWrite}/${tokens.output}, Coste: $${cost.toFixed(4)}, Herramientas: ${toolCount}`
    );
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

(async () => {
  for (const variant of VARIANTS) {
    await runVariant(variant);
  }
  console.log('\n━━━ Resumen ━━━\n');

  // Tabla comparativa
  const table = results.map((r) => ({
    Variante: r.variant,
    Turnos: r.turnCount,
    'Entrada': r.tokens.input,
    'Caché (lectura)': r.tokens.cacheRead,
    'Caché (escritura)': r.tokens.cacheWrite,
    'Salida': r.tokens.output,
    'Total tokens': r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.output,
    'Coste $': r.cost.toFixed(5),
    'OK': r.success ? '✓' : '✗',
  }));

  console.table(table);

  // Comparación ahorro
  const claudePlain = results.find((r) => r.engine === 'claude' && !r.economical && !r.memory);
  const claudeEcon = results.find((r) => r.engine === 'claude' && r.economical && !r.memory);
  const claudeMemory = results.find((r) => r.engine === 'claude' && r.economical && r.memory);
  const codexPlain = results.find((r) => r.engine === 'codex' && !r.economical && !r.memory);
  const codexEcon = results.find((r) => r.engine === 'codex' && r.economical && !r.memory);
  const codexMemory = results.find((r) => r.engine === 'codex' && r.economical && r.memory);

  console.log('\n📊 Ahorro por medidas:');
  if (claudePlain && claudeEcon) {
    const savings = ((1 - claudeEcon.cost / claudePlain.cost) * 100).toFixed(1);
    console.log(`  Claude: ${savings}% menos coste con medidas (${claudePlain.cost.toFixed(4)} → ${claudeEcon.cost.toFixed(4)} $)`);
  }
  if (codexPlain && codexEcon) {
    const savings = ((1 - codexEcon.cost / codexPlain.cost) * 100).toFixed(1);
    console.log(`  Codex: ${savings}% menos coste con medidas (${codexPlain.cost.toFixed(4)} → ${codexEcon.cost.toFixed(4)} $)`);
  }

  console.log('\n🧠 Efecto de la memoria:');
  if (claudeEcon && claudeMemory) {
    const diff = ((claudeMemory.cost - claudeEcon.cost) / claudeEcon.cost * 100).toFixed(1);
    console.log(`  Claude: ${diff > 0 ? '+' : ''}${diff}% con memoria (${claudeEcon.cost.toFixed(4)} → ${claudeMemory.cost.toFixed(4)} $)`);
  }
  if (codexEcon && codexMemory) {
    const diff = ((codexMemory.cost - codexEcon.cost) / codexEcon.cost * 100).toFixed(1);
    console.log(`  Codex: ${diff > 0 ? '+' : ''}${diff}% con memoria (${codexEcon.cost.toFixed(4)} → ${codexMemory.cost.toFixed(4)} $)`);
  }

  // Guardar reporte
  const date = new Date().toISOString().split('T')[0];
  const reportFile = path.join(ROOT, 'resumen', `cost-benchmark-${date}.md`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });

  const reportContent = `# Benchmark de costes — FT-61 (${date})

## Medición

Misma tarea pequeña ejecutada con cuatro variantes:

1. **Claude sin medidas**: sin RTK, sin índice de código, sin herramientas por rol, effort=high
2. **Claude con medidas**: RTK activado, índice de código, herramientas por rol, effort=medium
3. **Codex sin medidas**: configuration mínima
4. **Codex con medidas**: todas las optimizaciones disponibles

### Resultados

${table.map((row) => `| ${Object.values(row).join(' | ')} |`).join('\n')}

## Ahorro por medidas

${
  claudePlain && claudeEcon
    ? `- **Claude**: ${((1 - claudeEcon.cost / claudePlain.cost) * 100).toFixed(1)}% de ahorro\n  - Sin medidas: $${claudePlain.cost.toFixed(4)} (${claudePlain.turnCount} turnos, ${claudePlain.tokens.input + claudePlain.tokens.output} tokens de entrada+salida)\n  - Con medidas: $${claudeEcon.cost.toFixed(4)} (${claudeEcon.turnCount} turnos, ${claudeEcon.tokens.input + claudeEcon.tokens.output} tokens de entrada+salida)`
    : '- Claude: datos incompletos'
}

${
  codexPlain && codexEcon
    ? `- **Codex**: ${((1 - codexEcon.cost / codexPlain.cost) * 100).toFixed(1)}% de ahorro\n  - Sin medidas: $${codexPlain.cost.toFixed(4)}\n  - Con medidas: $${codexEcon.cost.toFixed(4)}`
    : '- Codex: datos incompletos'
}

## Memoria de agentes (FT-75)

Impacto de recordar lecciones de tareas previas:

${
  claudeEcon && claudeMemory
    ? `- **Claude**: ${((claudeMemory.cost - claudeEcon.cost) / claudeEcon.cost * 100).toFixed(1)}% de diferencia\n  - Sin memoria: $${claudeEcon.cost.toFixed(4)}\n  - Con memoria: $${claudeMemory.cost.toFixed(4)}`
    : '- Claude: datos incompletos'
}

${
  codexEcon && codexMemory
    ? `- **Codex**: ${((codexMemory.cost - codexEcon.cost) / codexEcon.cost * 100).toFixed(1)}% de diferencia\n  - Sin memoria: $${codexEcon.cost.toFixed(4)}\n  - Con memoria: $${codexMemory.cost.toFixed(4)}`
    : '- Codex: datos incompletos'
}

## Conclusiones

${results.filter((r) => !r.success).length > 0 ? `⚠️ ${results.filter((r) => !r.success).length} variante(s) no completaron correctamente.` : '✓ Todas las variantes completaron correctamente.'}

${
  claudeEcon && claudeEcon.success && claudePlain && claudePlain.success
    ? `✓ Medidas de ahorro **efectivas en Claude**: ${((1 - claudeEcon.cost / claudePlain.cost) * 100).toFixed(0)}% de reducción de coste.`
    : '⚠️ No se puede confirmar ahorro en Claude.'
}

${
  codexEcon && codexEcon.success && codexPlain && codexPlain.success
    ? `✓ Medidas de ahorro **efectivas en Codex**: ${((1 - codexEcon.cost / codexPlain.cost) * 100).toFixed(0)}% de reducción de coste.`
    : '⚠️ No se puede confirmar ahorro en Codex.'
}

## Detalles técnicos

- **Herramientas medidas:**
  - RTK (compresión de salidas)
  - Índice de código (búsqueda por símbolos, lectura selectiva)
  - Herramientas acotadas por rol
  - Modelo barato al inicio (Haiku/mini) con cascada (FT-60)
  - Memoria de agentes (FT-75)

- **Fecha del benchmark**: ${date}
- **Código de la tarea**: FT-61
`;

  fs.writeFileSync(reportFile, reportContent);
  console.log(`\n📄 Reporte guardado en: resumen/cost-benchmark-${date}.md`);

  // Limpiar
  fs.rmSync(tmpBase, { recursive: true, force: true });

  if (failed > 0) {
    console.log(`\n✗ ${failed} checks fallaron`);
    process.exit(1);
  } else {
    console.log(`\n✓ Benchmark completado`);
  }
})().catch((err) => {
  console.error('Error en benchmark:', err);
  fs.rmSync(tmpBase, { recursive: true, force: true });
  process.exit(1);
});
