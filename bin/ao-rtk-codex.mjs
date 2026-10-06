#!/usr/bin/env node
// FT-57: filtro del hook PreToolUse de Codex. Ejecuta `rtk hook codex` con el mismo stdin y deja pasar su respuesta SOLO si el
// comando reescrito es de la lista blanca (RTK_RULES; nunca `rtk run`/`rtk err`). Si no, no imprime nada → Codex ejecuta el original.
// Uso: ao-rtk-codex.mjs <ruta-de-rtk>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { rtkAllowed } from '../server/engines/allowlist.js';

const rtk = process.argv[2] || 'rtk';
const input = fs.readFileSync(0, 'utf8');
const r = spawnSync(rtk, ['hook', 'codex'], { input, encoding: 'utf8', timeout: 10_000 });
const out = (r.stdout || '').trim();
if (!out) process.exit(0);
let cmd;
try { const j = JSON.parse(out); cmd = j?.hookSpecificOutput?.updatedInput?.command ?? j?.updatedInput?.command; } catch { process.exit(0); }
if (cmd == null) process.exit(0); // sin reescritura: nada que filtrar
if (/^rtk(\s|$)/.test(String(cmd).trim()) && rtkAllowed(cmd)) process.stdout.write(out + '\n');
