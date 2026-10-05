# Assets Kenney (CC0) para la oficina

Dos hojas de sprites de [Kenney](https://kenney.nl), licencia **CC0** (dominio público; crédito opcional, lo damos en el README):

| Fichero | Hoja | Tamaño | Rejilla |
|---|---|---|---|
| `public/assets/kenney/indoor.png` | Roguelike Indoors | 458×305 | 27 col × 18 filas |
| `public/assets/kenney/characters.png` | Roguelike Characters | 918×203 | 54 col × 12 filas |

**Tiles de 16×16 px con 1 px de margen** → paso de 17 px. Para el tile (col, fila):
`sx = col * 17`, `sy = fila * 17`, `sw = sh = 16`. Dibujar con `drawImage(img, sx, sy, 16, 16, dx, dy, 16*S, 16*S)` y `imageSmoothingEnabled = false`.

Las referencias con cuadrícula numerada están en `docs/in-a.png` (interiores col 0–13), `docs/in-b.png` (col 13–26), `docs/ch-a.png` (personajes col 0–17), `docs/ch-b.png` (col 18–35) y `docs/ch-c.png` (col 36–53).

## Interiores (`indoor.png`) — coordenadas (col, fila)

**Mesas de madera** (CADA FILA ES UNA MESA COMPLETA de 1 tile de alto; la fila 1 es la misma mesa con patas más largas, no «el frente»):
- Mesa 3 de ancho: (0,0) izquierda · (1,0) centro · (2,0) derecha. Se alarga repitiendo el centro. Para un escritorio con más cuerpo se pueden apilar la fila 0 encima de la fila 1.
- Mesa ovalada 2 de ancho: (3,0),(4,0) (o la variante (3,1),(4,1)). Mesas de 1 tile: (5,0), (6,0), (7,0).
- Mesas de 1 tile: (4,2)…(7,2) y filas 3–5 cols 4–7 (variantes).

**Sillas** (cada fila es un estilo; col 0 = mirando abajo/frente, col 1 = de espaldas/mirando arriba, col 2 = mirando derecha, col 3 = mirando izquierda):
- Fila 2: cojín naranja · fila 3: cojín naranja (var.) · filas 4–5: madera lisa · filas 6–7: respaldo alto, cojín · fila 8: gris.
- Para un agente sentado tecleando de cara al monitor (que está al fondo de la mesa) usa la silla **de espaldas (col 1)** y pinta el personaje encima.
- La silla de la col 2 tiene el respaldo a la IZQUIERDA (mira a la derecha → va a la izquierda de una mesa); la de la col 3 al revés.

**Bancos** (fila 6–8, cols 4–7, 2 de alto): banco largo (4,6),(5,6),(6,6),(7,6) / fila 7 frente.

**Estanterías con libros** (2×2, fila superior/inferior):
- Naranja: (8,0),(9,0) / (8,1),(9,1) · otra: (12,0),(13,0) / (12,1),(13,1).
- Verde: (8,2),(9,2) / (8,3),(9,3) · (14,0),(15,0)… · beige: (8,4),(9,4) / (8,5),(9,5).

**Plantas:** maceta grande (16,0) · maceta pequeña (17,0). Cuadro pequeño con paisaje (18,0).

**Velas / candelabros:** (19,0)…(22,3) (opcional, ambiente). Antorchas de pared (20,6),(21,6),(22,6).

**Sofás** (CADA FILA ES UN SOFÁ COMPLETO de 1 tile de alto; las filas 9 y 11 son variantes, no «el frente»):
- Naranja 3 de ancho: (16,8),(17,8),(18,8). Naranja redondeado 2 de ancho: (19,8),(20,8).
- Verde 3 de ancho: (16,10),(17,10),(18,10). Verde redondeado: (19,10),(20,10).
- Sillones de 1 tile: (0,9)/(0,10) naranja, (6,9)/(6,10) verde…

**Camas** (cols 23–26, filas 10–17): cama doble naranja (23,11),(24,11)/(23,12),(24,12)/(23,13),(24,13) y verde en filas 15–17; camas individuales en cols 25–26. La fila 10/14 es el cabecero suelto.
**Alfombras:** no hay un tile de alfombra claro en esta hoja (cols 23–26 filas 0–7 son cortinas/empapelado): **la alfombra se dibuja a mano** (`drawRug`).

**Cuadros:** pequeños (16,12),(17,12),(18,12),(16,13),(17,13),(18,13) · grandes apaisados (19,12)+(20,12), (19,13)+(20,13) · teal largo (16,14),(17,14),(18,14) · naranja largo (16,15),(17,15),(18,15) · retratos (19,15),(20,15),(21,15) · mapa (16,17),(17,17),(18,17).
**Espejo:** (22,14)/(22,15). **Piano:** (23,8),(24,8) / (23,9),(24,9). **Armarios altos:** (25,8)/(25,9), (26,8)/(26,9).

**Cocina / rincón del café** (fila superior = encimera con pared gris, inferior = frente):
- Encimeras: (0,12)…(3,12) / (0,13)…(3,13); con cajones (0,14)…(3,14).
- Encimera con platos (4,12), con fruta/verduras (5,12),(6,12), con vasos (7,12).
- Fregadero (8,12)/(8,13) · **Cocina/hornillo negro** (14,14)/(14,15) → vale como «cafetera grande» · **Frigorífico** gris alto (13,14)/(13,15)/(13,16).
- Altavoces/cajas negras (14,16),(15,16)/(14,17),(15,17) (decoración).

**Paredes de madera / zócalos:** cols 12–13 filas 12–17 (paneles), cols 23–26 filas 10–17 (empapelados).

No hay ordenadores ni monitores en esta hoja: **el monitor se sigue dibujando a mano** (16×12 unidades, con el código animado) encima de la mesa.

## Personajes (`characters.png`) — por capas

Un personaje = **cuerpo + camiseta + pelo (+ sombrero/accesorio)**, todos tiles de 16×16 que se superponen en el mismo sitio, en ese orden. **Solo hay vista frontal** (sin animación de andar): para andar, balancea 1–2 px arriba/abajo y voltea horizontalmente (scale -1) para izquierda/derecha; de espaldas (sentado) usa cuerpo + camiseta + pelo sin cara (col 1 es la variante con boca abierta; para «espaldas» basta pintar el pelo «completo» (22,x) encima del cuerpo).

**Cuerpos (tono de piel):** (0,0) claro · (0,1) tostado · (0,2) moreno · (0,3) verde (no usar). Col 1 = misma piel con la boca abierta (hablar).
**Zapatos/manos pequeñas:** col 3–4 filas 0–9 (opcional).

**Camisetas** (cols 6–17; col 6 = lisa, 7 = con cuello, 8 = cuello blanco, 9 = chaleco):
- Naranja: fila 0 cols 6–9 · teal: fila 0 cols 10–13 · lila: fila 0 cols 14–17.
- Fila 1: variantes con capa/corbata (6,1) naranja chaleco… · fila 2: (6,2) cruzada.
- Verde: fila 5 cols 6–9 · marrón: fila 5 cols 10–13 · **negro/gris oscuro: fila 5 cols 14–17**.
- Blanco/beige: fila 4 cols 10–13 · armadura clara fila 4 cols 6–9.
- Para el **color del rol** (PO lila, back azul, front rosa, QA verde): pinta la camiseta y luego **tiñe** (globalCompositeOperation `source-atop` con el color del rol al 55 %) solo esa capa.

**Pelo** (cols 19–22 un color, 23–26 otro; col 19 = corto, 20 = melena, 21 = flequillo, 22 = melena completa):
- Castaño: filas 0–1 cols 19–22 · naranja: filas 0–1 cols 23–26.
- Barbas/bigotes: fila 2 cols 19–26 (castaño/naranja) · coletas/moños: fila 3.
- Rubio: filas 4–5 cols 19–22 · **negro:** filas 4–5 cols 23–26 · canoso/blanco: filas 8–9 cols 19–22.

**Sombreros/cascos:** cols 28–31 filas 0–1 (capuchas con plumero de color), fila 6 cascos con cuernos, fila 7 **sombreros de ala** (28,7) naranja… → vale como gorra del front; fila 8 sombreros puntiagudos.
**Gafas:** no hay → dibujar a mano 2×1 px encima de los ojos. **Cascos de música (back)** y **corbata (PO)**: dibujar a mano (ya existen en el código).

Ejemplos ya compuestos para ver el resultado: cols 0–1 filas 5–11.
