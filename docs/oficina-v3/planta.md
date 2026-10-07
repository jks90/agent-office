# FT-146 · Oficina v3: la planta se entiende antes de animarse

**Entregable de diseño, no implementación.** Fecha: 8-oct-2026. El cliente confirmó mediante `ao-ask`: «Crear el entregable según el briefing actual». Este checkout parte de `5e1d864`: no contiene commits FT-146 ni el intento anterior citado en la petición; no se ha supuesto una revisión inexistente.

## 1. Cómo leer el paquete

- [Contrato ejecutable de geometría](visual-contract-v3.json): autoridad para coordenadas, capacidad, anclajes y paleta; cuatro plantas explícitas, sin fórmulas que el implementador deba adivinar.
- [Planta isométrica](mockups/planta-iso.svg) y [cenital](mockups/planta-cenital.svg): SVG vectoriales dibujados con geometría manual, 1920 × 1080; sus PNG homónimos son rasterizaciones de esos SVG, no imágenes generadas por IA.
- [Captura de la planta existente](planta-actual-ft146.png): referencia de regresión, **no** una captura de la propuesta implementada.
- `render-mockups.mjs`: comprueba contrato y SVG y produce los dos PNG con el Chromium y `puppeteer-core` de desarrollo ya disponibles. Ejecutar desde la raíz: `node docs/oficina-v3/render-mockups.mjs`.

La muestra tiene **cinco agentes**: Ana trabajando, Bruno revisando, Carla esperando, Diego bloqueado y Elena con fallo. Visita y Limpieza son los **dos personajes de ambiente**. Los identificadores DEMO, los dos avisos y los textos de paneles son fixtures, no datos de producción. No hay PO en esta muestra: el despacho se ve, pero está vacío. «Tú» es la representación existente del usuario, no un sexto agente de IA.

## 2. Composición y jerarquía

Tres bandas, con frente y lateral derecho abiertos a la cámara:

| Banda | Izquierda → derecha | Motivo |
|---|---|---|
| Fondo | Reuniones · PO · **Tú** | Los perfiles clave tienen sitio propio, sin competir con las mesas; el PO no sustituye al usuario. |
| Centro | Trabajo · Revisión/QA · Kanban/espera | Toda la actividad real está agrupada y se puede leer en una pasada. |
| Frente | Café/descanso · Recreo · Recepción | La vida decorativa tiene acceso directo desde la puerta sin atravesar puestos. |

Orden de atención: **Tú/avisos → fallo/bloqueo → agentes activos → Kanban → ambiente**. La mesa «Tú» es más ancha que las demás (1,85 u frente a 1,25 u), tiene borde doble dorado, nombre permanente y burbuja de avisos. El PO tiene acento violeta y rótulo propio, pero no halo de notificaciones. Una señal de error permanece visible aunque no existan avisos para el usuario.

No se imita la referencia píxel a píxel: se conserva su diorama isométrico, dos paredes de fondo, muebles de madera, colores amables y tablero reconocible; se separan funciones que ahora comparten el mismo suelo. La decoración es secundaria: plantas solo en bordes, sin nuevas estanterías entre cámara y personajes.

## 3. Zonas y decisiones

