# AO-6 · Decoración de la vista del edificio (diseño y datos)

Datos en `public/office-decor.js` → `default.building` (la lista `items` de la planta AO-5 no cambia).
Estado: **solo datos**; la escena (`public/office3d.js`) aún no los consume (lo hará Teo).
Captura de la vista actual del edificio (sin decoración nueva): `/tmp/AO-6-edificio-actual.png`.

## Coordenadas reales (office3d.js)
- Planta: 9,2 × 3,9 (`BUILDING_FLOOR_SIZE`), `SLAB_H` 0,14, `FLOOR_H` 3,49, planta i en `y = i·FLOOR_H`.
- `placeIn()` apoya en `SLAB_H` (0,14); el suelo interior visible llega a 0,19 → decoración con `y=0` va a 0,19.
- Azotea: `y = n·FLOOR_H + SLAB_H`; pretil de 0,3 en el borde. Exterior: acera a `y ≈ -0,01`.
- `placements` usan x,z locales de la planta (azotea/exterior: locales de la estructura).

## Análisis: qué se ve a esa escala
| Objeto AO-5 | Decisión | Motivo |
|---|---|---|
| plantas altas, librería, ventanas, sofás | se conservan (ya los construye `office3d.js`) | siluetas grandes |
| dispensador de agua, impresora | **nuevos** en cada planta (fondo, x 4,3 y 5,3, z 0,45) | reconocibles |
| plantas medianas/pequeñas, libros, archivadores, lámparas, mesas aux., papeleras, cajas, pósters, corchos, alfombras, vasos | se omiten | ruido a escala miniatura |

## Objetos nuevos (`building.items`)
| id | Origen | Dónde |
|---|---|---|
| water, printer | `sourceItem` → receta del item homónimo de AO-5 | cada planta |
| reception-counter | receta (mostrador madera/blanco/verde) | planta baja (solo planta 0 de proyecto) |
| bench | GLB Kenney `bench` | azotea (2,5 · 0,65) y exterior (1,65 · 5,65, giro π) |
| planter | receta (jardinera + 3 arbustos) | azotea (7,8 · 0,55), exterior (0,9 · 4,55) y (8,0 · 4,5) |
| streetlamp | receta | exterior (-1,2 · 3,0) y (11,7 · 3,2) |
| entry-sign | receta (cartel azul con flecha arriba, sin texto) | exterior (6,3 · 4,55) |
| bicycle | receta | exterior (6,6 · 5,65) y (8,1 · 5,65) |

Colores: solo hex de la paleta de `office-v3-data.js`. Ya existen y NO se duplican: ventanas, plantas altas, sofá, sombrilla, árboles, coches, ascensor (`building.existing`, solo documentación).

## Para el desarrollador (Teo)
1. En `buildStructure`/`buildFloorBlock` lee `OFFICE_DECOR.building`. Resuelve cada `placements.<frame>[].item` contra `building.items` (modelo → `place()`; `recipe` → cajas/cilindros centrados, `size` ya es el tamaño final; `sourceItem` → reutiliza el modelo/receta del item de AO-5 con el `size` indicado).
2. Frames: `floor` → grupo de cada planta (todas, también Dirección/Guía); `groundFloor` → solo planta 0 de un proyecto real; `roof` → grupo de la estructura a `n·FLOOR_H + SLAB_H`; `exterior` → estructura a `y = -0,01`. Rotación en radianes sobre Y.
3. No instancies `building.existing`. Respeta `building.clearance` (mesas, Kanban, reuniones, ascensor, aparcamiento, árboles) y no añadas rótulos ni interacción.
4. Tras integrar, valida con Box3 y captura: que nada tape las etiquetas HTML de planta ni los agentes. `scripts/office-decor-e2e.mjs` solo cubre la planta; `scripts/building-e2e.mjs` debe seguir en verde.

Verificación de esta tarea: `node --check public/office-decor.js` y `node scripts/office-decor-e2e.mjs` (OK).
