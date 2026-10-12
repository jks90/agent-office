---
name: flows
description: Crear, ejecutar y verificar flows de flow-test (.flow.json) contra cualquier API REST — en vivo por MCP sobre el canvas del usuario, o como ficheros ejecutados con el CLI. Úsala cuando el usuario pida crear un flow, probar endpoints recién desarrollados o montar una batería de verificación.
user-invocable: true
---
# Flows skill

Tras terminar un desarrollo (o cuando el usuario lo pida), implementa los flows de flow-test
que ejercitan los endpoints afectados y ejecútalos para verificar la API de punta a punta.

> Copia esta carpeta (con `references/`) a `.claude/skills/flows/` de tu proyecto para
> activarla en Claude Code.

## Role

Actúa como un ingeniero de QA automation que domina la API objetivo y la herramienta
flow-test (web + CLI + MCP).

## Task

Crear o actualizar flows `.flow.json` que cubran los endpoints afectados, ejecutarlos y
reportar el resultado real (nunca asumido).

## Context

### Input
- El desarrollo recién terminado: endpoints nuevos/cambiados (git diff, spec o conversación).
- Los flows existentes del proyecto (habitualmente en `flows/`; créala si no existe).

### References
- [`references/flow-schema.md`](./references/flow-schema.md) — **el formato `.flow.json` al
  detalle**: nodos HTTP y SQL, conexiones, variables, extracciones, convenciones de curl,
  UUIDs, ejecución y diagnóstico. Síguelo exactamente al escribir flows.

### Tools
- **MCP `flow-test`** (si está conectado): construye y ejecuta en el canvas del usuario en
  directo. Endpoint típico: `http://localhost:9998/mcp` (contenedor) o `:3001` (local).
  Mapa de las 39 tools (5.17):
  - Observar: `bridge_status`, `flow_state` (pestañas con `filePath`/`dirty`; nodos con
    `position`/`order`/`pinned`; notas con `renderMode`/contenido/`scripts`; `drawings`),
    `console_read`, `runs_read`.
  - Pestañas: `flow_create`, `tab_select`, `tab_close`, `flow_overwrite` (copia sin enlazar).
  - Nodos: `node_add_request`, `node_add_sql`, `node_add_info` (text | mermaid | image, con
    `scripts`; 4.51: `when: 'after'` = corre al acabar el run con las extracciones en `vars`), `node_add_web` — todos aceptan `order`, `cell {col,row}`, `pinned` —,
    `node_update` (cualquier tipo y campo editable, incl. `cell`, `pinned`, `disabled`), `node_delete`,
    `nodes_connect`, `connection_update` (cambiar el behavior), `connection_delete`,
    `variables_set` (variables de la pestaña; 5.3: `environment`+`activate` para entornos con nombre), `global_variables_set` (globales), `tab_rename`,
    `sql_connections_list` (perfiles SQL para `connectionProfileId`).
  - Ejecutar: `flow_run`, `node_run`, `flow_reset`.
  - **Vigilar sin navegador (5.17):** `flow_monitor` — `set` programa el flow EN EL SERVIDOR cada `intervalMin` y define `rules`
    sobre las variables con las que termina el run (extracciones y scripts «después»): `{variable, op: gt|gte|lt|lte|equals|
    not-equals|contains|not-contains|changed, value, message?}`. El servidor avisa por POST a `notifyUrl` (Slack, Telegram, ntfy,
    n8n, o el `/hook/` de otro flow; admite `{{secret:X}}`) **solo cuando una regla se dispara, se recupera o el valor cambia** —
    no en cada run. Se publica al guardar: llama a `flow_save` después. `status` (sin pestaña web) devuelve el estado de cada
    regla y el último aviso; `clear` lo quita. Úsalo cuando el usuario pida «avísame si…», «vigila este dato», «alerta cuando…»:
    extrae el dato a una variable (o calcúlalo en un script `when: 'after'`), pon la regla y guarda — nada de `cron` ni
    `setInterval` en scripts de nota para esto.
  - Lienzo: `node_focus` (señalar un nodo al usuario), `canvas_layout`
    (`auto|row|column|grid|separate|collapse_all|expand_all|pin_all|unpin_all`; `grid` usa la celda `cell: {col,row}` de cada
    nodo — 1,1 arriba a la izquierda — que aceptan `node_add_*`/`node_update`; `separate` aparta
    solapes), `view_settings` (tamaño de las cards, modo compacto, separación mínima — la vista del
    usuario), `whiteboard_update` (anotar la pizarra; 5.3: `list`/`edit`/`delete` por elemento — por fin se puede mover/retocar un dibujo suelto sin reenviarlo todo).
  - **Proyecto `flows/`** (la carpeta del servidor = el panel Proyecto de la web):
    `flow_files_list` (con metadatos), `flow_open` (abre **enlazado** al fichero),
    `flow_save` (= Ctrl+S: enlaza la pestaña y la deja limpia; subcarpetas), `flow_file_delete`,
    `flow_file_read`.
  - **Correo de prueba** (4.37, sin pestaña web): `mail_state`, `mail_server` (`start|stop|configure`:
    puerto, dominio, `acceptAny`, `autoStart`; 4.42: `mailtmEnabled`, `mailtmPollMs`, `codeLength`, `codeRegex`), `mail_address` (`add|delete`; `provider: mailtm` = buzón remoto por API para correo desde Internet), `mail_messages`
    (`list|latest|read|delete|clear` con filtros `to/from/subject/since/q`). Un SMTP sandbox en
    `<host flow-test>:1025` (sin TLS, auth opcional): el servicio bajo prueba envía correos de verdad y
    tú los lees para verificar que salieron y sacar el OTP / enlace de confirmación.
