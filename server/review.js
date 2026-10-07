// FT-56 · Revisión visible y revisión automática opcional. Funciones puras (sin store): `team.js` las orquesta y `index.js` las publica en el snapshot.
export const POLICIES = ['manual', 'auto-qa', 'auto'];
export const MAX_AUTO_CYCLES = 3; // tope de devoluciones automáticas; luego queda para el humano (las devoluciones por choque con la base no cuentan)
export const SENSITIVE_DEFAULT = ['.github/workflows', 'Dockerfile', 'package.json', 'server/access'];

// La del proyecto manda (p.reviewPolicy); sin ella, la de la empresa (settings.reviewPolicy); sin ninguna, manual.
export const policyOf = (settings, project = null) => (POLICIES.includes(project?.reviewPolicy) ? project.reviewPolicy : POLICIES.includes(settings?.reviewPolicy) ? settings.reviewPolicy : 'manual');
export const nudgeMin = (settings) => { const n = settings?.reviewNudgeMin; return n === undefined || n === null || n === '' || !(Number(n) >= 0) ? 10 : Number(n); };
export const sensitiveList = (settings) => (Array.isArray(settings?.reviewSensitive) ? settings.reviewSensitive.map(String).filter(Boolean) : SENSITIVE_DEFAULT);

// Desde cuándo espera una tarea en revisión (reviewAt la fija el orquestador; las anteriores a FT-56 usan updatedAt).
export const waitingSince = (t) => t.reviewAt || t.updatedAt || Date.now();

// Tareas que esperan a `t` (dependsOn) y aún no están hechas.
export const blocksOf = (tasks, t) => tasks.filter((x) => x.id !== t.id && (x.dependsOn || []).includes(t.id) && !['done', 'discarded'].includes(x.status)).map((x) => ({ id: x.id, code: x.code || x.id }));

// De qué dependencia espera `t` (la primera sin terminar), con su estado: para «⏳ espera a FT-46 (en revisión)».
export const waitingOn = (tasks, t) => (t.status === 'todo' || t.status === 'backlog'
  ? (t.dependsOn || []).map((d) => tasks.find((x) => x.id === d)).filter((x) => x && !['done', 'discarded'].includes(x.status)).map((x) => ({ id: x.id, code: x.code || x.id, status: x.status }))
  : []);

// Campos derivados que viajan en cada tarea del snapshot (no se persisten).
export function decorate(tasks) {
  return tasks.map((t) => {
    if (t.status === 'review') return { ...t, reviewSince: waitingSince(t), blocks: blocksOf(tasks, t) };
    const w = waitingOn(tasks, t);
    return w.length ? { ...t, waitingOn: w } : t;
  });
}

