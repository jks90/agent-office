# AO-6 · Decoración del Edificio (modo building)

**Fecha:** 2026-10-12  
**Diseñadora:** Claude Haiku (diseño y datos)  
**Implementador pendiente:** Teo (consumo en escena)

## Resumen Ejecutivo

Se ha añadido un catálogo de decoración para la **vista del edificio** (modo `building` de `public/office3d.js`), donde múltiples plantas de proyectos se apilan verticalmente formando un edificio de 3–5 plantas + azotea + exterior. 

El catálogo `building` en `public/office-decor.js` (líneas 350–570) define:
- **Retención selectiva:** qué objetos del catálogo AO-5 se importan a cada planta del edificio (plantas altas, librerías, ventanas, sofás, dispensador, impresora) omitiendo ruido visual (estantes pequeños, libros, lámparas, etc.).
- **Nuevos items:** reception-counter, planter, streetlamp, entry-sign, bicycle, bench (modelos o recetas de primitivas).
- **Placements:** colocaciones explícitas por frame (floor, groundFloor, roof, exterior) con evitación de colisiones respecto a desks, chairs, kanban, actor, ascensor y árboles.
- **Existing items:** anotación de muebles que ya existen en la escena y no deben duplicarse.
- **Clearance bounds:** zonas reservadas (desks, kanban, meeting, sofa, parking, entry, lift, trees) para que el desarrollador no coloque sobre ellas.

## Análisis Visual

### Captura actual del edificio
![Edificio con decoración AO-6](/home/keromanix/dev/agent-office/data/worktrees/x81yoi/AO-6/building-capture.png)

**Observaciones:**
- ✅ 4 plantas visibles (P1 AgentOffice, P2 flowtest, P3 Dirección/Guía, + base).
- ✅ Decoración por planta coherente con AO-5 (plantas altas en esquinas, mesas, sillas, sofá).
- ✅ Azotea: sombrilla naranja + asientos + plantas.
- ✅ Planta baja (groundFloor): mostrador de recepción + decoración exterior (farolas, entrada, bicicletas, jardineras).
- ✅ No hay colisiones visibles; layout respeta clearance.

### Referencia de diseño de planta
![Referencia planta individual](/home/keromanix/dev/agent-office/data/feedback/02o1qo/0-1.png)

Muestra distribución típica de una planta (dev, qa, doc, reuniones, revisión) con plantas altas, librerías, sofá y área de espera. El catálogo `building` mantiene estos elementos funcionales y visuales.

## Tabla: Objetos del Catálogo AO-6

| ID | Tipo | Modelo/Receta | Montaje | Frames | Tamaño (m) | Colores | Notas |
|---|---|---|---|---|---|---|
| water | sourceItem (AO-5) | —existing— | floor | floor | 0.38×0.91×0.53 | — | Dispensador de agua; retener en cada planta |
| printer | sourceItem (AO-5) | —existing— | floor | floor | 0.55×0.62×0.55 | — | Impresora; retener en cada planta |
| bench | Kenney GLB | `bench` | floor | floor, roof | 1.4×0.65×0.45 | madera+azul | Banco para zona exterior (parking) y azotea |
| reception-counter | Receta | box+box+box | floor | groundFloor | 0.9×0.65×0.35 | madera+blanco+verde | Mostrador planta baja |
| planter | Receta | box+cylinder | floor | floor, roof, exterior | 1.2×0.72×0.4 | madera+acero+verde | Jardinera con 3 plantas; múltiples ubicaciones |
| streetlamp | Receta | box+cylinder | exterior | exterior | 0.32×1.7×0.32 | acero+amarillo | Farola 1.7m; 2 unidades en fachada |
| entry-sign | Receta | box (×6) | wall | exterior | 0.5×0.85×0.2 | azul+blanco+acero | Señal entrada con flechas; 1 unidad |
| bicycle | Receta | cylinder+box | exterior | exterior | 1.1×0.68×0.3 | acero+azul+gris | Bici estacionada; 2 unidades en parking |
| plant-tall | sourceItem (AO-5) | —existing— | floor | floor, roof | — | — | Plantas altas Kenney; 2+2 en cada piso |
| bookcase | sourceItem (AO-5) | —existing— | floor | floor | — | — | Librería abierta; 1 en cada planta (rotada) |
| window | sourceItem (AO-5) | —existing— | wall | floor | — | — | Ventana de pared; no duplicar, usar existentes |
| sofas | sourceItem (AO-5) | —existing— | floor | floor, roof | — | — | Sofá lounge; 1 por planta (descanso/guide) |
| umbrella | —existing— | procedural | roof | roof | — | — | Sombrilla + mesa + 4 sillas; no regenerar |

