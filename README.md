# 🏢 AgentOffice

Una oficina en 2D donde un equipo de agentes de IA (Claude Code o Codex) trabaja sobre tus proyectos:
el **PO** reparte un objetivo en tareas, **back**, **front** y **QA** las hacen, y tú ves en directo
quién está trabajando, en qué y quién está en la zona de descanso.

> MVP 0.1 · sin dependencias · Node ≥ 20

## Arrancar

```bash
npm start            # http://127.0.0.1:7420
npm run dev          # igual, reiniciando al cambiar el servidor
```

**Se actualiza solo.** Cada 15 min (`AO_UPDATE_MIN`) hace `git fetch`; si va por detrás de su rama remota, el árbol está limpio,
el avance es *fast-forward* y no hay ningún agente trabajando ni revisando, hace `git pull --ff-only`, avisa por Telegram y se
reinicia (sale con 75: lo relanza `npm start` vía `bin/ao-run.mjs`, o systemd con `Restart=on-failure`). Con cambios locales o
ramas divergentes no toca nada. Estado en `GET /api/version`; `POST /api/version/check` comprueba ya; `AO_AUTOUPDATE=off` lo apaga.

**Avisos por Telegram** (revisión pendiente, preguntas, cuota, atascos, tope de gasto, fallos): `data/telegram.json` con
`{ "enabled": true, "botToken": "…", "chatIds": ["…"] }` (o `AO_TELEGRAM_TOKEN` + `AO_TELEGRAM_CHATS`); prueba con `POST /api/telegram/test`.

El primer arranque crea **«Demo — Tienda online»** con el motor `demo` (simulado, no gasta tokens):
escribe un objetivo, pulsa **Encargar al PO** y luego **▶ Poner a trabajar**.

## Cómo funciona

1. **Proyecto** = un repositorio git (opcional en demo) más su equipo y su tablero.
2. **Objetivo → PO**: el PO lee el repo y devuelve las tareas en JSON (título, descripción, rol, dependencias).
3. **Planificador** (cada 1,5 s): cada tarea pendiente cuyas dependencias estén **hechas** va al primer agente libre de su rol (como mucho `maxParallel` a la vez).
4. **Aislamiento**: cada tarea corre en un **git worktree** propio (`data/worktrees/…`, rama `ao/<código>`). Al terminar se hace commit `<código>: <título>` con el agente como autor y la tarea pasa a **Revisión**.
5. **Código de tarea**: toda tarea lleva un código legible y estable — prefijo del proyecto + correlativo (`GL-7`, `UH-198`) — que aparece en la tarjeta, la rama, el commit, el prompt del agente (se le pide citarlo en lo que documente), la issue/tarjeta del tablero online (`GL-7 · título`; si el título ya trae un código, se respeta) y en `GET /api/projects/:id/tasks`. Las rutas `/api/tasks/<id>` aceptan también el código. El prefijo se deduce del nombre del proyecto y se cambia en Ajustes ▸ Proyecto (las tareas ya numeradas conservan el suyo).
6. **Mover tarjetas (FT-27)**: en el tablero se arrastra una tarjeta a otra columna o se usa su botón (→ Por hacer / ← Backlog). Solo se mueven a mano las tareas sin empezar (Backlog ↔ Por hacer; las fallidas vuelven a cualquiera de las dos). `PATCH /api/tasks/:id {status}` responde 409 con el motivo si la tarea está en curso/revisión/hecha o el destino es En curso/Revisión/Hecho, y la UI lo muestra como aviso.
7. **Quién hará la tarea (FT-50)**: cada tarjeta de Backlog / Por hacer lleva, bajo el título, el chip «👤 Nombre · motor/modelo» del agente que la hará: el asignado si lo hay, el **previsto** si no (`task.plannedAgentId`, calculado en cada snapshot y nunca persistido, con la misma regla que el planificador: `plannedAgentFor()` en `team.js` — primer agente del equipo con el rol de la tarea o que lo atiende por `handles`, libre antes que ocupado) y, si nadie del equipo tiene el rol, «⚠️ sin agente para este rol» en ámbar (`plannedReason`). Clic en el chip = abrir el cajón del agente (motor, modelo, registro); en el ámbar, «Contratar agente» con el rol ya elegido. El desplegable «Asignar a…» (agentes del equipo compatibles con el rol) llama a `POST /api/tasks/:id/assign {agentId}` (vacío = volver a la regla del rol; 400 si no está fichado, 409 si la tarea ya empezó) y el chip pasa a fijo. La misma fila está en el modal «Ver la tarea». Prueba: `node scripts/card-agent-e2e.mjs [captura.png]` (28 checks: API y UI con Chrome headless, sin Claude).
8. **Preguntas al cliente**: si un agente necesita una decisión tuya (regla de negocio, nombre visible, qué opción prefieres) ejecuta `node bin/ao-ask.mjs "¿Pregunta?" --opt A --opt B` (el prompt se lo explica); la pregunta aparece en AgentOffice como aviso fijo arriba y en un modal con las opciones o respuesta libre, y el comando espera tu respuesta (hasta `AO_ASK_TIMEOUT_MIN`, 120 min) y la imprime para que el agente siga. Sin respuesta, decide él con el criterio más conservador y lo deja visible en el resumen. Cada pregunta y su respuesta quedan en la tarea («Conversación con el agente») y se le repiten si vuelve a intentarla.
9. **Tablero compacto (FT-74)**: por defecto cada tarjeta ocupa 2–3 líneas (rol, código, repo e iconos con tooltip: ✖ fallo, ⚠ conflicto, ⏸ cuota, ✋ revisión, ⏳ dependencia, 💲 coste, ≈ estimación; título a 2 líneas; agente) y sus acciones salen al pasar el ratón o con foco (principal según la columna + «⋯»); clic en la tarjeta abre «Ver la tarea». El interruptor «Compacto / Detallado» de la cabecera (recordado en `localStorage ao:boardDensity`) devuelve el diseño anterior. Prueba: `node scripts/board-density-e2e.mjs`.
5. **Tú decides**: *Ver cambios* (diff), *Aprobar y fusionar* (`merge --no-ff` a la rama base; exige el repo limpio y en esa rama) o *Devolver* con comentarios (se descarta la rama y el agente lo rehace con tu feedback).
6. **QA + flow-test**: el agente QA recibe el MCP de flow-test (`Ajustes`, por defecto `http://localhost:9998/mcp`) para crear y ejecutar flows que verifiquen la API.

## Activity Stream (FT-1)

Además de las líneas de texto por agente (`log`), el servidor emite **eventos tipados** con ids correlacionables, pensados para el Guide Agent y la UI: `server/events.js`.

```json
{ "id": "ev_…", "ts": 1760000000000, "type": "AgentToolStarted", "projectId": "…", "taskId": "…", "taskCode": "FT-1", "agentId": "…", "data": { … } }
```

| Tipo | Cuándo (`data`) |
|---|---|
| `TaskCreated` | se crea una tarea (`title, role, kind, status, dependsOn, source`) |
| `TaskAssigned` / `AgentStarted` | el planificador entrega la tarea a un agente (`agentName, role, attempt` / `engine`) |
| `AgentProgress` | cambia la actividad del agente (`activity`) |
| `AgentToolStarted` / `AgentToolFinished` | el motor (claude/codex/demo) llama a una herramienta (`callId, tool, summary` / `callId, ok`). El resumen no lleva contenido sensible: de Bash solo el programa, nunca el comando |
| `AgentFileModified` | un fichero entra en el commit de la tarea (`path`) |
| `AgentArtifactCreated` | commit (`kind:'commit', branch, repo, sha, files, diffStat`) o diff simulado (`kind:'diff'`) |
| `ReviewPending` | FT-56: tarea esperando revisión más de `reviewNudgeMin` min (`taskCode, minutes, blocks[]`) |
| `AgentBlocked` | pregunta pendiente al cliente (`questionId, question, options`) |
| `UserInstructionAdded` | respuesta del cliente o feedback de *Devolver* (`kind:'answer'\|'feedback', text`) |
| `AgentPaused` / `AgentResumed` | el usuario para al agente / vuelve tras una respuesta o un reintento (`reason`) |
| `AgentFailed` / `AgentCompleted` | fin de la ejecución (`error` / `status, summary, costUsd`) |
| `TaskReviewed` | *Aprobar* o *Devolver* (`decision:'approved'\|'rejected'`) |
| `TaskUpdatedFromBase` / `TaskConflict` | FT-19: la base se fusionó en la rama de la tarea (`base, behind`) / chocó (`base, files, behind`) |

- **Consulta**: `GET /api/events?taskId=&agentId=&projectId=&since=&limit=` (`taskId` acepta id o código; `since` = id de evento o timestamp en ms; `limit` por defecto 200, máx. 2000). Devuelve los más recientes en orden cronológico.
- **SSE**: `/events` emite `event: activity` por cada evento (los clientes que no lo conocen lo ignoran).
- **Almacenamiento**: buffer en memoria de los últimos 2000 y `data/events.jsonl` (al pasar de 5 MB se rota a `events.jsonl.1`).
- Secuencia típica con el motor demo: `TaskCreated → TaskAssigned → AgentStarted → AgentProgress/ToolStarted/ToolFinished… → AgentArtifactCreated → AgentCompleted`.

## Contexto de la UI (FT-2)

El Guide Agent necesita saber qué está viendo el usuario, sin visión ni capturas: la UI publica su contexto estructurado y `server/context.js` lo guarda por cliente.

- **Publicar**: `POST /api/context` con `{view, projectId, openTaskId, selectedAgentId, taskFilter, questionOpen, officeMode, host, at}` (`view` = `office|tasks|agents|settings`; `officeMode` = `building|floor`, si la Oficina enseña el edificio o la planta de un proyecto, FT-47). `public/app.js` lo manda con *debounce* de 300 ms cada vez que cambia algo (pestaña, proyecto, tarea abierta en «Ver la tarea», agente del cajón, filtro, pregunta abierta, modo de la oficina). El cliente se identifica con la cabecera `x-ao-client` (id generado por pestaña en `sessionStorage`).
- **Leer**: `GET /api/context` (o `?client=`) devuelve el del cliente más reciente, enriquecido: `project` (nombre, prefijo, repos), `task` (código, título, estado, agente, rama, últimas 10 líneas de log, preguntas), `agent` (estado, actividad, tarea en curso), `recentEvents` (últimos 20 eventos de FT-1) y `host`.
- **`host`**: contexto que manda flow-test (FT-3). La UI escucha `postMessage({type:'flowtest:context', flow, filePath, node, consoleTail, dirty, running})` de la ventana padre y lo reenvía en el mismo POST. Solo se acepta el contexto del host si el mensaje viene del mismo origen (`e.origin === location.origin`, flow-test embebe AgentOffice por su proxy `/agents/`) y de `window.parent`; cualquier otro origen se ignora (FT-2).
- El snapshot SSE no cambia y no hay polling.

## Tools del Guide Agent (FT-4)

El Guide no es un worker: es la capa de conversación/supervisión por encima del orquestador. No duplica nada: cada tool delega en `team.js`, `context.js`, `events.js` o `git.js`.

- **Registro** (`server/guide/tools.js`): `{name, description, input (JSON Schema), policy, handler(args, ctx)}`. `GET /api/guide/tools` lo lista. Familias: `app.*` (`getContext`, `navigate`, `openTask`, `selectAgent`, `openArtifact`), `flowtest.show`, `project.list/run`, `task.list/get/create/update/assign/getStatus/delete`, `agent.list/status/getLastActions/getModifiedFiles/getArtifacts`.
- **Control de workers** (FT-5): `task.pause/resume/stop`, `task.addConstraint` y `agent.message` ya funcionan (ver «Control de workers»).
- **Fusión** (FT-19): `task.updateFromBase` (execute) — ver «Fusión sin conflictos a mano».
- **Pendientes (501)**: `flowtest.deleteFlow` (flow-test aún no expone el borrado). Están registradas y devuelven 501 sin pedir confirmación.
- **Políticas** (`server/guide/policy.js`): `read` y `navigate` automáticas; `execute` y `write` según `settings.guidePolicy = {execute:'auto'|'confirm', write:'auto'|'confirm'}` (por defecto `execute=auto`, `write=confirm`; se cambia en Ajustes ▸ 🛡 Guide Agent); `irreversible` (`task.delete`) **siempre** pide confirmación.
- **Confirmación**: reutiliza `questions.js` con `kind:'confirm'` (opciones Sí/No, sin respuesta libre, sin tarea asociada). El modal existente la pinta con 🛡; si se rechaza, la tool responde 403 y no hace nada. Sin respuesta en 10 min cuenta como «No».
- **Auditoría**: `data/guide-audit.jsonl` (rota a 5 MB): `{ts, tool, args resumidos, policy, mode, confirmed, via, client, result: ok|denied|error, status, error, ms}`.
- **`POST /api/guide/tool`** `{name, args}` (cabecera `x-ao-client` opcional) ejecuta una tool; los errores salen con su código HTTP (400 args inválidos, 403 rechazada, 404, 501). `task.create` no pasa por el control de suite de `POST /api/tasks` (crear no arranca nada; el planificador sí lo respeta).
- **Órdenes a la UI**: las tools de navegación emiten `event: ui` por el SSE (`navigate`, `openTask`, `selectAgent`, `flowtest.show`), dirigidas a la pestaña del último contexto publicado (FT-2). `flowtest.show` llega al host como `postMessage({type:'flowtest:show', flow, node})` (mismo origen, solo embebido). El snapshot incluye `guidePolicy`.
- **`task.assign`** fija `task.assignedAgentId` (el agente debe estar fichado en el proyecto); `tick()` solo se la da a ese agente. Desde la UI lo hace «Asignar a…» en la tarjeta (`POST /api/tasks/:id/assign`, FT-50).
- **MCP por stdio** (`bin/ao-mcp.mjs`, JSON-RPC 2.0 sin dependencias): `initialize`, `tools/list`, `tools/call`, `ping`; proxya a la API con `AO_URL` (7420) y `AO_TOKEN`. Los nombres MCP no admiten «.», así que `task.create` se publica como `task_create`. Para el proveedor Claude CLI del Guide (FT-6): `--mcp-config` con `{"mcpServers":{"agentoffice":{"command":"node","args":["bin/ao-mcp.mjs"]}}}`.

```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/ao-mcp.mjs
curl -X POST localhost:7420/api/guide/tool -H 'content-type: application/json' -d '{"name":"task.create","args":{"projectId":"…","title":"…","role":"back"}}'
```

## Control de workers (FT-5)

Intervenir en un agente que trabaja (sección 6.3 de la especificación del Guide):

- **Pausar / reanudar**: `POST /api/agents/:id/pause` y `/resume`. Los motores reales se lanzan con `detached:true` (grupo de procesos propio): pausa = `SIGSTOP` al grupo (`ps` → STAT `T`), reanudar = `SIGCONT`; parar manda `SIGTERM`+`SIGCONT` al grupo (un grupo parado no recibiría la señal). El agente pasa a `status:'paused'` («en pausa» en tarjeta, cajón y oficina 3D) y la tarea sigue `doing`. Eventos `AgentPaused` (`reason:'paused-by-user'`) / `AgentResumed`. El motor demo se congela sin avanzar.
- **Mensaje en caliente**: `POST /api/agents/:id/message {text, constraint?}`. **Claude** corre con `--input-format stream-json` y stdin abierto: el prompt inicial es el primer mensaje de usuario y el mensaje se inyecta como otro, precedido de «INSTRUCCIÓN DEL CLIENTE (prioritaria):». Con stdin abierto el CLI no sale solo, así que se cierra 2,5 s tras un `result` si no arranca otro turno; manda el último `result`. **Codex/demo** (sin entrada en caliente): se registra el mensaje, se para al agente y se reencola la misma tarea (misma rama/worktree) con el mensaje en el prompt (`pendingMessages`, se consumen al lanzarse).
- **Constraints**: `task.constraints[] = {text, at, origin}` (`POST /api/tasks/:id/constraints` o `constraint:true` en el mensaje). Van **siempre** en `buildPrompt` («Restricciones del cliente (obligatorias…)»), también tras Devolver o reintentar. El modal de la tarea las lista. Evento `UserInstructionAdded` (`kind: 'message'|'constraint'`).
- **UI**: botones ⏸ Pausar / ▶ Reanudar / ✉ Mensaje en la tarjeta del agente, el cajón y el modal de la tarea.

## Integraciones deterministas del Guide (FT-10)

Fase 4 de la especificación (preferencia 2: API/CLI antes que visión). Nuevas tools del registro de FT-4 (`server/guide/integrations.js`; mismo `POST /api/guide/tool` y MCP: `ide_openFile`, `git_status`…), todas bajo la Policy Layer, con auditoría y **limitadas a los repos del proyecto** (y a los worktrees de sus tareas):