| Zona | Equipamiento / ocupación | Por qué aquí |
|---|---|---|
| 🖥️ **Trabajo** (`development`) | Islas de dos columnas de mesas; grupos contiguos por rol real, con subrótulos Frontend/Backend/Documentación solo si esos roles existen. Monitor, silla y puesto fijo por agente. | El trabajo tiene una dirección visual común. Documentación deja de tener una alfombra suelta: mantiene identidad mediante la isla de rol. |
| 🔍 **Revisión / QA** (`qa`) | Puestos de pruebas/revisión en la banda central; monitor con señal de QA o revisión, silla reservada por ocupante. | La comprobación queda separada de implementar; compartir espacio no equivale a compartir estado. Los iconos y burbujas dicen si prueba, revisa o está bloqueado. |
| 🗂 **Kanban / espera** (`board`) | Tablero compacto orientado hacia la cámara; cuatro columnas reales TODO/DOING/REVIEW/DONE; slots de espera detrás de su cabecera, no delante del texto. | Quien está en cola se encuentra junto a la cola. El tablero no crece hasta convertirse en una pared que tape media oficina. |
| 🤝 **Reuniones** (`meeting`) | Sala acristalada con mesa, cuatro sillas y puerta; perfiles bajos, vidrio sin reflejos y retirada de caras que oculten etiquetas. | Se reconoce como sala separada, sin cerrar el diorama. El snapshot no demuestra reuniones: vacía o con ambiente explícito, nunca se interpreta «manager» como reunión real. |
| ☕ **Café / descanso** (`idle`) | Máquina, mostrador, mesa y sofá de dos plazas. Un agente realmente libre puede permanecer sentado; no recorre rutas de ambiente. | Comunica disponibilidad sin fingir actividad. Si hay más de dos libres, los restantes permanecen en sus puestos con estado libre; no se apilan ni se inventa café. |
| 🎮 **Recreo** (`recreation`) | Futbolín y sofá; solo personajes de ambiente en esta versión. | Aporta variedad sin confundir ocio con trabajo del equipo. No tiene contador de tareas ni fichas de agentes. |
| 🧭 **PO · despacho** (`po`) | Mesa propia y silla; ocupada solo por un PO realmente presente y con estado compatible. | Destaca la responsabilidad del producto sin inventar un dirigente. Un coordinador o un rol normalizado `manager` no basta para identificar un PO. |
| 👤 **Tú · avisos** (`user`) | Mesa prioritaria, representación FT-124 y anclaje `user-bell`; misma colección `mine` que «Para ti». | El usuario encuentra dónde intervenir de inmediato. Clic en mesa/burbuja conserva la bandeja filtrada por proyecto, su desglose y el acceso a tarea/pregunta. |
| 🚪 **Recepción / entrada** (`reception`) | Puerta en borde frontal, felpudo y mostrador. Visitas entran y salen por aquí. | Hace visible el origen del ambiente. No aparecen personajes en medio de la sala ni se atraviesan mesas. |

## 4. Señalética, materiales y leyenda

El **tipo de zona** determina borde, rótulo y suelo. El **estado del agente** determina únicamente indicador/burbuja/monitor. No colorear toda la zona de rojo porque falle un agente.

| Tipo | Acento / relleno | Suelo / patrón | Zonas |
|---|---|---|---|
| Trabajo | `#417EA6` / `#DDECF5` | Moqueta, trama fina | Trabajo, Revisión/QA, Reuniones |
| Espera | `#B07B25` / `#F7E8C8` | Baldosa, cuadrícula | Kanban, Recepción |
| Descanso | `#43836B` / `#DDECE2` | Madera, juntas longitudinales | Café, Recreo |
| Perfiles clave | `#8C68BD` / `#ECE2F5` | Madera, junta fina | PO |
| Perfil clave prioritario | `#B38A27` / `#FFF0BF` | Madera, borde doble | Tú |

Cada zona tiene rótulo permanente en su borde posterior, renderizado horizontalmente en pantalla sobre el anclaje del suelo; no texto en perspectiva ilegible. Los iconos ayudan, pero nunca sustituyen al nombre. Los SVG usan nombres en texto para no depender de fuentes emoji. Subrótulos de isla salen del catálogo de roles del snapshot, no de una lista inventada.

Estados: azul + tecleo (trabajando), amarillo + reloj (espera), naranja + lupa (revisión), ámbar + candado (bloqueo), rojo + cruz (fallo), gris + libre (idle). Mantener palabra/icono además del color, y conservar la leyenda accesible fuera del suelo. Ambiente usa **gris rayado, marcador rombo y rótulo AMBIENTE**, nunca estos indicadores ni una burbuja de tarea.

La leyenda de los mockups está al pie; en la UI futura debe poder plegarse sin perder los nombres de zona ni los avisos. Texto oscuro sobre rótulos claros; nombres y burbujas no dependen de transparencias del suelo.

## 5. Escalado de 2 a 8 agentes

Se cuentan los miembros reales del equipo, incluido un PO/coordinador si pertenece al proyecto; no «Tú» ni el ambiente. Ancho fijo de 14 u; únicamente crece la banda central, una fila de dos puestos cada vez. Las bandas de fondo/frente conservan sus muebles.

| Contrato | Agentes | Suelo (`rx × rz`) | Filas | Capacidad por pool Trabajo / QA / Espera |
|---|---:|---|---:|---:|
| `team-2` | 2 | 14 × 9,8 | 1 | 2 |
| `team-4` | 3–4 | 14 × 11,4 | 2 | 4 |
| `team-6` | 5–6 | 14 × 13 | 3 | 6 |
| `team-8` | 7–8 | 14 × 14,6 | 4 | 8 |

