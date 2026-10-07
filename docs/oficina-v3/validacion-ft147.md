# FT-147 · Validación del entregable de diseño

8 de octubre de 2026. Se añaden documentos y contrato; no se modifica código runtime ni el contrato geométrico FT-146.

- `node --check public/app.js`, `public/office3d.js`, `public/office-layout.js` y `docs/oficina-v3/validate-ambient.mjs`: correctos.
- `node docs/oficina-v3/validate-ambient.mjs`: correcto, 25 bindings y rutas en límites en las cuatro plantas; referencias de fases, suma de duraciones y cupos del catálogo. Es validación del diseño, no test de colisiones GLB ni del scheduler implementado.
- `node scripts/building-e2e.mjs`: termina con **8 fallos**. Siete aserciones del edificio dependen de equipos/conteos que los fixtures esperan sin el coordinador automático: «Vacío» tiene coordinador y aparece como planta; cambia el orden, etiquetas y lista de personajes esperada. Después falla navegación con timeout de 30 s y no completa los casos restantes. FT-146 ya reportaba nueve fallos previos; esta ejecución no reproduce exactamente ese resultado y no se declara verde.
- `node scripts/preview.mjs resumen/FT-147-current.png --wait 3000`: captura única de la escena actual, inspeccionada, sin errores de consola; ~13 fps en headless. Se ven trabajo, descanso, Kanban, mesa «Tú» y paneles existentes. No es una captura de v3 implementada.
- `storyboard.svg`: rasterizado mediante canvas de Chromium e inspeccionado a 1920×1080; cuatro viñetas y leyenda legibles. Corregida la etiqueta de pregunta para separarla del rótulo Kanban.

Las capturas locales quedan en `resumen/` (ignorado por git). No se añaden endpoints, dependencias, agentes ficticios al SSE ni eventos decorativos. Los barridos de colisión Kenney, la capa adaptadora y las pruebas de transiciones quedan como criterios explícitos para la futura implementación, no como trabajo runtime realizado por esta tarea de diseño.
