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

El primer arranque crea **«Demo — Tienda online»** con el motor `demo` (simulado, no gasta tokens):
escribe un objetivo, pulsa **Encargar al PO** y luego **▶ Poner a trabajar**.

## Cómo funciona

1. **Proyecto** = un repositorio git (opcional en demo) más su equipo y su tablero.
2. **Objetivo → PO**: el PO lee el repo y devuelve las tareas en JSON (título, descripción, rol, dependencias).
3. **Planificador** (cada 1,5 s): cada tarea pendiente cuyas dependencias estén **hechas** va al primer agente libre de su rol (como mucho `maxParallel` a la vez).
4. **Aislamiento**: cada tarea corre en un **git worktree** propio (`data/worktrees/…`, rama `ao/<código>`). Al terminar se hace commit `<código>: <título>` con el agente como autor y la tarea pasa a **Revisión**.
5. **Código de tarea**: toda tarea lleva un código legible y estable — prefijo del proyecto + correlativo (`GL-7`, `UH-198`) — que aparece en la tarjeta, la rama, el commit, el prompt del agente (se le pide citarlo en lo que documente), la issue/tarjeta del tablero online (`GL-7 · título`; si el título ya trae un código, se respeta) y en `GET /api/projects/:id/tasks`. Las rutas `/api/tasks/<id>` aceptan también el código. El prefijo se deduce del nombre del proyecto y se cambia en Ajustes ▸ Proyecto (las tareas ya numeradas conservan el suyo).
6. **Mover tarjetas (FT-27)**: en el tablero se arrastra una tarjeta a otra columna o se usa su botón (→ Por hacer / ← Backlog). Solo se mueven a mano las tareas sin empezar (Backlog ↔ Por hacer; las fallidas vuelven a cualquiera de las dos). `PATCH /api/tasks/:id {status}` responde 409 con el motivo si la tarea está en curso/revisión/hecha o el destino es En curso/Revisión/Hecho, y la UI lo muestra como aviso.
7. **Preguntas al cliente**: si un agente necesita una decisión tuya (regla de negocio, nombre visible, qué opción prefieres) ejecuta `node bin/ao-ask.mjs "¿Pregunta?" --opt A --opt B` (el prompt se lo explica); la pregunta aparece en AgentOffice como aviso fijo arriba y en un modal con las opciones o respuesta libre, y el comando espera tu respuesta (hasta `AO_ASK_TIMEOUT_MIN`, 120 min) y la imprime para que el agente siga. Sin respuesta, decide él con el criterio más conservador y lo deja visible en el resumen. Cada pregunta y su respuesta quedan en la tarea («Conversación con el agente») y se le repiten si vuelve a intentarla.
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

- **Publicar**: `POST /api/context` con `{view, projectId, openTaskId, selectedAgentId, taskFilter, questionOpen, host, at}` (`view` = `office|tasks|agents|settings`). `public/app.js` lo manda con *debounce* de 300 ms cada vez que cambia algo (pestaña, proyecto, tarea abierta en «Ver la tarea», agente del cajón, filtro, pregunta abierta). El cliente se identifica con la cabecera `x-ao-client` (id generado por pestaña en `sessionStorage`).
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
- **`task.assign`** fija `task.assignedAgentId` (el agente debe estar fichado en el proyecto); `tick()` solo se la da a ese agente.
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
- **Dictado en «Nueva tarea» (FT-43)**: botón 🎤 dentro de los campos Título y Descripción del diálogo; un clic empieza a dictar (rojo pulsante, `aria-pressed`), otro para, y cerrar el diálogo corta el micro. El texto reconocido se inserta en la posición del cursor y queda editable. Idioma = «Idioma hablado» de Ajustes. Encapsulado en `public/dictation.js` (`dictationSupported`, `createDictation({lang,onText,onState,onError})`, `insertAtCursor`), hoy sobre la Web Speech API del navegador, para poder cambiar de proveedor sin tocar `app.js`. Sin soporte el botón no se pinta; con permiso denegado avisa con un toast y el botón queda desactivado. `node scripts/dictation-e2e.mjs [captura.png]` lo prueba con un SpeechRecognition simulado (10 checks). **Proveedores (`public/dictation.js`):** el preferido es el **STT del servidor** (mismo `voiceRecord`/VAD del push-to-talk → `POST /api/guide/stt`, es decir, faster-whisper local: el audio no sale de tu instalación; se usa cuando `GET /api/guide/stt` da el proveedor disponible), y de respaldo la Web Speech API del navegador (Chrome manda el audio a Google; en Brave existe pero falla con «network»). Preferencia `localStorage ao:dictation=browser` para forzar el navegador. E2E: `scripts/dictation-e2e.mjs` (16 checks: navegador simulado, sin soporte, servidor con micro falso + STT falso).
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

## Fusión sin conflictos a mano (FT-19)

Las tareas nacen de la rama base en su worktree; si varias tocan los mismos ficheros, al aprobar la fusión chocaba y había que resolverla a mano. Ahora lo gestiona el plugin:

