// Traduce una llamada a herramienta en una frase corta para el bocadillo de la oficina.
const file = (p) => (p ? String(p).split('/').slice(-2).join('/') : '');
const short = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read': return `Leyendo ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Editando ${file(input.file_path)}`;
    case 'Write': return `Escribiendo ${file(input.file_path)}`;
    case 'Grep': return `Buscando «${short(input.pattern, 30)}»`;
    case 'Glob': return `Buscando ficheros ${short(input.pattern, 30)}`;
    case 'Bash': return `Ejecutando \`${short(input.command, 50)}\``;
    case 'TodoWrite': return 'Organizando sus pasos';
    case 'WebFetch': return `Leyendo ${short(input.url, 40)}`;
    case 'WebSearch': return `Buscando en la web «${short(input.query, 30)}»`;
    case 'Task':
    case 'Agent': return `Delegando: ${short(input.description, 40)}`;
  }
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `${server}: ${tool}${input.name ? ' ' + short(input.name, 30) : ''}`;
  }
  return name;
}

// Resumen para el Activity Stream (FT-1): sin contenido sensible — nunca el comando de Bash ni textos escritos, solo el programa/fichero/patrón.
export function toolSummary(name, input = {}) {
  if (name === 'Bash') return `Ejecutando ${short(String(input.command ?? '').trim().split(/\s+/)[0], 30)}`;
  if (name === 'WebFetch') return 'Leyendo una URL';
  return describeTool(name, input);
}

// FT-62: clave de repetición (orden completa / ruta completa). Solo para el detector de atascos: nunca se publica.
export function toolKey(name, input = {}) {
  if (name === 'Bash') return String(input.command ?? '').trim().slice(0, 300) || null;
  // Read: el tramo cuenta (offset/limit). Leer por tramos un fichero grande es justo lo que piden las reglas de ahorro;
  // solo es «releer» volver al MISMO tramo.
  if (name === 'Read') return input.file_path ? String(input.file_path) + (input.offset != null || input.limit != null ? ` @${input.offset ?? 1}+${input.limit ?? ''}` : '') : null;
  return null;
}

export const firstLine = (s, n = 70) => short(String(s ?? '').split('\n').find((l) => l.trim()) || '', n);

// El PO devuelve las tareas como JSON; lo sacamos aunque venga envuelto en texto o en ```json.
export function parseTasks(text) {
  const src = String(text ?? '');
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : src.slice(src.indexOf('['), src.lastIndexOf(']') + 1);
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error('El PO no devolvió una lista de tareas');
  return arr;
}