// Comandos de verificación que declara la tarea: `checks[]` + comandos en `código` de la descripción que parecen verificaciones.
const CHECK_RE = /^(node |npm (run |test|t\b)|npx |pnpm |yarn |make |pytest|python3? -m (pytest|unittest)|tsc\b|eslint|go test|cargo test|mvn |gradle)/;
export function declaredChecks(t) {
  const out = (Array.isArray(t.checks) ? t.checks : []).map((c) => String(c).trim()).filter(Boolean);
  for (const m of String(t.description || '').matchAll(/`([^`\n]{3,200})`/g)) if (CHECK_RE.test(m[1].trim()) && /(check|test|e2e|lint|typecheck|tsc|verify)/i.test(m[1])) out.push(m[1].trim());
  return [...new Set(out)].slice(0, 6);
}

// ¿Toca la tarea ficheros sensibles? `files` = rutas del diff; `patch` = diff completo (para distinguir dependencias en package.json).
export function sensitiveHits(files, patch, list) {
  const hits = [];
  for (const f of files) {
    for (const s of list) {
      if (!f.includes(s)) continue;
      if (/(^|\/)package\.json$/.test(s) || /(^|\/)package\.json$/.test(f)) {
        // package.json solo es sensible si cambia alguna dependencia (líneas `"nombre": "^1.2.3"` añadidas/quitadas)
        if (/^[+-]\s*"(?!version")[^"]+":\s*"[~^><=]*\d/m.test(patch || '')) hits.push(f);
      } else hits.push(f);
    }
  }
  return [...new Set(hits)];
}

// Veredicto estructurado del revisor: el último objeto JSON con `approve` del texto → { approve, reasons[], feedback } | null.
export function parseVerdict(text) {
  const s = String(text || '');
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    for (let j = s.indexOf('}', i); j >= 0; j = s.indexOf('}', j + 1)) {
      try {
        const o = JSON.parse(s.slice(i, j + 1));
        if (o && typeof o.approve === 'boolean') return { approve: o.approve, reasons: (Array.isArray(o.reasons) ? o.reasons : []).map(String).slice(0, 10), feedback: String(o.feedback || '').slice(0, 3000),
          followups: (Array.isArray(o.followups) ? o.followups : []).map((f) => (typeof f === 'string' ? { title: f } : f)).filter((f) => f && String(f.title || '').trim()).map((f) => ({ title: String(f.title).trim().slice(0, 140), description: String(f.description || '').slice(0, 2000) })).slice(0, 5),
          pending: (Array.isArray(o.pending) ? o.pending : []).map(String).slice(0, 8) };
      } catch { /* sigue buscando el cierre */ }
    }
  }
  return null;
}

export function reviewPrompt(t, base, checks) {
  return [
    `Eres el revisor de la tarea ${t.code || t.id}: ${t.title}. NO edites ficheros ni hagas commits: solo lees y ejecutas comprobaciones.`,
    `1. Mira los cambios: \`git diff ${base}...HEAD\` (y \`git log ${base}..HEAD\`).`,
    `2. Lee el resumen del autor y comprueba que la descripción de la tarea se cumple.`,
    checks.length ? `3. Ejecuta estas verificaciones y exige que pasen:\n${checks.map((c) => `   - ${c}`).join('\n')}` : '3. Ejecuta las verificaciones razonables que encuentres (typecheck, lint, tests, build) si existen y se pueden ejecutar aquí.',
    '',
    'CÓMO DECIDES (el objetivo es que el trabajo avance; una devolución cuesta otro intento completo):',
    '- DEVUELVE (approve:false) SOLO por algo que BLOQUEA: lo que pide la descripción no está hecho o está mal, hay un error claro (no compila, un test que se puede ejecutar aquí falla, rompe algo que ya funcionaba, un fallo de seguridad o de datos), o el cambio deja el repo inconsistente.',
    '- NO devuelvas por comprobaciones que no puedes hacer en este entorno (levantar la API o servicios, docker/docker compose, e2e contra un servidor en marcha, bases de datos): anótalas en "pending" y decide con lo que SÍ puedes comprobar.',
    '- NO devuelvas por mejoras, ampliaciones o cosas que la descripción no pedía (endpoints nuevos, pantallas extra, refactors, estilo): apruébala y propónlas en "followups" para que se hagan en otra tarea.',
    '- NO devuelvas por choques con la base (merge): eso se gestiona aparte.',
    '- Si devuelves, "feedback" dice exactamente qué corregir, en pocos puntos y solo lo bloqueante.',
    '',
    `Descripción de la tarea:\n${t.description || '(sin descripción)'}`,
    `\nResumen del autor:\n${(t.summary || '').slice(0, 3000)}`,
    '\nAl terminar, la ÚLTIMA línea de tu respuesta debe ser un único objeto JSON: {"approve": true|false, "reasons": ["…"], "feedback": "qué debe corregir el autor (vacío si apruebas)", "pending": ["comprobación que no se pudo hacer aquí"], "followups": [{"title": "…", "description": "…"}]}',
  ].join('\n');
}

// Mensaje del «pendientes de revisión» que se añade al prompt del Guía.
export function pendingBlock(tasks, now, minMin) {
  const lines = tasks.filter((t) => t.status === 'review' && (now - waitingSince(t)) / 60000 >= minMin)
    .map((t) => `- ${t.code || t.id} «${t.title}» espera revisión desde hace ${Math.max(0, Math.round((now - waitingSince(t)) / 60000))} min${blocksOf(tasks, t).length ? `; bloquea: ${blocksOf(tasks, t).map((b) => b.code).join(', ')}` : ''}`);
  return lines.length ? `<pendientes_de_revision>\n${lines.join('\n')}\n(Menciónalo al usuario en tu próxima respuesta y ofrécele aprobar o devolver.)\n</pendientes_de_revision>` : '';
}