Los pools son destinos alternativos para **el mismo equipo**, no 24 agentes distintos. Permiten que los ocho revisen o esperen simultáneamente, sin asumir una mezcla favorable de roles. Crear muebles de puestos realmente asignados; no poblar cada pool con todas las mesas vacías si no hacen falta. Los anclajes libres son capacidad, no personajes.

En Trabajo, asignación inicial por rol real y después ID estable; dos roles pueden compartir una fila si no hay espacio para dos islas completas. Conservar `homeIndex` mientras exista: un nuevo evento SSE no cambia la mesa ni la cámara. En QA primero se reservan los puestos del QA que trabaja y de bloqueos/fallos que permanecen allí; después se asignan revisores a índices libres. Nunca dos personajes en una silla. Un cambio de tamaño migra solo índices que desaparecen y reenmarca una vez.

Los pasillos troncales tienen 1 u; el acceso a mesas se hace desde esos pasillos y los laterales de cada isla, no por diagonales sobre tableros. Las posiciones de ambiente incluyen rutas explícitas. El ancho/paso se comprobará con las cajas de colisión reales de los Kenney antes de implementar; las dimensiones de contrato son huellas de colocación, no escalas arbitrarias de GLB.

**Trade-off explícito con §4 del documento de referencia:** no se promete su reducción del 30–40 % del suelo. La planta actual compacta mide 8,2 × 5,7 u y no contiene estas nueve áreas separadas. Forzar allí sala cerrada, recepción y dos perfiles clave haría ilegibles puestos y avisos. FT-146 prioriza el nuevo programa y la legibilidad; recorta filas inactivas, no zonas obligatorias. No aplicar automáticamente este suelo al edificio: sus mini-plantas y su cámara no cambian.

## 6. Estado real, adaptación y movimiento

Fuente única de estado: `S.projects`, `S.agents`, `S.tasks`, `S.questions`; actividad real: Activity Stream `/api/events`. Reutilizar `toVisualState()` de `public/office-layout.js`: conserva precedencia bloqueo → fallo → revisión → trabajo → espera → libre. No tratar una pregunta como café si el estado resultante sigue siendo trabajo. Las burbujas actuales mantienen el detalle de preguntas/cuota/herramienta, incluso cuando el estado base es distinto.

| Estado derivado | Destino y pose v3 |
|---|---|
| `working` | Mesa propia, sentado/tecleando. QA en su puesto QA; PO identificado en su despacho. Nunca café/recreo. |
| `reviewing` | Slot libre en Revisión/QA, revisión en monitor. No fingir que la aprobación humana se está ejecutando. |
| `waiting` | Slot estable junto a Kanban, burbuja con motivo real. |
| `blocked` / `failed` | Último puesto de trabajo conocido; si no existe, puesto propio según rol. Monitor/icono visible, sin deambular. |
| `idle` | Sofá libre en descanso; sin plaza, puesto propio con señal «libre», no tecleo. |
| Desconocido/incompleto | Puesto propio con «Estado no disponible»; no inventar trabajo, reunión ni ocio. |

**Diferencias deliberadas frente al código actual:** `zoneFor()` manda también los fallos a `review`, agrupa managers libres en `meeting` y la escena dispone de `WANDER_SPOTS` aleatorios. La v3 mantiene fallos en el puesto y reserva el deambular para ambiente. Son instrucciones para la futura capa adaptadora, no cambios ya implementados. `docs` se traduce a isla de Trabajo y `review` a QA; los IDs nuevos `po/user/reception/recreation` necesitan registro explícito. El JSON es compatible con la **geometría** de `floorZones`, no una sustitución directa del `LayoutEngine` actual.

Para reuniones reales falta evidencia explícita: **adaptador pendiente, desactivado por defecto**. Sin dato no se deduce reunión por rol, una llamada o un texto libre. Para PO usar el rol real `po`, no la normalización amplia `manager`; con varios PO el primer ID estable usa el despacho y el resto conserva mesa propia. Si su estado exige revisión o espera, el PO va a esa zona y deja vacío su despacho.