| Tool | Política | Qué hace |
|---|---|---|
| `ide.openFile {path, line?, task?, repo?}` | navigate | Abre el fichero en el IDE: `AO_IDE_CMD` (por defecto `code --goto {path}:{line}`; se trocea sin shell). Con `task` abre la copia del worktree y, sin `line`, la del **primer hunk** del diff. Sin IDE → 503 y el Guide cae a `app.openArtifact` (diff en la UI). |
| `git.status` / `git.diff` / `git.log {repo, branch?}` | read | Reutilizan `server/git.js`. Con `branch` el diff es `base...rama` y el estado se mira en el worktree de esa rama. Rama validada (sin `-opciones`). |
| `filesystem.read {repo\|task, path}` | read | Solo dentro del repo/worktree (resuelve symlinks), tope **200 KB** (recorta y avisa). Nunca `.env*`, `.git` ni `data/`. |
| `filesystem.write {repo\|task, path, content}` | write → confirmación | Mismos límites. |
| `terminal.execute {repo\|task, cmd}` | execute | **Misma lista blanca que los workers** (`server/engines/allowlist.js`, compartida con `engines/claude.js`: sin `rm`, `sudo`, `docker`, `ssh` ni `git push`). Sin shell (`execFile`): se rechazan `; & \| > < $ ( ) { } \` y backticks, `find -exec/-delete`, `xargs` con comandos no permitidos y rutas fuera del repo o vetadas. Timeout **60 s**, salida recortada a 20 KB por flujo; `exitCode` ≠ 0 no es un error HTTP. |
| `browser.open {url}` | navigate | Solo `http(s)`; `xdg-open` (`open` en macOS; `AO_BROWSER_CMD` lo cambia). |

`repo` es la clave de un repo del proyecto; con `task` se trabaja en su worktree. Límite conocido: la lista blanca es la de los workers, así que `node -e`, `python3 -c` o `curl` siguen pudiendo hacer lo que hagan (igual que un worker); por eso `terminal.execute` es `execute` y se puede pasar a confirmación en Ajustes ▸ 🛡 Guide Agent.

«Enséñame lo que ha cambiado» / «abre el fichero que acaba de modificar»: `agent.getModifiedFiles` + `ide.openFile` con el código de la tarea (VS Code en la línea del primer hunk); si no hay IDE, `app.openArtifact`.

Prueba: `node scripts/integrations-e2e.mjs` (55 comprobaciones, sin Claude: servidor temporal, repo git de pega, IDE/navegador falsos que registran sus argumentos). Incluye `rm -rf`, encadenados y rutas fuera del repo rechazados, `.env`/`data/`/symlinks, tope de 200 KB y timeout.

## 🧭 Guía (FT-6 · FT-9 · FT-12)
- **Lista de chats (FT-51)**: en la vista Guía la columna de chats se ensancha arrastrando su borde (160–480 px, doble clic = 220; `ao:guideListW`), se pliega a una tira con ◀/▶ (`ao:guideListMin`), cada chat tiene 🗑 (con confirmación; no con un turno en curso) y «Borrar todos…»; con el foco en la lista: ↑/↓ cambian de chat, Supr borra, Ctrl+N nuevo. En móvil y en el cajón flotante queda el selector con 🗑.


Mapa rápido (cada pieza es una tarea y tiene su sección en este README): eventos **FT-1** · contexto de la UI **FT-2** · contexto de flow-test **FT-3** (en el repo flow-test) · tools, políticas y MCP **FT-4** · control de workers **FT-5** · chat y proveedores **FT-6** · proveedores API **FT-8** · Task Capture **FT-7** · e2e **FT-11** · documentación **FT-12**. Cómo encaja todo: flow `flowtest/arquitectura-guide.flow.json` del workspace (Mermaid de arquitectura, eventos y permisos + cajitas ejecutables contra `/api/context`, `/api/events` y `/api/guide/tool`) y, comparado con la especificación, `AgentOffice - Guía y oficina de agentes.md` en la carpeta docs/ del proyecto (12-flowtest).

Ejemplos reales (uno por flujo; el Guide los resuelve con las tools de FT-4):

| Flujo | Dices | El Guide hace |
|---|---|---|
| A · crear | «Créame una tarea para solucionar esto» | `task.draft` → te enseña el borrador y pregunta «¿La creo?» → `task.create` con el `context` de lo que veías (flow, nodo, consola) |
| B · supervisar | «¿Cómo va FT-7?» | `task.getStatus` + `agent.getLastActions` (lectura, sin confirmar) |
| C · intervenir | «Páralo un momento» / «dile que no toque esa clase» | `task.pause` (luego `task.resume`) / `agent.message` con `constraint:true` |
| D · mostrar | «Enséñame lo que ha cambiado» | `agent.getModifiedFiles` + `app.openArtifact` (diff) y `flowtest.show` si es un flow |

**Voz (FT-9)**: otra entrada al mismo `POST /api/guide/chat`; no hay un pipeline aparte.

- **UI**: botón 🎤 junto a la caja del chat (mantener pulsado) o **barra espaciadora con la caja vacía** (mantener). `MediaRecorder` (`audio/webm;codecs=opus`, con alternativas si el navegador no lo soporta) y un **VAD** simple en el cliente (`AnalyserNode`, RMS > 0,02): corta solo tras **700 ms de silencio** una vez oída la voz, con tope de **30 s**; soltar también corta. El audio va a `POST /api/guide/stt` y el texto se inserta en la caja y se envía como si se hubiera escrito. La transcripción es una petición normal: la UI no se bloquea. Si no se oye nada: «No te he oído».
- **Ajustes ▸ 🎤 Voz**: proveedor STT (`local-cmd`/`openai`, con su disponibilidad), idioma hablado (`settings.sttProvider`, `settings.sttLang`; por defecto `local-cmd`/`es`), «revisar antes de enviar» (el texto queda en la caja para corregirlo), «leer en voz alta» y **🎤 Probar micrófono** (nivel, texto, proveedor y latencia). Las dos casillas son preferencias del navegador (`localStorage`), no del servidor.
- **TTS opcional**: `speechSynthesis` del navegador lee las respuestas **cortas** (≤ 320 caracteres, sin bloques de código) al terminar el turno. Apagado por defecto; empezar a hablar o enviar algo lo calla.
- **API**: `GET /api/guide/stt` → `{provider, lang, providers:[{name,label,ok,reason?}]}`; `POST /api/guide/stt {audio: base64, mime, lang?}` → `{text, lang, ms, provider}` (400 sin audio, 413 si pasa de ~9 MB, 503 si el proveedor no está disponible). Pasa por el token como el resto.
- **Palabra de activación (FT-35)**: `POST /api/guide/wake {audio: base64, mime, durationMs?}` → `{wake, rest, ms}`. Transcribe SIEMPRE con `local-cmd` (aunque `sttProvider` sea `openai`; el audio nunca va a OpenAI), normaliza (minúsculas, sin tildes ni puntuación) y busca «oye guía» al principio (variantes: «oye guia», «oiga guía», «oye, guía», «hey guía»); `rest` es lo que sigue. Con `wake=false` no se guarda ni se registra el texto. 413 si el audio pasa de 200 KB o `durationMs` de 3000; 503 con motivo si `local-cmd` no está disponible. `GET /api/guide/stt` añade `wake: {ok, reason?}`. Lógica en `server/guide/stt/wake.js` (`matchWake(text)` pura).
- **Escucha continua «oye guía» (FT-36)**: casilla en Ajustes ▸ 🎤 Voz (preferencia del navegador `ao:voice-wake`, APAGADA de serie; deshabilitada con su motivo si `GET /api/guide/stt` da `wake.ok=false`). Activa, el RMS del micro se analiza en local con el mismo `voiceRecord`/VAD del push-to-talk: solo se graba un segmento cuando hay voz (corte por silencio o a 2,5 s) y solo ese segmento va a `/api/guide/wake`; el silencio no se envía y nada va a `/api/guide/stt`. `wake:true` con `rest` → se trata como la transcripción de FT-9 (respeta «revisar antes de enviar»); sin `rest` → abre el Guía y empieza una grabación normal cortada por el VAD. Se pausa (y se sueltan las pistas del micro) con `G.busy`, `V.state≠idle`, `speechSynthesis.speaking` o la pestaña oculta. Indicador siempre visible: chip «👂 Escuchando «oye guía»» en la cabecera del Guía y marca 👂 en `#guide-fab`; un clic en cualquiera la apaga. Embebido y mismo origen publica `parent.postMessage({type:'agentoffice:listening', on})`. `scripts/voice-e2e.mjs` lo cubre con el micro falso de Chrome. **e2e de la escucha continua (FT-38)**: `node scripts/wake-e2e.mjs` (servidores temporales, micro falso de Chrome con un WAV, STT falso y un mock de OpenAI que cuenta llamadas; 36 checks): instalación limpia sin chip ni permisos ni `/wake`; chip y marca 👂 al activar; «oye guía, ¿cómo va?» entra en el chat y «hola qué tal» no; `sttProvider=openai` → 0 peticiones al mock; sin STT local casilla deshabilitada con motivo; sin peticiones a `/wake` con `G.busy`; apagar quita el chip; API con 413 (>200 KB o >3 s) y 503 sin STT local.
- **Dictado en «Nueva tarea» (FT-43)**: botón 🎤 dentro de los campos Título y Descripción del diálogo; un clic empieza a dictar (rojo pulsante, `aria-pressed`), otro para, y cerrar el diálogo corta el micro. El texto reconocido se inserta en la posición del cursor y queda editable. Idioma = «Idioma hablado» de Ajustes. Encapsulado en `public/dictation.js` (`dictationSupported`, `createDictation({lang,onText,onState,onError})`, `insertAtCursor`), hoy sobre la Web Speech API del navegador, para poder cambiar de proveedor sin tocar `app.js`. Sin soporte el botón no se pinta; con permiso denegado avisa con un toast y el botón queda desactivado. `node scripts/dictation-e2e.mjs [captura.png]` lo prueba con un SpeechRecognition simulado (10 checks). **Proveedores (`public/dictation.js`):** el preferido es el **STT del servidor** (mismo `voiceRecord`/VAD del push-to-talk → `POST /api/guide/stt`, es decir, faster-whisper local: el audio no sale de tu instalación; se usa cuando `GET /api/guide/stt` da el proveedor disponible), y de respaldo la Web Speech API del navegador (Chrome manda el audio a Google; en Brave existe pero falla con «network»). Preferencia `localStorage ao:dictation=browser` para forzar el navegador. El mismo 🎤 está en la barra «🎯 Objetivo para el PO» de Tareas (se añade al saber si hay STT). E2E: `scripts/dictation-e2e.mjs` (18 checks: navegador simulado, sin soporte, servidor con micro falso + STT falso, barra del objetivo).
- **Requisitos y documentación de la escucha continua (FT-40)**: `/api/guide/wake` y la casilla `ao:voice-wake` solo funcionan con un STT LOCAL: `faster-whisper` instalado (lo usa `bin/stt-whisper.py`) o `AO_STT_CMD` apuntando a tu comando; sin ninguno `GET /api/guide/stt` da `wake.ok=false` y la casilla queda deshabilitada. Nunca se usa OpenAI para esto, aunque `sttProvider` sea `openai`. Fase 7 explicada en el flow `flowtest/arquitectura-guide.flow.json` (nota «🎤 Voz · escucha continua (Fase 7)»); pruebas: `scripts/wake-e2e.mjs` (aquí) y `scripts/agents-wake-e2e.mjs` (repo flow-test, modal Agentes).
- **Proveedores** (`server/guide/stt/`, interfaz `SttProvider { transcribe(buffer, mime, lang) → {text, lang, ms}, available() }`):
  - `local-cmd.js`: ejecuta `AO_STT_CMD <fichero> <idioma>` (con comillas si hay espacios) y toma el stdout como texto (o JSON `{"text","lang"}`); sin `AO_STT_CMD` usa `python3 bin/stt-whisper.py` (**faster-whisper**: `pip install faster-whisper`; `AO_WHISPER_MODEL` por defecto `base`, `AO_WHISPER_DEVICE` `cpu|cuda`). Un script que imprima un texto fijo basta para probar sin micrófono.
  - `openai.js`: `/v1/audio/transcriptions` (`whisper-1`, `AO_STT_OPENAI_MODEL`; `AO_OPENAI_BASE` para otro endpoint). La clave sale de `getApiKey('openai')` en `server/engines/auth.js`: `OPENAI_API_KEY`, la guardada en `.ai-keys.json` o la de Codex en `~/.codex/auth.json`.
- **Navegador**: el micrófono solo se concede en `localhost` o `https`; con `AO_HOST=0.0.0.0` por http sin TLS el 🎤 avisa de que no puede grabar.
- **Prueba**: `node scripts/voice-e2e.mjs [captura.png]` (sin micrófono ni Claude): `AO_STT_CMD` → script con texto fijo «¿Cómo va?», proveedor `fake` del Guide y el micrófono falso de Chrome (necesita `puppeteer-core` y Chrome; sin ellos solo prueba la API). Comprueba el flujo 🎤 → texto en el chat → respuesta, «revisar antes de enviar», la barra espaciadora y los errores del STT.

**Variables de entorno de la Guía**: `AO_GUIDE_FAKE=1` (registra el proveedor de pruebas `fake`, solo para e2e), `AO_CLAUDE_BIN` (binario `claude`, también lo usa el proveedor `claude-cli`), `AO_URL` y `AO_TOKEN` (las lee `bin/ao-mcp.mjs` para llegar a la API; el token solo hace falta si AgentOffice escucha fuera de loopback, `AO_HOST=0.0.0.0`, y entonces se lee de `data/.token`), `AO_ASK_TIMEOUT_MIN` (preguntas al cliente). `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (proveedores HTTP, FT-8). Ajustes (`POST /api/settings`): `guideProvider`, `guideModel`, `guideModels`, `guidePolicy`.

**Contrato con flow-test (FT-3 ↔ FT-2/FT-4, revisado en FT-12)**: flow-test (`AgentsPanel.tsx`) manda `flowtest:context {activeTab, focusedNode, selection, consoleTail, runStatus, sidePanel}` al cargar el iframe, al recibir `agentoffice:ready` y en cada cambio; AgentOffice lo aplana al `host` del contexto (`flow, filePath, node, nodeId, nodeLabel, consoleTail, running…`), manda `agentoffice:ready` al arrancar embebido y, para `flowtest.show`, emite `agentoffice:navigate {flow, node}` (y `agentoffice:openDiff {text}` queda disponible en flow-test para un diff). La documentación de FT-12 detectó que los dos lados no coincidían; corregido en AgentOffice en `747fc4f`.

El **Guide Agent** es la capa de conversación, contexto, supervisión y navegación por encima del orquestador (`team.js`): no es un worker, no duplica tareas ni bus, y usa las tools de FT-4 (políticas y auditoría incluidas). Nunca controla la UI con capturas: solo órdenes `ui` estructuradas.

- **Servicio** (`server/guide/index.js`): chats persistentes en `data/guide/<id>.json` (mensajes, tool calls con su resultado, contexto de cada turno, `sessionId` del proveedor). Cada turno lleva `<app_context>` (`GET /api/context`, FT-2, con el `host` de flow-test si lo hay) y `<eventos_desde_tu_ultimo_turno>` (Activity Stream, FT-1) para que no pregunte lo que ya está a la vista. El system prompt (rol «guía») está en `server/guide/prompt.js`.
- **Proveedor** (`server/guide/providers/`): interfaz `GuideProvider { start({system, tools, model, resume}), send({text, context}) → stream de {type:'text'|'tool_call'|'tool_result'|'done'|'error', …}, stop() }`; el dominio no depende de ningún LLM. El primero, `claude-cli.js`, lanza `claude -p --input-format stream-json --output-format stream-json` con la sesión **viva** entre mensajes (se cierra tras 10 min ocioso y se retoma con `--resume <session_id>`), `--tools ""` (sin Bash/Edit/Write), `--strict-mcp-config` con `bin/ao-mcp.mjs` (FT-4) y `--allowedTools mcp__agentoffice`. Modelo: Ajustes ▸ 🧭 Guía (`settings.guideModel`, por defecto `sonnet`); proveedor: `settings.guideProvider` (por defecto `claude-cli`).
- **Proveedores intercambiables (FT-8)**: `settings.guideProvider` ∈ `claude-cli` (por defecto) · `anthropic-api` · `openai-api`; se elige en Ajustes ▸ 🧭 Guía (con el modelo de cada uno: `guideModel` para el CLI y `guideModels[proveedor]` para las APIs; por defecto `claude-sonnet-5-5` y `gpt-5.5`). Los tres emiten los mismos eventos (`text`, `tool_call`, `tool_result`, `done {costUsd, usage}`, `error`), así que los flujos A–D no cambian. `anthropic-api.js` usa la Messages API por `fetch` con streaming SSE, tools nativas (los esquemas del registro de FT-4, con `task.create` → `task_create`) y `cache_control` en el system; `openai-api.js` usa Chat Completions con streaming y function calling; el bucle «modelo → tools → modelo» (máx. 12 rondas), el historial y la ejecución de tools con política y auditoría están en `providers/common.js`. Sin SDKs. **Claves**: las de Ajustes ▸ Motores de IA (Claude → Anthropic; la clave de Codex se copia además como `openai` en `data/.ai-keys.json`, 0600, sin cifrar) o `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. **URL base**: `ANTHROPIC_BASE_URL` (sin `/v1`) y `OPENAI_BASE_URL` (con `/v1`), para mocks y gateways. Los proveedores HTTP no tienen sesión remota: al cambiar de proveedor o modelo el chat sigue, porque el historial se rehidrata del chat guardado. **Coste por turno**: el CLI da `costUsd`; las APIs dan solo tokens (`usage`: entrada, salida, caché), y `costUsd` si el gateway lo devuelve (`usage.cost`, p. ej. OpenRouter); la UI lo pinta bajo la respuesta.
- **API**: `GET /api/guide/chats` (lista), `GET /api/guide/chats/:id` (chat completo), `DELETE /api/guide/chats/:id`, `POST /api/guide/chat {chatId?, text}` (SSE: `chat` con el id, y los eventos del proveedor; el turno sigue aunque el navegador se desconecte; 409 si ese chat ya está respondiendo), `POST /api/guide/stop {chatId}`. El cliente se identifica con `x-ao-client` para que el contexto sea el de su pestaña.
- **UI**: vista **🧭 Guía** en la barra lateral (también `?view=guide`, para el botón de flow-test de FT-3) con lista de chats, y un **cajón flotante** en cualquier vista (botón 🧭 o **Ctrl+G**). Burbujas, tool calls plegables con argumentos y resultado, botón «■ Parar». Las confirmaciones de las tools (FT-4) salen por el modal de preguntas de siempre. `app.navigate` acepta la vista `guide`.
- **Flujos** (probados con `scripts/guide-smoke.mjs`): A «Créame una tarea para solucionar esto» → `task.create` contextualizada; B «¿Cómo va?» → `task.getStatus`/`agent.getLastActions`; C «Páralo» → `task.pause`/`task.stop` (FT-5); D «Enséñame lo que ha cambiado» → `agent.getModifiedFiles` + `app.openArtifact` (y `flowtest.show` si es un flow).
- **Task Capture (FT-7)**: la tool `task.draft` (read) reutiliza `server/ai-draft.js` («✨ Redactar con IA») con el contexto que el usuario tiene delante y devuelve, sin crear nada, `{title, description con «Hecho cuando», role, repo, skills}` (el rol es uno del equipo; si no está claro, el primero de la plantilla, como en el formulario; las skills solo pueden ser de ese rol). `task.create` (write; confirmación según Ajustes, y por defecto el Guide enseña el borrador y pregunta «¿La creo?» salvo «créala sin preguntar») acepta `skills` y persiste en la tarea `context: {view, projectId, taskCode?, agentId?, host:{flow, filePath, node, nodeLabel, consoleTail}}` (recortado en `server/task-context.js`; lo toma el servidor del contexto publicado, el modelo no lo inventa). La tarjeta y el modal muestran «↗ Nació de: flow X · nodo Y» (el enlace llama a `flowtest.show`; sin flow-test cae a «tarea/agente/vista» de AgentOffice) y `buildPrompt` añade al worker «El cliente estaba viendo … cuando pidió esto» con la cola de consola. `task.get` devuelve el `context`.
- **Prueba de humo**: `node scripts/guide-smoke.mjs` levanta un servidor temporal con motor demo y un stub de `/access`, y por cada proveedor (`claude-cli`, `anthropic-api`, `openai-api`; `--provider X` para uno) abre un chat, manda las cuatro frases y comprueba las tools llamadas y sus efectos en el estado (tarea creada, órdenes `ui`, chat guardado, contrato de eventos, coste/tokens). El «LLM» es un **mock HTTP incluido en el script** (protocolos de Anthropic y OpenAI; el `claude` del CLI también le habla vía `ANTHROPIC_BASE_URL`), así que no gasta nada; con `--real` usa el LLM de verdad (`claude` con sesión o claves en el entorno). Para las APIs comprueba además el protocolo (tools con nombres válidos, `cache_control`, cabeceras de clave, `tool_result` en el historial, modelo de Ajustes). Sale con código 1 si algo falla.
- **e2e determinista (FT-11)**: `node scripts/guide-e2e.mjs` (sin Claude ni dependencias; ~1 min) arranca el servidor con `AO_DATA_DIR`/`HOME` temporales, motor demo, un flow-test de pega y el proveedor de pruebas `fake` (`server/guide/providers/fake.js`, solo con `AO_GUIDE_FAKE=1`; el guion de tool calls va en el mensaje: `texto ::[{"tool":"task.list","args":{}}]`). Cubre contexto, orden de eventos, flujos A–D, políticas (irreversible/write confirm/auto, auditoría), pausa/reanudación, `agent.message` con constraint y el chat SSE, con sus rechazos. Un `claude` falso (`AO_CLAUDE_BIN`) escribe ficheros reales en una rama para el flujo D. La API viva está documentada en el flow `flowtest/guide-api.flow.json` del workspace (solo lecturas; el token de AgentOffice va en la variable `aoToken`).

## 🔊 Voz del Guía (TTS) (FT-52)

Cada respuesta del Guía (vista Guía y cajón flotante, también dentro del iframe de flow-test) lleva un botón **▶** que la lee en voz alta: ▶ → ⏳ preparando → ⏸ (pulsar otra vez para). Solo suena una a la vez y se calla al cambiar de chat, cerrar el cajón o enviar otro mensaje. Se lee el texto plano (sin markdown ni bloques de código; las tool calls no se leen). La casilla «Leer en voz alta las respuestas cortas» usa el mismo camino y la escucha continua («oye guía») se pausa mientras suena (`ttsPlaying()` en `wakeWanted()`).

- **Proveedores** (`server/guide/tts/`, espejo de `stt/`; interfaz `{synthesize(text,{voice,lang}) → {audio,mime}, voices(), available()}`), elegible en Ajustes ▸ «🔊 Voz del Guía» (`ttsProvider`/`ttsVoice` en `POST /api/settings`) con selector de voz y **Probar voz**:
  - `piper` (**por defecto, local, el texto no sale del PC**): ONNX en CPU. Voz por defecto `es_ES-sharvard-medium` hablante **F** (mujer, es-ES); también `es_AR-daniela-high` (mujer, calidad alta), `es_ES-mls_9972-low` (mujer, ligera) y `es_ES-davefx-medium` (hombre).
  - `openai` (nube, opcional): `/v1/audio/speech`, modelo `tts-1` (`AO_TTS_OPENAI_MODEL`), voces `nova`/`shimmer`; clave como el STT (`getApiKey('openai')`), `AO_OPENAI_BASE`. **Solo aquí el texto sale a la nube.**
  - `browser`: `speechSynthesis`; elige sola una voz femenina en español (`female`, Mónica, Paulina, Lucía, Elvira, «Google español»…), velocidad 1 y tono 1. También es el respaldo si el servidor responde 503 (si no hay ni eso, ▶ queda deshabilitado con el motivo en el tooltip).
