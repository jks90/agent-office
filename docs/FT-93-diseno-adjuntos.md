# FT-93 · Diseño UX/UI de adjuntos del chat del Guía

Decisiones del cliente (vía `ao-ask`) y una decisión propia (c).

| | Decisión | Origen |
|---|---|---|
| (a) Botón | 📎 «Adjuntar» **junto a Enviar, a la derecha** | cliente |
| (b) Miniaturas | **40 px**, chip en línea | cliente |
| (c) Drag & drop | Recuadro discontinuo sobre el chat «Suelta aquí para adjuntar» | propia (no se preguntó; ya existe, conservadora) |
| (d) Límites | **10 ficheros · 25 MB c/u · 30 MB total** (los del servidor, `server/uploads.js`) | cliente |

## Mockup

```
┌ Chat del Guía ───────────────────────────────┐
│  … conversación …                            │
│                                              │
│ ┌ chips (sobre la caja, con salto de línea) ┐│
│ │[▢40 foto.png 120 KB ✕] [📄 log.txt 3 KB ✕]││
│ │ 2/10 · 0,1/30 MB                          ││
│ └───────────────────────────────────────────┘│
│ ┌──────────────────────────────┐ [📎] [Enviar]│
│ │ Escribe al Guía…             │              │
│ └──────────────────────────────┘              │
└──────────────────────────────────────────────┘
Arrastrando:  todo el chat se tapa con un recuadro
              discontinuo + «Suelta aquí para adjuntar»
```

## Especificación

- **(a)** Orden de la fila inferior: caja de texto (flexible) · 📎 (botón icono, 32 px, `title`/`aria-label` «Adjuntar») · Enviar. Ctrl+V con ficheros en el portapapeles sigue funcionando; el texto pegado no cambia.
- **(b)** Chip de 40 px de alto: imagen → miniatura cuadrada 40×40 (`object-fit: cover`) + nombre truncado + tamaño; otros ficheros → icono 📄 + nombre + tamaño. ✕ siempre visible (no solo en hover). Los chips envuelven en varias líneas; más de ~2 líneas → scroll interno con máximo de alto. Estado «subiendo» con opacidad reducida y spinner; error en rojo con reintento/✕.
- **(c)** Durante `dragenter` con ficheros: borde discontinuo de acento, fondo translúcido, texto centrado «Suelta aquí para adjuntar». Se retira en `dragleave`/`drop`. No se activa si lo arrastrado es texto.
- **(d)** Contador discreto «2/10 · 0,1/30 MB» bajo los chips, visible solo con adjuntos; ámbar al ≥ 80 %. Al superar un límite no se adjunta el excedente y aparece aviso claro («foto.png supera 25 MB», «máximo 10 ficheros», «el envío superaría 30 MB»). Con 10 ficheros el 📎 se deshabilita.
- Se puede enviar solo con adjuntos (sin texto). Al enviar la lista se vacía y el mensaje del historial muestra las miniaturas/ficheros enlazados.

## Impacto en la implementación existente (FT-90/FT-95)

Hoy el 📎 está sobre la caja (`.g-attach` en `public/app.js`) y los chips usan otro tamaño: ajustar a la posición y tamaño de arriba, y añadir el contador. Sin cambios de API ni de límites.