- **CLI**: `docker exec flow node cli/run-flow.js …` (contenedor) o
  `node cli/run-flow.js …` (instalación local).

### Constraints (Step 0 — resuelve antes de nada; pregunta lo que falte, de una vez)
1. **¿Dónde corre la API objetivo?** (host y puerto → variable `{{apiBase}}`).
2. **¿Autenticación?** (ninguna / bearer estático / login que devuelve token / basic).
3. **¿Dónde corre flow-test?** (contenedor `:9998` por defecto / local).
4. Los flows **ejecutan de verdad** (HTTP con efectos y SQL con INSERT/UPDATE): apunta a
   entornos de prueba; ante endpoints destructivos, pregunta antes de incluirlos.
5. Un flow por dominio/caso: `flows/{dominio}-{caso}.flow.json`. Todas las URLs con
   `{{apiBase}}`; datos de prueba en `envVariables`, nunca hardcodeados en el curl.

## Steps

### Step 1: Scope
- Identifica los endpoints afectados y el camino realista que los encadena
  (crear → extraer id → consultar/limpiar).
- Si ya existe un flow que cubre el área (`flow_files_list` por MCP, o mira `flows/`),
  **ábrelo con `flow_open`** (la pestaña queda enlazada al fichero y conserva los ids) y
  actualízalo en vez de duplicar. `flow_state` te dice si la pestaña tiene cambios sin guardar
  (`dirty`) y a qué fichero está enlazada (`filePath`).

### Step 2: Implementar — elige el modo

> **🔴 REGLA DE ORO: si hay una pestaña web conectada, el Modo A es OBLIGATORIO.**
> La promesa central de flow-test es que la IA construye el flow **en el canvas del usuario
> mientras lo ve** — nodo a nodo, en directo. Escribir el `.flow.json` a disco por detrás y
> que el usuario tenga que recargar para "descubrirlo" **rompe el producto**: no lo hagas
> nunca teniendo el puente conectado, ni siquiera para flows grandes (para eso están
> `flow_overwrite` como base + ediciones en vivo encima). Comprueba `bridge_status` ANTES de
> decidir: solo si no hay pestaña conectada (y el usuario no puede abrirla) o si te piden
> explícitamente generación en lote/CI, cae al Modo B.

**Modo A — MCP en vivo** (el usuario ve el canvas):
1. `bridge_status`: si no hay pestaña web conectada, pide al usuario abrir la web y reintenta.
2. `flow_open` (flow existente) o `flow_create` (nuevo) → guarda el `tabId` y úsalo en todas
   las llamadas.
3. `node_add_request` / `node_add_sql` por paso, `nodes_connect` (behavior `next` ordena el
   grafo; `connection_update` para cambiarlo después). Guarda los `nodeId` que devuelven.
   **Disposición**: da a cada nodo una **celda `cell: {col, row}`** al crearlo — filas = capas
   (1 notas, 2 cadena HTTP, 3 SQL de verificación, 4 web/capturas), columnas = pasos — y al final
   `canvas_layout grid` (o `auto`, que respeta las celdas y ordena por el grafo lo que no tenga).
   Alternativa rápida: `order` = nº de paso + `canvas_layout row`. Si ves solapes, `canvas_layout
   separate`. Nunca calcules coordenadas a mano salvo que copies un flow existente.
   Pasos opcionales o destructivos que no deban correr por defecto: déjalos con `disabled: true`
   (se saltan en Run Flow/CLI; el usuario los activa desde el menú de la caja).
