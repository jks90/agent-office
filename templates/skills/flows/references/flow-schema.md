# Schema `.flow.json` (flow-test 4.x)

Formato exacto que entienden la web, el CLI y el MCP. Un agente debe seguirlo **al pie de la
letra** cuando escriba flows a mano.

## Estructura de primer nivel

```json
{
  "version": "1.0",
  "name": "dominio-caso",
  "nodes": [],
  "infoNodes": [],
  "sqlNodes": [],
  "webNodes": [],
  "connections": [],
  "envVariables": {}
}
```

- Para flows de API usa `nodes` (HTTP), `sqlNodes` (si verificas BBDD), `connections` y
  `envVariables`; deja `infoNodes` y `webNodes` como arrays vacíos (salvo que quieras
  documentar el flow con una nota o un diagrama, ver InfoNode más abajo).
- `name` corto y descriptivo (`{dominio}-{caso}`), que coincida con el nombre del fichero.
- Opcionales de primer nivel: `environments` + `activeEnvironment` (5.3.0 — juegos de overrides
  con nombre sobre `envVariables`; el CLI los elige con `--env <nombre>`), `settings`
  (4.48.0 — vista/`webhook {token}`/`monitor {intervalMin, notifyUrl?, notify, rules?}` (5.17: `rules [{id, name, variable, op, value, message?}]` = vigilancia sobre las variables finales del run); los dos últimos
  publican automatización server-side al guardar el flow) y `drawings` (pizarra; solo si hay).

## RequestNode (`nodes[]`)

```json
{
  "id": "<uuid-v4>",
  "name": "Auth - Login",
  "curl": "curl -X POST \"{{apiBase}}/auth/login\" \\\n\n-H \"Content-Type: application/json\" \\\n\n-d '{\n  \"email\": \"{{email}}\",\n  \"password\": \"{{password}}\"\n}'",
  "position": { "x": 60, "y": 60 },
  "status": "idle",
  "extractions": [
    { "id": "<uuid-v4>", "varName": "token", "jsonPath": "$.accessToken" }
  ],
  "collapsed": false
}
```

Reglas:

- `curl` es un comando curl **bash completo**. Soporta `-X`, `-H`, `-d/--data-raw`,
  `--data-urlencode`, `-u` (basic auth) y `-F` (multipart). Las continuaciones de línea se
  escriben como `\\\n\n` (backslash + línea en blanco), como en los flows existentes.
- `{{variable}}` se interpola en cualquier parte del curl (URL, headers, body).
- `extractions[].jsonPath` se evalúa sobre el body JSON de la respuesta; el valor queda en
  `varName` para los nodos **posteriores**. Rutas tipo `$.data.items[0].id`.
- Un nodo pasa con status HTTP 2xx; cualquier otra cosa lo marca FAIL.
- `status` siempre `"idle"` en disco; `position.x` suele incrementarse ~520 por nodo en la
  misma fila (`y` constante).
- **`asserts`** (opcional, 5.3.0): condiciones extra para dar el nodo por bueno aunque el HTTP
  sea 2xx — el CLI sale con exit ≠ 0 si fallan. Lista de objetos con `id` (uuid) y `kind`:
  `{ "kind": "status", "expected": "2xx" | "200-204" | "200,201" }` ·
  `{ "kind": "jsonpath", "path": "$.data.id", "op": "exists" | "equals" | "not-equals" | "contains" | "gt" | "lt", "value": "..." }` ·
  `{ "kind": "time", "maxMs": 2000 }`. Ponles siempre un assert de status y uno de jsonpath a
  los nodos importantes: convierten el flow en un test de verdad.

## SqlNode (`sqlNodes[]`)

