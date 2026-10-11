/**
 * AO-5 · Catálogo de decoración v3. Datos estáticos, unidades Kenney; y = base,
 * rotation = radianes. size normaliza GLB antes del giro; recipe usa centros locales.
 * mounting=existing documenta piezas del constructor semántico, NO las duplica.
 * Documentación de la referencia se adapta a development; Revisión se adapta a qa.
 * Conteos visuales aproximados (oclusiones): principal / ejemplo pequeño / mediano.
 * Tamaño relativo: P pequeño, M mueble, G alto. No son contadores del producto.
 * Objeto | Zona imagen | Cantidad | Tamaño, colores | Apoyo | Modelo elegido
 * Plantas altas | Desarrollo, Docs, Revisión, bordes | 7/5/6 | G verde, terracota | suelo | pottedPlant
 * Plantas medianas | QA, Reuniones, bordes | 5/3/5 | M verde, crema | suelo | plantSmall2
 * Macetas pequeñas | todas las mesas y estantes | ~12/6/10 | P verde, azul | mueble | plantSmall1/3
 * Librerías con libros | Desarrollo, Docs, Revisión | 4/2/2 | G madera, multicolor | pared | bookcaseOpen + books
 * Archivadores y aparadores | Desarrollo, Reuniones, descanso | 3/1/1 | M madera, gris | suelo | sideTableDrawers
 * Libros/papeles | mesas y estantes | ~12/7/10 grupos | P blanco, azul | mueble | books
 * Cuadros/pósters | Desarrollo, QA, Revisión | ~6/3/4 | P pastel | pared | primitivas
 * Corchos con notas | Desarrollo, QA | 2/1/2 | M ocre, pastel | pared | primitivas
 * Ventanas | Desarrollo, QA, Docs | 5/3/4 | M menta, madera | pared | primitivas (adaptadas al muro bajo)
 * Alfombras/suelos de zona | puestos; más claras en ejemplo mediano | 0/0/~6 | M azul gris | suelo | primitivas existentes
 * Sofás | descanso | 1/0/2 | M azul, rojo | suelo | loungeSofa existente
 * Sillones de descanso | no distinguibles (sí sillas de oficina) | 0/0/0 | — | — | no añadido
 * Mesas auxiliares | Reuniones/descanso | 1/0/1 | M madera | suelo | sideTable
 * Lámparas | Docs, Revisión | 2/1/1 | P blanco | mueble | lampSquareTable
 * Lámpara de pie | ambigua tras puestos | 0/0/0 seguros | M crema | suelo | lampSquareFloor (adaptación)
 * Dispensador de agua | Revisión, bordes | 1/2/2 | M gris, azul | suelo | primitivas
 * Papeleras | puestos | ~2/1/2 | P gris | suelo | trashcan
 * Cajas | estantes/Revisión | ~2/1/1 | P ocre | mueble | cardboardBoxClosed (al pie de librería)
 * Impresora/copias | descanso; identificación ambigua | 1/0/0 | M gris, azul | suelo | primitivas
 * Pizarras | fondo QA + Kanban | 2/1/1 | G blanco, azul | suelo/pared | Kanban existente; corcho para notas decorativas
 * Mamparas de cristal | ejemplo mediano | 0/0/~5 paños | M cian | suelo | primitivas existentes
 * Relojes | ninguno identificable | 0/0/0 | — | — | no añadido
 * Puertas | Docs/Revisión, esquinas | 3/2/2 | G gris azul | pared | anclas existentes; no duplicar
 * Tazas/vasos | mesas | ~8/4/6 | P blanco | mueble | primitivas
 * Escritorios, monitores, teclados, ratones, sillas y mesa de reuniones:
 * mobiliario funcional existente (aprox. 8/4/8 puestos), no decoración duplicada.
 * 141 GLB locales revisados: no hay modelos específicos de corcho, reloj,
 * dispensador ni impresora. Sin assets externos ni cambios al contrato generado.
 */