4. `variables_set` para la base (`apiBase`, credenciales de prueba); **asserts** en cada request que verifique algo (`asserts: [{kind:'status',expected:'2xx'}, {kind:'jsonpath',path:'$.id',op:'exists'}]` — son lo que convierte el flow en un test de CI); extracciones en cada
   nodo para encadenar (`jsonPath` en HTTP; `column`+`rowIndex` en SQL). Datos únicos por
   ejecución (emails, ids): un `node_add_info` con `scripts` (`return 'qa+' + Date.now() + '@x.com'`);
   cálculos sobre las respuestas (deltas, semáforos): un script con `when: 'after'` (`return Number(vars.total) > 0 ? 'OK' : 'VACÍO'`).
   **Scripts que dibujan interfaz (5.14):** un script de nota corre dentro de la página de FlowTest,
   así que puede pintar botones, un diálogo con pestañas, abrir un informe en pestaña nueva
   (`window.open`), descargar un CSV o **llamar al MCP desde la página** para reejecutar, cambiar
   Variables o abrir otro flow: `fetch('/mcp', {method:'POST', headers:{'Content-Type':'application/json',
   Accept:'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc:'2.0', id:1,
   method:'tools/call', params:{name:'flow_run', arguments:{}}})})` (sin sesión; con `FLOW_MCP_TOKEN`,
   `Authorization: Bearer`). Úsalo SOLO si el usuario pide botones/paneles/acciones, siempre con
   `when: 'after'` y con el contrato: guarda `typeof document === 'undefined'`, id fijo +
   `getElementById(ID)?.remove()` (una sola instancia), Shadow DOM, sin localStorage/Notification/
   setInterval ni relanzar el flow solo, botón ✕ y `return` de un texto de estado. Copia los modelos
   de la galería `scripts/04 Divisas` y `scripts/05 Tiempo`. Datos: las extracciones aplanan arrays a
   `"v1,v2,…"` (pares `[[ts,p],…]` → `"ts,p,ts,p…"`) y los objetos salen como `[object Object]`:
   extrae primitivos y parsea en el script.
   **Sandbox y confianza (5.15):** los flows que el usuario abre de disco, del cloud o importa
   corren sus scripts en un sandbox sin página (sin DOM, sin red); los que creas tú en su pestaña
   (`flow_create`) nacen de confianza y lo siguen siendo al guardarlos. Si un script que dibuja va
   en un flow abierto de fichero, la app le preguntará al usuario si confía en el flow antes de
   ejecutarlo: avísale (chip 🔒 → 🛡️ en la barra) y no intentes rodear el sandbox. Los scripts que
   solo calculan no necesitan nada.
5. Documenta dentro del canvas si aporta: `node_add_info` con `renderMode: "mermaid"` para el
   esquema del flujo, `whiteboard_update` para rodear/etiquetar grupos de cajas, y en el texto de
   las notas `[[otro-flow#Nodo]]` para enlazar flows relacionados del proyecto.
   **🔴 REGLA DE ORO: nada se pisa — ni nodo sobre nodo, ni nodo sobre pizarra.**
   `flow_state` da posiciones pero NO alturas renderizadas, y una caja puede ser mucho más
   alta de lo que imaginas (un Mermaid grande, una nota larga expandida, una respuesta
   pintada). Por eso:
   - Antes de colocar a mano, mira posiciones de cajas Y `drawings`, y deja aire (~80 px).
   - Cuenta con alturas reales: nota larga ≈ 600-900 px, Mermaid vertical ≈ el nº de nodos
     × 90 px. Si dudas, sobra espacio o usa `cell` + `canvas_layout grid`.
   - **Al terminar de construir, ejecuta SIEMPRE `canvas_layout separate`** — mide las cajas
     renderizadas de verdad y deshace cualquier solape que se te haya escapado (devuelve
     cuántas movió; si movió alguna, revisa el resultado con `flow_state`).
   - ⚠️ `separate` solo separa **nodos entre sí — la pizarra no la ve**. Si mezclas notas
     largas con bloques/tablas de pizarra, la única verificación fiable del conjunto es
     **visual**: captura headless del canvas (o pídele al usuario un vistazo) antes de dar
     la composición por buena. Entre filas de notas largas deja ≥1200 px.
   - Los dibujos de pizarra rodean o anotan cajas a propósito; un nodo plantado ENCIMA de un
     bloque de pizarra ajeno es un error de composición.
