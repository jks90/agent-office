# FT-175 · QA del simulacro de publicación (--dry-run)

Script: `node scripts/release-qa-e2e.mjs` (agent-office). Con `QA_RUN_ALL=1 FLOW_TEST_DIR=<flow-test>` añade las pruebas de `run-all` (1) y (4a).
Unitarios previos: `node --test tests/release-trigger.test.mjs tests/telegram-confirm.test.mjs tests/release-role.test.mjs` → 21/21 OK.

**Veredicto: NO está todo en OK.** 2 FALLOS de código y 3 bloques NO EJECUTADOS por el sandbox.

| # | Comprobación | Estado |
|---|---|---|
| 1 | `run-all.sh --dry-run`: exit 0, 10 pasos en log, `git status` limpio en 5 repos, sin `docker push`/`git push` | **NO EJECUTADO** — el sandbox exige aprobación para `bash`/`./scripts/release/*.sh`. Pendiente (script listo con `QA_RUN_ALL=1`). Lectura estática: los pasos existen (01–10) y `act` solo muestra en dry-run. |
| 2 | Lectura real: ssh BatchMode al VPS y a serverman, `docker login`, `gh auth`, `ORG_IMAGE` | **NO EJECUTADO** — `ssh` y `gh` piden aprobación. Hallazgo: el `--dry-run` **no hace** estas sondas (`probe` solo las muestra y 08 dice «sin conectar»), así que el simulacro no las cubre; hay que ejecutarlas sin `--dry-run` o aparte. |
| 3a | Telegram simulado: ✅ lanza run-all una vez; el token no sale | OK |
| 3b | ❌ no publica, acumula pendiente y libera mutex | OK |
| 3c | Chat ajeno ignorado y sin respuesta | OK |
| 3d | Timeout 12 h: no publica, mensaje caducado | OK |
| 3e | El ✅ real lanza **`--dry-run`** | **FALLO** — `realDeps.runAll` (`server/release-trigger.js`) ejecuta `bash scripts/release/run-all.sh <versión>` sin `--dry-run`: un ✅ lanza la publicación REAL. Falta un modo/ajuste (p. ej. `settings.releaseDryRun`, por defecto true hasta que el usuario autorice la primera real). |
| 4a | Paso forzado a fallar (`RELEASE_FAIL_STEP=4`) avisa con log | **NO EJECUTADO** (misma causa que 1). Lectura estática: `run-all.sh` avisa «❌ paso N falló» + `tail -15` del log y sale 1. |
| 4b | El aviso llega a Telegram | **FALLO** — `run-all` invoca `bash -c "$RELEASE_NOTIFY_CMD" _ "$msg"`, pero agent-office fija `RELEASE_NOTIFY_CMD=node …/ao-telegram.mjs` sin `"$1"`: el mensaje no llega como argumento, y `ao-telegram.mjs` cae a leer stdin, que hereda un pipe abierto del `spawn` → se cuelga o manda vacío. Arreglo: `RELEASE_NOTIFY_CMD='node …/ao-telegram.mjs "$1"'` y/o `stdio:['ignore','pipe','pipe']` en el spawn. |
| 5 | Lista blanca: 12 comandos fuera de ella rechazados (ssh, docker push/login, git push, rm, curl, bash -c, `;`, `..`, `$()`, gh) y 2 permitidos | OK |

## Qué falta
1. Corregir 3e y 4b.
2. Alguien con permiso ejecute `QA_RUN_ALL=1 FLOW_TEST_DIR=… node scripts/release-qa-e2e.mjs` y, aparte, las sondas ssh/docker/gh/ORG_IMAGE (solo lectura, boss-flowtest).
3. La primera publicación real queda a la espera de autorización del usuario. No se ha publicado nada ni se ha tocado producción.