export default {
  items: [
    {
      id: "plant-tall",
      name: "Planta alta en maceta",
      zone: "meeting / idle",
      size: [0.55,1.05,0.55],
      mounting: "floor",
      model: "pottedPlant",
      placements: {
        "team-2": [{"x": 0.5,"z": 1.45,"y": 0,"rotation": 0},{"x": 5.35,"z": 1.0,"y": 0,"rotation": 0},{"x": 0.45,"z": 9.3,"y": 0,"rotation": 0}],
        "team-4": [{"x": 0.5,"z": 1.45,"y": 0,"rotation": 0},{"x": 5.35,"z": 1.0,"y": 0,"rotation": 0},{"x": 0.45,"z": 10.9,"y": 0,"rotation": 0}],
        "team-6": [{"x": 0.5,"z": 1.45,"y": 0,"rotation": 0},{"x": 5.35,"z": 1.0,"y": 0,"rotation": 0},{"x": 0.45,"z": 12.5,"y": 0,"rotation": 0}],
        "team-8": [{"x": 0.5,"z": 1.45,"y": 0,"rotation": 0},{"x": 5.35,"z": 1.0,"y": 0,"rotation": 0},{"x": 0.45,"z": 14.1,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "plant-medium",
      name: "Planta de suelo",
      zone: "po / board",
      size: [0.38,0.65,0.38],
      mounting: "floor",
      model: "plantSmall2",
      placements: {
        "team-2": [{"x": 6.95,"z": 1.45,"y": 0,"rotation": 0},{"x": 13.5,"z": 5.05,"y": 0,"rotation": 0}],
        "team-4": [{"x": 6.95,"z": 1.45,"y": 0,"rotation": 0},{"x": 13.5,"z": 5.05,"y": 0,"rotation": 0},{"x": 13.5,"z": 6.65,"y": 0,"rotation": 0}],
        "team-6": [{"x": 6.95,"z": 1.45,"y": 0,"rotation": 0},{"x": 13.5,"z": 5.05,"y": 0,"rotation": 0},{"x": 13.5,"z": 6.65,"y": 0,"rotation": 0},{"x": 13.5,"z": 8.25,"y": 0,"rotation": 0}],
        "team-8": [{"x": 6.95,"z": 1.45,"y": 0,"rotation": 0},{"x": 13.5,"z": 5.05,"y": 0,"rotation": 0},{"x": 13.5,"z": 6.65,"y": 0,"rotation": 0},{"x": 13.5,"z": 8.25,"y": 0,"rotation": 0},{"x": 13.5,"z": 9.85,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "bookcase",
      name: "Librería de documentación",
      zone: "development",
      size: [0.88,1.05,0.34],
      mounting: "floor",
      model: "bookcaseOpen",
      placements: {
        "team-2": [{"x": 0.24,"z": 4.35,"y": 0,"rotation": 1.5707963267948966}],
        "team-4": [{"x": 0.24,"z": 4.35,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 5.95,"y": 0,"rotation": 1.5707963267948966}],
        "team-6": [{"x": 0.24,"z": 4.35,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 5.95,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 7.55,"y": 0,"rotation": 1.5707963267948966}],
        "team-8": [{"x": 0.24,"z": 4.35,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 5.95,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 7.55,"y": 0,"rotation": 1.5707963267948966},{"x": 0.24,"z": 9.15,"y": 0,"rotation": 1.5707963267948966}],
      },
    },
    {
      id: "shelf-plant",
      name: "Planta sobre librería",
      zone: "development",
      size: [0.19,0.28,0.19],
      mounting: "tabletop",
      model: "plantSmall1",
      placements: {
        "team-2": [{"x": 0.24,"z": 4.55,"y": 1.05,"rotation": 0}],
        "team-4": [{"x": 0.24,"z": 4.55,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 6.15,"y": 1.05,"rotation": 0}],
        "team-6": [{"x": 0.24,"z": 4.55,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 6.15,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 7.75,"y": 1.05,"rotation": 0}],
        "team-8": [{"x": 0.24,"z": 4.55,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 6.15,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 7.75,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 9.35,"y": 1.05,"rotation": 0}],
      },
    },
    {
      id: "books",
      name: "Libros apilados",
      zone: "development",
      size: [0.2,0.12,0.19],
      mounting: "tabletop",
      model: "books",
      placements: {
        "team-2": [{"x": 0.24,"z": 4.1,"y": 1.05,"rotation": 0}],
        "team-4": [{"x": 0.24,"z": 4.1,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 5.7,"y": 1.05,"rotation": 0}],
        "team-6": [{"x": 0.24,"z": 4.1,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 5.7,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 7.3,"y": 1.05,"rotation": 0}],
        "team-8": [{"x": 0.24,"z": 4.1,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 5.7,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 7.3,"y": 1.05,"rotation": 0},{"x": 0.24,"z": 8.9,"y": 1.05,"rotation": 0}],
      },
    },
    {
      id: "archive",
      name: "Archivador bajo",
      zone: "po",
      size: [0.52,0.62,0.34],
      mounting: "floor",
      model: "sideTableDrawers",
      placements: {
        "team-2": [{"x": 9.12,"z": 0.95,"y": 0,"rotation": 0}],
        "team-4": [{"x": 9.12,"z": 0.95,"y": 0,"rotation": 0}],
        "team-6": [{"x": 9.12,"z": 0.95,"y": 0,"rotation": 0}],
        "team-8": [{"x": 9.12,"z": 0.95,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "lamp",
      name: "Lámpara de sobremesa",
      zone: "po",
      size: [0.22,0.36,0.22],
      mounting: "tabletop",
      model: "lampSquareTable",
      placements: {
        "team-2": [{"x": 9.12,"z": 0.95,"y": 0.62,"rotation": 0}],
        "team-4": [{"x": 9.12,"z": 0.95,"y": 0.62,"rotation": 0}],
        "team-6": [{"x": 9.12,"z": 0.95,"y": 0.62,"rotation": 0}],
        "team-8": [{"x": 9.12,"z": 0.95,"y": 0.62,"rotation": 0}],
      },
    },
    {
      id: "side-table",
      name: "Mesa auxiliar",
      zone: "idle",
      size: [0.48,0.4,0.48],
      mounting: "floor",
      model: "sideTable",
      placements: {
        "team-2": [{"x": 3.8,"z": 8.8,"y": 0,"rotation": 0}],
        "team-4": [{"x": 3.8,"z": 10.4,"y": 0,"rotation": 0}],
        "team-6": [{"x": 3.8,"z": 12,"y": 0,"rotation": 0}],
        "team-8": [{"x": 3.8,"z": 13.6,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "table-plant",
      name: "Maceta pequeña",
      zone: "idle / reception",
      size: [0.2,0.28,0.2],
      mounting: "tabletop",
      model: "plantSmall3",
      placements: {
        "team-2": [{"x": 3.8,"z": 8.8,"y": 0.4,"rotation": 0},{"x": 11.8,"z": 7.5,"y": 0.5,"rotation": 0}],
        "team-4": [{"x": 3.8,"z": 10.4,"y": 0.4,"rotation": 0},{"x": 11.8,"z": 9.1,"y": 0.5,"rotation": 0}],
        "team-6": [{"x": 3.8,"z": 12,"y": 0.4,"rotation": 0},{"x": 11.8,"z": 10.7,"y": 0.5,"rotation": 0}],
        "team-8": [{"x": 3.8,"z": 13.6,"y": 0.4,"rotation": 0},{"x": 11.8,"z": 12.3,"y": 0.5,"rotation": 0}],
      },
    },
    {
      id: "bin",
      name: "Papelera",
      zone: "development",
      size: [0.22,0.32,0.22],
      mounting: "floor",
      model: "trashcan",
      placements: {
        "team-2": [{"x": 5.48,"z": 4.15,"y": 0,"rotation": 0}],
        "team-4": [{"x": 5.48,"z": 4.15,"y": 0,"rotation": 0},{"x": 5.48,"z": 5.75,"y": 0,"rotation": 0}],
        "team-6": [{"x": 5.48,"z": 4.15,"y": 0,"rotation": 0},{"x": 5.48,"z": 5.75,"y": 0,"rotation": 0},{"x": 5.48,"z": 7.35,"y": 0,"rotation": 0}],
        "team-8": [{"x": 5.48,"z": 4.15,"y": 0,"rotation": 0},{"x": 5.48,"z": 5.75,"y": 0,"rotation": 0},{"x": 5.48,"z": 7.35,"y": 0,"rotation": 0},{"x": 5.48,"z": 8.95,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "box",
      name: "Caja de archivo",
      zone: "development",
      size: [0.3,0.26,0.3],
      mounting: "floor",
      model: "cardboardBoxClosed",
      placements: {
        "team-2": [{"x": 0.24,"z": 5.05,"y": 0,"rotation": 0}],
        "team-4": [{"x": 0.24,"z": 5.05,"y": 0,"rotation": 0},{"x": 0.24,"z": 6.65,"y": 0,"rotation": 0}],
        "team-6": [{"x": 0.24,"z": 5.05,"y": 0,"rotation": 0},{"x": 0.24,"z": 6.65,"y": 0,"rotation": 0},{"x": 0.24,"z": 8.25,"y": 0,"rotation": 0}],
        "team-8": [{"x": 0.24,"z": 5.05,"y": 0,"rotation": 0},{"x": 0.24,"z": 6.65,"y": 0,"rotation": 0},{"x": 0.24,"z": 8.25,"y": 0,"rotation": 0},{"x": 0.24,"z": 9.85,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "floor-lamp",
      name: "Lámpara de pie",
      zone: "recreation",
      size: [0.3,1.12,0.3],
      mounting: "floor",
      model: "lampSquareFloor",
      placements: {
        "team-2": [{"x": 8.85,"z": 7.45,"y": 0,"rotation": 0}],
        "team-4": [{"x": 8.85,"z": 9.05,"y": 0,"rotation": 0}],
        "team-6": [{"x": 8.85,"z": 10.65,"y": 0,"rotation": 0}],
        "team-8": [{"x": 8.85,"z": 12.25,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "water",
      name: "Dispensador de agua",
      zone: "recreation",
      size: [0.38,0.91,0.53],
      mounting: "floor",
      recipe: [{"shape": "box","size": [0.38,0.59,0.38],"position": [0,0.295,0],"color": "#F3F6FA"},{"shape": "box","size": [0.26,0.23,0.03],"position": [0,0.35,0.202],"color": "#53677D"},{"shape": "box","size": [0.1,0.025,0.1],"position": [0,0.24,0.24],"color": "#A9DBE2"},{"shape": "cylinder","size": [0.24,0.32,0.24],"position": [0,0.75,0],"color": "#A9DBE2"},{"shape": "box","size": [0.1,0.04,0.06],"position": [0,0.44,0.23],"color": "#417EA6"}],
      placements: {
        "team-2": [{"x": 9,"z": 8.0,"y": 0,"rotation": 0}],
        "team-4": [{"x": 9,"z": 9.6,"y": 0,"rotation": 0}],
        "team-6": [{"x": 9,"z": 11.2,"y": 0,"rotation": 0}],
        "team-8": [{"x": 9,"z": 12.8,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "printer",
      name: "Impresora / fotocopiadora",
      zone: "development",
      size: [0.55,0.616,0.55],
      mounting: "floor",
      recipe: [{"shape": "box","size": [0.52,0.42,0.42],"position": [0,0.21,0],"color": "#53677D"},{"shape": "box","size": [0.55,0.17,0.44],"position": [0,0.505,0],"color": "#F3F6FA"},{"shape": "box","size": [0.34,0.025,0.29],"position": [0,0.603,0],"color": "#A9DBE2"},{"shape": "box","size": [0.33,0.02,0.18],"position": [0,0.32,0.25],"color": "#F3F6FA"}],
      placements: {
        "team-2": [{"x": 5.4,"z": 5.25,"y": 0,"rotation": 0}],
        "team-4": [{"x": 5.4,"z": 6.85,"y": 0,"rotation": 0}],
        "team-6": [{"x": 5.4,"z": 8.45,"y": 0,"rotation": 0}],
        "team-8": [{"x": 5.4,"z": 10.05,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "window",
      name: "Ventana con marco de madera",
      zone: "meeting",
      size: [1.25,0.54,0.08],
      mounting: "wall",
      recipe: [{"shape": "box","size": [1.25,0.54,0.045],"position": [0,0.27,0],"color": "#D7B18A"},{"shape": "box","size": [1.13,0.42,0.055],"position": [0,0.27,0.012],"color": "#A9DBE2"},{"shape": "box","size": [0.035,0.44,0.075],"position": [0,0.27,0.024],"color": "#D7B18A"},{"shape": "box","size": [1.15,0.035,0.075],"position": [0,0.27,0.024],"color": "#D7B18A"}],
      placements: {
        "team-2": [{"x": 1.2,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 4.6,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 7.4,"z": 0.012,"y": 0.16,"rotation": 0}],
        "team-4": [{"x": 1.2,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 4.6,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 7.4,"z": 0.012,"y": 0.16,"rotation": 0}],
        "team-6": [{"x": 1.2,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 4.6,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 7.4,"z": 0.012,"y": 0.16,"rotation": 0}],
        "team-8": [{"x": 1.2,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 4.6,"z": 0.012,"y": 0.16,"rotation": 0},{"x": 7.4,"z": 0.012,"y": 0.16,"rotation": 0}],
      },
    },
    {
      id: "noticeboard",
      name: "Corcho con notas de documentación",
      zone: "development",
      size: [0.76,0.52,0.08],
      mounting: "wall",
      recipe: [{"shape": "box","size": [0.76,0.52,0.05],"position": [0,0.26,0],"color": "#D7B18A"},{"shape": "box","size": [0.66,0.42,0.06],"position": [0,0.26,0.005],"color": "#B07B25"},{"shape": "box","size": [0.14,0.12,0.02],"position": [-0.21,0.35,0.05],"color": "#F3F6FA"},{"shape": "box","size": [0.14,0.12,0.02],"position": [0,0.32,0.05],"color": "#FFF0BF"},{"shape": "box","size": [0.14,0.12,0.02],"position": [0.2,0.35,0.05],"color": "#DDECE2"},{"shape": "box","size": [0.14,0.12,0.02],"position": [-0.15,0.16,0.05],"color": "#DDECF5"},{"shape": "box","size": [0.14,0.12,0.02],"position": [0.12,0.15,0.05],"color": "#F3F6FA"}],
      placements: {
        "team-2": [{"x": 0.015,"z": 5.15,"y": 0.18,"rotation": 1.5707963267948966}],
        "team-4": [{"x": 0.015,"z": 5.15,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 6.75,"y": 0.18,"rotation": 1.5707963267948966}],
        "team-6": [{"x": 0.015,"z": 5.15,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 6.75,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 8.35,"y": 0.18,"rotation": 1.5707963267948966}],
        "team-8": [{"x": 0.015,"z": 5.15,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 6.75,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 8.35,"y": 0.18,"rotation": 1.5707963267948966},{"x": 0.015,"z": 9.95,"y": 0.18,"rotation": 1.5707963267948966}],
      },
    },
    {
      id: "poster",
      name: "Cuadro botánico",
      zone: "po",
      size: [0.42,0.51,0.06],
      mounting: "wall",
      recipe: [{"shape": "box","size": [0.42,0.51,0.04],"position": [0,0.255,0],"color": "#53677D"},{"shape": "box","size": [0.35,0.44,0.05],"position": [0,0.255,0.008],"color": "#F3F6FA"},{"shape": "box","size": [0.23,0.16,0.02],"position": [0,0.3,0.04],"color": "#43836B"},{"shape": "box","size": [0.23,0.025,0.02],"position": [0,0.15,0.04],"color": "#417EA6"}],
      placements: {
        "team-2": [{"x": 9.1,"z": 0.02,"y": 0.18,"rotation": 0}],
        "team-4": [{"x": 9.1,"z": 0.02,"y": 0.18,"rotation": 0}],
        "team-6": [{"x": 9.1,"z": 0.02,"y": 0.18,"rotation": 0}],
        "team-8": [{"x": 9.1,"z": 0.02,"y": 0.18,"rotation": 0}],
      },
    },
    {
      id: "sofas",
      name: "Sofás de descanso",
      zone: "idle / recreation",
      size: [2.25,0.65,0.65],
      mounting: "existing",
      model: "loungeSofa",
      placements: {
        "team-2": [{"x": 2.4,"z": 8.85,"y": 0,"rotation": 3.141592653589793},{"x": 7.5,"z": 8.85,"y": 0,"rotation": 3.141592653589793}],
        "team-4": [{"x": 2.4,"z": 10.45,"y": 0,"rotation": 3.141592653589793},{"x": 7.5,"z": 10.45,"y": 0,"rotation": 3.141592653589793}],
        "team-6": [{"x": 2.4,"z": 12.05,"y": 0,"rotation": 3.141592653589793},{"x": 7.5,"z": 12.05,"y": 0,"rotation": 3.141592653589793}],
        "team-8": [{"x": 2.4,"z": 13.65,"y": 0,"rotation": 3.141592653589793},{"x": 7.5,"z": 13.65,"y": 0,"rotation": 3.141592653589793}],
      },
    },
    {
      id: "rugs",
      name: "Alfombras de zona",
      zone: "development",
      size: [5.4,0.02,2.4],
      mounting: "existing",
      recipe: [{"shape": "box","size": [5.4,0.02,2.4],"position": [0,0.01,0],"color": "#DDECF5"}],
      placements: {
        "team-2": [{"x": 3.1,"z": 4.6,"y": 0,"rotation": 0}],
        "team-4": [{"x": 3.1,"z": 5.4,"y": 0,"rotation": 0}],
        "team-6": [{"x": 3.1,"z": 6.2,"y": 0,"rotation": 0}],
        "team-8": [{"x": 3.1,"z": 7.0,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "glass",
      name: "Mamparas de reuniones",
      zone: "meeting",
      size: [4.425,0.55,0.05],
      mounting: "existing",
      recipe: [{"shape": "box","size": [4.425,0.55,0.05],"position": [0,0.275,0],"color": "#A9DBE2"}],
      placements: {
        "team-2": [{"x": 2.612,"z": 2.4,"y": 0,"rotation": 0}],
        "team-4": [{"x": 2.612,"z": 2.4,"y": 0,"rotation": 0}],
        "team-6": [{"x": 2.612,"z": 2.4,"y": 0,"rotation": 0}],
        "team-8": [{"x": 2.612,"z": 2.4,"y": 0,"rotation": 0}],
      },
    },
    {
      id: "kanban",
      name: "Pizarra / Kanban operativo",
      zone: "board",
      size: [2.05,1,0.12],
      mounting: "existing",
      recipe: [{"shape": "box","size": [2.05,1,0.12],"position": [0,0.5,0],"color": "#F3F6FA"}],
      placements: {
        "team-2": [{"x": 12.4,"z": 3.55,"y": 0.8,"rotation": 3.141592653589793}],
        "team-4": [{"x": 12.4,"z": 3.55,"y": 0.8,"rotation": 3.141592653589793}],
        "team-6": [{"x": 12.4,"z": 3.55,"y": 0.8,"rotation": 3.141592653589793}],
        "team-8": [{"x": 12.4,"z": 3.55,"y": 0.8,"rotation": 3.141592653589793}],
      },
    },
    {
      id: "cups",
      name: "Tazas sobre mesas comunes",
      zone: "meeting / idle",
      size: [0.09,0.12,0.09],
      mounting: "tabletop",
      recipe: [{"shape": "cylinder","size": [0.09,0.1,0.09],"position": [0,0.05,0],"color": "#F3F6FA"},{"shape": "cylinder","size": [0.065,0.005,0.065],"position": [0,0.102,0],"color": "#8A6A45"}],
      placements: {
        "team-2": [{"x": 2.7,"z": 1.35,"y": 0.48,"rotation": 0},{"x": 3.55,"z": 1.4,"y": 0.48,"rotation": 0},{"x": 2.7,"z": 7.55,"y": 0.45,"rotation": 0}],
        "team-4": [{"x": 2.7,"z": 1.35,"y": 0.48,"rotation": 0},{"x": 3.55,"z": 1.4,"y": 0.48,"rotation": 0},{"x": 2.7,"z": 9.15,"y": 0.45,"rotation": 0}],
        "team-6": [{"x": 2.7,"z": 1.35,"y": 0.48,"rotation": 0},{"x": 3.55,"z": 1.4,"y": 0.48,"rotation": 0},{"x": 2.7,"z": 10.75,"y": 0.45,"rotation": 0}],
        "team-8": [{"x": 2.7,"z": 1.35,"y": 0.48,"rotation": 0},{"x": 3.55,"z": 1.4,"y": 0.48,"rotation": 0},{"x": 2.7,"z": 12.35,"y": 0.45,"rotation": 0}],
      },
    },
  ],
};
