#!/usr/bin/env node
// FT-171: hook PreToolUse SOLO del rol «release». Cualquier Bash que no pase releaseAllowed() se rechaza con un mensaje claro;
// así no dependemos de cómo el CLI interprete comodines en Bash(...).
import { releaseAllowed } from '../server/engines/allowlist.js';
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch { /* sin entrada válida: se rechaza abajo */ }
  if (!releaseAllowed(ev.tool_input?.command)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Rol release (FT-171): solo se permite «scripts/release/<paso>.sh [argumentos simples]», sin ;, &&, |, $(), comillas, redirecciones ni «..». Ni ssh, docker push o git push directos: los hacen los scripts.' } }));
  }
  process.exit(0);
});