- **Comprobación previa**: cada tarea en revisión con rama lleva `behind` (commits de la base que no tiene) y `conflicts[]` (solo rutas que chocarían al fusionar). Se calcula en el servidor con `git merge-tree --write-tree` (git ≥ 2.38; con git antiguo, `merge-tree` clásico), no toca índice ni worktrees, se recalcula solo cuando cambia la base o la rama (cada 10 s y tras cada aprobación) y viaja por el SSE. La tarjeta y el modal muestran los chips «desfasada N commits» y «⚠ conflicto en X».
- **Actualizar con main** (botón en la tarjeta/modal, `POST /api/tasks/:id/update-from-base` y tool del Guide `task.updateFromBase`, policy execute): `git merge --no-edit <base>` dentro del worktree de la tarea. Si entra limpio se recalcula el diffStat y queda lista para aprobar (`TaskUpdatedFromBase`). Si choca se aborta el merge y la tarea vuelve al agente (misma rama y worktree, como *Devolver*) con el feedback: «Tu rama choca con main en: …; haz `git merge main` en tu worktree, resuelve los conflictos conservando lo de ambos lados, verifica y vuelve a confirmar» (`TaskConflict`). El agente tiene `Bash(git merge *)` en la lista blanca (rebase no).
- **Al aprobar**: si la rama está desfasada se actualiza antes de fusionar; si choca no se aprueba (409) y se devuelve como arriba.
- **Al arrancar** una tarea cuya rama ya existe (reintento) y la base avanzó, se actualiza primero; si choca, el conflicto va en el prompt.
- e2e: `node scripts/merge-e2e.mjs` (claude falso que edita la misma línea en varias tareas; una acaba devuelta con el feedback, el agente falso lo resuelve y la fusión sale limpia).

## Motores

| Motor | Cómo se lanza | Permisos |
|---|---|---|
| `demo` | simulado | — |
| `claude` | `claude -p --output-format stream-json` en el worktree | lectura/edición + shell de andar por casa (node, npm, git sin push, grep, sed, cp…; sin rm/sudo/docker/ssh); `--strict-mcp-config`: no hereda tus MCP globales; puede ver sus capturas con `scripts/preview.mjs` |
| `codex` | `codex exec --json -s workspace-write` en el worktree | sandbox de Codex (el PO, `read-only`) |

Cada agente elige motor y modelo desde su panel (clic en el personaje o en su ficha).
Variables: `AO_PORT` (7420), `AO_HOST` (127.0.0.1), `AO_DATA_DIR`, `AO_CLAUDE_BIN`, `AO_CODEX_BIN`.

## Consumo de tokens (FT-26)

El Resumen muestra, por agente y sesión, los tokens gastados (↓ entrada · ↑ salida · ⚡ caché · total) y un total por proyecto, en vivo por el mismo SSE `state` (`agent.usage`, y `task.usage` acumulado entre intentos). Solo se guardan cifras, nunca prompts ni transcripts. Lógica en `server/usage.js`; prueba: `node scripts/usage-e2e.mjs`.

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

## Estructura

```
server/index.js     HTTP + API REST + SSE (/events)
server/team.js      proyectos, agentes, tareas, planificador, revisión
server/events.js    Activity Stream tipado (FT-1)
server/context.js   contexto de la UI para el Guide Agent (FT-2)
server/guide/       Guide Agent: tools + política + auditoría (FT-4), chats, prompt y proveedores (FT-6), voz STT en stt/ (FT-9), integraciones IDE/git/fs/terminal/browser (FT-10), visión de pantalla en vision.js (FT-23)
server/engines/allowlist.js  lista blanca de shell compartida por el motor Claude y terminal.execute (FT-10)
bin/ao-mcp.mjs      servidor MCP stdio del Guide (FT-4)
bin/stt-whisper.py  STT local con faster-whisper (FT-9)
server/desktop/     DesktopProvider: ventana activa/lista/captura, linux X11+Wayland GNOME, fake (FT-20); capture.js guarda capturas (FT-21)
server/git.js       worktrees, commit, diff, merge, estado frente a la base y actualizar con ella (FT-19)
server/engines/     demo · claude · codex (+ describe.js: herramienta → frase del bocadillo)
public/office.js    la oficina: pixel art en canvas, rutas por pasillos, bocadillos
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

Para verla sin navegador (y para que un agente pueda ver lo que pinta): `node scripts/preview.mjs out.png --wait 15000` levanta un servidor temporal con un equipo demo, captura la oficina con Chrome headless (WebGL por SwiftShader) e imprime los errores de consola y los fps. `--full` captura la página entera, `--query r=2d` fuerza el 2D.

## Créditos

- 3D: [Kenney](https://kenney.nl) *Furniture Kit* y *Mini Characters* (CC0, `public/assets/3d/`), [three.js](https://threejs.org) (MIT, `public/vendor/three/`).