```json
{
  "id": "<uuid-v4>",
  "name": "BBDD - Último usuario",
  "position": { "x": 60, "y": 320 },
  "collapsed": false,
  "dbType": "mysql",
  "connectionProfileId": "mi-mysql",
  "host": "", "port": "", "database": "", "username": "", "password": "",
  "query": "SELECT id, email FROM users WHERE email = '{{email}}' LIMIT 1",
  "displayMode": "table",
  "status": "idle",
  "extractions": [
    { "id": "<uuid-v4>", "varName": "userId", "column": "id", "rowIndex": 0 }
  ]
}
```

Reglas:

- `dbType`: `postgres` | `mysql` | `oracle` (Oracle en modo thin).
- Conexión: por `connectionProfileId` (resuelto contra `sql-connections.json`, que se busca
  desde la carpeta del flow hacia arriba) **o** campos inline. Si el perfil no existe, se
  cae a los campos inline con un aviso. Postgres admite `jdbcUrl`
  (`jdbc:postgresql://host:5432/db?sslmode=disable&user=u&password=p`).
- `query` admite `{{variables}}`. **Ejecuta de verdad** (INSERT/UPDATE incluidos): solo
  entornos de prueba.
- `extractions`: `column` (nombre de columna) + `rowIndex` (0 = primera fila,
  **obligatorio**) → variable para los nodos siguientes.
- Los sqlNodes entran en el mismo grafo topológico que los HTTP: pueden ser origen o destino
  de una connection.

## InfoNode (`infoNodes[]`) — notas y diagramas

No se ejecutan (el CLI los ignora); documentan el flow dentro del canvas.

```json
{
  "id": "<uuid-v4>",
  "name": "Diagrama",
  "content": "graph TD\n  Cliente --> API\n  API --> BBDD[(BBDD)]",
  "position": { "x": 520, "y": 60 },
  "collapsed": false,
  "scripts": [],
  "renderMode": "mermaid"
}
```

- `renderMode` es opcional: sin él (o `"text"`) el `content` es texto libre; con
  `"mermaid"` (desde la **4.3.0**) es código Mermaid que la web renderiza como diagrama
  en vivo; con `"image"` + `imageSrc` es una captura. Admite `{{variables}}` en todos.
- `scripts` (`[{ "id", "varName", "code" }]`): JavaScript que hace `return` de un valor.
  Desde la **4.23.0 se ejecutan** al Run Flow / `flow_run` / CLI **antes de la primera
  petición** y su valor queda en `{{varName}}` (precedencia `envVariables` < scripts <
  `--var`). Úsalos solo cuando necesites datos únicos por ejecución (p. ej.
  `return 'qa+' + Date.now() + '@example.com'`); si no, `[]`.
- Los scripts corren en la página web (o en el CLI, sin `document`) y reciben `vars`; con
  `when: "after"` corren al acabar el run con todas las extracciones. Un array extraído llega
  como texto `"v1,v2,…"` y un objeto como `[object Object]`: extrae primitivos y parsea. Un
  script «after» también puede dibujar botones y paneles sobre FlowTest y llamar a `/mcp`
  desde la página (ver SKILL.md ▸ «Scripts que dibujan interfaz» y su contrato de higiene). Desde la 5.15 eso solo
  ocurre en flows **de confianza**: los abiertos de fichero, cloud o import corren en un sandbox sin
  página hasta que el usuario confía (chip de la barra).
- Por MCP se crean con `node_add_info` (`renderMode` text | mermaid | image).

## WebNode (`webNodes[]`) — vista de una web / modo Live

```json
{ "id": "<uuid-v4>", "name": "Panel admin", "url": "{{apiBase}}/admin", "position": { "x": 60, "y": 600 }, "collapsed": false, "status": "idle" }
```

Solo en la web (el CLI lo ignora). Por MCP: `node_add_web`. Útil para dejar a mano la web que
consume la API que prueba el flow.

## Enlaces entre flows en las notas (desde la 4.25.0)

En el `content` de una nota de texto: `[[otro-flow]]`, `[[otro-flow|texto]]` o
`[[otro-flow#Nombre de nodo]]` — la vista previa lo convierte en un enlace que abre ese flow del
proyecto (por nombre de fichero o de flow) y centra el nodo. Úsalo para enlazar el flow de login
desde los flows que dependen de su token, o un flow «índice» con el resto.

