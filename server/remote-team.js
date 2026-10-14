// ES-16 · Plantilla del proyecto para el mando (GET /api/remote/team/:id): compacta, sin avatar/identidad/rutas ni secretos.
const clip = (v, n) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function teamView(st, p, roles) {
  const agents = st.agents.filter((a) => (p.team || []).includes(a.id)).map((a) => ({
    id: a.id, name: clip(a.name, 40), role: a.role, roleLabel: roles[a.role]?.label || a.role, kind: roles[a.role]?.kind || null,
    status: a.status || 'idle', activity: clip(a.activity, 60), engine: a.engine || null, model: a.model || null,
    taskCode: (a.taskId && st.tasks.find((t) => t.id === a.taskId)?.code) || null,
  }));
  const ids = new Set(agents.map((a) => a.id)), mgr = p.managers && typeof p.managers === 'object' ? p.managers : {};
  return {
    agents, coordinatorId: agents.find((a) => a.kind === 'supervisor')?.id || null, reviewerId: p.reviewerAgentId || null,
    managers: Object.fromEntries(Object.entries(mgr).filter(([m]) => ids.has(m)).map(([m, l]) => [m, (Array.isArray(l) ? l : []).filter((x) => ids.has(x))])),
  };
}
