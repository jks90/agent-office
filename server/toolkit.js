// 🧰 Herramientas de los agentes: skills + MCP + scripts del catálogo que lleva cada agente (rol + ficha), el bloque del prompt
// que les pide usarlas ANTES de improvisar, el rastreo de lo que de verdad usan en cada tarea y las cifras con/sin para la
// pestaña 🧰 Herramientas. Las skills llegan siempre: con Claude y repo se enlazan en el worktree (herramienta Skill); con
// Codex, sin repo o en planificación van como «lee <ruta>/SKILL.md» y su carpeta entra por --add-dir.
import fs from 'node:fs';
import path from 'node:path';
import * as skills from './skills.js';
import * as toolcat from './toolcatalog.js';

const uniq = (l) => [...new Set((l || []).filter(Boolean))];
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// Skills del agente: las del rol (frontmatter `skills:`) + las de su ficha (`agent.skills`), solo las que existen en el catálogo.
export function skillsOf(agent, role) {
  const cat = new Map(skills.listCatalog().filter((s) => !s.broken).map((s) => [s.name, s]));
  return uniq([...(role?.skills || []), ...(agent?.skills || [])]).map((n) => cat.get(n)).filter(Boolean)
    .map((s) => ({ name: s.name, description: s.description, dir: real(s.dir) }));
}

// Todo lo que lleva el agente en esta tarea. `nativeNames` = skills enlazadas en el worktree (Claude con repo: herramienta Skill);
// el resto se usan leyendo su SKILL.md (su carpeta va por --add-dir).
export function kitOf(agent, role, { nativeNames = [] } = {}) {
  const mcpCat = new Map(toolcat.mcpCatalog().map((m) => [m.name, m]));
  const mcps = toolcat.assignedMcps(agent, role).map((n) => ({ name: n, description: mcpCat.get(n)?.description || '' }));
  const scripts = toolcat.resolveScripts(toolcat.assignedScripts(agent, role));
  return { skills: skillsOf(agent, role).map((s) => ({ ...s, native: nativeNames.includes(s.name) })), mcps, scripts };
}

// Carpetas a abrir al agente (skills que no se enlazan + scripts fuera del worktree).
export const kitDirs = (kit, cwd) => uniq([...kit.skills.filter((s) => !s.native).map((s) => s.dir), ...kit.scripts.map((s) => path.dirname(s.path))])
  .filter((d) => !(cwd && d.startsWith(cwd + path.sep)));

// Bloque del prompt (parte ESTABLE: mismo texto para el mismo agente → aprovecha la caché).
export function promptBlock(kit) {
  const business = kit.business || {}; // notas «cómo se aplica aquí» por skill (proposals.notesOf)
  if (!kit.skills.length && !kit.mcps.length && !kit.scripts.length) return '';
  const out = ['', '## 🧰 Tus herramientas — úsalas PRIMERO',
    'Antes de improvisar comandos, leer código a ciegas o escribir algo desde cero, mira si una de estas herramientas lo hace: son más baratas, ya están probadas y son lo que el equipo espera que uses. Si una encaja, úsala; si no encaja ninguna, sigue como siempre.'];
  if (kit.skills.length) {
    out.push('', '### Skills (instrucciones de cómo hacer una faena concreta)');
    for (const s of kit.skills) {
      const how = s.native ? `herramienta Skill «${s.name}»` : `lee \`${path.join(s.dir, 'SKILL.md')}\` y síguela`;
      out.push(`- **${s.name}** — ${s.description || 'sin descripción'} → ${how}`);
      if (business[s.name]) out.push(`  En este proyecto:\n${business[s.name].split('\n').map((l) => `    ${l}`).join('\n')}`);
    }
  }
  if (kit.mcps.length) {
    out.push('', '### MCP (además de los de serie)');
    for (const m of kit.mcps) out.push(`- **${m.name}**${m.description ? ` — ${m.description}` : ''}`);
  }
  if (kit.scripts.length) {
    out.push('', '### Scripts del equipo (ejecútalos tal cual; no los edites salvo que la tarea lo pida)');
    for (const s of kit.scripts) out.push(`- **${s.name}**: \`${toolcat.runnerOf(s.path)}\`${s.description ? ` — ${s.description}` : ''}`);
  }
  out.push('');
  return out.join('\n');
}

