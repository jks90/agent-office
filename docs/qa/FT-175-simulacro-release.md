# FT-175 · QA del simulacro de publicación (--dry-run)

Script: `node scripts/release-qa-e2e.mjs` (agent-office). Con `QA_RUN_ALL=1 FLOW_TEST_DIR=<flow-test>` añade las pruebas de `run-all` (1) y (4a).
Unitarios: `node --test tests/release-trigger.test.mjs tests/telegram-confirm.test.mjs tests/release-role.test.mjs` → 21/21 OK.

**Veredicto: todo lo ejecutable está en OK (segunda pasada). Quedan 1, 2 y 4a PENDIENTES DE EJECUCIÓN por quien tenga permisos** (el sandbox exige aprobación para `bash scripts/…`, `ssh`, `gh`, `docker`).

| # | Comprobación | Estado |
|---|---|---|
| 1 | `run-all.sh --dry-run`: exit 0, 10 pasos en el log, `git status` limpio en 5 repos, sin `docker push`/`git push` | **PENDIENTE** (script listo con `QA_RUN_ALL=1`) |
| 2 | Lectura real: ssh BatchMode a VPS y serverman, `docker login`, `gh auth`, `ORG_IMAGE` | **PENDIENTE**. Nota: el `--dry-run` no hace estas sondas (solo las muestra); ejecutarlas sin `--dry-run` o a mano, solo lectura, en boss-flowtest |
| 3a | ✅ lanza run-all una vez; el token no sale en lo enviado | OK |
| 3b | ❌ no publica, acumula pendiente, libera mutex | OK |
| 3c | Chat ajeno ignorado y sin respuesta | OK |
| 3d | Timeout 12 h: no publica, mensaje caducado | OK |
| 3e | El ✅ lanza `--dry-run` por defecto; publicar de verdad exige `settings.releaseDryRun=false` | OK (antes FALLO; corregido con `runAllSpec` en `server/release-trigger.js`) |
| 4a | Paso forzado (`RELEASE_FAIL_STEP=4`) avisa «❌ paso 4 falló» con log | **PENDIENTE** (misma causa que 1) |
| 4b | El aviso llega a Telegram: `RELEASE_NOTIFY_CMD` lleva `"$1"` y el spawn usa `stdio:['ignore','pipe','pipe']` | OK (antes FALLO; corregido) |
| 5 | Lista blanca: 12 comandos fuera de ella rechazados, 2 permitidos | OK |

La primera publicación real queda a la espera de que el usuario la autorice (desactivando `settings.releaseDryRun`). No se publicó nada ni se tocó producción.
