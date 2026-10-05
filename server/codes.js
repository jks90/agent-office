// Códigos de tarea: cada tarea lleva un código legible y estable (`GL-7` = prefijo del proyecto + correlativo)
// que viaja a todas partes — tarjeta, rama git, commit, issue del tablero online, prompt del agente, flows y docs —
// para poder citarla y relacionarla. El id interno (aleatorio) sigue siendo la clave de la API.
const CODE_RE = /\b([A-Z][A-Z0-9]{1,4})-(\d{1,6})\b/;

// Prefijo por defecto a partir del nombre/carpeta del proyecto: «gestionlab» → GL, «flow-test» → FT, «home» → HO, «unityhouse» → UH.
const KNOWN = { unityhouse: 'UH', disasterworld: 'UH', gestionlab: 'GL', agentoffice: 'AO', 'agent-office': 'AO', flowtest: 'FT', 'flow-test': 'FT', home: 'HO', default: 'WS' };
export function defaultPrefix(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (KNOWN[raw]) return KNOWN[raw];
  const words = raw.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return 'TK';
  // Varias palabras → iniciales (flow test → FT); una con sufijo conocido → inicial + sufijo (gestionlab → GL); si no, dos primeras letras.
  if (words.length > 1) return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  const m = words[0].match(/^(.)(?:.+?)(lab|house|test|office|shop|web|app|world)$/);
  return (m ? m[1] + m[2][0] : words[0].slice(0, 2)).toUpperCase();
}

export const normalizePrefix = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const prefixOf = (project) => normalizePrefix(project?.prefix) || defaultPrefix(project?.folder || project?.name);

// Código escrito en un texto (título de tarjeta, de issue…): «UH-198», «[GL-7]», «GL-7 ·».
export const codeIn = (text, prefix = null) => {
  const m = String(text || '').match(prefix ? new RegExp(`\\b(${prefix})-(\\d{1,6})\\b`) : CODE_RE);
  return m ? `${m[1]}-${Number(m[2])}` : null;
};
export const numberOf = (code) => Number(String(code || '').split('-')[1]) || 0;

// Siguiente número libre del proyecto (mira los códigos asignados Y los que aparecen en títulos para no chocar).
export function nextNumber(tasks, project) {
  const prefix = prefixOf(project);
  let max = project?.codeSeq || 0;
  for (const t of tasks) {
    if (t.projectId !== project.id) continue;
    for (const c of [t.code, codeIn(t.title, prefix)]) if (c && c.startsWith(prefix + '-')) max = Math.max(max, numberOf(c));
  }
  return max + 1;
}

// Asignar código a una tarea nueva: si el título ya trae uno del proyecto (importado de un tablero o escrito a mano)
// y nadie lo tiene, se respeta; si no, correlativo.
export function assignCode(tasks, project, task) {
  const prefix = prefixOf(project);
  const inTitle = codeIn(task.title, prefix);
  const taken = new Set(tasks.filter((t) => t.projectId === project.id && t !== task && t.code).map((t) => t.code));
  task.code = inTitle && !taken.has(inTitle) ? inTitle : `${prefix}-${nextNumber(tasks, project)}`;
  project.codeSeq = Math.max(project.codeSeq || 0, numberOf(task.code));
  return task.code;
}

// Título para fuera (issue/tarjeta): con el código delante salvo que ya lo lleve.
export const titleWithCode = (task) => (!task.code || codeIn(task.title) === task.code || String(task.title).includes(task.code)) ? task.title : `${task.code} · ${task.title}`;
// Título que llega de fuera → sin el «CODE · » que pusimos nosotros (si el código iba dentro del texto original, se deja).
export const stripCode = (title, code) => (code ? String(title || '').replace(new RegExp(`^\\[?${code}\\]?\\s*[·:\\-–]\\s*`), '') : String(title || '')).trim();

// Migración: dar código a las tareas que no lo tienen, por orden de creación, respetando los que ya van en el título.
export function migrate(state) {
  for (const p of state.projects) {
    const mine = state.tasks.filter((t) => t.projectId === p.id).sort((a, b) => a.createdAt - b.createdAt);
    for (const t of mine) if (!t.code) assignCode(state.tasks, p, t);
  }
}
