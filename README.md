# 🏢 AgentOffice

Una oficina en 2D donde un equipo de agentes de IA (Claude Code o Codex) trabaja sobre tus proyectos:
el **PO** reparte un objetivo en tareas, **back**, **front** y **QA** las hacen, y tú ves en directo
quién está trabajando, en qué y quién está en la zona de descanso.

> MVP 0.1 · sin dependencias · Node ≥ 20

## Arrancar

```bash
npm start            # http://127.0.0.1:7420
npm run dev          # igual, reiniciando al cambiar el servidor
```

El primer arranque crea **«Demo — Tienda online»** con el motor `demo` (simulado, no gasta tokens):
escribe un objetivo, pulsa **Encargar al PO** y luego **▶ Poner a trabajar**.

## Cómo funciona

1. **Proyecto** = un repositorio git (opcional en demo) más su equipo y su tablero.
2. **Objetivo → PO**: el PO lee el repo y devuelve las tareas en JSON (título, descripción, rol, dependencias).
3. **Planificador** (cada 1,5 s): cada tarea pendiente cuyas dependencias estén **hechas** va al primer agente libre de su rol (como mucho `maxParallel` a la vez).
4. **Aislamiento**: cada tarea corre en un **git worktree** propio (`data/worktrees/…`, rama `ao/<tarea>`). Al terminar se hace commit con el agente como autor y la tarea pasa a **Revisión**.
5. **Tú decides**: *Ver cambios* (diff), *Aprobar y fusionar* (`merge --no-ff` a la rama base; exige el repo limpio y en esa rama) o *Devolver* con comentarios (se descarta la rama y el agente lo rehace con tu feedback).
6. **QA + flow-test**: el agente QA recibe el MCP de flow-test (`Ajustes`, por defecto `http://localhost:9998/mcp`) para crear y ejecutar flows que verifiquen la API.

## Motores

| Motor | Cómo se lanza | Permisos |
|---|---|---|
| `demo` | simulado | — |
| `claude` | `claude -p --output-format stream-json` en el worktree | lectura/edición + shell de andar por casa (node, npm, git sin push, grep, sed, cp…; sin rm/sudo/docker/ssh); `--strict-mcp-config`: no hereda tus MCP globales; puede ver sus capturas con `scripts/preview.mjs` |
| `codex` | `codex exec --json -s workspace-write` en el worktree | sandbox de Codex (el PO, `read-only`) |

Cada agente elige motor y modelo desde su panel (clic en el personaje o en su ficha).
Variables: `AO_PORT` (7420), `AO_HOST` (127.0.0.1), `AO_DATA_DIR`, `AO_CLAUDE_BIN`, `AO_CODEX_BIN`.

## Estructura

```
server/index.js     HTTP + API REST + SSE (/events)
server/team.js      proyectos, agentes, tareas, planificador, revisión
server/git.js       worktrees, commit, diff, merge
server/engines/     demo · claude · codex (+ describe.js: herramienta → frase del bocadillo)
public/office.js    la oficina: pixel art en canvas, rutas por pasillos, bocadillos
public/app.js       tablero, equipo, panel del agente, diálogos
data/state.json     estado (gitignored)
```

## Límites conocidos del MVP

- Solo local: lanza procesos con tus permisos (escucha en 127.0.0.1).
- Codex hereda los MCP de `~/.codex/config.toml`.
- El QA trabaja sobre la rama base, así que solo ve lo que ya has aprobado (por eso depende de esas tareas).
- Sin tope de gasto todavía: se muestra el coste por tarea (Claude) pero no se corta.

## La oficina

Dos renderizadores con la misma API (`Office`): **3D isométrico** por defecto (`public/office3d.js`, three.js + modelos glTF de Kenney, personajes animados, etiquetas HTML proyectadas) y **2D pixel art** (`public/office.js`, sprites Kenney) con `?r=2d` en la URL o `localStorage['ao:renderer'] = '2d'`.

Para verla sin navegador (y para que un agente pueda ver lo que pinta): `node scripts/preview.mjs out.png --wait 15000` levanta un servidor temporal con un equipo demo, captura la oficina con Chrome headless (WebGL por SwiftShader) e imprime los errores de consola y los fps. `--full` captura la página entera, `--query r=2d` fuerza el 2D.

## Créditos

- 3D: [Kenney](https://kenney.nl) *Furniture Kit* y *Mini Characters* (CC0, `public/assets/3d/`), [three.js](https://threejs.org) (MIT, `public/vendor/three/`).
- 2D: [Kenney](https://kenney.nl) *Roguelike Indoors* y *Roguelike Characters* (CC0, `public/assets/kenney/`). Mapa de tiles en `docs/assets-kenney.md`.