- **API**: `GET /api/guide/tts` → `{provider, voice, providers:[{name,label,ok,reason?}], voices}` (`?provider=` para ver las voces de otro); `POST /api/guide/tts {text, voice?}` → `audio/wav` (`audio/mpeg` con openai). Máx. 4000 caracteres (413), 503 si el proveedor no está, caché en memoria de los últimos 50 audios (hash de proveedor+voz+texto).
- **Instalar piper**: `pip install piper-tts` (Python ≥3.9). La voz se descarga sola la primera vez (~75 MB, Hugging Face `rhasspy/piper-voices`) a `data/tts/voices/`; sin red hay un mensaje claro y puedes copiar a mano `<voz>.onnx` y `<voz>.onnx.json` en esa carpeta. Probar: `echo hola | python3 -m piper -m data/tts/voices/es_ES-sharvard-medium.onnx -s 1 -f /tmp/h.wav`.
- **Añadir otra voz**: busca una en <https://huggingface.co/rhasspy/piper-voices> y declárala con `AO_TTS_VOICES="es_MX-ald-medium|Ald|es|male,es_ES-xxx-medium:F|Mi voz|es|female"` (`id|etiqueta|idioma|género`, `id` = `<modelo>[:<hablante>]`); aparece en el selector.
- **Variables**: `AO_TTS_CMD` (sustituye a piper: se ejecuta con `<salida.wav> <voz> <idioma>` y recibe el texto por stdin; sirve para probar sin piper), `AO_TTS_VOICES_DIR` (carpeta de modelos), `AO_TTS_VOICES`, `AO_TTS_HF_BASE`, `AO_TTS_OPENAI_MODEL`, `AO_OPENAI_BASE`.
- **Prueba**: `node scripts/tts-e2e.mjs [captura.png]` (servidor temporal con `AO_TTS_CMD` falso que genera un WAV, Chrome headless con autoplay): API, ▶ con el texto plano, `play`/`ended` del `<audio>`, ⏸, una sola reproducción, cambio y prueba de voz en Ajustes, 503 con respaldo del navegador y botón deshabilitado sin ninguno.

## ✋ Revisión (FT-56)

Cuando una tarea llega a **Revisión** el trabajo se para hasta que alguien pulsa Aprobar/Devolver, y las tareas que dependen de ella esperan en «Por hacer». Para que nunca «parezca que no pasa nada»:

- **Tarjeta en Revisión**: franja ámbar «✋ Esperando tu revisión desde hace 14 min» (el tiempo se actualiza solo), «bloquea: FT-47, FT-48» (con enlace) y los botones **Aprobar / Devolver / Ver diff** en la propia tarjeta.
- **Tarjetas dependientes** (Por hacer / Backlog): «⏳ espera a FT-46 (en revisión)» con enlace.
- **Contadores**: `✋N` en la pestaña Tareas, «✋ N por revisar» en la cabecera (clic → la más antigua), KPI y columna Revisión del 📊 Resumen en ámbar con «desde hace X min» en el tooltip; el edificio 3D ya enseña «✋ K en revisión» (FT-46).
- **Aviso proactivo**: toast al entrar una tarea en revisión («Óscar terminó FT-46: revísala»). Pasados `settings.reviewNudgeMin` minutos (10 por defecto; 0 = enseguida) el servidor emite **`ReviewPending {taskCode, minutes, blocks[]}`** en el Activity Stream (una vez por entrada en revisión) y el Guía recibe un bloque `<pendientes_de_revision>` en su siguiente turno para mencionarlo.

### Política de revisión (`settings.reviewPolicy`, Ajustes vía `POST /api/settings`)

| Valor | Qué hace |
|---|---|
| `manual` (por defecto) | Siempre decide una persona. |
| `auto-qa` | Al llegar a revisión, el orquestador lanza un **revisor** interno (rol QA; mismo motor que el autor o `settings.reviewEngine`) sobre la rama: lee `git diff <base>...HEAD`, el resumen y ejecuta las verificaciones declaradas, y acaba con un JSON `{"approve": bool, "reasons": [], "feedback": ""}`. `approve` → se aprueba y fusiona sola («✅ aprobada por revisión automática (QA): …»); si no → se **devuelve** al autor con el feedback (intento N+1). Tope de **2 ciclos automáticos**; después queda para el humano con «⚠️ dos revisiones automáticas fallidas». Una devolución humana reinicia el contador. |
| `auto` | Sin LLM: ejecuta las verificaciones declaradas en el worktree y, si **todas** pasan, aprueba. Si una falla se queda en revisión con el motivo. Sin verificaciones declaradas se comporta como `manual`. |

- **Verificaciones declaradas**: `checks: ["npm run lint", …]` al crear la tarea (`POST /api/tasks`) o comandos en `código` de la descripción que parezcan tests/lint/typecheck/e2e (`node scripts/x-e2e.mjs`, `npm run typecheck`…).
- **Nunca se aprueba sola** una tarea con `reviewRequired: true`, una cortada por tope de gasto o atasco, ni una que toque ficheros sensibles: `settings.reviewSensitive[]` (por defecto `.github/workflows`, `Dockerfile`, `package.json` —solo si cambian dependencias— y `server/access`).
- Todo queda en el Activity Stream (`TaskReviewed {by:'auto-qa'|'auto', verdict}`) y en `task.reviewLog` (historial de la tarea).
- 💡 **Consejo**: deja `manual` en los proyectos cuyas tareas toquen producción (despliegues, infraestructura, accesos, migraciones); usa `auto` para repos con buenos tests y `auto-qa` para una segunda opinión barata.
- Pruebas: `node scripts/review-e2e.mjs` (motor demo; un título con `[revisor:devolver]` hace que el revisor demo devuelva) y `node scripts/review-shot.mjs out.png` (captura de la pestaña Tareas).

## Un worktree por cada repo del proyecto (FT-44)

Si el proyecto tiene varios repos, cada tarea real (motores claude/codex) recibe un worktree y la rama `ao/<código>` en **todos**: el principal (`task.repo`) en `data/worktrees/<proyecto>/<código>/` como siempre y los demás como hermanos `data/worktrees/<proyecto>/<código>.<repoKey>/` (anidarlos en el principal los ensuciaría). El prompt lista cada repo con **su** ruta de worktree y prohíbe escribir en los checkouts principales; los motores reciben los demás worktrees como directorios adicionales (`--add-dir`).

- **Schema aditivo**: `task.branch`/`task.diffStat` siguen siendo los del repo principal; `task.repos = { <key>: { branch, diffStat, sha } }` trae todos. Al terminar se confirma en cada worktree y los repos **sin cambios se sueltan** (worktree y rama fuera) para no fusionar nada vacío.
- **Revisión**: la tarjeta/modal enseña un diffStat por repo, el diff (`GET /api/tasks/:id/diff`, «Ver cambios») recorre todos con cabecera `══ repo <key> ══`, y las tools `agent.getModifiedFiles` (ficheros de otros repos con prefijo `repo:`, más `repos`), `agent.getArtifacts` (commits y diffStat por repo) y `task.get` entienden varios repos. `git.diff` del Guide ya es por clave de repo (una llamada por repo).
- **Aprobar / Devolver / Actualizar con main (FT-19)**: se ponen al día todas las ramas antes de fusionar ninguna; si una choca, la tarea vuelve al agente con el feedback del repo afectado («Tu rama choca con main (repo api, tu worktree …) en: …») y no se fusiona nada. Borrar la tarea quita todos los worktrees y ramas. `behind`/`conflicts` de la tarea son la suma de los repos (`repo:ruta` fuera del principal).
- **Guardarraíl**: se guarda el `git status --porcelain` de cada checkout principal al empezar y al terminar; si hay líneas nuevas, la tarea lleva `outsideWrites: [{ repo, path, files }]`, la tarjeta un chip «⚠ escribió fuera de su worktree» y el modal el detalle (también en `agent.getArtifacts`). Es solo un aviso para el humano: no se fusiona ni se revierte nada. Con tareas simultáneas en el mismo repo puede haber falsos avisos.
- e2e: `node scripts/multirepo-e2e.mjs` (2 repos git temporales, `claude` falso).

## Fusión sin conflictos a mano (FT-19)

Las tareas nacen de la rama base en su worktree; si varias tocan los mismos ficheros, al aprobar la fusión chocaba y había que resolverla a mano. Ahora lo gestiona el plugin:

- **Comprobación previa**: cada tarea en revisión con rama lleva `behind` (commits de la base que no tiene) y `conflicts[]` (solo rutas que chocarían al fusionar). Se calcula en el servidor con `git merge-tree --write-tree` (git ≥ 2.38; con git antiguo, `merge-tree` clásico), no toca índice ni worktrees, se recalcula solo cuando cambia la base o la rama (cada 10 s y tras cada aprobación) y viaja por el SSE. La tarjeta y el modal muestran los chips «desfasada N commits» y «⚠ conflicto en X».
- **Actualizar con main** (botón en la tarjeta/modal, `POST /api/tasks/:id/update-from-base` y tool del Guide `task.updateFromBase`, policy execute): `git merge --no-edit <base>` dentro del worktree de la tarea. Si entra limpio se recalcula el diffStat y queda lista para aprobar (`TaskUpdatedFromBase`). Si choca se aborta el merge y la tarea vuelve al agente (misma rama y worktree, como *Devolver*) con el feedback: «Tu rama choca con main en: …; haz `git merge main` en tu worktree, resuelve los conflictos conservando lo de ambos lados, verifica y vuelve a confirmar» (`TaskConflict`). El agente tiene `Bash(git merge *)` en la lista blanca (rebase no).
- **Al aprobar**: si la rama está desfasada se actualiza antes de fusionar; si choca no se aprueba (409) y se devuelve como arriba.
- **Al arrancar** una tarea cuya rama ya existe (reintento) y la base avanzó, se actualiza primero; si choca, el conflicto va en el prompt.
- e2e: `node scripts/merge-e2e.mjs` (claude falso que edita la misma línea en varias tareas; una acaba devuelta con el feedback, el agente falso lo resuelve y la fusión sale limpia).

## Motores

**Selector de modelo único (FT-55):** el modelo nunca se escribe a mano salvo en «Otro…»; `modelSelect()` (`public/app.js`) es el mismo `<select>` en el cajón del agente, contratar, editar, roles y Ajustes (grupos Claude/Codex, no disponibles deshabilitados con su nota, lista de `GET /api/engines/models` cacheada 5 min con botón ↻). Prueba: `node scripts/model-select-e2e.mjs`.

| Motor | Cómo se lanza | Permisos |
|---|---|---|
| `demo` | simulado | — |
| `claude` | `claude -p --output-format stream-json` en el worktree | lectura/edición + shell de andar por casa (node, npm, git sin push, grep, sed, cp…; sin rm/sudo/docker/ssh); `--strict-mcp-config`: no hereda tus MCP globales; puede ver sus capturas con `scripts/preview.mjs` |
| `codex` | `codex exec --json -s workspace-write` en el worktree | sandbox de Codex (el PO, `read-only`) |
| `local` (FT-54) | el mismo `codex exec`, con un proveedor propio (LM Studio / Ollama) por `-c` | como `codex` |

Cada agente elige motor y modelo desde su panel (clic en el personaje o en su ficha).
Variables: `AO_PORT` (7420), `AO_HOST` (127.0.0.1), `AO_DATA_DIR`, `AO_CLAUDE_BIN`, `AO_CODEX_BIN`.

## Adjuntos del chat (FT-95)

`POST /api/upload {files:[{name, data}]}` (`data` en base64 o data URL) guarda en `data/uploads/<hex>/` con el nombre saneado (solo basename, sin `..` ni ocultos; duplicados renumerados) y devuelve `[{name, path, size}]`. Límites (`server/uploads.js`): 10 ficheros, 25 MB por fichero, 30 MB por envío → 413; vacío o sin `files` → 400.
`POST /api/guide/chat {chatId?, text?, attachments:[{path}]}` acepta esas referencias (solo rutas dentro de `data/uploads`; otras → 400). El mensaje guardado lleva `attachments` y al proveedor le llega el texto con la lista de rutas. Se puede enviar solo adjuntos, sin texto. Se leen con `GET /api/file?path=…`.
**Limpieza (FT-96):** al borrar un chat se borran sus carpetas de `data/uploads` si ninguna tarea ni otro chat las referencia. Al arrancar y cada hora, `uploads.sweep` elimina las carpetas con más de 1 día que no aparecen en el estado ni en ningún chat (chips quitados, modales cancelados). El historial pinta miniaturas/nombres desde `attachments`; el chat solo texto no cambia (Enter).

**UI (FT-90):** en el chat del Guía (pestaña y cajón), 📎 «Adjuntar» junto a Enviar (`<input type=file multiple>`, FT-94), Ctrl+V sobre la caja (solo si el portapapeles trae ficheros; el texto pegado no cambia) y arrastrar y soltar sobre el chat (recuadro «Suelta aquí para adjuntar»). Se suben al elegirlos y salen sobre la caja como chips de 40 px (miniatura en imágenes, nombre y tamaño en el resto, ✕ para quitar) y un contador «2/10 · 0,1/30 MB» (ámbar al 80 %; con 10 ficheros el 📎 se desactiva); límites en `app.js` (`GUIDE_MAX_FILES` 10, 25 MB por fichero, 30 MB en total) con aviso claro. Al enviar la lista se vacía y el mensaje del historial muestra miniaturas/ficheros enlazados. Prueba: `node scripts/guide-attach-e2e.mjs [captura.png]`.

## Consumo de tokens (FT-26)

**Resumen limpio (FT-53):** la tabla del 📊 Resumen queda en una línea por proyecto — «Tokens por sesión» = solo el total (`23,9M tok`) con un punto ámbar/rojo si algún agente pasa del 80 % de su contexto y botón «Ver» (`data-sum-tokens`); «Equipo» = «6 agentes» con hasta 3 avatares + «+3» (`data-sum-team`); «Trabajando en» = «2 en curso» (+ código si es una); «Libres» = «4 libres». El detalle vive en modales (`dialog()`, clase `summary-modal`, a pantalla completa en ≤760 px): **Tokens por sesión · proyecto** (una fila por agente: rol, motor/modelo, total, ↓↑⚡, barra con «quedan…», coste; totales al pie; orden por total; «Copiar como texto») y **Equipo · proyecto** (💤 libre / ⚙ trabajando en FT-xx / ⏸ pausado / ❓ esperando respuesta, actividad, «Abrir» el cajón y «Ir a la tarea»). Se repintan en vivo con cada `state` del SSE sin cerrarse; Esc cierra. Con varios proyectos, la fila «Total» trae «Ver todos» (tokens agrupados por proyecto). Solo UI, sin cambios de API; prueba: `node scripts/summary-e2e.mjs`.

El Resumen muestra, por agente y sesión, los tokens gastados (↓ entrada · ↑ salida · ⚡ caché · total) y un total por proyecto, en vivo por el mismo SSE `state` (`agent.usage`, y `task.usage` acumulado entre intentos). Solo se guardan cifras, nunca prompts ni transcripts. Lógica en `server/usage.js`; prueba: `node scripts/usage-e2e.mjs`.

### Cuota de las suscripciones (FT-45)
- **Detalles de las peticiones (verificado contra las cuentas reales):** chatgpt.com (Cloudflare) devuelve 403 «challenge» al `fetch` de Node aunque lleve user-agent, y acepta `https.request` con `user-agent: codex_cli_rs`, así que `server/quota.js` usa el módulo `https`. En Claude la ventana por modelo llega como `limits[].kind = weekly_scoped` con `scope.model.display_name` («Fable») → ventana `model:fable`.

Encima de los tokens, el Resumen muestra **cuánta cuota queda** de cada suscripción (como `/usage` de Claude Code): ventana de sesión de 5 h, semanal 7 d y, si el proveedor las da, las de modelo, con barra por severidad (ámbar ≥ 80 %, rojo ≥ 95 %) y «se reinicia en 1 h 12 min». En la barra superior, un chip con el peor % de cada motor («Claude 88 % · Codex 84 %») abre el Resumen. Usa el login que ya hay en el PC (sin claves nuevas; los tokens nunca se guardan ni se loguean) y llega por el snapshot SSE (`quota`); el servidor la refresca cada 60 s. `GET /api/quota[?force=1]` devuelve `{claude, codex}` con la forma `{engine, ok, plan, windows:[{id:'session'|'weekly'|'model:<n>', label, percent, resetsAt, severity}], limitReached, reason?, fetchedAt}`; sin dato, `ok:false` y el motivo («sin login», «token caducado: usa claude una vez»: no se refresca desde aquí, cada tarea con el CLI lo renueva).

| Motor | Endpoint | Credenciales |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) · `AO_CLAUDE_USAGE_URL` | `~/.claude/.credentials.json` → `claudeAiOauth` (`CLAUDE_CONFIG_DIR`) |
| Codex | `GET https://chatgpt.com/backend-api/codex/usage` · `AO_CODEX_USAGE_URL` | `~/.codex/auth.json` → `tokens.{access_token, account_id}` (`CODEX_HOME`) |

**Guardarraíl** (`settings.quotaGuard`, activo de serie; casilla en Ajustes): el planificador no arranca tareas nuevas con un motor cuya ventana de sesión esté ≥ 97 % o con `limitReached`. La tarea sigue en *Por hacer* con «⏸ Claude al 98 %: espera al reinicio de las 14:00», una línea de log y un evento `AgentBlocked {reason:'quota'}`, y `tick()` la retoma sola cuando baja el %. Los agentes `engine: auto` eligen el motor con más margen y solo se frenan si ninguno lo tiene. Sin dato de cuota no se frena nada. Prueba: `node scripts/quota-e2e.mjs [captura.png]` (mocks de ambos endpoints, logins falsos, `AO_QUOTA_ENGINE_MAP=demo=claude`, `AO_QUOTA_TTL`).

| | Claude Code | Codex |
|---|---|---|
| Entrada / salida / caché | `message.usage` de cada evento `assistant` del stream-json (dedupe por `message.id`) y `usage` del `result` final (caché = lectura + creación) | `usage` de `turn.completed` de `codex exec --json` (entrada = `input_tokens` − `cached_input_tokens`; salida incluye razonamiento) |
| Total | entrada + salida + caché | ídem |
| Límite / restante | ventana de contexto (`modelUsage[modelo].contextWindow` del `result`, barra amarilla ≥70 %, roja ≥90 %); aparece al terminar el primer turno. La cuota del plan (Session/Weekly) no la expone `claude -p` | n/d: el stream no informa ventana ni cuota |
| Coste | `total_cost_usd` del `result` (en el tooltip) | n/d |
| Frecuencia | por mensaje | solo al terminar cada turno |

El motor `demo` no consume tokens: aparece «n/d».

## DesktopProvider (FT-20)

`server/desktop/` abstrae el escritorio del usuario (ventana activa, lista de ventanas, captura). `getProvider()` elige por `process.platform`: `linux` → `linux.js`; darwin/win32 → provider `unsupported` (error 501 «aún no disponible en <so>»); `AO_DESKTOP=fake` → `fake.js` con ventanas y captura fijas para pruebas. Contrato (cabecera de `index.js`): `{ id, session, available(): {ok, missing[]}, getActive(): {id, title, app, pid}, list(): [{id, title, app, pid, active}], capture(opts) }`.

`linux.js` detecta la sesión en tiempo de ejecución (`XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`/`DISPLAY`):

- **X11**: `xdotool getactivewindow getwindowname getwindowpid` + `wmctrl -lp`; captura con `import` (ImageMagick), `scrot` o `gnome-screenshot`.
- **Wayland GNOME**: `gdbus` a `org.gnome.Shell` (`Eval`, o la extensión «Window Calls» si Eval está bloqueado); captura con `grim` o `gnome-screenshot`. Otros compositores Wayland → 501.

El nombre de la app sale de `/proc/<pid>/comm`. `available()` indica qué herramienta falta (`missing`). Sin dependencias npm; `execFile` con timeout de 3 s. Decisión (sin respuesta del cliente): se soportan ambas sesiones.