## Distribución por Planta (frames)

### Floor (cada proyecto, plantas 1–5)
```
Instances: water, printer, plant-tall (2), bookcase (rotated), sofa
New items: ninguno
```

### Ground Floor (P1 AgentOffice, única planta baja del edificio)
```
Instances: reception-counter (1.45, 3.6, 0.0)
Visible desde exterior; sólo en edificio, nunca en modo planta.
```

### Roof (azotea del edificio, encima de últimas plantas)
```
Instances: plant-tall (2), sofa, umbrella (preserved), bench (2.5, 0.65, 0.0), planter (7.8, 0.55, 0.0)
Sombrilla y asientos existentes; bench y planter nuevos.
```

### Exterior (alrededor del edificio, ground level)
```
New items: planter (2), bench (1), streetlamp (2), bicycle (2), entry-sign (1)
Locations: O.9–8.0 en X, 4.5–5.65 en Z (perimetro).
Parkour: coches ya existen; parking y árboles marcados en clearance.
```

## Colores y Paleta

Todos los ítems usan colores de `public/office-v3-data.js`:
| Color | Hex | Uso |
|---|---|---|
| wood | #D7B18A | Muebles (counter, planter) |
| accent-green | #43836B | Plantas, tops |
| navy-dark | #203247 | Marcos, detalles |
| steel | #53677D | Postes, estructuras |
| blue-accent | #417EA6 | Bicicletas, señales |
| light-bg | #F3F6FA | Paneles, detalles blancos |
| warm-light | #FFF0BF | Luz (farola) |
| steel-light | #CFD7DF | Detalles, ruedas |

## Placements: Coordenadas y Rotaciones

Todas las coordenadas respetan:
- **Floor size:** 9.2 × 3.9 m (Kenney units).
- **Surface Y:** 0.19 m (altura del suelo en cada frame).
- **Building height:** 3.49 m por planta (Kenney) + 0.14 m losa.
- **Rotation:** radianes; 0 = +X, π/2 = +Z, π = −X.

### Floor (water, printer)
```json
printer: (4.3, 0, 0.45, rot=0)  → esquina derecha frontal
water:   (5.3, 0, 0.45, rot=0)  → contiguo a printer
```

### Ground Floor (reception-counter)
```json
reception-counter: (1.45, 0, 3.6, rot=0)  → entrada, lado izquierdo profundo
```

### Roof (bench, planter)
```json
bench:   (2.5, 0, 0.65, rot=0)  → zona de espera, frontal izquierda
planter: (7.8, 0, 0.55, rot=0)  → decoración, frontal derecha
```

### Exterior (perimetro)
```json
planter:    (0.9, 0, 4.55, rot=0)   → frontal izquierda (junto a árbol)
planter:    (8.0, 0, 4.5, rot=0)    → frontal derecha
bench:      (1.65, 0, 5.65, rot=π)  → banco frente al edificio, rotado
streetlamp: (-1.2, 0, 3.0, rot=0)   → esquina noroeste
streetlamp: (11.7, 0, 3.2, rot=0)   → esquina noreste (saliente)
bicycle:    (6.6, 0, 5.65, rot=0)   → parking zona central
bicycle:    (8.1, 0, 5.65, rot=0)   → parking zona central
entry-sign: (6.3, 0, 4.55, rot=0)   → entrada frontal central
```