6. Al terminar, `flow_save` (sin `fileName` si la pestaña ya está enlazada; con subcarpeta
   `dominio/caso` si es nuevo) — equivale al Ctrl+S del usuario: el `.flow.json` queda en `flows/`
   y es ejecutable con el CLI. `node_focus` sobre el nodo clave para señalárselo al usuario.
7. Todo lo que hagas por MCP **se pinta en la pestaña del usuario al instante** (puente SSE): crea
   los nodos de uno en uno y en orden, nombra bien cada caja y comenta al usuario qué estás
   añadiendo — está mirando. `flow_state` te devuelve siempre el estado real (nodos, conexiones
   con id y behavior, variables de entorno/runtime/globales, vista). Si el flow es grande, sube la
   legibilidad con `view_settings` (`compactMode: 'always'` o `nodeScale: 0.75`) — es la vista
   del usuario, restáurala al acabar si la cambiaste.

**Modo B — Fichero + CLI** (sin MCP, o para CI): escribe el `.flow.json` siguiendo
[`references/flow-schema.md`](./references/flow-schema.md) — estructura exacta, convención
`\\\n\n` en los curl, UUIDs v4 frescos por nodo/conexión/extracción, toda `{{var}}`
declarada en `envVariables` o producida por una extracción.

### Step 3: Ejecutar y verificar
- **Si el caso envía correos** (registro, OTP, recuperación de contraseña): `mail_state` → si está parado
  `mail_server start` → `mail_address add {local}` → configura/pide al usuario que el servicio apunte a
  `<host>:<port>` sin TLS (en Docker `-p 1025:1025`; otro contenedor → `flow:1025`; otra máquina → IP o
  túnel `ssh -R`) → dispara la acción → `mail_messages latest {to, subject}` (reintenta unos segundos) →
  extrae el código/enlace de `message.text` y sigue la cadena. Para que el flow lo verifique solo, un
  nodo HTTP `GET {{flowBase}}/mail/messages/latest?to=…` con extracción JSONPath **`$.code`** (el código ya viene extraído; `$.codeSource` = keyword|fallback|regex — configura `codeLength`/`codeRegex` si el OTP no son 6 dígitos). Si el emisor está en la nube y no alcanza el 1025, `mail_server configure {mailtmEnabled:true}` y crea el buzón con `provider: mailtm` (el dominio activo lo da `mail_state`).
- Comprueba que la API objetivo responde antes de ejecutar (un curl a su health/status); si
  está caída, avisa en vez de ejecutar a ciegas.
- **MCP**: `flow_run` (scripts de notas → requests y SQL en orden topológico, con las pausas `delayMs`) o `node_run` sobre cualquier nodo (sigue sus flechas hacia cualquier tipo). Si un paso depende de un proceso asíncrono del backend, pon `delayMs` en la flecha (`nodes_connect`/`connection_update`) en vez de inventar reintentos.
  Espera el resultado y léelo: status por nodo, `runtimeVariables`, bodies. Si responde
  `finished:false`, lee el `reason` — no asumas que corrió.
- **CLI**: `… cli/run-flow.js --flow flows/x.flow.json --report-root /tmp/resumen`
  (+ `--var` para credenciales). Exit code `0` = verde; con `1`, lee
  `report.md` y `debug/*.debug.md` del report para diagnosticar.
- Diagnóstico: si el flow está mal, corrígelo (`node_update` o editar el fichero) y reejecuta;
  si la API está mal, **reporta el bug** con la evidencia del debug — no maquilles el flow
  para que pase.

## Output
- Flows nuevos/actualizados (en `flows/` vía `flow_save` — la pestaña del usuario queda enlazada y
  sin cambios pendientes —, o ficheros commiteables).
- Resumen de la ejecución: nodos passed/failed, variables extraídas, ruta del report.
- Si el proyecto versiona los flows y el run pasa: commit `test(flows): {descripción}`.

## Verification
- [ ] El flow es JSON válido y sigue el schema (version, nodes, connections, envVariables).
- [ ] Toda `{{variable}}` usada existe en `envVariables` o viene de una extracción previa.
- [ ] Verifica efectos, no solo status: tras un POST que crea algo, un GET (o nodo SQL)
      confirma que existe de verdad.
- [ ] La ejecución terminó en verde de verdad (exit 0 / `finished:true` con nodos OK) y el
      resultado reportado sale del run real, no de una suposición.
- [ ] Sin credenciales reales ni entornos de producción salvo petición explícita del usuario.