## Campos opcionales de cualquier nodo (colocación y estado)

Valen para `nodes[]`, `sqlNodes[]`, `infoNodes[]` y `webNodes[]`:

| Campo | Tipo | Para qué |
|-------|------|----------|
| `position` | `{x, y}` | Esquina superior izquierda en el lienzo (px, lienzo de 4000×3000). Solo visual; el orden de ejecución lo marcan las conexiones `next` |
| `collapsed` | bool | Caja plegada (una sola fila: icono-menú · plegar · estado · título · ▶) |
| `order` | entero | Nº de orden para **Alinear en fila / columna** (`canvas_layout row|column`) y la guía de nodos; los nodos sin `order` van detrás |
| `cell` | `{col, row}` (desde 1) | **Celda de cuadrícula**: `{col:1,row:1}` arriba a la izquierda, `{col:3,row:4}` = columna 3, fila 4. **`canvas_layout grid`** (y también `auto`) colocan cada caja en su celda: cada columna tan ancha como su caja más ancha, cada fila tan alta como la más alta (40 px de hueco). Es la forma recomendada de **diseñar la disposición a mano** desde la IA: asigna celdas y deja que el lienzo calcule las coordenadas |
| `pinned` | bool | 📌 Fijado: ningún relayout (alinear, auto, cuadrícula, separar, colapsar/expandir) ni el arrastre lo mueven |
| `disabled` | bool | **Desactivado** (4.31): Run Flow, cadenas, cron, `flow_run` y el CLI lo **saltan** pero sus conexiones se siguen recorriendo; el ▶ de la caja sí lo ejecuta. Útil para dejar pasos opcionales/destructivos preparados pero apagados |

Recomendaciones de disposición (lo que hace bonito un flow en pantalla):

- **Filas = capas del proceso, columnas = pasos**: `cell` `{col: paso, row: capa}`. Típico: fila 1 notas (texto con scripts + Mermaid), fila 2 la cadena HTTP principal, fila 3 las consultas SQL de verificación, fila 4 web/capturas.
- Si no quieres pensar celdas, da `order` = nº de paso y usa `canvas_layout row` (o `auto`, que sigue el grafo).
- Coordenadas a mano (`position`) solo si copias un flow existente: escalona ≥ 560 px en X para cards expandidas (420–520 px de ancho) y ≥ 520 px en Y (una request con respuesta mide ~470 px).
- Fija (`pinned`) lo que no quieras que ningún relayout toque (p. ej. una nota de cabecera).

## Pizarra (`drawings[]`, desde la 4.24.0)

