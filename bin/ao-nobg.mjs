#!/usr/bin/env node
// FT-134: hook PreToolUse de los workers `claude -p`. En -p no hay avisos de "terminó": un proceso en segundo plano muere al
// cerrar la sesión. Rechaza Bash con run_in_background:true y explica cómo hacerlo (primer plano + timeout).
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch { /* sin entrada válida: no opina */ }
  if (ev.tool_input?.run_in_background === true) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Segundo plano no permitido (FT-134): en este modo no hay avisos y el proceso muere al cerrar la sesión. Ejecútalo en primer plano con timeout (hasta 10 min, parámetro timeout=600000) y espera su resultado.' } }));
  }
  process.exit(0);
});