Ambiente: una visita y una persona de limpieza, entidades locales que no se añaden a `S.agents`. Visita: puerta → recepción → pasillo → entrada de reuniones y vuelta por el mismo camino. Limpieza: circuito de pasillos → salida. Fases/duraciones fijas en el JSON; interpolación con el `requestAnimationFrame` existente. Nada de `setInterval`, aleatorio por render ni eventos de tareas falsos. Prioridad de paso para agentes reales: ambiente espera si un tramo está ocupado. No atraviesa puestos, ni desplaza ni sustituye al agente real.

Las transiciones de agentes van solo al destino confirmado por el snapshot, con estado/burbuja ya actualizado y flecha de destino durante el trayecto; sin paradas de café intermedias. Con movimiento reducido: destino instantáneo, indicadores estáticos, ambiente fijo junto a recepción. Las animaciones locales de teclado/pantalla no modifican métricas.

## 7. Compatibilidad de UI que no se debe perder

- **FT-123:** burbujas con tarea, actividad, cuota y preguntas; al seleccionar/hover/fallo mostrar detalle, el resto compacto. Medir rectángulos proyectados; separar anclajes/etiquetas al menos 48 px o usar desplazamiento y líneas guía. Los mockups muestran todos los textos para revisar el contrato, no prescriben ruido permanente en producción.
- **FT-124:** misma mesa «Tú», misma colección `mine`, mismos tipos/orden y clic de bandeja; ningún segundo cálculo del total. Cero avisos muestra «nada te espera», no una campana animada permanente.
- **FT-125/138:** paneles Equipo/Actividad a izquierda; Progreso/Para ti/Consumo a derecha. Conservar medición de `floorHull()` y `obstacles()`, plegado, scroll del contenedor y almacenamiento de cabeceras. El JSON reserva márgenes orientativos de 268 px; no sustituye el layout medido. Los paneles siguen fuera de `labelRoot` para evitar el recorte de su `overflow:hidden`.
- Cámara isométrica 3/4; dos lados abiertos, paredes de 0,8 u, sala acristalada sin ocultar personas. `frameCamera()` contempla todo el suelo y las burbujas. Si no cabe, paneles laterales plegados antes de reducir etiquetas. Sin nuevas dependencias ni cambios en edificio↔planta, miga, selección, Esc, SSE o ficha de agente.

## 8. Validación y criterios de entrega

Comprobar en la futura implementación: 2/5/8 agentes; todos trabajando, todos revisando y todos esperando; PO ausente/presente; cero/múltiples avisos; cuota bloqueada; resize; movimiento reducido. Cada agente debe tener exactamente un destino real y los dos ambientes no figuran en equipo, tareas, costes ni contadores. El vidrio y el Kanban no pueden ocultar un error. Clics de personajes, mesa «Tú», avisos y paneles deben conservar sus acciones.

Verificación de este entregable:

- `node --check public/office3d.js`, `public/office-layout.js` y `public/office-panels.js`: pasan; no se modificaron estos archivos.
- `node scripts/preview.mjs docs-planta-actual-ft146.png --width 1920 --height 1080 --wait 1500`: captura inspeccionada, sin errores de consola; conservados como requisitos burbujas, márgenes, Kanban y mesa «Tú».
- `node scripts/building-e2e.mjs`: ejecutado una vez **antes de editar**, termina con nueve comprobaciones fallidas. El fixture «Vacío» recibe un coordinador automático y sí tiene equipo; eso rompe expectativas de número/orden de plantas y retirada de equipos, incluida la última comprobación de vuelta al edificio. No se arregla fuera de alcance ni se afirma que el e2e pasa.
- `node docs/oficina-v3/render-mockups.mjs`: pasa; valida las cuatro geometrías, referencias de anclajes, cardinalidad de la muestra y dimensiones de SVG. Los dos PNG se inspeccionaron y se corrigieron solapes de rótulos y avisos; las sillas distinguen las poses sentadas de la espera de pie.

Fuentes consultadas: `AgentOffice_Diseno_Edificio_Oficinas.md` §§2–5, imagen `diseno-edificio-referencia.png`, código de planta/layout/paneles y contrato anterior. El contrato anterior está en `AgentOffice_Visual_Implementation_Pack/agentoffice_visual_pack/spec/visual-contract.json`, no en la raíz del pack citada por el briefing. La v3 conserva lenguaje low-poly; sube contraste de zonas/rótulos frente a las alfombras actuales al 13 % para priorizar lectura.