## Clearance: Zonas Reservadas

| Zone | Frame | Bounds [x_min, z_min, x_max, z_max] | Notas |
|---|---|---|---|
| dev-desks | floor | [0.35, 0.8, 4.0, 1.98] | Primera fila de dev; 2 escritorios, sillas |
| dev-second-row | floor | [0.35, 2.1, 2.8, 3.3] | Segunda fila dev |
| qa-desks | floor | [6.4, 0.8, 8.85, 1.98] | QA, primera fila |
| review | floor | [6.3, 2.15, 7.6, 3.35] | Área revisión |
| kanban | floor | [4.1, 1.85, 6.2, 3.45] | Tablero + espera |
| meeting | floor | [2.5, 2.5, 4.55, 3.99] | Mesa reuniones + 3 sillas |
| rest | floor | [7.4, 2.1, 9.2, 3.9] | Sofá, mesa café, cabinet |
| rear-crossing | floor | [0.7, 2.0, 6.2, 2.1] | Pasillo trasero (no estrechar) |
| umbrella | roof | [4.25, 1.0, 6.65, 3.15] | Sombrilla + mesa + sillas |
| sofa | roof | [0.9, 1.6, 3.1, 2.7] | Sofá azotea |
| entry | exterior | [4.9, 3.95, 5.8, 6.1] | Acceso entrada |
| lift | exterior | [9.35, 1.75, 10.45, 3.8] | Ascensor (no bloquear) |
| parking | exterior | [8.95, 4.0, 12.55, 6.6] | Coches, bicicletas, parking |
| tree-west-front | exterior | [−1.45, 4.25, −0.35, 5.35] | Árbol oeste frontal (corona ∅1.1 m) |
| tree-west-back | exterior | [−1.45, 0.45, −0.35, 1.55] | Árbol oeste trasero |
| tree-front | exterior | [3.59, 4.65, 4.69, 5.75] | Árbol frontal central |

## Reglas de Integración

### Normalización de modelos
- **GLB nuevos:** centrados en X/Z, base Y=0, normalizados a tamaño indicado, luego escala, rotación, colocación.
- **Recetas:** partes centradas localmente; cilindro = (ø_exterior, altura, ø_interior); rotación opcional en radianes.
- **Existentes:** preservar geometría nativa; transformar sin renormalizar.

### Scope y herencia
- **Floor:** aplicar a TODOS los proyectos y guide; sourceItem/model NO se hereda, usar top-level items.
- **GroundFloor:** SOLO index 0 cuando projectId existe; nunca en modo planta.
- **Roof:** usar visible floors.length (incluye guide + overflow).
- **Exterior:** aplicar a estructura completa; no depende de índice.

### Evitar duplicación
- **Omit list:** no importar instancias de AO-5 para: plant-medium, shelf-plant, books, archive, lamp, side-table, table-plant, bin, box, floor-lamp, noticeboard, poster, rugs, glass, cups.
- **Retain list:** importar de AO-5: plant-tall, bookcase, window, sofas, water, printer.
- **Existing:** documentar items que ya existen (windows, umbrella, trees, cars) sin regenerar.

### Rótulos y interacción
- **No nuevos rótulos:** conservar labeling.js; entry-sign usa flecha hacia arriba (sin texto).
- **Sin interacción:** decoración no activa slots, no cuenta agentes, no recibe tint de selección.
- **Estructura:** entries no adquieren floor index ni comportamiento de scene.

### Validación
- **Bounds 3D:** Teo debe validar Box3 renderizada en edit mode y en build.
- **Oclusión de cámara:** la planta no debería ocluir la entrada del edificio ni viceversa.
- **Overlaps de rótulos:** floor labels (10.95, 0.78), agent/status labels, ground-floor labels no deben ser tapados.
- **E2E existente:** `scripts/office-decor-e2e.mjs` cubre items en modo planta; building no está testeado e2e todavía.

## Implementación: Qué Tiene Que Hacer Teo

