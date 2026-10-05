// Roles del equipo: los cuatro de serie + roles definidos en ficheros .md con el MISMO formato que los
// subagentes de Claude Code (frontmatter name/description/tools/model + prompt de sistema en el cuerpo):
//   - globales: <data>/roles/**/*.md
//   - por repo del proyecto: <repo>/.claude/agents/*.md y <repo>/.agent-office/agents/*.md
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';

const BUILTIN = {
  po: {
    label: 'PO / Orquestador', color: '#a78bfa', kind: 'planner',
    system:
      'Eres el Product Owner y orquestador de un equipo de agentes de IA (back, front, qa). ' +
      'Tu trabajo es entender el objetivo, leer la documentación y el código del proyecto, y dividirlo en tareas ' +
      'pequeñas, concretas y verificables. No escribes código.',
  },
  back: {
    label: 'Backend', color: '#60a5fa', kind: 'dev',
    system:
      'Eres el desarrollador backend del equipo. Implementas APIs, servicios y persistencia siguiendo el estilo del repo. ' +
      'Haces el cambio mínimo y seguro, lo pruebas y explicas qué hiciste.',
  },
  front: {
    label: 'Frontend', color: '#f472b6', kind: 'dev',
    system:
      'Eres el desarrollador frontend del equipo. Implementas interfaz y lógica de cliente siguiendo el estilo del repo. ' +
      'Haces el cambio mínimo y seguro, compruebas que compila y explicas qué hiciste.',
  },
  qa: {
    label: 'QA', color: '#34d399', kind: 'qa',
    system:
      'Eres el QA del equipo. Verificas que lo implementado funciona: lees los cambios, escribes o ejecutas pruebas y, ' +
      'si tienes las herramientas de flow-test (MCP), creas y ejecutas un flow que pruebe los endpoints. ' +
      'Informas claramente de qué pasa y qué falla.',
  },
};

const PALETTE = ['#fbbf24', '#f87171', '#2dd4bf', '#c084fc', '#fb923c', '#a3e635', '#38bdf8', '#e879f9', '#facc15', '#4ade80'];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
// Modelos que el CLI no acepta en modo -p (o que no están disponibles): se bajan a opus.
const MODEL_MAP = { fable: 'opus' };

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}

const kindOf = (id, meta) => {
  if (['planner', 'dev', 'qa'].includes(meta.kind)) return meta.kind;
  if (/orquest|planner|^po$|product|manager/i.test(id)) return 'planner';
  if (/qa|test|automation/i.test(id)) return 'qa';
  return 'dev';
};
const labelOf = (id) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function loadDir(dir, source, out) {
  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) { loadDir(full, source, out); continue; }
    if (!f.name.endsWith('.md')) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(full, 'utf8'));
      const id = String(meta.name || f.name.replace(/\.md$/, '')).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      if (!id || BUILTIN[id] || !body) continue;
      out[id] = {
        label: labelOf(id), color: PALETTE[hash(id) % PALETTE.length], kind: kindOf(id, meta),
        description: meta.description || '', model: MODEL_MAP[meta.model] || meta.model || '',
        tools: meta.tools ? meta.tools.split(',').map((t) => t.trim()).filter(Boolean) : null,
        handles: meta.handles ? meta.handles.split(',').map((t) => t.trim()).filter(Boolean) : [],
        system: body.slice(0, 40_000), source, file: full, custom: true,
      };
    } catch { /* fichero ilegible: se ignora */ }
  }
}

// Todos los roles visibles ahora mismo (de serie + globales + los de los repos de todos los proyectos).
export function allRoles() {
  const out = { ...BUILTIN };
  loadDir(path.join(store.DATA_DIR, 'roles'), 'global', out);
  for (const p of store.get().projects) {
    for (const r of p.repos || []) {
      loadDir(path.join(r.path, '.claude', 'agents'), `repo:${r.key}`, out);
      loadDir(path.join(r.path, '.agent-office', 'agents'), `repo:${r.key}`, out);
    }
  }
  return out;
}
export const roleOf = (id) => allRoles()[id] || null;
export const ROLES = BUILTIN; // de serie (para quien solo necesite los fijos)