**Captura (FT-21)**: `capture({target: 'screen'|'window', windowId?})` solo se ejecuta cuando alguien la llama (nunca hay capturas automáticas). Elige la herramienta según la sesión: X11 → `import -window root|<id>` (ImageMagick), luego `scrot`, `gnome-screenshot`; Wayland GNOME → `gnome-screenshot -f` o `gdbus org.gnome.Shell.Screenshot`; Wayland wlroots → `grim`. Guarda el PNG en `data/desktop/captures/<ts>.png` (`capture.js`: FIFO de 20 y, si hay `convert`, ancho máx. 1920 px) y devuelve `{path, width, height, bytes, tool, ts}`. En Wayland `windowId` no es posible (501); `target:'window'` sin id captura la ventana activa. `available()` añade `captureTool` (la herramienta que se usaría) y, si no hay ninguna, la lista en `missing`; capturar sin herramienta da 503 «falta una herramienta de captura para x11: instala …». `fake` devuelve `server/desktop/fake.png`.

**Tools del Guide (FT-22)**: `window.getActive`, `window.list` y `screen.capture` (política `read`, en `server/guide/tools.js`) delegan en este provider. Regla «solo fuera»: si la ventana activa casa con «FlowTest», «AgentOffice» o el origen de la UI (`localhost:<puerto>`), devuelven `{inside: true, hint: 'usa app.getContext'}` sin datos del escritorio (y `screen.capture` ni pide confirmación). `window.list` recorta los títulos a 200 caracteres; `screen.capture` devuelve ruta y metadatos, nunca el base64. `screen.capture` usa el modo `confirmOnce` de `server/guide/policy.js`: la primera vez por sesión abre el modal 🛡 Sí/No (`questions.confirm`). La clave de sesión es el `chatId` del Guide (cabecera `x-ao-chat`, que `bin/ao-mcp.mjs` envía desde `AO_CHAT_ID`) o, por API/MCP, `x-ao-client`; se recuerda solo en memoria (se olvida al reiniciar) y, sin ninguna clave, se pregunta siempre. Rechazar → 403 auditado como `denied` en `guide-audit.jsonl`.

**`screen.describe` (FT-23)**: último recurso (la descripción de la tool manda al Guide a usar antes `window.getActive` / `app.getContext`). Política `read` con el mismo `confirmOnce` que `screen.capture` (la clave de sesión es compartida: confirmar una vale para la otra). Captura el escritorio, o usa `capturePath` de una captura previa (solo PNG dentro de `data/desktop/captures/`), y la describe con el proveedor del Guide (`server/guide/vision.js`, por `fetch`): `anthropic-api` (bloque `image` base64) u `openai-api` (`image_url` con data URL), con el modelo de `guideModels`. `claude-cli` y `fake` responden 501 «el proveedor actual no admite imágenes» (antes de capturar o preguntar); `fake` con `AO_DESKTOP=fake` devuelve una descripción fija. Si la ventana activa es flow-test/AgentOffice responde `{inside: true, hint: 'usa app.getContext'}` sin llamar al modelo. Argumento opcional `question`. Devuelve `{description, capturePath, provider, model}`.

**e2e de escritorio (FT-24)**: `node scripts/desktop-e2e.mjs` (37 checks con el provider fake; `--real` además llama a getActive/list/capture contra el escritorio real y solo informa). Variables de prueba: `AO_DESKTOP_FAKE_ACTIVE=<título>` (el fake finge esa ventana activa, p. ej. «AgentOffice» para la regla «solo fuera») y `AO_DESKTOP_PLATFORM=darwin|win32` (simula otra plataforma → 501).

**Aplicaciones (FT-31)**: `server/desktop/apps.js` lee los `.desktop` de `/usr/share/applications`, `/usr/local/share/applications`, `~/.local/share/applications` y los exports de flatpak, y el provider expone `listApps()` → `[{id, name, exec}]` (sin `NoDisplay`/`Hidden`; el `id` es el nombre del fichero sin `.desktop`) y `openApp({id})`, que lanza con `gtk-launch <id>` (o `gio launch <id>.desktop`) desacoplado, sin shell ni argumentos libres. Tools del Guide: `application.list` (`read`) y `application.open` (`execute`, sujeta a `guidePolicy.execute`; queda en `guide-audit.jsonl`). Solo acepta un `id` de la lista: un id con formato raro o inexistente → 400 («entrada no válida»); AgentOffice, flow-test y terminales → 403; cualquier argumento extra (p. ej. `exec`) → 400 «Argumento desconocido». Se valida antes de pedir confirmación. `fake.js` simula gedit, firefox, Calculadora, un terminal, AgentOffice y flow-test, y registra los lanzamientos (`launchedApps()`).

**AT-SPI y tools `ui.*` (FT-29)**: actuar por semántica en apps de fuera, sin píxeles. `server/desktop/atspi.js` (sin dependencias npm: `python3 -c` con `pyatspi` vía `execFile`, timeout 3 s) añade al provider `a11yAvailable()` → `{ok, missing[]}`, `uiTree({pid|windowId, depth≤6, maxNodes≤500})`, `uiFind({pid|windowId, role?, name?})`, `uiNode(ref)` y `uiAct({ref, action:'click'|'press'|'focus'|'setText', text?})`. Los nodos son `{ref, role, name, states[], actions[], bounds}`; el `ref` es `<pid>:<i.j.k>` (estable mientras la app no reestructure su UI). Sin `pyatspi` → 503 con `missing` (también en el cuerpo JSON); fuera de Linux → 501. El fallback con `gdbus` (`org.a11y.Bus`) **no** está implementado. `fake.js` simula un árbol (botones «Guardar» y «Eliminar», campo de texto «Nombre») y guarda las acciones en memoria (`uiActions()`).
Tools del Guide (`tools.js`): `ui.getTree` y `ui.find` (política `read`) y `ui.act` (`execute`), las tres con `precheck` «solo fuera»: si la ventana activa, o la del pid/windowId/ref objetivo, es flow-test/AgentOffice responden `{inside: true}` (nunca se actúa sobre nuestra UI). Si el nombre o el rol del control coincide con `DESTRUCTIVE_WORDS` (eliminar, borrar, delete, remove, enviar, send, pagar, comprar, confirmar, aceptar…, por prefijo y sin acentos), `ui.act` pasa a `irreversible` por llamada (`tool.dynamic`): confirmación SIEMPRE, con app, control y acción en el modal, y el audit registra `policy:'irreversible'` y `confirmed`. Para el resto, `policy:'execute'` (según `guidePolicy`).

**Fallback de entrada: ratón y teclado ciegos (FT-30)**: último recurso, **desactivado de serie**. Se enciende con el interruptor de Ajustes ▸ 🛡 Guide Agent, que guarda `settings.guideInputFallback` (booleano, `false`); se lee/escribe junto a la política del Guide (`getPolicy()`/`setPolicy({guideInputFallback})`, snapshot `guidePolicy.guideInputFallback`, `POST /api/settings {guideInputFallback:true}`). El provider añade `inputAvailable()`, `click({x,y,button,double})`, `scroll({x,y,dx,dy})`, `type({text})` y `keyPress({keys:'ctrl+s'})` (`server/desktop/input.js` construye los comandos): `xdotool` en X11, `ydotool` en Wayland; si falta el binario, 503 con `missing`; `fake.js` los registra en memoria (`inputs()`). Tools `mouse.click`, `mouse.scroll`, `keyboard.type` y `keyboard.keyPress` (política `execute`, descripción «ÚLTIMO RECURSO: antes ui.find/ui.act»): con el ajuste apagado responden 403 «fallback de ratón/teclado desactivado en Ajustes»; con `precheck` «solo fuera» devuelven `{inside:true}` sin tocar nada si la ventana activa es flow-test/AgentOffice. `keyboard.keyPress` pasa a `irreversible` (confirmación siempre) con los atajos de `IRREVERSIBLE_KEYS` (`enter`, `ctrl+w`, `ctrl+q`, `alt+f4`, `shift+delete`, `delete`, `ctrl+enter`). `keyboard.type` nunca guarda el texto en `guide-audit.jsonl` (solo `{chars:n}`; hook `auditArgs` de la tool); el modal de confirmación sí lo muestra si `guidePolicy.execute='confirm'`. Sin probar con xdotool/ydotool reales.

**Interruptor, prompt y modal (FT-32)**: Ajustes ▸ 🛡 Guide Agent muestra «Permitir ratón y teclado (último recurso)» (apagado de serie; persiste vía `POST /api/settings {guideInputFallback}`) y, si `inputAvailable()` indica que faltan `xdotool`/`ydotool`, una línea de ayuda (snapshot `guidePolicy.input = {ok, missing}`, en caché 30 s). `server/guide/prompt.js` documenta el orden de preferencia (API interna → integraciones FT-10 → `ui.find`→`ui.act` → `application.open` → `mouse.*`/`keyboard.*`) y que lo irreversible siempre pide confirmación. El modal `confirm` reutiliza `context` y muestra App/Control/Acción en `ui.act`, `keyboard.keyPress` y `application.open`.

**e2e de computer use (FT-33) y documentación (FT-34)**: `node scripts/computer-use-e2e.mjs` levanta servidores temporales (`AO_DATA_DIR`/`HOME` desechables, `AO_DESKTOP=fake`, Guide fake; ventana activa normal, «AgentOffice» y «flow-test») y comprueba las 9 tools (`ui.getTree`, `ui.find`, `ui.act`, `application.list`, `application.open`, `mouse.click`, `mouse.scroll`, `keyboard.type`, `keyboard.keyPress`), sus políticas, el interruptor apagado de serie (403), las confirmaciones irreversibles, el `{inside:true}` y que `guide-audit.jsonl` no guarda el texto tecleado (65 checks). La guía completa (orden de preferencia, dependencias y códigos 501/503/403) está en el flow `flowtest/arquitectura-guide` y en `flowtest/guide-escritorio.md`, sección «Computer use (Fase 6)».

Prueba: `node -e "import('./server/desktop/index.js').then(async m=>{const p=m.getProvider();console.log(p.session,p.available(),await p.getActive(),(await p.list()).length)})"`.

## 🌐 Navegador del agente: visión general (FT-120)

El Guía y los agentes pueden **manejar un navegador** (abrir webs, leer, rellenar formularios, capturar), al estilo «Claude en Chrome» pero dentro de AgentOffice. Dos fases con el **mismo contrato de tools `browser.*`**:

| | Fase A · Chromium dedicado (FT-114) | Fase B · Extensión MV3 «Mi navegador» (FT-118) |
|---|---|---|
| Qué controla | Un Chromium propio, con perfil persistente en `data/browser/profile`, vía CDP (`puppeteer-core`) | Tu Brave/Chrome real, con tus sesiones, mediante una extensión emparejada |
| Cuándo | Por defecto; automatizar sin tocar tu navegador | Cuando necesitas tus logins o Chrome 136+ (no deja depurar el perfil por defecto) |
| Límite | Cloudflare, captchas y login de Google detectan la automatización | Solo actúa en las pestañas que le cedes |

No se usan iframes: `X-Frame-Options`/CSP lo impiden; la vista 🌐 es un vídeo del navegador (FT-117).

**Elegir modo:** Ajustes ▸ Navegador del agente (`settings.browserMode`: `dedicated` | `extension`). `AO_BROWSER=fake` solo existe para los tests. Variables `AO_BROWSER_*`: ver la subsección FT-114.

