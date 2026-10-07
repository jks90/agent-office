// FT-122 · Decisiones del Coordinador / Supervisor (rol de serie 'coordinador'). Funciones puras; team.js las aplica.
const RESOLVED = new Set(['done', 'discarded']); // = team.RESOLVED (sin importarlo: team.js importa este módulo)

export const SUPERVISE_EVERY_MS = 30_000; // cada cuánto se reconsidera una tarea que sigue esperando en revisión

// Veredicto de una tarea en revisión. in: { checks: { ok, failed? } | null, sensitive: [], delegated, reviewRequired }
// → { action: 'approve' | 'recommend' | 'reject' | 'skip', text }
export const BIG_DIFF_LINES = 30; // por encima, aprobar exige además el visto bueno de un revisor (FT-122)
export const changedLines = (patch) => String(patch || '').split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
export function decide({ checks, sensitive = [], delegated = false, reviewRequired = false }) {
  if (checks && !checks.ok) return { action: 'reject', text: `La verificación «${checks.failed}» falla en tu rama (ya puesta al día con la base). Arréglala y vuelve a pasarla antes de pedir revisión.` };
  if (!checks) return { action: 'skip', text: 'sin verificaciones declaradas: hace falta un revisor' };
  const what = 'las verificaciones pasan con la rama al día';
  if (sensitive.length) return { action: 'recommend', text: `✅ ${what}, pero toca ficheros sensibles (${sensitive.slice(0, 3).join(', ')}): la aprueba una persona` };
  if (!delegated) return { action: 'recommend', text: `✅ listo para aprobar: ${what}${reviewRequired ? ' (revisión obligatoria)' : ''}` };
  return { action: 'approve', text: `${what}${reviewRequired ? '; aprobada por delegación del proyecto' : ''}` };
}

// Dependencias que no hacen falta: la tarea (sin empezar) depende de otra que lleva parada en revisión o fallida y NO la menciona
// (ni su código ni su título) ni comparte fichero con ella. Nunca si la dependiente es qa/docs ni si la bloqueante es planner.
// `auto` = solo si TODAS las bloqueantes han fallado (en revisión es siempre solo propuesta). → [{ auto, taskId, code, drop: [ids], dropCodes, why }]
export function trimDeps(tasks, kindOf = () => 'dev') {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const files = (t) => new Set([...String(t.diffStat || '').matchAll(/^\s*(\S+)\s+\|/gm)].map((m) => m[1]));
  const out = [];
  for (const t of tasks) {
    if (!['backlog', 'todo'].includes(t.status) || !t.dependsOn?.length || t.depsKept) continue;
    if (['qa', 'docs'].includes(kindOf(t))) continue; // QA y docs dependen de lo que verifican/documentan aunque no lo nombren
    const text = `${t.title}\n${t.description || ''}`.toLowerCase();
    const drop = t.dependsOn.map((d) => byId.get(d)).filter((d) => d && !RESOLVED.has(d.status) && ['review', 'failed'].includes(d.status) && kindOf(d) !== 'planner'
      && !(d.code && text.includes(d.code.toLowerCase())) && !text.includes(String(d.title).toLowerCase())
      && ![...files(d)].some((f) => text.includes(f.toLowerCase())));
    if (!drop.length) continue;
    out.push({ auto: drop.every((d) => d.status === 'failed'), taskId: t.id, code: t.code || t.id, drop: drop.map((d) => d.id), dropCodes: drop.map((d) => d.code || d.id),
      why: `${t.code || t.id} no menciona ${drop.map((d) => d.code || d.id).join(', ')} ni toca sus ficheros, y esa tarea está parada (${drop.map((d) => d.status).join('/')}): la dependencia sobra` });
  }
  return out;
}
