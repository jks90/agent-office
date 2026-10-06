# FT-92 · Arquitectura del chat del Guía (cliente → servidor → agente)

Exploración sin cambios de código. Base para adjuntos en el chat (FT-90).

## Ruta de un mensaje

1. **Cliente** `public/app.js` `guideSend(text)`: añade el mensaje a `G.messages`, hace
   `fetch POST api/guide/chat` con `{chatId, text}` y cabecera `x-ao-client`. Lee la respuesta SSE a mano
   (eventos `chat|text|tool_call|tool_result|done|error`). La voz (STT) acaba en el mismo `guideSend`.
2. **Servidor** `server/index.js` `guideChat()`: `readBody` (límite 1 MB; `/api/upload` 40 MB, `/api/guide/stt` 12 MB,
   en la línea del `limit`) → `guide.chat({chatId, text, client})` → abre SSE y reenvía cada evento.
   El turno sigue aunque el navegador se desconecte.
3. **Orquestación** `server/guide/index.js` `chat()`: valida `text` (solo texto), crea/lee el chat
   (`data/` JSON), elige proveedor (`settings.guideProvider`), lo arranca una vez por chat con
   `provider.start({system: SYSTEM, model, resume, history, cwd})` y construye `<app_context>` (+ eventos nuevos
   + revisiones pendientes). Guarda `{role:'user', text, context}` y llama a `provider.send({text, context, client})`.
4. **Prompt del Guía** `server/guide/prompt.js` (`SYSTEM`, fijo por sesión). El contexto variable va en el
   mensaje de usuario, no en el system.
5. **Proveedores** `server/guide/providers/`:
   - `claude-cli.js`: proceso `claude -p` con stream-json por stdin; envía
     `content: [{type:'text', text: context + '\n\n' + text}]` (línea ~88). Un bloque `image` cabría aquí.
   - `common.js` (`anthropic-api`, `openai-api`, `local-api`): `turns.push({role:'user', text: context + text})`;
     el historial neutral solo guarda `text`. Habría que ampliarlo para imágenes.
   - `fake.js` para pruebas.

## Adjuntos reutilizables

- **Subida**: `POST /api/upload {files:[{name, data(base64)}]}` (`server/index.js`) → `data/uploads/<hex>/nombre`,
  devuelve `[{name, path, size}]` (los documentos extraen texto con `extractText`). Máx. 10 ficheros / 25 MB cada uno en cliente.
- **Servir**: `GET /api/file` (`serveUpload`) solo para `data/uploads` y `data/feedback`.
- **Cliente**: `pendingAttachments`, `attachArea()`, `uploadFiles()`, `renderChips()` y los listeners globales de
  change/paste/drag/drop, todos atados a **un único `#attach`** (id) → para el chat habría que parametrizarlos por contenedor.
- **Consumo en tareas** (`server/team.js`): `createTask`/`reject` separan imágenes (`png|jpe?g|webp`) de ficheros, `copyImages`
  y citan rutas en el prompt (`t.feedbackImages`, `t.files`); codex usa `--image`, claude las lee con Read.
- **Visión del Guía**: `server/guide/vision.js` `describeImage(file, question)` (Anthropic/OpenAI) lo usa la tool
  `screen.capture`; devuelve `NO_IMAGES` (501) si el proveedor no admite imágenes. Reutilizable para describir adjuntos.

## Qué falta para adjuntos en el chat

- `guideSend` y `guideChat`/`guide.chat` no aceptan `attachments`; `readBody` ya tolera el flujo si se sube antes con `/api/upload`
  (el chat solo enviaría rutas).
- Persistir `attachments` en el mensaje guardado y pintarlos en `guideRender`.
- Pasarlos al proveedor: en `claude-cli` como bloques `image` (base64) o citando la ruta; en `common.js`, ampliar `turns`.
- Parametrizar el área `#attach` (hoy única) y la whitelist de `server/context.js` si se publica algo nuevo.
