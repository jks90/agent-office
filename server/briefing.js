// Briefing por repo: mapa compacto del repositorio que se inyecta en el prompt de cada tarea para que el agente NO tenga
// que explorar (ls/find/wc/README) cada vez. Se genera sin LLM a partir de git y se cachea por commit (HEAD).
// Tope ~12 KB (~3k tokens): estructura, ficheros grandes (leer por tramos), scripts y secciones del README/CLAUDE.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const MAX = 12_000;
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32e6, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const cache = new Map(); // repoPath → { head, text }

export function briefingFor(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return '';
  let head;
  try { head = git(repoPath, ['rev-parse', 'HEAD']); } catch { return ''; }
  const hit = cache.get(repoPath);
  if (hit?.head === head) return hit.text;
  const file = path.join(DATA_DIR, 'briefings', `${path.basename(repoPath)}-${head.slice(0, 12)}.md`);
  if (fs.existsSync(file)) { const text = fs.readFileSync(file, 'utf8'); cache.set(repoPath, { head, text }); return text; }
  const text = build(repoPath);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } catch { /* sin disco: solo en memoria */ }
  cache.set(repoPath, { head, text });
  return text;
}

function build(repo) {
  let files = [];
  try { files = git(repo, ['ls-files']).split('\n').filter(Boolean); } catch { return ''; }
  const code = files.filter((f) => !/\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|woff2?|ttf|pdf|zip|lock)$/i.test(f) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f) && !/(^|\/)(vendor|node_modules|dist)\//.test(f));
  const lines = (f) => { try { const b = fs.readFileSync(path.join(repo, f)); return b.length > 3e6 ? -1 : b.toString('utf8').split('\n').length; } catch { return 0; } };
  const dirs = new Map();
  const big = [];
  for (const f of code) {
    const d = f.includes('/') ? f.split('/').slice(0, f.split('/').length > 2 ? 2 : 1).join('/') : '.';
    dirs.set(d, (dirs.get(d) || 0) + 1);
    const n = lines(f);
    if (n > 400) big.push([f, n]);
  }
  big.sort((a, b) => b[1] - a[1]);
  const out = [`## Briefing del repo «${path.basename(repo)}» (generado; no hace falta explorarlo con ls/find/wc)`];
  out.push(`- ${files.length} ficheros versionados. Carpetas (nº de ficheros): ${[...dirs].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([d, n]) => `${d} (${n})`).join(', ')}`);
  if (big.length) out.push(`- Ficheros GRANDES (líneas) — léelos SOLO por tramos (Grep -n + Read offset/limit): ${big.slice(0, 20).map(([f, n]) => `${f} (${n})`).join(', ')}`);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    if (pkg.scripts) out.push(`- Scripts npm: ${Object.entries(pkg.scripts).slice(0, 20).map(([k, v]) => `${k} = ${String(v).slice(0, 70)}`).join(' · ')}`);
  } catch { /* sin package.json */ }
  const e2e = code.filter((f) => /(^|\/)scripts\/.*-e2e\.(m?js|ts)$/.test(f));
  if (e2e.length) out.push(`- Pruebas e2e existentes: ${e2e.join(', ')}`);
  for (const doc of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
    if (!files.includes(doc)) continue;
    const heads = fs.readFileSync(path.join(repo, doc), 'utf8').split('\n').filter((l) => /^#{1,3} /.test(l)).map((l) => l.replace(/^#+ /, '').slice(0, 80));
    if (heads.length) out.push(`- Secciones de ${doc} (busca la que necesites con Grep, no lo leas entero): ${heads.slice(0, 60).join(' · ')}`);
  }
  try { out.push(`- Últimos commits: ${git(repo, ['log', '--oneline', '-8']).split('\n').join(' · ')}`); } catch { /* sin historial */ }
  let text = out.join('\n');
  if (text.length > MAX) text = text.slice(0, MAX) + '…';
  return text;
}
