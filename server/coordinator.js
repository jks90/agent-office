// 🧑‍✈️ Coordinador del equipo: reglas fijas (sin IA, sin tokens) que reajustan la plantilla de un proyecto en marcha para que
// el tablero avance. Función PURA: recibe una foto del proyecto y devuelve las acciones; team.js las aplica (o solo las sugiere).
//   1. Motor sin cuota: un agente parado porque su motor no tiene cuota, con trabajo listo para su rol y el otro motor con
//      margen → pasa a `auto` (elige motor en cada tarea).
//   2. Rol atascado: tareas LISTAS (por hacer, dependencias hechas) y nadie que pueda hacerlas (o ≥3 por agente) → se trae a
//      alguien de ese rol: del banquillo si lo hay, si no se contrata. Sin mesa libre, antes se manda al banquillo a un agente
//      ocioso (sin trabajo listo para su rol desde hace rato) que no sea el único de un rol con trabajo pendiente.
//   3. (FT-121) Reasignar antes que contratar: tareas listas de un rol sin nadie libre y un ocioso ≥ IDLE_MIN de otro rol del mismo
//      kind (y repo permitido por p.repos[].roles) → 'retarget' (cambia su rol, guarda homeRole); sin trabajo listo del rol prestado
//      → 'restore' (vuelve a su homeRole). Revisiones que bloquean tareas: ver reviewPlan().
// Nunca toca a quien trabaja, ni a quien tiene tareas suyas esperando (asignadas o pausadas por cuota), ni al PO.
import { blocksOf, waitingSince, nudgeMin } from './review.js';
export const MAX_DESKS = 8;
export const IDLE_MIN = 10;      // minutos sin trabajo listo antes de poder ir al banquillo
export const RATIO = 3;          // tareas listas por agente a partir de las que se refuerza un rol
export const MAX_PER_ROLE = 3;   // no se refuerza un rol que ya tiene tantos agentes que pueden trabajar

const ENGINES = ['claude', 'codex'];
export const matches = (a, role, roles) => a.role === role || (roles[a.role]?.handles || []).includes(role);
export const canWork = (a, engineOk) => (a.engine === 'auto' ? ENGINES.some((e) => engineOk[e]) : !!engineOk[a.engine]);

