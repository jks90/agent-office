// Catálogos de MCP y de scripts que se pueden dar a los agentes (por agente o por rol), junto al de skills en _agentes/.
//   mcp.json     → [{ name, description }]: solo el NOMBRE. La definición (comando, URL y sus claves) se lee al lanzar de la
//                  config del usuario (~/.claude.json, ~/.codex/config.toml): ningún secreto se copia al workspace (es git).
//   scripts.json → [{ name, path, description }]: scripts propios (de las carpetas scripts/ de los repos o añadidos a mano).
// Asignación: agent.mcps / agent.scripts (ficha del agente) y `mcps:` / `scripts:` en el frontmatter del rol.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import { catalogDir } from './skills.js';

const HOME = os.homedir();
const short = (p) => String(p || '').replace(HOME, '~');
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const cleanName = (n) => String(n || '').trim().replace(/[^\w.-]+/g, '-').slice(0, 80);

// MCP con acciones que cuestan dinero o tocan producción: la UI avisa al asignarlos.
export const RISKY_MCP = /hostinger|billing|stripe|paypal|aws|gcp|azure/i;

// ── Inventario de MCP del PC ────────────────────────────────────────────────
const claudeJson = () => readJson(process.env.AO_CLAUDE_JSON || path.join(HOME, '.claude.json'), {});
const codexToml = () => { try { return fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'utf8'); } catch { return ''; } };
export function codexMcpNames(toml = codexToml()) {
  const out = new Set();
  for (const m of String(toml).matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([\w-]+))\]\s*$/gm)) out.add(m[1] || m[2]);
  return [...out];
}
const kindOf = (d) => d?.type || (d?.url ? 'http' : 'stdio');
// Resumen sin secretos: comando + args (o URL), nunca env ni cabeceras.
const summaryOf = (d) => (d?.url ? String(d.url) : [d?.command, ...(Array.isArray(d?.args) ? d.args : [])].filter(Boolean).join(' ')).slice(0, 200);

// Definiciones de Claude por nombre: primero las del usuario; después las de cada proyecto (la primera que aparezca).
function claudeDefs() {
  const j = claudeJson();
  const defs = new Map();
  for (const [n, d] of Object.entries(j.mcpServers || {})) defs.set(n, { def: d, scope: 'Claude (usuario)' });
  for (const [p, v] of Object.entries(j.projects || {})) for (const [n, d] of Object.entries(v?.mcpServers || {})) if (!defs.has(n)) defs.set(n, { def: d, scope: `Claude (${short(p)})` });
  return defs;
}

export function mcpInventory() {
  const defs = claudeDefs(), codex = codexMcpNames(), cat = new Set(mcpCatalog().map((c) => c.name));
  const names = [...new Set([...defs.keys(), ...codex])].sort();
  return names.map((name) => {
    const c = defs.get(name);
    return { name, type: c ? kindOf(c.def) : 'stdio', summary: c ? summaryOf(c.def) : '(definido en ~/.codex/config.toml)',
      sources: [c?.scope, codex.includes(name) ? 'Codex' : null].filter(Boolean), risky: RISKY_MCP.test(name), central: cat.has(name) };
  });
}

// ── Catálogos ───────────────────────────────────────────────────────────────
const mcpFile = () => path.join(catalogDir(), 'mcp.json');
const scriptsFile = () => path.join(catalogDir(), 'scripts.json');
export const mcpCatalog = () => (readJson(mcpFile(), []) || []).filter((x) => x?.name);
export const scriptCatalog = () => (readJson(scriptsFile(), []) || []).filter((x) => x?.name && x?.path);

export function addMcp({ name, description = '' }) {
  const n = cleanName(name);
  if (!n) throw fail(400, 'Falta el nombre del MCP');
  if (!mcpInventory().some((m) => m.name === n)) throw fail(404, `No encuentro «${n}» en la config de Claude ni de Codex de este PC`);
  const list = mcpCatalog().filter((x) => x.name !== n);
  list.push({ name: n, description: String(description).slice(0, 300) });
  writeJson(mcpFile(), list.sort((a, b) => a.name.localeCompare(b.name)));
  return { name: n };
}
export function removeMcp(name) { writeJson(mcpFile(), mcpCatalog().filter((x) => x.name !== name)); return { ok: true }; }