// ── Rastreo de uso dentro de una tarea ──────────────────────────────────────
// Cuenta una skill como usada si se invoca la herramienta Skill con su nombre o se lee algo de su carpeta; un MCP si se llama
// a cualquiera de sus herramientas; un script si un comando de Bash lo nombra por su ruta o su fichero.
export function tracker(kit) {
  const used = { skills: {}, mcps: {}, scripts: {} };
  const bump = (k, n) => { used[k][n] = (used[k][n] || 0) + 1; };
  const scriptHit = (cmd) => { for (const s of kit.scripts) if (cmd.includes(s.path) || cmd.includes(path.basename(s.path))) bump('scripts', s.name); };
  const skillPath = (p) => { const r = String(p || ''); for (const s of kit.skills) if (r.startsWith(s.dir + path.sep) || r === s.dir) bump('skills', s.name); };
  const mcpHit = (server) => { const n = String(server || '').replace(/_/g, '-'); for (const m of kit.mcps) if (m.name === server || m.name === n || m.name.replace(/-/g, '_') === server) bump('mcps', m.name); };
  return {
    used,
    feed(ev, engine) {
      if (!ev) return;
      if (engine === 'claude' && ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type !== 'tool_use') continue;
          const i = c.input || {};
          if (c.name === 'Skill') { const n = i.skill || i.name || i.command; if (kit.skills.some((s) => s.name === n)) bump('skills', n); }
          else if (c.name === 'Bash') { scriptHit(String(i.command || '')); for (const s of kit.skills) if (String(i.command || '').includes(s.dir)) bump('skills', s.name); }
          else if (['Read', 'Glob', 'Grep'].includes(c.name)) skillPath(i.file_path || i.path);
          else if (c.name?.startsWith('mcp__')) mcpHit(c.name.split('__')[1]);
        }
      } else if (engine === 'codex' && ev.type === 'item.completed' && ev.item) {
        const it = ev.item;
        if (it.type === 'command_execution') { const cmd = String(it.command || ''); scriptHit(cmd); for (const s of kit.skills) if (cmd.includes(s.dir)) bump('skills', s.name); }
        else if (it.type === 'mcp_tool_call') mcpHit(it.server);
      }
    },
  };
}

// Lo que se le dio y lo que usó, acumulado por tarea (varios intentos): t.toolkit = { given:{skills,mcps,scripts}, used:{…} }.
export function record(t, kit, used) {
  const tk = t.toolkit ||= { given: { skills: [], mcps: [], scripts: [] }, used: { skills: {}, mcps: {}, scripts: {} } };
  tk.given.skills = uniq([...tk.given.skills, ...kit.skills.map((s) => s.name)]);
  tk.given.mcps = uniq([...tk.given.mcps, ...kit.mcps.map((m) => m.name)]);
  tk.given.scripts = uniq([...tk.given.scripts, ...kit.scripts.map((s) => s.name)]);
  for (const k of ['skills', 'mcps', 'scripts']) for (const [n, c] of Object.entries(used[k] || {})) tk.used[k][n] = (tk.used[k][n] || 0) + c;
}

// ── Cifras para 🧰 Herramientas ─────────────────────────────────────────────
// Por herramienta: tareas que la tenían, tareas que la usaron, usos, y coste medio de las tareas HECHAS que la usaron frente a
// las hechas del mismo rol que no la usaron (la comparación «con/sin» más justa que hay sin experimentos).
export function usage(tasks) {
  const out = { skills: {}, mcps: {}, scripts: {} };
  const done = tasks.filter((t) => t.status === 'done' && t.costUsd > 0);
  const avg = (l) => (l.length ? l.reduce((n, t) => n + t.costUsd, 0) / l.length : null);
  for (const k of Object.keys(out)) {
    const names = uniq(tasks.flatMap((t) => [...(t.toolkit?.given?.[k] || []), ...Object.keys(t.toolkit?.used?.[k] || {})]));
    for (const n of names) {
      const given = tasks.filter((t) => t.toolkit?.given?.[k]?.includes(n));
      const usedIn = tasks.filter((t) => t.toolkit?.used?.[k]?.[n]);
      const roles = new Set(usedIn.map((t) => t.role));
      const withT = done.filter((t) => t.toolkit?.used?.[k]?.[n]);
      const without = done.filter((t) => roles.has(t.role) && t.toolkit && !t.toolkit.used?.[k]?.[n]);
      out[k][n] = { given: given.length, used: usedIn.length, uses: usedIn.reduce((s, t) => s + t.toolkit.used[k][n], 0),
        avgWith: avg(withT), avgWithout: avg(without), nWith: withT.length, nWithout: without.length };
    }
  }
  return out;
}

// ── Avisos: lo que se declara y no llega ────────────────────────────────────
export function warnings({ roles, agents }) {
  const skillCat = new Set(skills.listCatalog().filter((s) => !s.broken).map((s) => s.name));
  const mcpCat = new Set(toolcat.mcpCatalog().map((m) => m.name));
  const scriptCat = new Map(toolcat.scriptCatalog().map((s) => [s.name, s]));
  const out = [];
  const check = (owner, kind, names) => {
    for (const n of names || []) {
      if (kind === 'skills' && !skillCat.has(n)) out.push({ owner, kind, name: n, why: 'no está en el catálogo de skills' });
      if (kind === 'mcps' && !mcpCat.has(n)) out.push({ owner, kind, name: n, why: 'no está en el catálogo de MCP' });
      if (kind === 'scripts') {
        const s = scriptCat.get(n);
        if (!s) out.push({ owner, kind, name: n, why: 'no está en el catálogo de scripts (no le llega al agente)' });
        else if (!fs.existsSync(s.path)) out.push({ owner, kind, name: n, why: `el fichero ya no existe (${s.path})` });
      }
    }
  };
  for (const [id, r] of Object.entries(roles)) {
    for (const k of ['skills', 'mcps', 'scripts']) check(`rol ${r.label || id}`, k, r[k]);
    const has = ['skills', 'mcps', 'scripts'].some((k) => (r[k] || []).length);
    if (has && !agents.some((a) => a.role === id)) out.push({ owner: `rol ${r.label || id}`, kind: 'rol', name: id, why: 'tiene herramientas pero ningún agente con este rol: no las usa nadie' });
  }
  for (const a of agents) for (const k of ['skills', 'mcps', 'scripts']) check(`agente ${a.name}`, k, a[k]);
  return out;
}
