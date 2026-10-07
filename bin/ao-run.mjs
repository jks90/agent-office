#!/usr/bin/env node
// Lanzador de `npm start`: arranca el servidor y lo vuelve a levantar cuando sale con 75 (autoactualización,
// server/selfupdate.js). Cualquier otro código de salida termina el lanzador con ese mismo código.
// Con systemd no hace falta: Restart=on-failure ya relanza al salir con 75.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESTART_CODE = 75;

function start() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE) { console.log('↻ AgentOffice se ha actualizado: lo vuelvo a arrancar'); start(); return; }
    process.exit(code ?? (signal ? 1 : 0));
  });
}
start();