Subsecciones: [driver CDP (FT-114)](#-navegador-del-agente--driver-cdp-ft-114) · [tools `browser.*` (FT-115)](#tools-browser-del-guía-y-de-los-agentes-ft-115) · [seguridad (FT-116)](#-seguridad-del-navegador-del-agente-ft-116) · [panel en vivo (FT-117)](#-navegador--panel-en-vivo-ft-117) · [extensión (FT-118)](#-navegador-del-agente--extensión-mv3-mi-navegador-ft-118).

Guía de uso para el usuario: `~/JksDocs/workspace/flowtest/guide-navegador.md`. Informe QA: `qa-navegador/INFORME-FT-119.md`. Arquitectura: nota Mermaid en el flow `flowtest/arquitectura-guide`.

## 🌐 Navegador del agente — driver CDP (FT-114)

Fase A de la épica «Navegador del agente»: `server/browser/` con un contrato `BrowserDriver` (documentado en `index.js`) y dos implementaciones: `cdp.js` (Chromium/Chrome/Brave dedicado por CDP con `puppeteer-core`, que se importa en el primer `launch()`) y `fake.js` (`AO_BROWSER=fake`, sin Chromium). `getDriver()` devuelve la instancia compartida única.

- **Perfil persistente** en `data/browser/profile` (las sesiones iniciadas sobreviven); `close()` y el cierre por inactividad (`AO_BROWSER_IDLE_MS`, 15 min) no lo borran.
- **Visible** por defecto si hay escritorio; headless con `AO_BROWSER_HEADLESS=1` (o sin `DISPLAY`). `AO_BROWSER_PATH` fuerza el binario; `AO_BROWSER_NO_SANDBOX=1` (automático como root).
- `snapshot()`: árbol de accesibilidad compacto (incluye iframes) con refs estables por pestaña (`e12`) `{ref, role, name, value, states}`; tope `AO_BROWSER_SNAPSHOT_NODES` (300) con `truncated`/`omitted`. `act`/`type`/`scroll` resuelven la ref por CDP (`backendNodeId`) y caen a `x,y`.
- `screenshot()` ≤1280 px de ancho en `data/browser/captures`; `console()`/`network()` con anillo de 200 por pestaña y cabeceras sensibles a `***`; solo se navega a `http(s)`.
- Los popups pasan a ser la pestaña activa. Prueba: `node scripts/browser-driver-e2e.mjs`.
- Las tools `browser.*` ya existen (FT-115, abajo). Pendiente: `puppeteer-core` sigue en `devDependencies`; moverlo a `dependencies` cuando se despliegue a usuarios.

### Tools `browser.*` del Guía y de los agentes (FT-115)

Las 16 tools exponen el driver (`browser.requestHuman` es de FT-116; `browser.upload`, de FT-130): `browser.tabs`, `navigate` (url o back/forward/reload), `snapshot`, `find` (rol y/o texto), `click`, `type`, `select`, `scroll`, `press`, `waitFor`, `screenshot`, `console`, `network` y `evaluate`. `browser.open` (xdg-open) sigue siendo «enseñar una web al usuario en su navegador normal».

- **Flujo guiado por las descripciones**: `snapshot` primero (texto, barato), actuar siempre por `ref`, `screenshot` solo si hace falta ver el aspecto.
- **Política**: lectura (`tabs`, `snapshot`, `find`, `waitFor`, `screenshot`, `console`, `network`) automática; `navigate`/`scroll` = navigate; `click`, `type`, `select`, `press` = execute (ajuste del Guía); `evaluate` = write (confirma). **Irreversible, confirma siempre**: `click` sobre un control destructivo (mismas palabras que `ui.act`), `type` con `submit` y `press` de Enter/Delete. El texto de `browser.type` nunca va al audit (solo `chars`).
- **Solo fuera**: navegar o actuar con la pestaña activa en AgentOffice o flow-test responde `{inside:true}` sin tocar nada.
- **`browser.screenshot` devuelve la imagen**: por MCP, `bin/ao-mcp.mjs` la entrega como contenido `type:image` (base64) además del texto con la ruta, así que Claude la ve (con claude-cli sustituye al 501 de `screen.describe`); por `POST /api/guide/tool` solo la ruta.
- **Agentes worker**: la capacidad `browser` (`server/engines/toolscope.js`) está activa para los roles `qa-suite` y `office-flowtest` (otro rol la activa con `tools: …, browser` en su frontmatter; nunca en modo plan). `claude.js` les añade un MCP stdio `agentoffice-browser` con `AO_MCP_ONLY=browser`: solo ven `browser_*` (sin `browser_open`); política y auditoría siguen en el servidor. Solo motor Claude.
- Prueba: `node scripts/browser-tools-e2e.mjs` (driver fake, MCP real); con `AO_E2E_REAL_BROWSER=1` repite lo esencial con Chromium real.

### 📝 Formularios robustos y envíos que se envían (FT-130)

Nació de la demo sobre `httpbin.org/forms/post`: el agente rellenó todo y pulsó «Submit order», pero la página seguía en el formulario (la hora `min/max` era inválida y nadie lo dijo).

- **`browser.type` / `select` según el tipo de campo** (driver CDP, sin `browser.evaluate`): `date`, `time`, `datetime-local`, `month`, `week`, `range`, `color` (valor en formato nativo, p. ej. `2026-10-08T14:30`; si el navegador lo rechaza → 400 con el formato esperado), `<select>` nativo y `multiple` (varias opciones con «|», p. ej. `Bacon|Onion`; si no existe lista las disponibles), checkbox/radio (`true`/`false`), `contenteditable`, texto (`Input.insertText`, añade al final o `clear`). Siempre dispara `input`/`change`. Funciona también si el ref es un `spinbutton` interno de un `<input type=date>`.
- **`browser.upload({ref, paths})`**: `DOM.setFileInputFiles` en un `<input type=file>`; las rutas deben estar en `data/uploads` (adjuntos del chat o de la tarea), si no → 400. Pide la confirmación de `execute`. Con la extensión «Mi navegador» responde 501 (pendiente).
- **Resultado de click / type / press**: `{navigated, url, title}`. Espera la navegación o un cambio del DOM (hasta 5 s si el control es de envío: botón submit o enlace; 300 ms en el resto, para no frenar clics normales).
- **Envío que no se envía**: si tras pulsar enviar (clic en submit, Enter o `submit:true`) no hubo navegación y el formulario es inválido, el resultado trae `submitted:false`, `validation:[{field, type, message}]` (`form.checkValidity` + `validationMessage` de cada campo inválido) y una `hint`.
- Prueba: `node scripts/browser-forms-e2e.mjs` (Chromium headless real: todos los tipos, el HTML de httpbin servido en local —se rechaza la hora fuera de rango y, corregida, se envía— y validación por Enter).

### 🌐 Navegador: tarea abierta, paridad con «Claude in Chrome» (FT-132)

Para pedir cualquier cosa y que el Guía se mueva solo (el prompt tiene un modo «tarea abierta»: planifica, ejecuta seguido salvo 🛡, se recupera de errores, **verifica antes de dar por terminado** y en tareas de navegador usa solo `browser.*`):

- **`browser.readPage`** `{selector?, offset?, max?, section?}`: texto legible (encabezados `#`, listas `-`, filas `a | b`; `<pre>`/JSON tal cual), paginado. Devuelve `total`, `next`, `sections` y, si recorta, `truncated`+`hint`. No hace falta `evaluate` (que pide 🛡) para leer.
- **`browser.find {query}`**: lenguaje natural («el botón de añadir al carrito») sobre el snapshot → refs candidatos ordenados.
- **Coordenadas sobre la captura**: `browser.click {x,y,shot:true}` (+ `rightclick`, `dblclick`, `hover`, `drag` con `toX,toY`/`toRef`) y `browser.scroll {x,y,shot}` usan píxeles de la última `browser.screenshot`, incluso con zoom (`region:{x,y,w,h}`, escala ≤2). Pulsar así un botón de envío o destructivo también pide 🛡.
- **Esperas inteligentes**: act/type(Enter)/navigate/back/forward/reload/scroll devuelven `settle:{networkIdle,domStable,waitedMs}` (red en reposo + DOM estable; tope `AO_BROWSER_SETTLE_MS`, 3 s).
- **Coste**: `browser.snapshot {diff:true}` devuelve solo los cambios (`mode:'diff'`, líneas `+`/`- desaparecen:`); `browser.screenshot {detail:'low'}` = JPEG ≤800 px. `settings.guideBrowserMaxUsd` (por defecto 1 $, 0 = sin tope; `POST /api/settings`) limita cada petición: al llegar avisa y para (`done.capped`). El evento `done` lleva `browser:{calls,costUsd,usage,maxUsd,capped,ms}` y el panel 🌐 muestra «💸 Última petición». Sin límite de pasos.
- Límites: la extensión «Mi navegador» no soporta `region`/`detail` ni `settle`. El coste es una estimación por tokens (claude-cli solo da el real al final).

### 🛡 Seguridad del navegador del agente (FT-116)

- **Dominios** (`settings.browserPolicy = { default: 'ask'|'allow'|'block', domains: { 'dominio': 'allow'|'block'|'ask' } }`, Ajustes ▸ 🌐 Navegador del agente, o `POST /api/settings {browserPolicy}`; módulo `server/browser/policy.js`). `block` gana a todo; subdominios heredan la regla. Sin regla: **pregunta 🛡 la 1.ª vez por dominio y sesión** (en memoria; «Sí» lo recuerda hasta reiniciar). `file://`, `chrome://`, `about:` (salvo `about:blank`), `data:`… se bloquean siempre; `localhost`, `127.x`, redes privadas y hosts sin punto, salvo que su host esté como `allow` explícito. Se aplica a `navigate` y `tabs new` (por la URL pedida) y a **todas** las tools sobre la pestaña activa (una redirección o un clic a un dominio bloqueado hace que la siguiente llamada responda 403). El rechazo es 403.
- **Irreversible = confirma siempre**: además de lo de FT-115, `click` sobre un botón en una página con campo de contraseña/tarjeta (nombre tipo contraseña, card, iban… o estado `protected`) y **`browser.evaluate`, siempre** (aunque `guidePolicy` esté en automático).
- **Datos no confiables**: `snapshot`, `find`, `console`, `network` y `evaluate` devuelven `untrusted:true` + `aviso` («DATOS NO CONFIABLES…»); el texto del snapshot va entre `<<<DATOS_WEB_NO_CONFIABLES … >>>`. El prompt del Guía repite la regla.
- **Handoff** `browser.requestHuman({motivo})`: lista la petición en el panel 🌐, pasa el control al usuario (el agente queda en pausa, sus acciones dan 409), lanza una pregunta 🛡 «Listo»/«Cancelar» (campana y barra de preguntas) y, al responder, devuelve el control: `{done:true}` con «Listo»; `{done:false, cancelled|timeout}` si no. Caduca a los 10 min.
- **Auditoría** (`guide-audit.jsonl`): cada `browser.*` registra `page` (URL sin query/hash), acción, `ref` y resultado (también los 403 por dominio). Nunca el texto tecleado (solo `chars`) ni expresiones de `evaluate` que mencionen contraseñas/tokens.
- Prueba: `node scripts/browser-policy-e2e.mjs`.

#### 🔑 Contraseñas que da el usuario (FT-137)

Antes (FT-116) el agente nunca tecleaba contraseñas. Ahora, si **en la conversación con el Guía** le das usuario y contraseña de una web, `browser.type` puede teclearla:

- **🛡 siempre**: en un campo de contraseña (estado `protected`, o nombre tipo contraseña/password/clave/pin) pregunta «¿Escribir la contraseña en «dominio» (campo X)?» con el valor enmascarado (`••••••`). Con «No» no se teclea y el error ofrece `browser.requestHuman`.
- **Solo si la diste tú en ESTE chat**: el servidor comprueba que el valor está en un mensaje tuyo de esa conversación (`server/guide/secrets.js`); una contraseña leída en una página, de otro chat o de un agente de tarea (sin chat) → 403 sin preguntar. El prompt del Guía lo dice y le prohíbe repetirla.
- **Sin eco**: `guide-audit.jsonl` solo guarda `chars`; la 🛡 y el tool_call del SSE/chat guardado llevan `••••••`; el valor se sustituye por `••••••` en el chat guardado (incluido tu propio mensaje), en las respuestas del Guía y en los resultados; `browser.snapshot` nunca devuelve el valor de un campo de contraseña. El Activity Stream ya no llevaba argumentos de tools MCP. Límite: el primer evento SSE `chat` (título = inicio de tu mensaje) y el transcript propio de `claude -p` en `~/.claude` no se pueden enmascarar.
- **Tarjetas y pagos** (número, CVV, IBAN, cuenta bancaria): `browser.type` da 403 → `browser.requestHuman`; no se teclean.
- Prueba: `node scripts/browser-password-e2e.mjs` (driver fake; `AO_BROWSER_FAKE_TRACE=fichero` vuelca lo tecleado, solo para tests). El escenario 8 del bench (`scripts/browser-bench.mjs`, login local con credenciales del prompt) pasa a éxito si inicia sesión, con la 🛡 contestada por el script.

## 🌐 Navegador — panel en vivo (FT-117)

> **FT-135 · espera integrada**: si el usuario tiene el control, las acciones del agente (`click`, `navigate`, `waitFor`…) **esperan** a que lo devuelva en vez de dar 409 al instante (hasta `AO_BROWSER_WAIT_CONTROL_MS`, 120 s por defecto). Si vence: 409 con `retryAfterMs` y mensaje claro. El panel muestra «el agente espera a que le devuelvas el control» (`browser.waiting` en el snapshot).

Vista **🌐 Navegador** (menú lateral, `?view=browser` y `app.navigate view=browser` del Guía): lo que ve el navegador dedicado del agente, en directo.

- **Vídeo**: `driver.screencast(onFrame)` (CDP `Page.startScreencast`, JPEG, ≤10 fps, sigue a la pestaña activa) → SSE `GET /api/browser/stream` (`frame`, `mark`, `control`). Solo está abierto mientras la vista se ve; sin espectadores el screencast se para. El estado (control, pestañas, URL, handoffs) va en el snapshot SSE (`browser`).
- **Barra**: quién controla (🤖 agente / 🧑 tú), atrás/adelante/recargar, URL, pestañas (seleccionar, cerrar, ＋), «Abrir/Cerrar navegador».
- **Tomar el control** (`POST /api/browser/control {mode:'user'|'agent'}`): el agente queda en pausa y tus clics, rueda y teclas sobre el fotograma se reenvían (`POST /api/browser/input`), como en el modo Live de flow-test. «Devolver al agente» lo reanuda. Sin el control, la entrada responde 409.
- **Marca**: `panel.agentDriver()` es el driver que deben usar las tools `browser.*` (A2): lanza 409 mientras controla el usuario y, antes de `act`/`type`/`scroll`, pinta 1 s un rectángulo sobre el ref (`driver.box()`).
- **Handoff (A3)**: el panel lateral lista `browser.handoffs` (`panel.addHandoff({reason})` / `resolveHandoff(id)`); los genera `browser.requestHuman` (FT-116). «Tomar el control» desde la petición.
- Responsive: ≤760 px el panel lateral pasa bajo la imagen.
- Prueba: `node scripts/browser-panel-e2e.mjs [--real] [dir-capturas]` (driver fake por defecto; `--real` con Chromium headless). Capturas en `docs/FT-117/`.

## 🧩 Navegador del agente — extensión MV3 «Mi navegador» (FT-118)

Fase B: la carpeta `extension/` es una extensión Manifest V3 (Chrome/Brave, carga desempaquetada; instalación en `extension/README.md`) que cumple el **mismo `BrowserDriver`** con `chrome.debugger` sobre las pestañas del usuario.

- **Ajustes ▸ Navegador del agente**: «Chromium dedicado» (FT-114, por defecto) o «Mi navegador (extensión)» (`settings.browserMode`, `POST /api/settings`). `getDriver()` devuelve el driver elegido; `AO_BROWSER=fake` sigue ganando (tests). El snapshot SSE trae `browser: { mode, ext: { connected, paired, tabs, pairing } }`.
- **Emparejamiento**: `POST /api/browser/pair` da un código de 8 caracteres de un solo uso (5 min). La extensión lo manda en su `hello` por `ws://127.0.0.1:7420/api/browser/ext` y recibe una clave que guarda solo en `chrome.storage.session`; el servidor guarda su hash SHA-256 en `data/browser/ext.json`. `POST /api/browser/forget` la invalida. El upgrade solo se acepta desde loopback y sin `Origin` web; no usa el token `x-ao-token`.
- **Pestañas cedidas**: el agente solo actúa en las que el usuario cede con «Dejar al agente esta pestaña» (grupo morado «AgentOffice»); sin ninguna, las operaciones dan 503. El banner de depuración de Chrome es esperado.
- `server/browser/ws.js` (WebSocket RFC 6455 mínimo, sin dependencias) y `server/browser/extension.js` (hub + driver; las URL se validan también en el servidor y las cabeceras sensibles se enmascaran de nuevo).
- **Panel en vivo (FT-117) con la extensión**: `panel.js` usa `getDriver()`, así que sirve con ambos modos. El snapshot `browser` combina `browserPanel.status()` con `mode`, `modes` y `ext`. `chrome.debugger` no da screencast fiable: el driver de la extensión degrada `screencast()` a capturas JPEG ~1 fps y expone `box()` para la marca del agente.
- Prueba: `node scripts/extension-e2e.mjs` (cliente WebSocket que simula la extensión, y servidor real para pair/Ajustes/snapshot).
- Pendiente: las tools `browser.*` con política (A3) todavía no existen en esta rama; cuando lleguen usarán `getDriver()` y se aplicarán igual a ambos modos. La extensión real solo se ha comprobado con `node --check`: falta la prueba manual en Brave.

## Estructura

```
server/index.js     HTTP + API REST + SSE (/events)
server/team.js      proyectos, agentes, tareas, planificador, revisión
server/events.js    Activity Stream tipado (FT-1)
server/context.js   contexto de la UI para el Guide Agent (FT-2)
server/guide/       Guide Agent: tools + política + auditoría (FT-4), chats, prompt y proveedores (FT-6), voz STT en stt/ (FT-9) y TTS en tts/ (FT-52), integraciones IDE/git/fs/terminal/browser (FT-10), visión de pantalla en vision.js (FT-23)
server/engines/allowlist.js  lista blanca de shell compartida por el motor Claude y terminal.execute (FT-10)
bin/ao-mcp.mjs      servidor MCP stdio del Guide (FT-4)
bin/stt-whisper.py  STT local con faster-whisper (FT-9)
server/desktop/     DesktopProvider: ventana activa/lista/captura, linux X11+Wayland GNOME, fake (FT-20); capture.js guarda capturas (FT-21)
server/review.js    revisión visible y automática: política, checks, ficheros sensibles, veredicto (FT-56)
server/git.js       worktrees, commit, diff, merge, estado frente a la base y actualizar con ella (FT-19)
server/engines/     demo · claude · codex (+ describe.js: herramienta → frase del bocadillo)
public/office3d.js  la oficina 3D (three.js + Kenney): sala con personajes y, desde FT-46, el edificio con una planta por proyecto (navegación edificio ↔ planta en app.js, FT-47)
public/app.js       tablero, equipo, panel del agente, diálogos
data/state.json     estado (gitignored)
```

## Límites conocidos del MVP

- Solo local: lanza procesos con tus permisos (escucha en 127.0.0.1).
- Codex hereda los MCP de `~/.codex/config.toml`.
- El QA trabaja sobre la rama base, así que solo ve lo que ya has aprobado (por eso depende de esas tareas).
- Sin tope de gasto todavía: se muestra el coste por tarea (Claude) pero no se corta.

## La oficina

Oficina **3D isométrica** (`public/office3d.js`: three.js + modelos glTF de Kenney, personajes animados, etiquetas HTML proyectadas).

Para verla sin navegador (y para que un agente pueda ver lo que pinta): `node scripts/preview.mjs out.png --wait 15000` levanta un servidor temporal con un equipo demo (si el workspace de flow-test aún no ha dado proyectos, crea el demo), captura la oficina con Chrome headless (WebGL por SwiftShader) e imprime los errores de consola y los fps. `--full` captura la página entera, `--building` el edificio (3 proyectos con equipo y 1 sin él; con varios equipos la Oficina abre ya como edificio) y `--building --floor Facturación` entra en esa planta con un clic antes de capturar (FT-47).

FT-72 remata la Oficina para tamaños reales y embebidos: de 1024 px a pantallas anchas el canvas mantiene el encuadre con `ResizeObserver`; en móvil el modo `building` degrada a una lista accesible de plantas con contadores. El canvas lleva etiqueta ARIA, foco visible y navegación por teclado (`Tab`/`Enter` entre plantas o agentes, `Esc` para subir de agente → planta → edificio). La ficha del agente es un diálogo con etiqueta ARIA y su actividad reciente filtra los cierres ruidosos de herramientas: solo se ven inicios y fallos (`⚠ falló: …`). `debugState().metrics` expone `fps`, `lastRebuildMs` y `lastFloorCount` para medir el coste con 12 plantas y 12 agentes.

### El edificio (FT-46)

La misma clase `Office3D` tiene dos modos: **`floor`** (la sala de siempre: el proyecto activo con sus personajes) y **`building`**: el **edificio** de la empresa, **una planta por proyecto con equipo** (≥ 1 agente fichado en `project.team`; los proyectos sin trabajadores no se dibujan). Planta baja = proyecto más antiguo (`createdAt`), arriba los nuevos; tope visual de 12 plantas (con más, las restantes se agrupan en una planta «+N proyectos» que no se abre). Sin personajes: cada planta es losa + fachada con los mismos muros `wall`/`wallWindow` de la sala (caras que ve la cámara), interior oscuro y azotea con terraza en la última; las **ventanas se encienden** (emissive, como las pantallas) según el nº de agentes trabajando, la fachada se apaga a gris si el proyecto está parado y cada planta lleva una etiqueta HTML «nombre · N trabajando · M en cola · ✋ K en revisión» con ⏸ delante si `running=false`. Pasar el ratón resalta la planta (emissive suave + cursor pointer) y el clic llama a `onFloorClick(projectId)`, con el que `app.js` entra en esa planta (FT-47).

- **API**: `office.setMode('building'|'floor')`; `office.update({agents, tasks, roles, title, selected, projects, allAgents, allTasks, projectId})` (`app.js` pasa `S.projects`, `S.agents`, `S.tasks` y el proyecto activo; el modo `floor` sigue usando solo `agents`/`tasks` del proyecto activo). La cámara isométrica encuadra la caja que toque (`frameCamera(aspect, [x, y, z])`): la sala o `[RX, nPlantas·FLOOR_H, RZ]`; `resize()` vale en ambos modos.
- **Rendimiento**: las plantas se reconstruyen solo cuando cambia su firma (proyectos con equipo + contadores), nunca por frame; en el edificio no se instancian personajes ni sombras.
- **QA**: `canvas.dataset.officeMode` (`building`|`floor`), `canvas.dataset.officeLevel` (`building`|`floor`|`agent`) y `window.aoOffice.debugState()` → `{mode, officeLevel, activeProjectId, hoverFloor, animating, actors, metrics, zones, slots, floors:[{projectId, name, working, queued, review, failed, running, screen:{x,y,w,h}}]}` (`screen` = rectángulo de la planta en px del viewport en modo edificio, para hacer clic en ella; FT-48/FT-72). Prueba: `node scripts/building-e2e.mjs [captura.png]` (Chrome headless: edificio, navegación, agente, contadores, métricas y cero errores de consola).

### Edificio ↔ planta (FT-47)

La Oficina **abre como edificio** y se entra y se sale de cada planta:

- **Entrar**: clic en una planta (la etiqueta «+N proyectos» no se abre) → el desplegable pasa a ese proyecto y la oficina enseña su sala (`floor`) con una transición corta de cámara (≤ 400 ms del encuadre del edificio al de la sala; ninguna con `prefers-reduced-motion`). También entran directo a la planta de un proyecto `app.navigate {view:'office', projectId}` del Guide (sin `projectId` respeta el modo que haya) y `flowtest.show` cuando el flow vive en la carpeta de un proyecto (`folder`), igual embebido en flow-test que suelto.
- **Volver**: botón **🏢 Edificio** del pie de la vista (miga «🏢 Edificio › proyecto»; en el edificio el pie resume «N proyectos con equipo · M trabajando») o **Esc** con el canvas enfocado (un clic en la oficina lo enfoca; si hay un cajón de agente abierto, Esc cierra antes el cajón, como siempre). Embebido en flow-test, Esc solo cierra el panel cuando no hay planta de la que salir.
- **Modo por defecto y memoria**: al abrir la pestaña Oficina se aplica el último modo (`localStorage ao:officeMode`, `building` de serie); si solo **un** proyecto tiene equipo se entra directo a su planta (el botón Edificio sigue disponible). Cambiar el proyecto en el desplegable estando en `floor` cambia de planta; en `building` solo **resalta** la planta del proyecto activo (fachada con emissive suave y etiqueta con borde verde en negrita).
- **Guide**: `publishContext()` incluye `officeMode` (FT-2), así `app.getContext` sabe si el usuario ve el edificio o una planta. `?view=building` de FT-46 ya no existe (con varios equipos el edificio es el modo de serie).
- **Sin regresiones**: el clic en un personaje sigue abriendo su cajón en `floor`; las etiquetas de personajes, pizarra y plantas solo se ven en su modo (clase `building` en el contenedor de etiquetas); `resize`/`ResizeObserver` valen en ambos modos y, si llega en plena transición, la cámara acaba en el encuadre nuevo.

### Cambiar la geometría del edificio (FT-49)

Todo vive en `public/office3d.js` (constantes arriba del fichero):

- `RX`, `RZ` (13 × 9): dimensiones base de la sala; `recommendedFloorSize()` y `layoutFloor()` (`public/office-layout.js`) escalan a oficina compacta/media según nº de agentes. Mover mesas/mobiliario toca `DESK_COLS`/`DESK_ROWS`, `FURNITURE`, `BOARD`…
- `BASE_ZONE_STYLE`: zonas funcionales, color de alfombra y posición de placa en suelo (`labelX`/`labelZ`). Estados → posición: `working` usa zona por rol; `waiting` va a cola/Kanban; `reviewing` a Revisión; `failed` conserva el puesto visible con etiqueta roja; `idle` a Descanso.
- `SLAB_H` (losa) y `FLOOR_H = WALL_H + SLAB_H`: altura de una planta; la planta *i* se coloca a `i · FLOOR_H`.
- `MAX_FLOORS` (12): tope visual antes de agrupar en la planta «+N proyectos».
- `FLOOR_BOX = [RX, WALL_H, RZ]` y `frameCamera(aspect, [x, y, z])`: caja que encuadra la cámara (la sala en `floor`, `[RX, nPlantas·FLOOR_H, RZ]` en `building`). `CAM_MS` (380) es la duración de la transición.
- `WINDOW_ON`, `WALL_PAUSED`, `SLAB_COLOR`, `INTERIOR`, `HOVER`, `HOVER_K`, `ACTIVE_K`: colores e intensidades de ventanas encendidas, fachada parada, resalte bajo el ratón y planta activa.
- `frameAgentCamera()`: encuadre del nivel agente. Desde FT-72 desplaza el objetivo para descontar la ficha lateral (~440 px) y usa un zoom menos cerrado para ver el puesto y su zona.

Tras cambiar la geometría: `node scripts/building-e2e.mjs` y mirar `scripts/preview.mjs --building`. La documentación con diagrama y capturas está en el flow `flowtest/arquitectura-guide.flow.json` (nota «🏢 Edificio 3D», FT-49).

**Probarlo a mano** (3 proyectos, 2 con equipo): `npm start`, crea «Alfa» y «Beta» con un agente cada uno (Agentes ▸ Contratar) y «Vacío» sin equipo; en Oficina se ve el edificio con dos plantas y «Vacío» no sale. Clic en una planta → su sala y miga «🏢 Edificio › Beta»; botón o Esc (tras un clic en la oficina) → edificio. Cambia el desplegable estando en la sala (cambia de planta) y en el edificio (solo se resalta). Pide al Guía «llévame a la oficina de Beta» (`app.navigate`) y recarga la página para ver que recuerda el modo. Automático: `node scripts/building-e2e.mjs [captura.png]` (36 checks: lo anterior más `officeMode` en `/api/context`, el caso de un solo proyecto con equipo y cero errores de consola).

## Créditos

- 3D: [Kenney](https://kenney.nl) *Furniture Kit* y *Mini Characters* (CC0, `public/assets/3d/`), [three.js](https://threejs.org) (MIT, `public/vendor/three/`).

## 💸 Consumo de tokens de los agentes

Medido el 6 OCT 2026: lo caro no es el arranque (≈31k tokens con `--strict-mcp-config`) sino lo que se lee, porque cada turno reenvía todo lo leído, y el modelo (el alias `opus` del CLI resuelve al modelo más caro). Medidas:
- **Modelo por rol:** código con `sonnet`; documentación, QA y planificación con `haiku` (roles en `~/JksDocs/workspace/_agentes/roles/`).
- **Briefing por repo** (`server/briefing.js`): mapa generado con git (carpetas, ficheros grandes a leer por tramos, scripts, e2e, secciones de README/CLAUDE.md, últimos commits), cacheado por commit en `data/briefings/` e inyectado en cada prompt, para que el agente no explore.
- **Reglas de lectura en el prompt** (`economyBlock` en `team.js`): Grep + Read por tramos en ficheros grandes, sin releer, salidas recortadas, un e2e salvo fallo, una captura.
- **Tope de gasto por intento** (Ajustes, `maxTaskUsd`, 3 $; `claude --max-budget-usd`): al alcanzarlo la tarea NO falla, va a Revisión con «⚠️ tope de gasto alcanzado»; Devolver le da otro intento desde su rama.
- **Agente atascado (FT-62)** (`server/stuck.js`, Ajustes ▸ «Detectar agentes atascados»): sobre el stream que ya llega (`AgentToolStarted/Finished` y `t.usage`, igual con `claude`, `codex` y `auto`) detecta: la misma orden o lectura de fichero ≥3 veces sin editar nada entre medias (editar reinicia el contador), ≥4 errores de herramienta seguidos, 25 pasos sin editar en una tarea de código (rol `dev`), el mismo e2e/test fallando igual ≥3 veces y tokens por turno >80 k durante 4 turnos sin cambios en el worktree (`git status` + `git diff --stat`). Todos los umbrales se cambian en Ajustes. Acción escalonada: 1.ª señal → aviso en caliente de redacción neutra («Parece que das vueltas…; cambia de enfoque o termina con lo que tienes y explica qué te bloquea»; Claude por stdin, Codex/demo —sin entrada en caliente— reencolando la misma tarea con el aviso en el prompt); si la señal vuelve a saltar tras el aviso, se corta y la tarea va a Revisión con «⚠️ atascado: <señal>» (como el tope de gasto: lo hecho queda en la rama, `t.stuck`, evento `AgentBlocked {reason:'stuck', signal}`). Prueba: `node scripts/stuck-unit.mjs` (cada señal) y `node scripts/stuck-e2e.mjs` (`claude`/`codex` falsos que repiten una orden: aviso, corte y Revisión).
- **Esfuerzo** (Ajustes, `agentEffort`, medio; `claude --effort`).
- **Reanudar sesión** en reintentos de la misma tarea en su worktree si el anterior acabó hace <50 min (`claude --resume`, la caché de contexto aún vale).
- **Paridad Codex (FT-57)** — mismas medidas con `codex exec --json` (`server/engines/codex.js`); `team.js` pasa `budgetUsd`/`maxTokens`/`effort`/`resumeSession` a ambos motores (y con `auto`):

  | Medida | Claude | Codex |
  |---|---|---|
  | Esfuerzo (`agentEffort`) | `--effort` | `-c model_reasoning_effort="…"` + `-c model_reasoning_summary="concise"` |
  | Tope por intento | `--max-budget-usd` (lo corta el CLI) | el servidor lo calcula con el uso del stream (llega al cerrar cada turno): coste estimado con `CODEX_PRICES` (`usage.js`, **estimación**) ≥ `maxTaskUsd`, o tokens ≥ `maxTaskTokens` si está fijado (Ajustes; 0 = equivalente al de $, ≈ 7 M tokens para 3 $). Al superarlo `SIGTERM` al grupo → `{budgetHit:true}` → Revisión con aviso, igual que Claude |
  | Reanudar (<50 min, misma tarea y **mismo motor**) | `--resume <id>` | `codex exec … resume <thread_id> -` (el `thread_id` sale del evento `thread.started`) |
  | RTK (solo agentes, no planificación) | `--settings` con `rtk hook claude` + `RTK_RULES` | `-c features.codex_hooks=true -c hooks.PreToolUse=[…]` por línea de órdenes: **no se toca `~/.codex/config.toml`** ni hace falta `CODEX_HOME` temporal. El hook es `bin/ao-rtk-codex.mjs`, que ejecuta `rtk hook codex` y solo deja pasar la reescritura si es de `RTK_RULES` sin metacaracteres de shell (nunca `rtk run`); si no, se ejecuta el comando original. PATH con el directorio de `rtk` |

  Prueba: `node scripts/codex-economy-e2e.mjs` (codex y rtk falsos). ⚠️ **No verificado contra el `codex` real**: al desarrollar esto el entorno no permitió ejecutar `codex --help`/`rtk hook --help`; los nombres `exec resume`, `features.codex_hooks`, `hooks.PreToolUse` y `model_reasoning_summary` salen de la documentación conocida y deben confirmarse con `codex exec --help` / una pasada real de una línea. Los precios de `CODEX_PRICES` son una estimación.
- **Estimación** en las tarjetas de Por hacer / Backlog: mediana del coste de las últimas 10 tareas hechas del mismo rol (`costEstimates()`).
- **Afinidad de caché** (FT-64; Ajustes, `cacheAffinity`, activa por defecto): la caché de prompt dura ~5 min y dos tareas seguidas del mismo repo+rol+motor comparten el prefijo estable. `tick()` ordena las «Por hacer» como pausadas por cuota → prioridad → **la «caliente»** (repo+rol+motor igual a una en curso o terminada hace <5 min; con agente `auto` basta repo+rol) → la más antigua (`server/affinity.js`). Con `maxParallel` alto, además, no abre un repo distinto mientras haya otra tarea lista de un repo que ya está en marcha esperando agente (no hay starvation: se libera al acabar lo que corre). Es solo planificación, vale igual para `claude`, `codex` y `auto`; no usa flags nuevos. Prueba: `node scripts/cache-affinity-e2e.mjs` (motor demo). Medir el `cache_read_input_tokens` del primer turno de la 2ª tarea con y sin agrupado requiere ejecuciones reales de `claude`/`codex` (no hechas aquí).
- **RTK** (rtk-ai/rtk, Apache-2.0): si está instalado (`~/.local/bin/rtk` o `AO_RTK_BIN`; `AO_RTK=off` lo apaga), los agentes Claude arrancan con su hook PreToolUse por `--settings` (NO se toca `~/.claude/settings.json`) y se permiten solo los `rtk …` equivalentes a la lista blanca (`RTK_RULES`, nunca `rtk run`). Comprime salidas de git/grep/ls/lint; no las de Read/Grep nativos. `rtk gain` enseña el ahorro.
- **Índice de código por símbolos (FT-58)**, para Claude **y** Codex. Evaluado: **Codebase-Memory MCP** (DeusData, **MIT**, binario C único con tree-sitter, JS/TS/Java entre sus lenguajes, sin root, indexado incremental (`detect_changes`), herramientas `search_graph`, `trace_path`, `get_code_snippet`, `search_code`, `query_graph`, `get_architecture`, `detect_changes`…) frente a **jCodeMunch MCP** (Python/PyPI, licencia propia «dual-use», no permisiva; hace falta Python+uv). Elegido el primero por licencia e instalación (un binario). Los tiempos de indexado de agent-office/flow-test **no se midieron** (ver «Medición»).
  - Instalar: `scripts/setup-code-index.sh [vX.Y.Z]` (idempotente, con checksum, en `data/tools/bin/`; también se detecta `~/.local/bin/codebase-memory-mcp` o `AO_CODEINDEX_BIN`).
  - Índice por repo en `data/code-index/<repoKey>/` (`CBM_CACHE_DIR`), regenerado al arrancar una tarea si cambió HEAD (marca `HEAD` en el directorio; si falla, el agente sigue sin índice y queda un aviso en el log).
  - Conexión: Claude → segundo servidor `code-index` (stdio) en `--mcp-config` (sigue `--strict-mcp-config`) + `mcp__code-index` en `--allowedTools`; Codex → `-c mcp_servers.code_index.command/args/env`. El prompt añade una línea al briefing y una regla en `economyBlock` («para encontrar dónde está algo usa primero el índice; lee el fichero solo en el tramo que devuelva»).
  - **Ajustes ▸ «Índice de código por símbolos»** (`settings.codeIndex`): **apagado por defecto** — no se ha podido medir una mejora clara (ver abajo) y solo se puede encender si está instalado. `node scripts/code-index-e2e.mjs` verifica con binarios falsos el indexado por HEAD y los flags de ambos motores.
  - **Medición pendiente:** en el entorno de esta tarea el sandbox pide aprobación para ejecutar `codebase-memory-mcp`, `claude` y `codex`, así que no se pudo comparar tokens/coste con y sin índice (misma tarea pequeña, Sonnet y Codex, `t.usage`). Hazlo encendiendo el ajuste en una tarea y comparando el coste en el resumen antes de dejarlo activo.
  - Pendiente de verificar con el binario real: el argumento `repo_path` de `index_repository` y la sintaxis `-c mcp_servers.…env={…}` de Codex.

- **Herramientas por rol** (FT-59, `server/engines/toolscope.js`): cada definición de herramienta viaja en TODOS los turnos, así que cada rol recibe solo las suyas. Por `kind`: **dev** = lo de siempre; **docs** = Read/Grep/Glob/Edit/Write + shell de lectura (+ `git add/commit`) + MCP flow-test; **QA** = Read/Grep/Glob/Write (solo scripts de prueba, sin Edit) + shell de pruebas (npm/node/python3/curl/mvn…) + MCP flow-test; **planificador** = lectura + `ao-ask`. Nadie lleva WebFetch/WebSearch/NotebookEdit/Task. Un rol puede sustituirlas con `tools: Read, Grep, Bash, Bash(make *)` en su frontmatter (nombres de herramientas integradas; `Bash(patrón)` añade regla de shell). **Claude**: `--tools` (herramientas DISPONIBLES, sus definiciones no se envían) + `--allowedTools` (permitidas sin preguntar); la skill del rol añade `Skill`. **Codex**: `-c tools.web_search=false` siempre y `-c tools.view_image=false` en docs/planificador sin imágenes (Codex no permite elegir herramientas por nombre).
- **Prompt ordenado para la caché** (FT-59, `buildPrompt` en `team.js`): primero lo ESTABLE y siempre igual (system del rol por `--append-system-prompt`/inicio del prompt de Codex, carpeta, reglas, briefing del repo, memoria, cómo preguntar, `economyBlock`), después la marca `════════ TAREA` y lo VARIABLE (código, título, rama, descripción, contexto, restricciones, feedback, adjuntos, respuestas del cliente). Nada de fechas ni ids en la parte estable.
- **Medido el 6 OCT 2026** (`node scripts/tools-scope-measure.mjs`: primer `assistant` del stream, `input + cache_creation + cache_read`, haiku, prompt mínimo, sin MCP):

  | Rol | Antes (sin `--tools`) | Después | Ahorro |
  |---|---|---|---|
  | dev | 22 813 | 13 123 | 42 % |
  | QA | 22 813 | 12 683 | 44 % |
  | docs | 22 813 | 13 123 | 42 % |
  | planificador | 22 813 | 12 406 | 46 % |

  Codex no se midió (el binario real pide aprobación en este entorno): lo que reporte `turn.completed` en `usage` queda en la tarjeta de cada tarea. Prueba: `node scripts/tools-scope-e2e.mjs` (binarios falsos que vuelcan sus argumentos).
- **Cascada de modelos con escalado (FT-60)** — vale para `claude`, `codex` y `auto` (la escalera es la del motor que toque en cada intento). Código: `server/model-ladder.js` (lógica pura) + `modelFor()`/`escalate()` en `team.js`.
  - **Escalera por motor** (Ajustes ▸ «Escalera de modelos», `settings.modelLadder`): de serie Claude `haiku → sonnet` (opus solo a mano) y Codex `<mini/rápido que liste ~/.codex/models_cache.json> → gpt-5.5` (si la caché no trae ninguno, un solo peldaño: no hay cascada). Vacío = la de serie. El snapshot la publica en `modelLadders`.
  - **Cuándo sube un peldaño** (`t.escalations`, máximo 2): al «Devolver» desde Revisión (salvo si la cortó el tope de gasto: un modelo más caro no lo arregla), y cuando el agente termina con error (la tarea va a Fallidas ya escalada; «Reintentar» no escala otra vez). `escalate(t, motivo)` está exportada para enganchar la revisión automática de FT-56 cuando exista.
  - **Cuándo NO empieza abajo:** tareas `kind: plan` (empiezan en el peldaño alto), `minModel` de la tarea (`POST /api/tasks {minModel}` / `PATCH`) o del rol (campo «Modelo mínimo» del rol, `minModel:` en su `.md`; un `sonnet` en un agente Codex vale como «el 2.º peldaño»), y reintentos que ya escalaron. Un modelo fijado en el agente o el rol (`model`) manda y no entra en la cascada.
  - **Rastro:** `t.modelHistory[]` (modelo, motor, intento, motivo) y la tarjeta enseña «🧠 haiku → sonnet». La estimación de coste («≈ 0,8 $») usa solo las tareas que empezaron por el modelo inicial del rol (si hay ≥3; si no, todas).
  - Prueba: `node scripts/model-ladder-e2e.mjs` (claude y codex falsos que registran `--model`/`-m`).

### Compactar antes o partir la tarea (FT-63)

La compactación automática salta cerca del 93 % de la ventana y relee/resume varias veces. Se evita con dos medidas (`server/compact.js`, funciones puras; `team.js` las enruta):
- **Medir y compactar en caliente.** `claudeTracker` ya da el contexto por llamada (`used` = entrada + caché del último mensaje); la ventana sale de `modelUsage.contextWindow` o, mientras no llega, 200 k (1 M con `[1m]`; `AO_CONTEXT_WINDOW` la fuerza). Al pasar el umbral (`settings.compactAt`, 62 % por defecto, rango 30–90, 0 lo apaga; `POST /api/settings {compactAt: 60}`) se manda por stdin (stream-json) la instrucción de escribir `NOTAS.md` (hecho, decisiones, ficheros, lo que falta, cómo probar) y terminar el turno. Al acabar, `runTask` lee y borra `NOTAS.md` (no entra en la rama), confirma el avance y **relanza** la tarea en un contexto limpio con las notas en el prompt (sin `--resume`, justo lo que se quiere evitar). Máx. 3 relanzamientos por intento; si el agente no escribe notas es que había terminado y vale su resumen. El coste y el uso se acumulan; la tarea guarda `compactions`; evento `AgentResumed {reason:'compact'}`.
- **No se comprobó que `claude -p` acepte `/compact` como mensaje de usuario** (los binarios piden aprobación en este entorno), así que se usa siempre el truco de las notas, que no depende del CLI.
- **Codex:** `codex exec --json` solo informa del uso en `turn.completed` (el turno entero), así que a mitad de la ejecución **no hay medida** y no se puede compactar en caliente. El código ya lo cubre si un motor informa `ctx` (el tracker de Codex lo rellena con la entrada del último turno): al no admitir mensajes, corta la sesión y la relanza desde su rama (`git log`/`git diff`). En la práctica, para Codex vale la segunda medida. `auto` hereda el comportamiento del motor elegido.
- **Partir antes de empezar.** En `tick()`, una tarea nueva de trabajo (primer intento, no troceada ya) se evalúa una vez con `bigTaskReason`: ≥6 puntos enumerados, ≥2 «y además…», descripción >2 500 caracteres, o estimación por rol (`costEstimates`, FT-26) ≥70 % del tope de gasto con varias piezas. Si lo es, pasa a Backlog con `sizeHint` y `splitInto`, y se crea una tarea «Planificar:» para el PO con su texto (evento `TaskSplitRequested`); las tareas que crea el PO nacen con `sizeChecked`. `settings.bigTasks`: `plan` (por defecto) · `suggest` (solo avisa en el log y la lanza entera) · `off`. Sin PO en el equipo, solo avisa.
- Prueba: `node scripts/compact-e2e.mjs` (claude falso con uso creciente que escribe `NOTAS.md` al recibir la instrucción; 26 checks).

### Subagente explorador (FT-65)

Lo leído se reenvía en cada turno; para exploraciones amplias el agente delega en un subagente que lee en **su propio contexto** y devuelve solo un resumen.
- **Claude (opcional, `AO_EXPLORER=on`; apagado por defecto hasta que el benchmark FT-61 confirme el ahorro y para respetar las herramientas por rol de FT-59):** `server/engines/claude.js` pasa `--agents` con `explorador` (modelo `haiku`, tools solo de lectura: Read/Grep/Glob + shell de lectura de la lista blanca; sin Edit/Write ni MCP, así que respeta la allowlist y `--strict-mcp-config`), permite `Task`/`Agent` al agente principal y veta con `--disallowedTools` los subagentes integrados (`general-purpose`, `Explore`, `Plan`). `AO_EXPLORER=off` lo desactiva.
- **Prompt:** `economyBlock` añade «para explorar más de 3 ficheros, delega en el explorador y trabaja con su resumen».
- **Codex: no aplica.** `codex exec` no tiene subagentes/`spawn` que se puedan declarar por flag (no verificable aquí: `codex` pide aprobación en este entorno); ese caso lo cubre el índice de código (FT-58). Con motor `auto` cada agente usa lo de su motor; el texto del prompt dice «si tu motor la tiene».
- **Medición pendiente:** la comparación con/sin explorador (tarea «enumera dónde se emite cada tipo de evento») requiere consumir cuota real; compárala con `AO_EXPLORER=off` en el benchmark de FT-61.

## 🚫 Sin procesos en segundo plano en los workers (FT-134)

En `claude -p` no hay notificaciones: un proceso lanzado con `run_in_background` muere al cerrarse la sesión y la tarea llegaba a Revisión sin entregable (caso FT-133). Ahora:
- `--settings` lleva siempre un hook `PreToolUse` (`bin/ao-nobg.mjs`) que rechaza `Bash` con `run_in_background:true` explicando «ejecútalo en primer plano con timeout», y el worker arranca con `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- El prompt base (junto a las reglas de preguntar) pide no lanzar procesos en segundo plano ni esperar avisos; comandos largos en primer plano con timeout (hasta 10 min).
- Al terminar, si el resumen promete un aviso o una espera futura («me avisará», «te aviso», «sigue en segundo plano», «will notify»; «cuando termine» a secas no cuenta) y no hay entregable, la tarea vuelve a **Por hacer** (sin Revisión) con esa nota como indicación. Entregable = diff en algún repo, o una ruta absoluta citada en el resumen (informes fuera del repo, `~` incluido) modificada tras empezar el intento (`t.startedAt`).
- Solo se reencola UNA vez por tarea (`t.nobgRequeued`): si vuelve a pasar, va a Revisión con «⚠️ terminó esperando un aviso dos veces».
- Prueba: `node scripts/nobg-e2e.mjs`.

## ⏸ Sin cuota a mitad de tarea: pausa y reanudación automática (FT-66)

Si un agente se queda sin cuota de la suscripción mientras trabaja (Claude: «usage limit reached», «5-hour limit», 429…; Codex: «You've hit your usage limit… try again at …»), la tarea **no** va a Fallidas:
- `server/quota-pause.js` reconoce el error y la hora de reinicio que trae el mensaje (epoch tras `|`, «resets 7pm», «try again at 8:53 PM», «in 2 hours»); sin hora, la de la ventana de sesión de `quota.js`, o +15 min.
- `team.js` confirma lo hecho en su rama, devuelve la tarea a «Por hacer» con `quotaPaused {engine, since, resetsAt}` y `preferAgentId`, libera al agente y emite `AgentPaused {reason:'quota'}`. La tarjeta dice «⏸ sin cuota de Claude: sigue sola a las 18:59 (en 42 min)» con **▶ Reanudar ya** (`POST /api/tasks/:id/resume-now`).
- `tick()` reparte primero las pausadas y las relanza solas cuando pasa la hora y `quota.gate()` da margen (si no, mueve la hora), con el mismo agente, en su rama y con `--resume` de su sesión en Claude; el prompt le dice que continúe donde lo dejó. Con motor `auto` y `settings.quotaFailover` (activo por defecto) sigue antes con el otro motor si tiene cuota. `AgentResumed {reason:'quota-reset'}`.
- El proyecto sigue «en marcha» y el estado sobrevive a reinicios del servicio.
- Prueba: `node scripts/quota-pause-e2e.mjs` (claude falso que se corta y luego termina, mock de cuota, reinicio del servidor durante la espera, «Reanudar ya»).

## 📈 Observabilidad de costes (FT-76)

Objetivo: que una tarea hecha por los agentes cueste **igual o menos** que hacerla en una sesión interactiva de Claude Code, con datos para afinar.

**Qué se mide.** Cada turno de cada tarea (Claude y Codex) se anota en `data/costs/<proyectoId>/<tareaId>.jsonl`: `ts, attempt, engine, model, role, turn, input, cacheRead, cacheWrite, output, costUsd, tool, tools[{name,file,bytes,image}], bytes, image`. Claude: `message.usage` de cada mensaje `assistant` del stream-json (un turno por `message.id`) y los `tool_result` de la herramienta (bytes devueltos, imágenes). Codex: eventos `item.completed` + `turn.completed` (la entrada fresca = `input_tokens − cached_input_tokens`). `t.usage`/`t.costUsd` (FT-26) siguen siendo el acumulado; los motores solo ganan un hook `onEvent(ev)`.

**Precios.** `server/pricing.js` (US$/Mtok por modelo: input, cacheRead, cacheWrite, output; coincidencia por fragmento del id, modelo desconocido → tarifa Sonnet). Se sobreescriben con `data/pricing.json` (`{"opus": {"input": 5, ...}}`). En **API** el coste es el que se paga; en **suscripción** no se paga por token, pero el coste calculado con tarifas de API es la unidad común para comparar agente vs interactivo (y `total_cost_usd` del CLI cuando existe sigue en `t.costUsd`). _Pendiente: % de cuota consumido por tarea._

**Desglose por causa** (`breakdown()`): lo que cuesta un turno es reenviar todo el contexto + generar la salida. La salida va a «Salida»; el coste del contexto de cada turno se reparte entre lo que lo compone: el **arranque** (contexto del turno 1: system prompt, memoria, skills, herramientas), y lo que devolvió cada herramienta en turnos anteriores (**lecturas** por fichero, **comandos**/e2e, **imágenes** ≈1 500 tokens; bytes/4 como estimación de tokens). Los intentos anteriores al último (tirados o devueltos) van enteros a **reintentos**. Es una atribución estimada, no una medida exacta; la suma siempre iguala el coste total.

**KPI** (`GET /api/costs`): **coste por tarea aprobada** (incluye intentos fallidos/devueltos) por rol, modelo, motor y proyecto; % aprobadas a la primera (`t.returns` cuenta las devoluciones); gasto en intentos tirados y por devolución; ahorro por caché; tendencia de 7 días; por tarea: turnos, curva de contexto, % de caché, ficheros más caros.

**Línea base interactiva.** `POST /api/costs/baseline {code, title?, transcript?, costUsd?, files?, lines?}` importa el coste por turnos de un transcript de Claude Code (`~/.claude/projects/**/*.jsonl`, solo bajo `~/.claude`; un mensaje por id) o un coste manual. Ejemplo: `curl -XPOST :7420/api/costs/baseline -d '{"code":"FT-66","transcript":"~/.claude/projects/-home-…-flow-test/<sesión>.jsonl","lines":220}'`. La comparación se normaliza por **$/línea cambiada** cuando hay `lines` en ambos lados (las del agente salen del `diffStat`); si no, por coste medio por tarea.

**Cómo leerlo y afinar.** 📊 Resumen ▸ **💸 Costes**: KPI arriba (y si se cumple el objetivo), recomendaciones, objetivo semana a semana, tablas por rol/modelo/motor/proyecto y por tarea la barra apilada (arranque · lecturas · comandos · imágenes · salida · reintentos) con la curva de contexto; clic en una fila abre la tarea, cuya ficha («Ver la tarea») repite el desglose y los ficheros más caros. Reglas de recomendación (`recommend()`): arranque ≥40 %, reintentos ≥25 %, comandos ≥30 %, imágenes ≥15 %, un fichero ≥15 % del coste de un proyecto, un modelo barato con ≥20 pts menos de aprobadas a la primera que otro del mismo rol (≥3 tareas cada uno), y objetivo incumplido.

**Objetivo.** Ajustes ▸ «Objetivo de costes» (`costTargetPct`, 100 por defecto): coste por tarea aprobada ≤ X % del interactivo; la pestaña lo muestra global y semana a semana (lunes).

**Export y flow-test.** `GET /api/costs/export[?format=csv]` (una fila por turno), `GET /api/costs/:proyectoId/:tarea` (detalle por turno) y `GET /api/costs` para el flow `costes-agentes.flow.json`.

**Prueba:** `node scripts/costs-e2e.mjs [captura.png]` (claude falso con usos conocidos en dos intentos con imagen, Codex falso, línea base por transcript, pestaña sin errores de consola).

**Fuera de esta entrega (siguientes fases):** ahorro de RTK (`rtk gain`) y coste de memoria/briefing por separado, % de cuota por tarea, alertas (2× la mediana del rol, presupuesto diario/semanal), experimentos A/B con el benchmark FT-61 e informe inicial con las tareas FT-xx históricas (esas no tienen telemetría por turno; solo su `costUsd`).

## ⏱️ Benchmark de costes (FT-61)

Verifica que las medidas de ahorro (FT-57 a FT-65) funcionan realmente. Script: `node scripts/cost-benchmark.mjs` (binarios falsos con costes predecibles).

- **Variantes medidas:** 6 combinaciones (Claude/Codex × sin/con medidas × sin/con memoria)
- **Métricas:** tokens entrada/caché_lectura/caché_escritura/salida, coste USD, nº turnos, herramientas usadas, si la tarea se completó
- **Salida:** tabla en `resumen/cost-benchmark-YYYY-MM-DD.md` con comparativas de ahorro y resumen de conclusiones
- **Flow de verificación:** `flowtest/benchmark-costes-ft61.flow.json` prueba los endpoints de observabilidad (`GET /api/costs`, `/api/costs/:proyecto/:tarea`, `/api/costs/export?format=csv`, `POST /api/costs/baseline`)
- **Prueba:** `node scripts/cost-benchmark.mjs` (requiere permisos para `spawn` y `git`); no está en el CI porque depende de binarios falsos y consume varios minutos

**Lo que falta verificar en entorno real:**
- Precios estimados de Codex vs reales (`CODEX_PRICES` en `usage.js`)
- Ahorro real del índice de código (FT-58): requiere ejecutar la misma tarea con/sin índice en Claude/Codex reales
- Comparación del explorador (FT-65) vs sin: requiere `AO_EXPLORER=off` y `AO_EXPLORER=on` con tarea real
- Flags de Codex no verificados contra binario real: `exec resume`, `features.codex_hooks`, `hooks.PreToolUse`, `-c model_reasoning_summary`

## 🧠 Memoria de los agentes (FT-75)

Cada tarea empezaba de cero. Ahora cada agente tiene una memoria corta por proyecto, y el proyecto otra común (`server/memory.js`, ficheros `data/memory/<proyecto>/agent-<id>.md` y `project.md`, una lección por línea con su código de tarea):
- **De dónde salen, sin llamadas extra al modelo:** al terminar, el agente puede cerrar su resumen con «LECCIONES:» y 1–2 viñetas (≤160 caracteres; «[proyecto]» para la común) — se guardan y se quitan del resumen —, y la primera frase de cada «Devolver» se guarda como «Corrección de revisión».
- **Dónde van:** en la parte estable del prompt, tras el briefing del repo (se lee de caché), con la regla «si algo contradice el código actual, manda el código».
- **Para que salga rentable:** tope de ≈1 500 tokens por fichero (`MAX_CHARS` = 6 000; al pasarse se descartan las más antiguas) y deduplicado (≥80 % de palabras en común).
- **Control:** sección «🧠 Memoria» en la ficha del agente para verla y editarla (`GET/PUT /api/memory/:projectId[?agent=id]`), interruptor en Ajustes (`agentMemory`).
- Prueba: `node scripts/memory-e2e.mjs` (11 checks). Su efecto en el coste entra en el benchmark de FT-61 (variante con y sin memoria).

## 🐴 Ponytail (prueba) (FT-86)

Prueba medida de si las reglas «construir lo mínimo» abaratan las tareas sin empeorar el resultado. Inspirada en la escalera de decisión del plugin [Ponytail](https://github.com/DietrichGebert/ponytail) (no hacerlo → ya existe → configurarlo → reutilizar/extender → una línea → lo mínimo → solo entonces código nuevo). El texto (`server/ponytail.js`, `BLOCK`) es **nuestro, en castellano, no una copia**. Licencia del repo original: **no verificada** desde este entorno (sin acceso a red); como no se copia texto ni código, no hace falta, pero compruébala antes de reutilizar nada literal. Sus cifras publicadas (≈54 % menos código, ≈22 % menos tokens, ≈20 % menos coste) son suyas: aquí se mide con las tareas reales.

- **Apagada por defecto.** Se activa **por rol** (Ajustes → «Ponytail», o casilla en la ficha del rol; se guarda en `settings.ponytailRoles`) y/o **por agente** (casilla en su ficha; `agent.ponytail`, `PATCH /api/agents/:id`). Basta con una de las dos.
- Con la opción activa el bloque va en la parte **estable** del prompt (tras `economyBlock`, antes de «TAREA»; FT-59), igual para Claude y Codex (comparten `buildPrompt`). Apagada, el prompt queda **byte a byte igual** (lo comprueba el e2e).
- Cada intento se etiqueta con `variant: 'base' | 'ponytail'` (`task.variant` y cada línea de `data/costs/…jsonl`; también en el CSV de `/api/costs/export`).
- «💸 Costes» → tabla **Ponytail vs base** con medias por tarea aprobada (coste, tokens, salida, devoluciones, líneas del diff) y selector para filtrar el resto de la pestaña (`GET /api/costs?variant=base|ponytail`; `byVariant` siempre trae la comparación).
- Con pocas tareas por variante no hay conclusión: lanza varias del mismo tipo con y sin la opción antes de decidir.

Prueba: `node scripts/ponytail-e2e.mjs` (motores falsos Claude y Codex).


### Medición A/B (FT-87)

**Estado:** ⏳ **Pendiente cuota real.** Procedimiento y herramientas listos; requiere ≥5 tareas aprobadas por variante.

La decisión de activarla de serie depende de ejecutar la medición A/B en un rol real. Criterio: activar si ahorra ≥15 % por tarea aprobada **SIN más devoluciones** (`ponytail.returns ≤ base.returns`).

**Herramientas y documentación:**
- **Script de medición:** `scripts/ponytail-measure-e2e.mjs` — muestra procedimiento, estado de costes e APIs.
- **Flow de test:** `flowtest/medicion-ponytail-costos.flow.json` en el workspace de flow-test — verifica `/api/costs` (byVariant), filtro ?variant= y exportación CSV.
- **Documentación:** `flowtest/ponytail-medicion-FT-87.md` en el workspace de flow-test — tabla de criterios de decisión, APIs, próximos pasos.

**Procedimiento cuando haya cuota:**
1. Elegir un rol con volumen (p. ej. `back`, `office-flowtest`).
2. Lanzar ≥5 tareas aprobadas SIN Ponytail (desactivada por defecto, `variant="base"` en telemetría).
3. Activar Ponytail en el rol: `POST /api/settings {ponytailRoles:{role: true}}`.
4. Lanzar ≥5 tareas aprobadas CON Ponytail (`variant="ponytail"`).
5. Consultar tabla en «💸 Costes» → «🧪 Ponytail vs base» con medias por variante.
6. Aplicar criterio: si `(base.cost - ponytail.cost) / base.cost ≥ 15%` y `returns_ponytail ≤ returns_base`, activar en el rol y documentar aquí.

**APIs de telemetría:** `GET /api/costs` (byVariant), `GET /api/costs?variant=base|ponytail` (filtrado), `GET /api/costs/export?format=csv` (export).


## 🔔 Para ti y la campana

Todo lo que **te** espera, de todos los proyectos visibles, en un sitio: la **🔔 N** de la barra (clic → vista «Para ti»). Se deriva del estado (no se guarda) y cada aviso desaparece al resolverse:
preguntas de los agentes · revisiones (de proyectos en manual o que la revisión automática te dejó) · cortadas por tope/atasco · fallidas · tareas manuales (título con 👤 o MANUAL) · sugerencias y cambios del 🧑‍✈️ coordinador · pausadas por cuota (solo aviso). Cada aviso trae su acción (contestar, abrir, diff, aprobar, devolver, reintentar, reanudar, revisar otra vez). Grupos por proyecto plegables; las tarjetas importadas de un tablero sin agente van aparte y plegadas.

## 👁 Proyectos visibles

Ajustes ▸ Proyectos visibles: desmarca los proyectos que no quieres ver en el selector, el Resumen, el edificio y Para ti (`settings.hiddenProjects`). Ocultar no para ni borra nada.

## ✋ Revisión por proyecto

La política de revisión (`manual` · `auto-qa` · `auto`, ver FT-56) se elige **por proyecto** en Ajustes ▸ Proyecto (`project.reviewPolicy`; «Igual que la empresa» = `settings.reviewPolicy`). Al activar una automática se revisa en el momento lo que ya esperaba. «🔎 Revisar otra vez» (`POST /api/tasks/:id/review-again`) relanza una revisión automática que falló por un problema técnico. El revisor usa un «Revisor» genérico si la tarea no tiene autor ni el proyecto equipo.

## 🧠 Memoria de Claude Code del repo

Agentes ▸ 🧠 Memoria del proyecto: la auto-memoria que Claude Code guarda por repo (`~/.claude/projects/<repo>/memory/`: `MEMORY.md` + un `.md` por memoria) se ve y se edita aquí (si el repo no tiene, se usa la de una carpeta padre). Su índice va en la parte estable del prompt de los agentes (también del PO) y la carpeta en `--add-dir` para leer el detalle. Ajuste `claudeMemory`. API `/api/projects/:id/claude-memory[/file]`.

## 🔌 MCP y 📜 scripts del catálogo

Agentes ▸ 🔌 MCP / 📜 Scripts, junto a las skills:
- **Inventario**: MCP de `~/.claude.json` (usuario y proyectos) y `~/.codex/config.toml`; scripts de las carpetas `scripts/` de los repos de tus proyectos (+ «Añadir por ruta»).
- **Catálogo** (`_agentes/mcp.json` solo con nombres —ningún secreto—; `_agentes/scripts.json` con ruta y descripción).
- **Asignación** por agente (su ficha o «＋ agente…» en el catálogo; `agent.mcps` / `agent.scripts`) y por rol (frontmatter `mcps:` / `scripts:`, editor de rol). Aviso al dar MCP con coste (Hostinger…).
- **Al lanzar**: Claude recibe los MCP en un `--mcp-config` **fichero 0600** (borrado al acabar) y sus `mcp__` permitidos; Codex conserva los de su config y recibe por `-c` los que solo tiene Claude. Los scripts van al prompt, a la lista blanca (`Bash(node <ruta>:*)`) y su carpeta a `--add-dir`.

## 💸 Codex: coste visible y más barato sin bajar de modelo

- Coste **≈ estimado** de Codex (tabla de precios) en vivo y por tarea (`costEstimated`); columna «Acumulado» y desglose por motor en «Ver» del Resumen; la tabla del Resumen muestra el reparto **Claude / Codex** por proyecto.
- Los agentes Codex **no heredan** tus MCP, plugins ni memorias de `~/.codex/config.toml` (se apagan por `-c`; `AO_CODEX_ISOLATE=off` lo desactiva), salida de órdenes acotada (`tool_output_token_limit`), regla de agrupar lecturas, aviso de atasco a los 15 pasos sin editar.
- Bajo el servicio Codex corre sin sandbox (bwrap no arranca en systemd), así que **sí puede capturar y mirar** su trabajo visual: el prompt le dice que mire las imágenes con `view_image`.

## 🧑‍✈️ Coordinador del equipo

Ajustes ▸ Proyecto: apagado · solo sugerir · automático. Reglas fijas, sin IA (`server/coordinator.js`), cada 2 min en proyectos en marcha:
- agente parado porque su motor no tiene cuota, con trabajo listo y el otro motor con margen → **motor automático**;
- rol con tareas **listas** (por hacer, dependencias hechas) y nadie que pueda hacerlas (o ≥3 por agente) → vuelve uno de ese rol del **banquillo** o se **contrata** (motor con más margen, modelo de ese motor); sin mesa libre (8 por proyecto), antes va al banquillo un ocioso (≥10 min sin trabajo listo) que no sea imprescindible.
- **(FT-121) Reasignar antes que contratar**: si un rol tiene tareas listas y nadie libre, y hay un agente **ocioso ≥ 10 min** de otro rol del **mismo kind** (dev↔dev) que comparte repo (`p.repos[].roles`), la acción `retarget` le cambia el rol (guarda `homeRole`); cuando ya no queda trabajo listo del rol prestado, `restore` lo devuelve a su `homeRole`. Nunca al PO, a quien trabaja o tiene tareas suyas, ni a un prestado.
- **(FT-121) Revisión que bloquea** (`reviewPlan()`): tarea en revisión con otras esperándola más de `reviewNudgeMin` → con política automática y sin `reviewRequired` se **lanza ya** la revisión (`review-now`); si es `reviewRequired`, la política es manual o la automática la retuvo → **aviso prioritario** (`review-alert`: evento `ReviewBlocking` + Telegram si está configurado) con «bloquea a N tareas». Una vez por tarea; en «solo sugerir» los avisos salen igualmente.
- Cada acción lleva su `why` en `coordLog` y se ve en 📊 Resumen («Lo que hizo el coordinador»). Prueba: `scripts/coordinator-reassign-e2e.mjs` (snapshots sintéticos).

Nunca toca a quien trabaja, tiene tareas suyas (asignadas o pausadas) ni al PO; un cambio de plantilla cada 10 min. Sugerencias con «Aplicar» y registro de 24 h en 🔔 Para ti; evento `TeamAdjusted`; `POST /api/projects/:id/coordinate`. Pruebas: `scripts/coordinator-unit.mjs`, `scripts/coordinator-e2e.mjs`.

### 🧑‍⚖️ Coordinador / Supervisor de serie (FT-122)

Rol de serie `coordinador` («Coordinador / Supervisor», `kind: supervisor`, modelo barato `haiku`; distinto del PO). **Cada proyecto nuevo lo trae en su equipo** (agente «Coordi», ocupa mesa; se puede quitar con el equipo) y no coge tareas de trabajo. Con él en la mesa, cada ~30 s (`AO_SUPERVISOR_MS`, `server/supervisor.js` decide y `team.js` aplica):

- **Tareas en Revisión**: pone la rama al día con la base (FT-19; un choque de verdad la devuelve al agente), ejecuta sus checks y lee el diff acotado. Checks rojos → **devuelta con nota** (qué check falla). Verdes → si el proyecto **delega** (`supervisorApproves`, casilla en Ajustes del proyecto, apagada por defecto) la **aprueba** —también las de revisión obligatoria—; si no, deja `t.supervisor` = «✅ listo para aprobar», lo apunta en el historial de revisión y avisa (evento `SupervisorDecision`, Telegram). Con ficheros sensibles solo recomienda. Sin checks declarados usa un revisor de modelo barato con tope de gasto propio (`settings.supervisorMaxUsd`, 1 $ por proyecto por defecto).
- **Aprobar con delegación no depende solo de los checks**: si el diff cambia más de 30 líneas, un revisor barato (tope `supervisorMaxUsd`) lo mira también; aprueba solo si pasan los checks Y el revisor; si este devuelve, la tarea vuelve con su nota.
- **Dependencias que sobran**: una tarea sin empezar que depende de otra parada y no la menciona ni toca sus ficheros → propuesta con motivo (`t.depProposal`, botones **Quitar / Mantener** en Ajustes del proyecto; «Mantener» pone `t.depsKept` y no se vuelve a proponer). Nunca si la dependiente es `qa`/`docs` ni si la bloqueante es `planner`. Con la bloqueante en *Revisión* siempre es solo propuesta; con delegación se aplica sola únicamente si la bloqueante está *fallida*.
- **Proyectos existentes**: botón «Añadir coordinador» en Ajustes del proyecto (`POST /api/projects/:id/supervisor`); sin mesa libre → «sin mesa libre: manda a alguien al banquillo».
- **Reasignación**: aplica las reglas `retarget`/`restore` de FT-121 aunque el coordinador del equipo no esté en automático.
- Herramientas (`engines/toolscope.js`, kind `supervisor`): solo lectura, checks y `git merge/add/commit` para resolver choques; sin Edit/Write: nunca edita código de producto.

Prueba: `node scripts/supervisor-e2e.mjs`.

## ⏰ Tareas programadas, 🔎 comprobación sin IA y 🪝 webhook

Tareas ▸ ⏰ Programadas (por proyecto, `project.schedules`): una plantilla de tarea (título, descripción, rol, revisión obligatoria) que se crea sola **cada N minutos**, **cada día a una hora** o **cuando llega un aviso**:
- **Comprobación sin IA** (opcional): una orden que se ejecuta en la carpeta del proyecto. Código 0 = sin novedad (solo se apunta); **2 = se crea la tarea** con la salida del script como datos; otro = error apuntado. Así se vigila cada X tiempo sin gastar tokens.
- **🪝 Webhook** `POST /api/hooks/<token>`: crea la tarea con el cuerpo del aviso (p. ej. el `notifyUrl` de un monitor de flow-test; desde el Docker de flow-test, `http://host.docker.internal:7420/api/hooks/<token>`). El token secreto de la URL es la credencial (no pide `x-ao-token`).
- Solo en proyectos en marcha (el webhook, siempre); sin acumular: si la tarea anterior de esa programada sigue pendiente, esa vuelta se salta.
- API: `GET|POST /api/projects/:id/schedules`, `PATCH|DELETE …/schedules/:sid`, `POST …/schedules/:sid/run`. Pruebas: `scripts/schedules-e2e.mjs`.

## 📁 Proyectos sin repo

Un proyecto sin repos pero con carpeta en el workspace de flow-test (p. ej. «empresa»: documentación, flows y scripts) funciona igual: el agente trabaja **directamente en esa carpeta** (sin worktree ni rama, de una tarea en una para no pisarse) y «Aprobar» la da por hecha. Ejemplo real: el equipo de inversión de `empresa/` (estratega, contable y verificador), descrito en `empresa/inversion-revert-agentes.md` del workspace.

## Otras mejoras de la UI (7-oct)

Banquillo agrupado por proyecto (Disponibles primero, grupos plegables) · la etiqueta del rol lleva al rol también desde el banquillo · la planta Dirección / Guía abre el Guía · el tablero conserva el scroll de cada columna al llegar actualizaciones · plegar un grupo de skills/scripts no oculta los de debajo · el Guía lista y lee los flows del workspace (`flowtest.listFlows` / `flowtest.readFlow`) sin contar las copias de los worktrees.

## 🖥️ IA local (LM Studio / Ollama) (FT-54)

Cuarto motor, `local`: trabaja con un modelo que corre en tu máquina, sin cuota ni nube. **Quien ejecuta es el CLI de Codex** (`server/engines/local.js` envuelve `codex.js`): mismo worktree, stream JSON, mensajes en caliente y sandbox; solo cambia el proveedor, que se pasa por línea de comandos (`-c model_provider=aolocal -c model_providers.aolocal.base_url=… -c …wire_api="responses"`) sin tocar tu `~/.codex/config.toml`. Si el servidor pide clave, va por `env_key` (`AO_LOCAL_API_KEY`).

- **Requisitos**: el CLI `codex` instalado y un servidor OpenAI-compatible con **un modelo con soporte de herramientas** cargado: LM Studio con el servidor activado (`:1234`, ≥ 0.3.29) u `ollama serve` (`:11434`, ≥ 0.13). Un modelo sin tools (se detecta en LM Studio y Ollama) se rechaza al arrancar con un mensaje claro; sirven p. ej. qwen2.5-coder, llama-3.x-instruct, devstral. El Codex actual solo admite `wire_api = "responses"` (`/v1/responses`); `AO_LOCAL_WIRE_API=chat` es para un Codex antiguo.
- **Configuración** (Ajustes ▸ Motores de IA ▸ IA local): preajustes «LM Studio :1234» / «Ollama :11434» (URL editable), clave opcional (en `data/.ai-keys.json`; no viaja por el SSE) y **Probar** (`GET /v1/models`): lista los modelos y guarda `settings.local = {baseUrl, model, allowAuto}`. Ahí se elige el modelo por defecto; en «Contratar agente» / ficha del agente, el motor `local` ofrece la lista del servidor. El motor `auto` solo elige `local` si marcas «Permitir…» (`allowAuto`, apagado de serie). API: `POST /api/engines/local/probe` y `/settings`; `GET /api/engines` trae `local: {installed, loggedIn, text: «LM Studio · 3 modelos», model}`.
- **Guía**: proveedor `local-api` en «Proveedor del Guía» (el cliente de `openai-api.js` con la URL base y la clave de la IA local).
- **Cuota y coste**: sin cuota (`quota.gate('local')` nunca bloquea) y `costUsd` 0; los tokens por sesión se cuentan igual (`turn.completed`), con «límite n/d».
- **Limitaciones**: más lento y menos capaz que Claude/Codex en la nube (el prompt añade una nota de brevedad); un modelo pequeño puede no usar las herramientas (se avisa en el log si no ejecutó ninguna).
- Prueba: `node scripts/local-engine-e2e.mjs` (servidor OpenAI-compatible falso + `codex` real; sin `codex` se salta la tarea).

### Edificio v2, fiel a la referencia (FT-77)

Objetivo visual: `~/JksDocs/Proyects/12-flowtest/task/diseno-edificio-referencia.png` (panel 1) y contrato `…/agentoffice_visual_pack/spec/visual-contract.json`.
- **Un único edificio** tipo dollhouse: plantas alineadas en un solo eje (`FLOOR_Z_STEP = 0`), anchas y poco profundas (`BUILDING_FLOOR_SIZE` 9,2×3,9), paredes más altas que en la sala (`BWALL_H`) y solo una losa fina entre plantas (`FLOOR_GAP`), para que el interior se vea por el frente abierto con la cámara del edificio (`BUILDING_CAM_DIR`, más baja que la de la sala).
- **Estructura** (`buildStructure`): núcleo de escalera/ascensor a la derecha, azotea con pretil, sombrilla y terraza, planta baja con zócalo, árboles y aparcamiento.
- **Interior real**: muebles Kenney (`placeIn`) y personajes reales posados sin animación por frame (`addMiniChar`: el mixer se avanza una vez con `sit`/`idle`), colocados por estado: trabajando sentado en su puesto, revisión en el puesto de revisión, esperando/bloqueado de pie junto al Kanban, fallido en su puesto con aro rojo, libre en el sofá. Kanban exento con columnas TODO/DOING/REVIEW/DONE y notas según los contadores reales.
- **Tarjetas de planta** P1…Pn (nombre y métricas con punto de color; el texto completo en `title`), secundarias a la escena.
- **Scroll antes que miniaturizar** (`fitBuildingHeight`): si las plantas quedarían por debajo de ~560 px de ancho, el lienzo crece en alto y la vista hace scroll hasta ~620 px.
- **Pruebas**: `scripts/building-e2e.mjs` mide el contrato a 1920×1080 (plantas alineadas ±4 px, ancho 550–750 px, alto 65–80 %); la visibilidad de agentes usa rayos paralelos a la vista (cámara ortográfica). Capturas: `node scripts/preview.mjs out.png --building --width 1920 --height 1080`.

### Planta v2, fiel a la referencia (FT-78)

La vista de planta sigue el panel 2 de `diseno-edificio-referencia.png`:

- Personajes un 30 % más pequeños (`CHAR_H` 0,66), en proporción con mesas y sillas; el edificio conserva su escala.
- Zonas como alfombras suaves (13 % de opacidad) con un borde fino de su color, no bloques saturados.
- Etiquetas de zona como píldoras de color DENTRO de su zona; la de QA a la derecha y la del Kanban bajo la pizarra.
- Kanban más grande (3,5 × 1,25) y el título del proyecto encima del marco, sin tapar columnas.
- Más densidad: doble monitor por puesto, estanterías en la pared izquierda, plantas grandes en las esquinas y mesita auxiliar.

Captura: `node scripts/preview.mjs out.png --width 1920 --height 1080`.

## 🫧 Burbujas de estado en la oficina (FT-123)

En la planta, cada agente lleva siempre una burbuja compacta: icono + código de tarea + estado (`✏️ FT-115 editando…`, `✋ FT-114 en revisión`, `⏳ en cola`, `⛔ bloqueado`, `💤 sin cuota`, `☕ libre`). Al pasar el ratón o seleccionar se expande con la actividad completa. Si dos se pisan (mesas contiguas) se apilan hacia arriba —sin tapar las píldoras de zona ni la pizarra— con una línea fina hasta el avatar. En el edificio no se ven y en pantallas estrechas (<640 px) solo llevan icono + código. El DOM solo se toca cuando cambia el texto.

Ajustes → «Burbujas de estado» (`settings.officeBubbles`, `POST /api/settings`): `'todas'` (por defecto) o `'al pasar'`. Prueba: `node scripts/bubbles-e2e.mjs [captura.png]`.

## 🪑 Mi mesa en la oficina (FT-124)

Cada planta tiene una mesa «Tú» (avatar naranja con corona, en la franja libre a la derecha de QA, calculada desde `floorZones`) con lo que te espera en ESE proyecto: pila de papeles proporcional (máx. 14) y burbuja siempre visible `🔔 3 · ❓1 ✋2` con el desglose por tipo (❓ pregunta · ✋ revisión · ⚠️ cortada · ❌ fallida · 👤 manual · ⏸ cuota · 🧑‍✈️ coordinador). Sin pendientes: `✅ nada te espera`.

- Fuente: la misma lógica que 🔔 Para ti (`inboxItems(projectId)` en `public/app.js`; `mineSummary()` la resume y llega a `office.update({mine, mineByProject})` por el snapshot SSE, sin polling). La burbuja usa el apilado anti-solape de FT-123.
- Un agente que te espera muestra `❓ te pregunta` / `✋ espera tu revisión` y una línea discontinua une su avatar con tu mesa.
- Clic en la mesa, en «Tú» o en la burbuja → abre 🔔 Para ti filtrado por ese proyecto (chip con ✕ para quitar el filtro); cada fila lleva sus acciones (contestar / ver la tarea).
- Vista Edificio: cada planta con avisos muestra un punto naranja con tu número de pendientes.

Prueba: `node scripts/mydesk-e2e.mjs [captura.png]`.

## 🗂 Paneles en los márgenes de la planta (FT-125)

El hueco que deja el diorama a izquierda y derecha se aprovecha con tarjetas HTML semitransparentes (`public/office-panels.js`), siempre fuera del suelo, la pizarra y las burbujas:

- **👥 Equipo** (arriba-izq): agente, rol, motor/modelo, estado, tarea actual (`FT-n` + título), minutos en ella y coste de hoy; clic → ficha del agente.
- **📜 Actividad** (abajo-izq): últimos 8 eventos del Activity Stream del proyecto (aprobada, devuelta, fusionada, empieza, pregunta…), en vivo por SSE.
- **🗂 Progreso** (arriba-dcha): hechas/total con barra, en curso, cola siguiente con «⏳ espera a FT-n» y épicas agrupadas por prefijo del título (`Épica: …` o `[Épica] …`).
- **🔔 Para ti** (centro-dcha): lo de `inboxItems(projectId)` (el mismo de la mesa «Tú»); clic en una fila abre la tarea o la bandeja.
- **⚡ Consumo y cuota** (abajo-dcha): coste de hoy del proyecto y cuota de Claude/Codex (FT-45) con aviso cerca del tope.

Colocación: se proyecta el volumen de la planta (`office.floorHull()`) y los obstáculos vivos (`office.obstacles()`); cada tarjeta ocupa el ancho libre de su franja (170–268 px). Si alguna no cabe o la ventana mide < 760 px, todas pasan a una barra lateral desplegable («☰ Paneles»). Cada panel se pliega con su cabecera (se recuerda en `localStorage` `ao:opCollapsed`). Se desactivan en Ajustes (`settings.officePanels`, por defecto on) y no se muestran en la vista Edificio. «Coste de hoy» suma las tareas tocadas desde las 00:00 (aproximación). `aoOffice.panels.why()` dice por qué no cupieron.

**Paneles enteros, sin scroll (FT-138).** Cada panel crece hasta su contenido completo (nunca `overflow:auto`): todos los agentes del equipo y todas las épicas se ven siempre, sin compactar ni cambiar la fuente. Si una columna no cabe en el alto del lienzo, los paneles se apilan hacia abajo (buscando el primer hueco sin pisar el suelo) y la vista de la oficina hace scroll como página. Cada panel se pliega/despliega por su cabecera (recordado por panel en `localStorage`, `ao:opCollapsed`); plegado muestra solo la cabecera con un resumen corto (`👥 8 · 1 trabajando`, `🗂 6/16 hechas`, `⚡ hoy 2.91 $`). Check: `scripts/office-panels-e2e.mjs` (8 agentes y 10 épicas a 1920×1080 y 1366×768).

También (FT-125): la burbuja de la oficina muestra el código `FT-n` de la tarea (antes podía salir su id interno) y un agente libre pone su nombre: `☕ Marta libre`.

Prueba: `node scripts/office-panels-e2e.mjs [carpeta]` (1920×1080, 1366×768 y 600 px; guarda capturas).

### Entrada directa a la planta con Coordi de serie (FT-126)

Desde FT-122 todo proyecto (también los descubiertos en el workspace) lleva a Coordi (kind `supervisor`). La Oficina decide «un solo proyecto con equipo → planta» contando equipos, así que con varios proyectos nunca entraba en `floor`. `teamProjects()` (`public/app.js`) ya no cuenta a los supervisores: un proyecto solo con Coordi no cuenta como equipo. Prueba: `node scripts/bubbles-e2e.mjs` (Coordi tiene burbuja en la planta).

**FT-163:** `computeFloors()` (`public/office3d.js`) usaba otro criterio que `teamProjects()` y dibujaba una planta para proyectos que solo tenían a Coordi (p. ej. «Vacío»). Ahora aplica el mismo: una planta exige al menos un agente que no sea `supervisor`. `scripts/building-e2e.mjs` vuelve a estar en verde (Beta también se vacía de Coordi de serie en el fixture y la navegación admite 120 s con la máquina cargada).

### Coordi solo en proyectos creados a mano (FT-127)

El escaneo del workspace ya no crea un Coordi por carpeta descubierta: solo `createProject` lo añade (reutilizando antes un Coordi libre del banquillo; nunca más de uno por proyecto). En los demás sirve «Añadir coordinador» (FT-122). Al arrancar, una migración borra los Coordi de proyectos sin repo y sin tareas (nunca uno con tareas o historial). Prueba: `node scripts/supervisor-e2e.mjs`.

### Confirmaciones 🛡 largas del Guía (FT-128)

- `bin/ao-mcp.mjs` habla con `node:http` sin los 300 s de undici (antes «fetch failed» y el modelo reintentaba, duplicando la pregunta). Tope propio: `AO_MCP_TOOL_TIMEOUT_MS` (30 min).
- `questions.confirm/choose` deduplica: una confirmación idéntica pendiente se reutiliza (varias tools esperan a la misma respuesta).
- Sin respuesta en `AO_CONFIRM_TIMEOUT_MS` (servidor, 10 min) la pregunta se retira de 🔔 y la tool falla con 408 «el usuario no ha contestado a la confirmación» (antes contaba como «No»).
- Prueba: `node scripts/confirm-timeout-e2e.mjs`.

### 🛡 visibles también embebido en flow-test (FT-131)

- El manejador SSE de `state` aísla `render()` y `renderQuestions()`: si un panel lanza una excepción dentro del iframe, el modal 🛡 y la barra `#questions-bar` se pintan igualmente (el error queda en la consola).
- Una orden `ui` del Guía (p. ej. `app.navigate`) ya no cierra una 🛡/pregunta abierta (antes la «Más tarde» implícita la silenciaba).
- La 🔔 abre primero la 🛡/pregunta pendiente (aunque la hubieras pospuesto); sin ninguna, va a «Para ti».
- Prueba: `node scripts/embedded-e2e.mjs [captura.png]` (flow-test simulado con iframe + proxy `/agents/` como `agents-proxy.js`, vista 🌐, contestar, 🔔, textos y fotogramas).

## 🎯 Oficina fiel al estado (FT-148)

La posición de cada agente REAL la decide solo su estado: `working` → su mesa sentado (sin paseos); `reviewing` → Revisión; esperando o bloqueado por dependencia → Kanban; espera al usuario (❓/✋) → junto a la mesa «Tú»; `failed` y sin cuota → su mesa; libre → Descanso. Solo los libres pasean (`WANDER_SPOTS`: café, nevera, planta, charla). Al cambiar de estado caminan a su sitio nuevo. QA: `aoOffice.simulate(s)` acelera el reloj y `debugState()` da la posición real. Prueba: `node scripts/office-fidelity-e2e.mjs`.

## 🛒 Marketplace: paquetes `ao-pkg/1` de roles, skills y agentes (FT-141)

`server/marketplace.js` exporta e importa paquetes JSON `{format:"ao-pkg/1", kind, name, version, summary, author, files:[{path, content(base64), sha256}], meta, memory?}` (tope 2 MB). No habla con la nube: flow-test hace de puerta (`/account-link/marketplace/*`).

- **Ámbitos**: `team` (roles, skills y agentes con memoria) y `public` (solo roles y skills; nunca memoria ni agentes).
- **Exportar** (`POST /api/marketplace/export {kind,id,scope,projectId?}`): rol → su `.md`; skill → su carpeta (sin `node_modules`, `.git` ni ficheros > 512 KB, listados en `meta.skipped`); agente → rol + `meta` (engine, model) + memoria `agent-<id>.md` y `project.md` solo en `team`.
- **Saneado**: rutas del usuario → `{{HOME}}` (se expanden al importar) y escáner de secretos (patrones de flow-test + claves privadas, JWT, Bearer, `password=`…). Si encuentra algo, error 422 que dice qué y dónde (sin el valor).
- **Importar** (`POST /api/marketplace/import {package, org?, overwrite?, confirmCode?, projectId?, agentName?}`): verifica sha256; rol → `_agentes/roles/marketplace/<org|public>/<name>.md`; skill → `_agentes/skills/<name>/`; agente → banquillo con su rol (si falta se instala) y memoria en `data/memory/<projectId>/agent-<nuevo id>.md`. Nunca sobrescribe sin `overwrite` (409 `needsConfirm:'overwrite'`). Skills con scripts: `meta.hasCode` y 409 `needsConfirm:'code'` hasta que la UI confirme con 🛡.
- `POST /api/marketplace/inspect` previsualiza (existe, versión instalada, código, secretos); `GET /api/marketplace/installed` da las versiones instaladas (`data/marketplace-installed.json`) para «actualizar».
- **El cliente se protege solo** (no se fía de la nube): antes de escribir nada valida todo el paquete y rechaza con 422 rutas absolutas, con `..`, `\` o bytes nulos, ficheros repetidos, `name`/`org` fuera de `/^[a-z0-9][a-z0-9._-]{0,63}$/i` (ni `.` ni `..`), más de 200 ficheros, ficheros > 512 KB, sha256 que no coincide y destinos que sean (o cuelguen de) un enlace simbólico. Un fallo rechaza el paquete entero.
- e2e: `node scripts/marketplace-e2e.mjs`.

### Vista 🛒 Marketplace, ⬆ Publicar e ⬇ Instalar (FT-142)

`server/marketplace-cloud.js` habla **solo con flow-test** (`settings.flowTestUrl` + `/account-link/marketplace/*`, que reenvía a la nube con el token de vinculación; aquí nunca se ve). Sin vinculación (401/403/412) responde **412** con `{unlinked:true, linkUrl}` y la UI pinta el aviso con enlace «Vincular en flow-test».

- **Vista** (menú lateral 🛒, `?view` no hace falta): pestañas «👥 Mi team» y «🌍 Público», búsqueda, filtro por tipo y tarjetas con nombre, versión, autor/org, resumen, descargas, 🧠 si trae memoria y «⏳ pendiente de moderación». «⟳ Actualizar» si la versión de la nube difiere de la instalada.
- **⬆ Publicar**: en cada rol del catálogo, cada skill del catálogo y la ficha del agente (agente: solo team, con memoria). Diálogo con ámbito, versión, resumen y previsualización de ficheros, memoria y saneado (un secreto bloquea con 422).
- **⬇ Instalar**: lista los ficheros; skill con código exige 🛡 (`confirmCode`); agente con memoria exige proyecto destino; si ya existe, casilla de sobrescribir.
- **API local**: `GET /api/marketplace/status`, `GET /api/marketplace/items?scope=&kind=&q=`, `GET|DELETE /api/marketplace/items/:id`, `POST /api/marketplace/items/:id/install {overwrite?, confirmCode?, projectId?}`, `POST /api/marketplace/preview` y `POST /api/marketplace/publish {kind,id,scope,version?,summary?}`.
- **Guía**: `marketplace.search` (lectura) y `marketplace.install` (siempre 🛡 con la lista de ficheros); `app.navigate` acepta `view=marketplace`.
- e2e con flow-test y nube simulados: `node scripts/marketplace-cloud-e2e.mjs` (módulo) y `node scripts/marketplace-ui-e2e.mjs [captura.png]` (UI con Chrome; usa catálogo temporal).