// Descripción de un script: la primera línea de comentario útil (tras el shebang).
function describeScript(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000).split('\n').slice(0, 12);
    for (const l of head) { const m = l.match(/^\s*(?:\/\/|#(?!!)|--)\s*(.{8,})$/); if (m) return m[1].trim().slice(0, 200); }
  } catch { /* ilegible */ }
  return '';
}
const SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts|py)$/i;
export function scriptInventory() {
  const repos = new Map();
  for (const p of store.get().projects) for (const r of p.repos || []) if (r.path && !repos.has(r.path)) repos.set(r.path, p.name);
  const cat = new Map(scriptCatalog().map((s) => [path.resolve(s.path), s.name]));
  const out = [];
  for (const [repo, project] of repos) {
    const dir = path.join(repo, 'scripts');
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && SCRIPT_EXT.test(e.name) && !e.name.startsWith('_')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f.name);
      out.push({ name: f.name.replace(SCRIPT_EXT, ''), path: full, short: short(full), group: `${project} · ${short(repo)}`, description: describeScript(full), central: cat.get(path.resolve(full)) || null });
    }
  }
  return out;
}
export function addScript({ path: p, name, description }) {
  const full = path.resolve(String(p || '').replace(/^~(?=\/|$)/, HOME));
  if (!full.startsWith(HOME + path.sep)) throw fail(400, 'El script tiene que estar dentro de tu carpeta personal');
  let st; try { st = fs.statSync(full); } catch { throw fail(404, `No existe ${short(full)}`); }
  if (!st.isFile()) throw fail(400, `${short(full)} no es un fichero`);
  const n = cleanName(name || path.basename(full).replace(SCRIPT_EXT, ''));
  const list = scriptCatalog().filter((x) => x.name !== n && path.resolve(x.path) !== full);
  list.push({ name: n, path: full, description: String(description ?? describeScript(full)).slice(0, 300) });
  writeJson(scriptsFile(), list.sort((a, b) => a.name.localeCompare(b.name)));
  return { name: n };
}
export function removeScript(name) { writeJson(scriptsFile(), scriptCatalog().filter((x) => x.name !== name)); return { ok: true }; }

// ── Lo que lleva un agente al lanzar una tarea ──────────────────────────────
const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];
export const assignedMcps = (agent, role) => union(agent?.mcps || [], role?.mcps || []);
export const assignedScripts = (agent, role) => union(agent?.scripts || [], role?.scripts || []);

// { claude: {nombre: def}, codexKeep: [nombres ya definidos en config.toml], codexArgs: ['-c', …] (los que solo tiene Claude), missing: [] }
export function resolveMcps(names) {
  const defs = claudeDefs(), codex = codexMcpNames();
  const out = { claude: {}, codexKeep: [], codexArgs: [], missing: [] };
  for (const n of names) {
    const c = defs.get(n);
    if (!c && !codex.includes(n)) { out.missing.push(n); continue; }
    if (c) out.claude[n] = c.def;
    if (codex.includes(n)) out.codexKeep.push(n);
    else if (c) { // solo en Claude: se le pasa a Codex por -c (TOML; los guiones del nombre pasan a «_»)
      const k = `mcp_servers.${n.replace(/[^\w]/g, '_')}`, d = c.def;
      if (d.url) out.codexArgs.push('-c', `${k}.url=${JSON.stringify(d.url)}`);
      else {
        out.codexArgs.push('-c', `${k}.command=${JSON.stringify(d.command || '')}`, '-c', `${k}.args=${JSON.stringify(Array.isArray(d.args) ? d.args : [])}`);
        if (d.env && Object.keys(d.env).length) out.codexArgs.push('-c', `${k}.env={${Object.entries(d.env).map(([a, v]) => `${a}=${JSON.stringify(String(v))}`).join(',')}}`);
      }
    }
  }
  return out;
}

export function resolveScripts(names) {
  const cat = new Map(scriptCatalog().map((s) => [s.name, s]));
  return names.map((n) => cat.get(n)).filter((s) => s && fs.existsSync(s.path));
}
// Cómo se ejecuta (para el prompt y para la lista blanca de Claude).
export function runnerOf(file) {
  if (/\.(mjs|cjs|js)$/i.test(file)) return `node ${file}`;
  if (/\.py$/i.test(file)) return `python3 ${file}`;
  if (/\.ts$/i.test(file)) return `npx tsx ${file}`;
  return /\.(sh|bash)$/i.test(file) ? `bash ${file}` : file;
}
export function scriptsPromptBlock(scripts) {
  if (!scripts.length) return '';
  return ['', '## Scripts del equipo que puedes usar (ejecútalos tal cual; no los edites salvo que la tarea lo pida)',
    ...scripts.map((s) => `- ${s.name}: \`${runnerOf(s.path)}\`${s.description ? ` — ${s.description}` : ''}`), ''].join('\n');
}
