# Extensión «Navegador del agente» (FT-118)

Extensión Manifest V3 para Chrome/Brave que deja a AgentOffice usar **tu navegador real** (con tus sesiones iniciadas) mediante `chrome.debugger` (CDP). Implementa el mismo contrato `BrowserDriver` que el Chromium dedicado (FT-114).

## Instalación en Brave (o Chrome)

1. Abre `brave://extensions` (Chrome: `chrome://extensions`) y activa **Modo desarrollador**.
2. **Cargar descomprimida** → elige esta carpeta `extension/`.
3. Fija el icono de AgentOffice en la barra.

## Emparejar

1. En AgentOffice: **Ajustes ▸ Navegador del agente → «Mi navegador (extensión)»** y pulsa **Generar código de emparejamiento** (8 caracteres, caduca a los 5 min, un solo uso).
2. En el popup de la extensión deja la URL `ws://127.0.0.1:7420/api/browser/ext` (cambia el puerto si usas `AO_PORT`), pega el código y pulsa **Conectar / emparejar**.
3. Ajustes mostrará 🟢 conectada.

El servidor te da una clave de sesión que la extensión guarda **solo en `chrome.storage.session`** (se borra al cerrar el navegador; entonces hay que emparejar de nuevo). AgentOffice guarda únicamente su hash. El token `x-ao-token` no se usa: el WebSocket solo se acepta desde loopback y rechaza cualquier `Origin` web. «Olvidar extensión» en Ajustes invalida las claves.

## Qué puede hacer el agente

Solo actúa en las pestañas que le **cedas**: abre la pestaña y pulsa **«Dejar al agente esta pestaña»**. Esa pestaña pasa a un grupo de pestañas morado «AgentOffice»; «Quitar esta pestaña al agente» la suelta. Las pestañas que abra el agente (`tabs.new`) también entran en el grupo. Solo se ceden páginas `http(s)` y nunca la propia AgentOffice.

Chrome/Brave mostrará la barra «AgentOffice Navegador del agente está depurando este navegador»: es el aviso de `chrome.debugger` y es esperado; desaparece al quitar la pestaña.

## Paridad con el driver CDP (FT-136)

La extensión cumple el mismo contrato que `server/browser/cdp.js`:

- **`browser.upload`** — `DOM.setFileInputFiles` sobre el `<input type=file>` (comprueba tipo y `multiple`; las rutas ya las valida AgentOffice). Ya no devuelve 501.
- **`browser.readPage`** — el servidor evalúa en la pestaña cedida la misma expresión de modo lectura (`readPageExpr`) y pagina con `offset`/`max`/`section`.
- **settle** — `act`, `type`, `upload` y `scroll` esperan red en reposo (~400 ms sin peticiones vivas) y DOM estable (~300 ms, tope 3 s; 1,5 s en scroll) y devuelven `settle: {networkIdle, domStable, waitedMs}`.
- **`screenshot` `detail:'low'` / `region`** — `low` = JPEG q50 de ≤800 px; `region:{x,y,w,h}` (px CSS del viewport) hace zoom (hasta ×2) y devuelve `scale`, `originX`, `originY`.

Se prueba con el cliente simulado de `node scripts/extension-e2e.mjs`; con Chromium real queda como prueba manual.

## Limitaciones conocidas

- El snapshot cubre el documento principal de la pestaña (los iframes no se recorren, a diferencia del driver CDP).
- Si abres DevTools en una pestaña cedida, Chrome suelta el depurador: vuelve a cederla.
- Si el service worker se suspende se reconecta solo con la clave de sesión.

## Prueba manual

1. Empareja como arriba y cede una pestaña con una web cualquiera.
2. Con `browserMode = extension`, ejecuta (hasta que las tools `browser.*` estén expuestas) un script con `getDriver()` de `server/browser/index.js` dentro del proceso del servidor, o usa `node scripts/extension-e2e.mjs` para la parte de protocolo.
3. Comprueba: `tabs.list` solo muestra las cedidas; `snapshot` devuelve refs `eN`; `act` por ref hace clic; `screenshot` crea el PNG en `data/browser/captures`; sin pestañas cedidas todo da 503.
