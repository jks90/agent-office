// Redactar una tarea con IA: el texto en bruto del usuario (+ adjuntos) → título, descripción con contexto y
// criterios de «hecho cuando», rol y repo del proyecto. Usa `claude -p` sin herramientas de escritura.
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { allRoles } from './roles.js';
import { teamOf } from './team.js';
import { engineEnv } from './engines/auth.js';

export async function draftTask({ projectId, text, attachments = [], model = '' }) {
  const p = store.get().projects.find((x) => x.id === projectId);
  if (!p) throw Object.assign(new Error('Proyecto no encontrado'), { status: 404 });
  if (!text?.trim()) throw Object.assign(new Error('Escribe qué quieres que se haga'), { status: 400 });
  const roles = allRoles();
  const team = teamOf(p);
  const roleIds = [...new Set(team.map((a) => a.role))].filter((r) => roles[r]?.kind !== 'planner');
  const repos = p.repos || [];
  const images = attachments.filter((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.path));
  const files = attachments.filter((a) => !/\.(png|jpe?g|webp|gif)$/i.test(a.path));
  const prompt = [
    `Proyecto «${p.name}»${p.folder ? ` (carpeta ${p.folder}/ en flow-test)` : ''}.`,
    repos.length ? `Repositorios: ${repos.map((r) => `«${r.key}» = ${r.path}${r.roles?.length ? ` (roles: ${r.roles.join(', ')})` : ''}`).join(' · ')}.` : 'Sin repositorios.',
    `Roles disponibles en la plantilla: ${roleIds.map((r) => `${r} — ${roles[r].description || roles[r].label}`).join(' · ')}.`,
    '',
    'Petición del usuario, tal cual:',
    '"""', text.trim(), '"""',
    images.length ? `\nImágenes adjuntas (míralas; están en: ${images.map((a) => a.path).join(', ')}).` : '',
    files.length ? `\nFicheros adjuntos (léelos si ayudan: ${files.map((a) => a.path).join(', ')}).` : '',
    '',
    'Redacta UNA tarea para un agente de IA que trabajará solo en un worktree del repo. Responde SOLO con JSON:',
    '```json',
    '{"title": "imperativo, concreto, ≤ 80 caracteres", "description": "contexto necesario, qué hacer paso a paso, qué NO tocar, y una lista «Hecho cuando:» con criterios verificables; en español; markdown ligero", "role": "uno de los roles disponibles", "repo": "clave de repo o null"}',
    '```',
  ].join('\n');
  const args = ['-p', '--output-format', 'json', '--model', model || 'sonnet', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', 'Read', '--append-system-prompt', 'Eres el PO del proyecto: conviertes peticiones informales en tareas claras y acotadas para agentes de IA. No ejecutes nada; solo redacta.'];
  const out = await new Promise((resolve, reject) => {
    const env = { ...process.env, ...engineEnv('claude'), BROWSER: 'true' };
    delete env.CLAUDECODE;
    const child = spawn(process.env.AO_CLAUDE_BIN || 'claude', args, { cwd: repos[0]?.path || store.DATA_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve(so) : reject(new Error(se.trim() || `claude terminó con código ${c}`))));
    child.stdin.end(prompt);
    setTimeout(() => child.kill('SIGTERM'), 180000).unref();
  });
  let res;
  try { res = JSON.parse(out); } catch { throw Object.assign(new Error('Respuesta no válida de claude'), { status: 502 }); }
  if (res.is_error) throw Object.assign(new Error(String(res.result || 'error').slice(0, 300)), { status: 502 });
  const txt = String(res.result || '');
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  let draft;
  try { draft = JSON.parse(fenced ? fenced[1] : txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { throw Object.assign(new Error('La IA no devolvió la tarea en JSON: ' + txt.slice(0, 200)), { status: 502 }); }
  const role = roleIds.includes(draft.role) ? draft.role : (roleIds[0] || 'back');
  const repo = repos.some((r) => r.key === draft.repo) ? draft.repo : null;
  return { title: String(draft.title || '').slice(0, 160), description: String(draft.description || ''), role, repo, costUsd: res.total_cost_usd ?? null };
}
