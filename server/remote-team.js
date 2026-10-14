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

// ES-17 · Detalle de un agente para el mando: sin secretos ni rutas de ficheros (se tachan en prompt, descripción y skills).
const scrub = (s) => String(s || '')
  .replace(/\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{8,}/g, '[…]')
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '[…]')
  .replace(/\b([A-Za-z_]*(?:key|token|secret|password|passwd|pwd)[A-Za-z_]*)\s*[:=]\s*\S+/gi, '$1=[…]')
  .replace(/\{\{secret:[^}]*\}\}/g, '[…]')
  .replace(/\b[A-Za-z0-9+\/_-]{32,}={0,2}/g, '[…]')
  .replace(/(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)[\w.@~-]+(?:[\/\\][\w.@ ~-]*)+/g, '[ruta]');
const clean = (v, n) => clip(scrub(v), n);
const taskOf = (t) => ({ code: t.code, title: clean(t.title, 80) });

export function agentView(st, p, roles, agentId) {
  const a = (p.team || []).includes(agentId) && st.agents.find((x) => x.id === agentId);
  if (!a) return null;
  const r = roles[a.role] || {};
  const mine = st.tasks.filter((t) => t.projectId === p.id && (t.agentId || t.assignedAgentId) === a.id);
  const cur = a.taskId && st.tasks.find((t) => t.id === a.taskId && t.projectId === p.id);
  const skills = [...new Set([...(r.skills || []), ...(a.skills || [])].map((s) => String(s).trim()).filter((s) => s && !/[\/\\]/.test(s)))].slice(0, 30).map((s) => clean(s, 40));
  return {
    name: clean(a.name, 40), role: a.role, roleLabel: r.label || a.role, kind: r.kind || null,
    description: clean(r.description, 300), engine: a.engine || null, model: a.model || r.model || null,
    status: a.status || 'idle', activity: clean(a.activity, 60), currentTask: cur ? taskOf(cur) : null,
    recentTasks: [...mine].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).slice(0, 5).map((t) => ({ ...taskOf(t), status: t.status })),
    stats: { done: mine.filter((t) => t.status === 'done').length, enRevision: mine.filter((t) => t.status === 'review').length },
    skills, systemPrompt: clean(r.system, 1200), // se tacha antes de recortar para no cortar un secreto por la mitad
  };
}
