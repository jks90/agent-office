# FT-147 · Vida ambiental sin fingir trabajo

Entregable de diseño para la futura implementación por Claude. La escena actual no cambia. [Contrato](ambient-contract.json), [fidelidad](fidelidad.md) y [storyboard](storyboard.svg) completan la geometría FT-146 de [planta.md](planta.md). FT-147 sustituye su límite fijo de dos figurantes y sus reglas de movimiento; conserva zonas, paleta, puestos y escalado 2–8.

La referencia mantiene diorama isométrico, mobiliario low-poly y bandas reconocibles. Jerarquía: «Tú» y avisos → fallo/bloqueo → agentes activos → Kanban → ambiente. Los figurantes aportan vida con gestos pequeños y caminatas continuas. La actividad del equipo nunca depende de su presencia.

## Catálogo

Todos usan ropa neutra, un pequeño aro gris discontinuo y, si hace falta, rombo gris con tooltip «Ambiente». Sin chapa de nombre, burbuja, código de tarea ni interacción. La leyenda permanente explica el rombo. Uniforme, accesorio y forma distinguen personajes incluso sin percibir color.

| Personaje | Aspecto / gesto | Recorrido y paradas | Duración nominal mínima | Frecuencia mínima en calma |
|---|---|---|---|---|
| Limpieza | Delantal gris con bajo rayado, guantes apagados; carrito detrás, fregona corta | Entrada → pasillo sur → eje oeste → norte → eje este → salida. Dos paradas de 12 s en suelo vacío; omite zonas ocupadas | 90 s | 150 s |
| Visita | Abrigo arena, pantalón oscuro, rombo gris | Entrada → recepción (6 s) → sofá exclusivo de recepción (15 s) → sala (15 s) → salida | 110 s | 120 s |
| Repartidor | Chaqueta marrón apagada, gorra, caja | Entrada → mostrador (14 s) → salida; retira la caja al marcharse | 26 s | 210 s |
| Reunión decorativa | 2 personas con chalecos neutros rayados; 3 solo en calma | Entrada en fila → sillas de sala → conversación muda (36 s) → salida en fila | 100 s | 180 s |
| Mantenimiento | Mono pizarra, bolsa de herramientas | Entrada → planta (12 s) → impresora (22 s) → salida | 88 s | 240 s |

Los tiempos de camino crecen si la distancia, la cesión de paso o el tamaño de planta lo requieren; no acelerar ni saltar para cumplir una agenda. Periodos entre inicios, no promesa de visitas. El JSON especifica fases y rutas completas, incluidas vueltas. La reunión no puede compartir sillas con una visita; se reserva el conjunto antes de entrar.

## Anclajes y geometría pendiente

`bindings` resuelve nombres contra los anclajes y puntos de `visitor`/`cleaner` del contrato v3 **de la planta seleccionada**. No reutilizar coordenadas de `team-2` en `team-8`. `paths` ordena esos nombres; `return` invierte cada camino en el orden declarado. Se vuelve desde la posición actual si la carga exige salida temprana.

FT-146 no tiene sofá de recepción, planta de servicio ni impresora: son ampliaciones marcadas en `adapter.newGeometry`, con huellas y offsets explícitos. El sofá de recepción pertenece exclusivamente al ambiente; las plazas `idle-seat-*` siguen reservadas al equipo. No sentar visitas en el sofá de los agentes para ahorrar un mueble.

Los accesos interiores a reunión también son nuevos. La futura implementación debe comprobar barridos de colisión con muebles Kenney, mampara, puerta y carrito en los cuatro tamaños. Si un segmento no cabe, desactivar ese episodio y exponer el motivo de debug; adaptar la ruta dentro de los pasillos antes de activarlo. Las coordenadas son diseño, no una certificación de los GLB actuales.

La limpieza recorre suelo de pasillos junto a zonas vacías, sin penetrar mesas, sillas, despacho PO ni «Tú». Detener fregona si cualquier ocupante invade el radio reservado. La planta y la impresora son accesorios decorativos: el gesto no implica avería ni tarea de mantenimiento real.

## Densidad, reloj y convivencia

Medir la carga con agentes **reales** del proyecto: proporción que no está libre tras aplicar el adaptador de fidelidad. Estado desconocido cuenta ocupado; sin equipo se apaga el ambiente. Evaluar admisión cada 30 s de tiempo visible. Calma (<34 %): hasta 3 personas, periodos ×1; mixta (<67 %): hasta 2, ×1,5; alta: hasta 1, ×2. Una reunión consume 2–3 plazas completas y queda desactivada con carga alta. Salientes también consumen plaza. Las frecuencias no obligan a llenar continuamente el cupo.

Al subir la carga, no admitir más y hacer salir los figurantes al terminar la pausa actual. Puede haber hasta 3 durante el vaciado, nunca un cuarto. La cola usa episodio elegible más atrasado y orden fijo de catálogo para desempatar; no acumula ráfagas al volver de una pestaña oculta. Fase inicial determinista por ID de proyecto y reloj `requestAnimationFrame` existente; sin aleatorio por render ni `setInterval`.

Agentes reales tienen prioridad absoluta. Figurante espera en el último punto seguro si el tramo está reservado; carrito incluido en colisiones. Figuras de reunión caminan en fila con separación de 0,6 u; no caminar lado a lado por pasillos de 1 u. Sin teletransporte al abandonar un episodio bloqueado.

Cada frame de cámara comprueba la proyección de burbujas y mesa «Tú», con margen de 16 px. Ocultar temporalmente figura, rombo, carrito, caja y sombras ambientales si se superponen; la ruta lógica continúa. Esto preserva la lectura sin mover al agente ni alterar su señal. Ambiente no intercepta clics y no entra en métricas, costes, plantilla, SSE ni Activity Stream.

Con movimiento reducido se suprimen episodios móviles; opcionalmente queda **un** mantenimiento estático en recepción si no tapa señales. Animación suspendida en pestaña oculta; ninguna recuperación acelerada al volver. Para el equipo real rige el desplazamiento accesible descrito en fidelidad.

## Aceptación de la futura implementación

Comprobar 2/5/8 agentes y las cuatro geometrías; todos trabajando, todos libres, todos bloqueados; 0/1/varios avisos; cambio de carga y proyecto, resize y movimiento reducido. Debe mantenerse el límite absoluto de 3 contando reuniones y salientes; ningún ambiente ocupa mesa de agente o usuario, oculta una burbuja ni cambia contadores. Dos recargas con mismo snapshot, ID y tiempo visible deben resolver iguales rutas y poses. Ninguna reunión decorativa aparece en la ficha de un agente.

El storyboard muestra fixtures de un minuto para leer la intención; no representa una ejecución actual ni modifica datos reales. La captura de verificación del repo sigue mostrando la implementación previa.
