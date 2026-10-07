# FT-147 · La posición siempre expresa el estado real

Diseño para implementar sobre FT-146, sin modificar la escena en esta tarea. Esta tabla prevalece sobre `statePlacement` y §6 de [planta.md](planta.md) en los casos explícitos: bloqueo al Kanban, espera del usuario a «Tú», fallo/cuota al puesto propio y paseo libre limitado al descanso. [Ambiente](ambiente.md) aporta movimiento adicional sin inventar actividad de agentes.

## Fuentes y precedencia

Usar el snapshot SSE `S.projects`, `S.agents`, `S.tasks`, `S.questions`, filtrado por proyecto y asociación real. Reutilizar `toVisualState()` de `public/office-layout.js` para el estado base, tarea activa, dependencia y cuota; no reinterpretar texto libre de actividad como estado. `/api/events` solo amplía el detalle de actividad real, nunca decide una reunión decorativa ni sustituye un snapshot más reciente.

**Adaptador de destino pendiente**: producir `{agentId, visualState, reason, destinationAnchor, pose, overlays}`. Es una vista local, no endpoint nuevo. Mantener todos los motivos simultáneos aunque un único destino gane. Orden de destino: **cuota explícita → fallo → intervención del usuario → pausa administrativa → dependencia/bloqueo → reviewing → working/PO → espera → libre → desconocido**. Un error conserva aro rojo incluso si también hay pregunta; cuota conserva el error en la burbuja y duerme en su mesa. Una pregunta resuelta no desplaza al agente hasta que llegue el snapshot confirmado.

Intervención se obtiene de preguntas pendientes propias y de los avisos `mine.items` de FT-124 (misma derivación de «Para ti»): solo `question` o `review` con `agentId` y tarea realmente asociada. Un aviso de proyecto sin agente resalta «Tú», sin fabricar un visitante. `task.status=review` solo indica revisión; para enviar a «Tú» tiene que existir un aviso de aprobación humana pendiente. No hacer un segundo cálculo de totales de campana.

Cuota: usar flags explícitos agente/tarea `quotaBlocked` / `quotaPaused` y resultado real de `hasFuel()` para su motor efectivo. Con motor `auto`, no declarar sin cuota porque solo un proveedor se haya agotado. `paused` sin motivo de cuota verificable se queda en su puesto con «En pausa», sin atribuir agotamiento. El `quota` actual de `toVisualState()` incluye cualquier `paused`: el adaptador debe conservar el motivo original y separar ambos casos.

## Estado → lugar y animación

| Evidencia real | Sitio / anclaje | Pose estable y señal | Movimiento permitido |
|---|---|---|---|
| `working` | Mesa propia `chair-{homeIndex}`; QA en `qa-chair-{homeIndex}` | Sentado, manos alternas sobre teclado, pantalla discreta; burbuja conserva tarea/herramienta | Solo llegar a su puesto; nunca pausa de café |
| `reviewing` sin intervención humana pendiente | Revisión / QA, `qa-chair-{reviewIndex}` reservado | Mirar monitor, gesto lento de lectura; señal naranja y tarea real | Ruta directa a QA |
| Dependencia pendiente o bloqueo sin cuota | Frente al Kanban, `wait-{waitIndex}` | De pie mirando tablero; burbuja con motivo real, sin teclear | Ruta directa a Kanban |
| Pregunta propia / aprobación pendiente del usuario | De pie junto a «Tú», `user-wait-{index}` (ampliación) | Espera tranquila mirando al usuario; burbuja pregunta/revisión, campana con total real | Ruta directa, sin invadir silla ni mostrador del usuario |
| `failed` | Su mesa propia, QA o PO si ese es su puesto | Sentado quieto, aro rojo continuo y error legible; no fingir trabajo | Regreso directo al puesto, nunca llevar el error al café |
| Sin cuota explícita | Su mesa propia | Dormido, respiración leve, `💤 sin cuota`; burbuja retiene motivos coexistentes | Llegar a su mesa; permanecer hasta reanudación real |
| Libre, sin tarea activa ni motivo anterior | Café o recreo, plaza reservada | Sentado o paseo lento local; indicador gris «Libre» | Paseos SOLO dentro de su zona asignada de café o recreo; traslado inicial directo por pasillo |
| PO real planificando | `po-chair` en su despacho | Sentado, lectura/notas discretas y actividad real | Ruta al despacho; bloqueo, fallo, cuota o usuario prevalecen |
| Espera de cola sin bloqueo | Kanban, `wait-{waitIndex}` | De pie, señal «En cola» | Ruta al tablero |
| Pausa explícita sin cuota | Su puesto | Quieto, «En pausa», sin Zzz ni tecleo | Llegar al puesto |
| Estado desconocido / snapshot incompleto | Su puesto | «Estado no disponible», quieto | No inferir descanso, trabajo o reunión |

PO exige rol original exactamente `po`; la normalización `manager`, ser coordinador o un mensaje de «planificando» no bastan. PO `working` usa despacho con actividad recibida; libre descansa como el resto. Sin dato explícito de planificación, mostrar trabajo en despacho, sin inventar fase de planificación. Si hay varios PO, el primero por ID estable conserva el despacho; los restantes tienen mesas propias. Sin PO real, despacho vacío.

## Puestos y ampliación del grafo v3