Anotaciones dibujadas sobre el lienzo (`rect`, `ellipse`, `arrow`, `line`, `pen`, `text`).
Opcional; el CLI las ignora. Si un agente edita a mano un flow que ya las tiene, debe
conservarlas tal cual. Por MCP se añaden con `whiteboard_update` (mismas coordenadas que
`position` de los nodos: p. ej. un `rect` de `x: 40, y: 40, w: 1200, h: 400` rodea una fila de
cajas de 420 px de ancho, y un `text` con `fontSize: 24` encima la titula). Formato completo en
[`docs/flows-formato.md`](../../../docs/flows-formato.md#pizarra-drawings--desde-la-4240).

## Connection (`connections[]`)

```json
{ "id": "<uuid-v4>", "sourceId": "<node-uuid>", "targetId": "<node-uuid>" }
```

- Definen el **orden de ejecución** (topológico): un nodo corre cuando su origen termina OK,
  y ve las variables extraídas aguas arriba.
- `delayMs` opcional (4.34): pausa en ms antes de lanzar el destino cuando se recorre la flecha — web, CLI y MCP (`nodes_connect` / `connection_update`). Úsalo cuando el paso siguiente depende de un proceso asíncrono del backend (webhook, job).
- `behavior` opcional: `next` (por defecto — el único que ordena el grafo en CLI y «Run
  Flow»), `on_error`, `parallel`, `none` (interactivos de la web).
- Los nodos sin dependencias forman la primera capa y corren en paralelo.

## envVariables

```json
{
  "apiBase": "http://localhost:8080",
  "email": "qa@example.com",
  "password": "cambia-esto"
}
```

- Todos los valores son **strings**.
- Toda `{{var}}` usada en un curl o query debe existir aquí **o** venir de una extracción
  aguas arriba — si no, se queda sin interpolar tal cual (`{{var}}` literal en la petición).
- En ejecución se sobrescriben con `--var clave=valor` (CLI) o `variables_set` (MCP) — pon
  ahí las credenciales en vez de hardcodearlas en el curl.

## UUIDs

Genera UUIDs v4 reales y **frescos para cada** nodo/conexión/extracción
(`uuidgen`, `python3 -c "import uuid; print(uuid.uuid4())"` o el `crypto.randomUUID()` de
Node). Al importar por web/MCP se regeneran, pero en disco deben ser únicos dentro del flow.

## Ejemplo mínimo completo (login → llamada autenticada)

```json
{
  "version": "1.0",
  "name": "auth-login-listado",
  "nodes": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Auth - Login",
      "curl": "curl -X POST \"{{apiBase}}/auth/login\" \\\n\n-H \"Content-Type: application/json\" \\\n\n-d '{\n  \"email\": \"{{email}}\",\n  \"password\": \"{{password}}\"\n}'",
      "position": { "x": 60, "y": 60 },
      "status": "idle",
      "extractions": [
        { "id": "22222222-2222-4222-8222-222222222222", "varName": "token", "jsonPath": "$.accessToken" }
      ],
      "collapsed": false
    },
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "name": "Users - Listado autenticado",
      "curl": "curl \"{{apiBase}}/users\" \\\n\n-H \"Authorization: Bearer {{token}}\"",
      "position": { "x": 580, "y": 60 },
      "status": "idle",
      "extractions": [],
      "collapsed": false
    }
  ],
  "infoNodes": [],
  "sqlNodes": [],
  "webNodes": [],
  "connections": [
    { "id": "55555555-5555-4555-8555-555555555555", "sourceId": "11111111-1111-4111-8111-111111111111", "targetId": "33333333-3333-4333-8333-333333333333" }
  ],
  "envVariables": {
    "apiBase": "http://localhost:8080",
    "email": "qa@example.com",
    "password": "cambia-esto"
  }
}
```

> Los UUID de arriba son placeholders legibles: genera los tuyos.

## Ejecutar y diagnosticar

```bash
# Contenedor (lo habitual)
docker exec flow node cli/run-flow.js --flow flows/x.flow.json --report-root /tmp/resumen
docker exec flow node cli/run-flow.js --dir flows --report-root /tmp/resumen

# Instalación local del repo flow-test
node cli/run-flow.js --flow flows/x.flow.json --report-root /tmp/resumen

# Sobrescribir variables (credenciales, host del API…)
… --var apiBase=http://host.docker.internal:8080 --var password=otra
```

- **Exit code 1** si algún nodo falla (no-2xx o error SQL); `0` = todo verde.
- Report en `<report-root>/<fecha-hora>/`: `report.md` (resumen), `summary.json`,
  `all-runs.json`, `flows/*.run.json` y `debug/*.debug.md` — **el debug es lo primero que
  hay que leer al diagnosticar**: curl/query interpolados + request/response completos +
  variables extraídas.
- Flags útiles: `--timeout <ms>` (180000 por defecto), `--continue-on-error`, `--no-report`,
  `--skip-sql-nodes`, `--no-localhost-rewrite`, `--sql-connections <fichero>`.
- Desde el contenedor, `localhost` en los curl se reescribe a `host.docker.internal`
  (apaga con `--no-localhost-rewrite` o `FLOW_REWRITE_LOCALHOST=false`).
