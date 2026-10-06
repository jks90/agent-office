// Índice de código por símbolos vía MCP (FT-58): Codebase-Memory MCP (DeusData, MIT, binario único con tree-sitter, local).
// Un índice por repo en data/code-index/<repoKey>/ (CBM_CACHE_DIR), regenerado cuando cambia HEAD (como el briefing).
// Se conecta a los DOS motores (claude: --mcp-config; codex: -c mcp_servers.…); lo instala scripts/setup-code-index.sh.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './store.js';

export const SERVER_NAME = 'code-index';
// Herramientas del servidor que el prompt recomienda (nombres reales de Codebase-Memory).
export const TOOLS = ['search_graph', 'trace_path', 'get_code_snippet', 'search_code'];

const BIN = () => [process.env.AO_CODEINDEX_BIN, path.join(DATA_DIR, 'tools', 'bin', 'codebase-memory-mcp'), path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp')].find((f) => f && fs.existsSync(f)) || null;
export const available = () => !!BIN();
// Ajustes ▸ «Índice de código»: apagado por defecto hasta medir una mejora clara (FT-58); solo cuenta si está instalado.
export const enabled = (settings) => settings?.codeIndex === true && available();

const dirOf = (repoKey) => path.join(DATA_DIR, 'code-index', String(repoKey).replace(/[^\w.-]+/g, '_'));
const inflight = new Map(); // repoKey → Promise

const head = (repoPath) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// Devuelve { command, env } para el servidor MCP del repo, indexándolo antes si HEAD cambió; null si no se puede (el agente sigue sin índice).
export async function ensure(repoKey, repoPath, onLog = () => {}) {
  const bin = BIN();
  const h = repoPath && head(repoPath);
  if (!bin || !h) return null;
  const dir = dirOf(repoKey);
  const stamp = path.join(dir, 'HEAD');
  const conn = { command: bin, env: { CBM_CACHE_DIR: dir } };
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === h) return conn;
  if (!inflight.has(repoKey)) {
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    inflight.set(repoKey, new Promise((resolve) => {
      execFile(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: repoPath })], { env: { ...process.env, CBM_CACHE_DIR: dir }, timeout: 180_000, maxBuffer: 16e6 }, (err) => {
        if (err) { onLog(`⚠ Índice de código: no se pudo indexar ${repoKey} (${String(err.message).split('\n')[0].slice(0, 120)}); el agente trabaja sin él`); resolve(false); return; }
        fs.writeFileSync(stamp, h + '\n');
        onLog(`🗂 Índice de código de ${repoKey} listo en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        resolve(true);
      });
    }).finally(() => inflight.delete(repoKey)));
  }
  return (await inflight.get(repoKey)) ? conn : null;
}

// Líneas para el prompt (briefing + reglas de economía).
export const BRIEFING_LINE = `- Índice de código por símbolos disponible (servidor MCP «${SERVER_NAME}», FT-58): funciones, clases y llamadas del repo ya indexadas.`;
export const ECONOMY_RULE = `- Para ENCONTRAR dónde está una función/clase/llamada usa primero el índice MCP «${SERVER_NAME}» (${TOOLS.join(', ')}); lee el fichero solo en el tramo (Read offset/limit) que te devuelva.`;