// snap: { team, bench, tasks (del proyecto), roles, engineOk:{claude,codex}, busy:Set(agentId), idleSince:{id: ms}, now, margin:{claude,codex} }
export function plan(snap) {
  const { team, bench = [], tasks, roles, engineOk, busy = new Set(), idleSince = {}, now = Date.now(), margin = {}, repos = [] } = snap;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsDone = (t) => (t.dependsOn || []).every((d) => ['done', 'discarded'].includes(byId.get(d)?.status ?? 'done'));
  const ready = tasks.filter((t) => t.status === 'todo' && t.kind !== 'plan' && depsDone(t));
  const pendingRoles = new Set(tasks.filter((t) => ['todo', 'backlog'].includes(t.status)).map((t) => t.role));
  const readyFor = (role) => ready.filter((t) => t.role === role);
  const readyForAgent = (a) => ready.filter((t) => matches(a, t.role, roles));
  const ownsWork = (a) => tasks.some((t) => !['done', 'discarded'].includes(t.status) && (t.assignedAgentId === a.id || t.preferAgentId === a.id || (t.status === 'doing' && t.agentId === a.id)));
  const isPlanner = (a) => roles[a.role]?.kind === 'planner';
  const actions = [];

  // 1 · motor sin cuota → auto
  const otherOk = (e) => ENGINES.some((x) => x !== e && engineOk[x]);
  for (const a of team) {
    if (busy.has(a.id) || a.engine === 'auto' || !ENGINES.includes(a.engine) || engineOk[a.engine] || !otherOk(a.engine)) continue;
    if (!readyForAgent(a).length) continue;
    actions.push({ type: 'engine', agentId: a.id, engine: 'auto', why: `${a.name}: ${a.engine} sin cuota y tiene trabajo listo → motor automático` });
  }
  const after = (a) => (actions.some((x) => x.type === 'engine' && x.agentId === a.id) ? { ...a, engine: 'auto' } : a);

  // 1b · FT-121 · el prestado vuelve a casa cuando ya no queda trabajo listo del rol que cubría
  const restored = new Set();
  for (const a of team) {
    if (!a.homeRole || a.homeRole === a.role || busy.has(a.id) || ownsWork(a) || readyFor(a.role).length) continue;
    restored.add(a.id);
    actions.push({ type: 'restore', agentId: a.id, role: a.homeRole, why: `${a.name}: ya no queda trabajo listo de ${a.role} → vuelve a ${a.homeRole}` });
  }

  // 1c · FT-121 · reasignar antes que contratar: rol con trabajo listo y nadie libre → un ocioso del mismo kind cambia de rol
  const repoOk = (r1, r2) => !repos.length || repos.some((r) => [r1, r2].every((x) => !(r.roles || []).length || r.roles.includes(x)));
  const retargeted = new Set();
  const lend = [...new Set(ready.map((t) => t.role))].filter((role) => !team.some((a) => !busy.has(a.id) && matches(after(a), role, roles) && canWork(after(a), engineOk)));
  for (const role of lend) {
    const kind = roles[role]?.kind;
    if (!kind || kind === 'planner') continue;
    const donor = team.filter((a) => !busy.has(a.id) && !a.homeRole && !restored.has(a.id) && !retargeted.has(a.id) && !isPlanner(a) && roles[a.role]?.kind === kind && a.role !== role
      && !ownsWork(a) && !readyForAgent(after(a)).length && canWork(after(a), engineOk) && now - (idleSince[a.id] ?? now) >= IDLE_MIN * 60_000 && repoOk(a.role, role))
      .sort((x, y) => (idleSince[x.id] ?? now) - (idleSince[y.id] ?? now))[0];
    if (!donor) continue;
    retargeted.add(donor.id);
    actions.push({ type: 'retarget', agentId: donor.id, role, why: `${readyFor(role).length} tarea(s) de ${role} listas y nadie libre; ${donor.name} (${donor.role}) lleva ${Math.round((now - (idleSince[donor.id] ?? now)) / 60000)} min ocioso → pasa a ${role} (volverá a ${donor.role})` });
  }

  // 2 · rol atascado → reforzar (una sola vez por pasada)
  const capacity = (role) => team.map(after).filter((a) => matches(a, role, roles) && canWork(a, engineOk)).length;
  const needy = [...new Set(ready.map((t) => t.role))].filter((r) => !actions.some((x) => x.type === 'retarget' && x.role === r))
    .map((role) => ({ role, n: readyFor(role).length, cap: capacity(role) }))
    .filter((r) => r.cap === 0 || (r.n / r.cap >= RATIO && r.cap < MAX_PER_ROLE))
    .sort((x, y) => (x.cap - y.cap) || (y.n - x.n));
  const need = needy[0];
  if (need) {
    const from = bench.filter((a) => a.role === need.role && canWork(a, engineOk)).sort((x, y) => (y.engine === 'auto') - (x.engine === 'auto'))[0];
    const best = ENGINES.filter((e) => engineOk[e]).sort((x, y) => (margin[y] ?? 50) - (margin[x] ?? 50))[0];
    const bring = from ? { type: 'sign', agentId: from.id, role: need.role, why: `${need.n} tareas de ${need.role} listas y ${need.cap ? `solo ${need.cap} agente(s)` : 'nadie que pueda hacerlas'} → vuelve ${from.name} del banquillo` }
      : best ? { type: 'hire', role: need.role, engine: best, why: `${need.n} tareas de ${need.role} listas y ${need.cap ? `solo ${need.cap} agente(s)` : 'nadie que pueda hacerlas'} → se contrata uno con ${best}` } : null;
    if (bring) {
      if (team.length >= MAX_DESKS) {
        // mesa llena: un ocioso al banquillo (sin trabajo listo, ocioso ≥ IDLE_MIN, no imprescindible para su rol)
        const donor = team.filter((a) => !busy.has(a.id) && !isPlanner(a) && !ownsWork(a) && a.role !== need.role && !readyForAgent(after(a)).length
          && now - (idleSince[a.id] ?? now) >= IDLE_MIN * 60_000
          && (!pendingRoles.has(a.role) || team.some((b) => b.id !== a.id && b.role === a.role)))
          .sort((x, y) => (idleSince[x.id] ?? now) - (idleSince[y.id] ?? now))[0];
        if (donor) actions.push({ type: 'bench', agentId: donor.id, why: `${donor.name} lleva ${Math.round((now - (idleSince[donor.id] ?? now)) / 60000)} min sin trabajo listo → al banquillo para dejar mesa` }, bring);
      } else actions.push(bring);
    }
  }
  return actions;
}

// FT-121 · revisiones que bloquean. snap: { tasks (del proyecto), reviewPolicy, reviewNudgeMin, now }.
// Tarea en review con tareas esperándola más de reviewNudgeMin minutos:
//   · política automática y no reviewRequired → 'review-now' (se lanza ya la revisión, sin esperar al tick) una sola vez (t.blockKicked);
//   · reviewRequired, política manual o ya retenida por la revisión automática → 'review-alert' prioritario, una sola vez (t.blockAlerted).
export function reviewPlan(snap) {
  const { tasks, reviewPolicy = 'manual', now = Date.now() } = snap;
  const min = snap.reviewNudgeMin ?? nudgeMin({});
  const out = [];
  for (const t of tasks) {
    if (t.status !== 'review' || t.reviewing || t.blockAlerted || t.kind === 'plan') continue;
    const blocks = blocksOf(tasks, t);
    const minutes = Math.floor((now - waitingSince(t)) / 60000);
    if (!blocks.length || minutes < min) continue;
    const code = t.code || t.id, n = blocks.length;
    const base = { taskId: t.id, blocks: blocks.map((b) => b.code), minutes };
    const auto = reviewPolicy !== 'manual' && !t.reviewRequired && !t.reviewNote && !t.blockKicked;
    if (auto) out.push({ ...base, type: 'review-now', why: `${code} lleva ${minutes} min en revisión y bloquea a ${n} tarea(s) (${base.blocks.join(', ')}) → se lanza ya la revisión automática` });
    else out.push({ ...base, type: 'review-alert', required: !!t.reviewRequired, why: `⚠ ${code} «${t.title}» lleva ${minutes} min en revisión y bloquea a ${n} tarea(s) (${base.blocks.join(', ')})${t.reviewRequired ? ': es de revisión obligatoria, la tienes que revisar tú' : ': necesita tu revisión'}` });
  }
  return out;
}