Conservar `homeIndex` y reservas estables de FT-146. Cada agente tiene exactamente un destino; asignar índices libres por ID estable, preservar reservas anteriores, reservar QA para trabajadores QA antes de revisores. Los fallos y sin cuota regresan a su **puesto propio**, no al último sitio transitorio. Ambientales nunca tienen `homeIndex`.

FT-146 no proporciona grafo completo para agentes ni plazas junto al usuario/recreo. Ampliación pendiente con coordenadas relativas a la planta elegida:

- **Espera de usuario:** N slots (`N=maxAgents`) en `user-wait-{i}`, x = 11,25 + 0,7 × (i % 4), z = 2,5 + 0,65 × floor(i / 4), radio 0,18 u. La primera fila está junto al borde de «Tú»; la segunda es cola visible hacia el Kanban. Nunca usa `user-chair` ni `user-bell`. Acceso por lado x=13,6 del pasillo norte, sin cruzar escritorio. Orden FIFO por instante de aviso y después ID; no tapar campana. Si no caben las huellas reales, adaptar fila de espera antes de habilitar la función; no apilar agentes.
- **Descanso:** conservar dos `idle-seat-*`; usar también `cafe-chair`. Recreo añade cinco plazas `recreation-seat-{0..4}`, tres sentadas sobre `recreation-sofa` en offsets x = −0,9 / 0 / +0,9 y dos de pie en (x=8,6, z=idle.z−0,8) y (x=8,6, z=idle.z−0,15). Así caben ocho libres (3 café + 5 recreo), sin usurpar sofá de recepción. Verificar cuerpos y brazos Kenney antes de implementar.
- **Paseo libre:** como mucho un caminante por zona. Café: x=3,55, z entre `idle.z−0,8` y `idle.z+0,2`; recreo: x=5,35, mismo intervalo de z. Ida y vuelta por segmento, 0,45 u/s, pausa de 12 s por extremo, primer paseo tras 20 s libre más (ID estable módulo 10) segundos. Reservar cuerpo contra mesa/sofá/futbolín; si no cabe, permanece sentado/libre. No cruzar a otra zona por ocio.
- **Acceso a mesas:** construir nodos laterales a cada fila, conectados a `spine-west`/`spine-east` y `north`/`south`. Entrar por lateral y detrás de silla, evitando tableros. Cada segmento y giro necesita barrido de radio 0,18 u y huella Kenney real. Las rutas de ambiente del JSON no son rutas suficientes para todas las sillas.

Estas ampliaciones no afirman que el LayoutEngine actual ya las soporte. Resolución de muebles, grafos y colisiones corresponde a la implementación. Conservar IDs de las anclas existentes; exponer ampliaciones mediante adaptador registrado explícitamente.

## Transiciones que no engañan

Al cargar una planta se permite colocar cada agente directamente en su destino real. Después, caminar por el grafo v3 y sus accesos, a 1 u/s máximo; flecha de destino y burbuja se actualizan inmediatamente al snapshot. Mientras cruza, «→ Revisión», «→ Tu mesa» o «→ Puesto · sin cuota» explica la diferencia entre posición y destino. No mostrar tecleo al caminar ni mantener el rótulo «Libre» si ya tiene trabajo.

Si llega otro snapshot durante el trayecto, recalcular desde su posición interpolada hacia el nuevo destino y seguir sin salto. El estado manda; no completar antes un paseo decorativo. Agentes ceden entre sí por reserva de tramo, orden de ID si llegan a la vez. Ambiente cede siempre. No atravesar muebles, ni detenerse para saludar o tomar café entre dos estados activos.

En resize o cambio de tamaño, preservar coordenadas mundiales y anclajes existentes, conectar los nodos desplazados por ruta libre y reenmarcar una vez. No usar cada SSE como una nueva carga. En cambio explícito de proyecto se carga otra planta: permitido posicionamiento inicial de ese escenario. Si un grafo falla, detenerse en el último punto seguro con destino visible y motivo de debug; no teleportar como recuperación.

Con `prefers-reduced-motion`, quitar gestos cíclicos, balanceo, paseos y movimientos de cámara. Mantener solo la traslación continua mínima por ruta al cambiar el estado, sin rebotes ni giros ornamentales; indicador de destino estático. FT-147 sustituye el salto instantáneo propuesto en FT-146 para cumplir la regla de no teletransportarse salvo al cargar. En pestaña oculta congelar reloj; al volver procesar snapshot más reciente y caminar desde la posición conservada sin recuperar pasos perdidos.

Nunca deducir una reunión real por rol, conversación o decoración. El snapshot actual no tiene estado de reunión explícito: adaptador de reunión real desactivado hasta que exista evidencia. La reunión gris del catálogo es independiente y no admite agentes reales como participantes.

## Casos de aceptación

Verificar snapshot → destino para cada fila y combinaciones: fallo+pregunta, cuota+dependencia, reviewing con/sin aviso humano, pregunta sin agente, PO bloqueado/libre, `auto` con un proveedor agotado, pausa administrativa. En 2/5/8 agentes: todos en trabajo, revisión, bloqueo, espera del usuario y descanso, sin doble reserva. Cambiar trabajo→pregunta→working durante marcha y libre→working durante paseo: burbuja inmediata, ruta continua, ausencia de café intermedio. Verificar colisiones y legibilidad desde la cámara isométrica, resize y movimiento reducido. Los avisos de «Tú» y sus clics siguen usando FT-124.