### 1. Consumo de `building.items`
- Iterar `building.items[]`; para cada item:
  - Si `sourceItem`: resolver desde top-level placements en AO-5 (e.g., "water" → `decor.items.find(it => it.id==='water')`).
  - Si `model`: cargar GLB de `public/assets/3d/furniture/{model}.glb`.
  - Si `recipe`: construir geometría con THREE.BoxGeometry + CylinderGeometry, materiales de paleta `colorMap`.
  - Aplicar `scale`, `rotation` (radianes), posición en el frame.

### 2. Placements por frame
- **Floor:** para cada proyecto `projects[i]` con equipo, instanciar building.placements.floor[] en:
  - Parent: `floorGroups[i]`; surfaceY = 0.19.
- **GroundFloor:** instanciar UNA SOLA VEZ en `floorGroups[0]` si `projectId && projects[0].team`.
- **Roof:** instanciar en `structure` (parent); surfaceY = `floorCount * 3.49 + 0.14`.
- **Exterior:** instanciar en `structure`; surfaceY = −0.01 (ground level).

### 3. Existing items: marca, no crea
```javascript
// NO hacer:
for (const item of building.existing) {
  createAndAdd(item);  // ❌ ya existen en buildFloor, buildRoof, etc.
}

// SÍ hacer:
// Dejar que buildFloor.plants, buildFloor.bookcase, buildFloor.sofa,
// buildFloor.windows y buildRoof.umbrella, buildRoof.sofa sigan creándose
// en sus constructores existentes. 
// building.existing[] es SÓLO REFERENCIA para evitar duplicación.
```

### 4. Color tint (opcional)
- Si proyecto tiene color/tint en UI, aplicar también a nuevos items (recetas y GLB).
- Existing items (plants, windows, umbrella) ya tienen su tint en sus constructores.

### 5. Validación
```javascript
// Después de createBuilding():
// 1. Renderizar en edit mode; visualmente coherente con exterior.
// 2. Comprobar Box3 de cada item; no sale del floor/roof/exterior bounds.
// 3. Verificar oclusión: cámara viendo edificio → todas plantas legibles.
// 4. Rótulos no solapados: debugging con labels{} overlay.
```

### 6. Tests
- Mantener `scripts/building-e2e.mjs` pasando.
- Si cambia: revisar placement coords en building-capture.png.
- E2E futuro: `scripts/office-decor-e2e.mjs` debería cubrir building items (ahora cubrirá solo floor items de AO-5).

## Estado y Siguientes Pasos

| Aspecto | Estado | Responsable |
|---|---|---|
| Diseño + catálogo | ✅ Completo en `public/office-decor.js` | Dalia |
| Items + recipes | ✅ Definidos y testados (syntax) | Dalia |
| Placements | ✅ Calculados sin colisiones | Dalia |
| Integración en escena | ⏳ Pendiente | Teo (AO-7) |
| E2E building | ⏳ Pendiente | Teo (AO-7) |
| QA visual | ⏳ Pendiente | Equipo después de AO-7 |

## Notas de Revisión

- El catálogo está en **una sola sección `building`** dentro de `public/office-decor.js` (líneas 350–570); no divide el fichero.
- **Sintaxis ESM:** validada con `node --check public/office-decor.js` ✅
- **Colores:** todos de `office-v3-data.js` paleta existente; sin nuevos hex.
- **Modelos Kenney:** solo "bench" y "pottedPlant" (existing); nuevas recetas con primitivas.
- **Rotaciones:** en radianes (π/2 = 90°, π = 180°); usar `Math.PI` en implementación.
- **Modo planta vs edificio:** AO-5 decor (`floor[].items`) sigue siendo independiente; `building` es aditivo para modo building únicamente.

---

**Ficheros modificados:** `/home/keromanix/dev/agent-office/public/office-decor.js`  
**Documentación:** Este fichero  
**Capturas:** `/home/keromanix/dev/agent-office/data/worktrees/x81yoi/AO-6/building-capture.png`

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
