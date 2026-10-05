// Motor simulado: recorre pasos verosímiles con tiempos aleatorios. Sirve para ver la oficina sin gastar tokens.
const STEPS = {
  po: [
    'Leyendo la documentación del proyecto',
    'Revisando el código existente',
    'Dibujando el plan en la pizarra',
    'Escribiendo las historias de usuario',
    'Repartiendo tareas al equipo',
  ],
  back: [
    'Leyendo server/routes.js',
    'Buscando «router» en el repo',
    'Editando server/routes.js',
    'Editando server/services/{slug}.js',
    'Ejecutando `npm test`',
    'Escribiendo el resumen',
  ],
  front: [
    'Leyendo src/App.tsx',
    'Buscando componentes parecidos',
    'Editando src/components/{Slug}.tsx',
    'Editando src/api/{slug}.ts',
    'Ejecutando `npm run typecheck`',
    'Escribiendo el resumen',
  ],
  qa: [
    'Leyendo la tarea y los cambios',
    'flow-test: flow_create «QA {slug}»',
    'flow-test: node_add_request POST /api/{slug}',
    'flow-test: node_add_request GET /api/{slug}',
    'flow-test: flow_run',
    'Revisando asserts: 4/4 ✓',
    'Escribiendo el informe de QA',
  ],
};

const slugOf = (s) => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'feature';
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());

export function start({ agent, task, mode, goal, roles, onActivity, onLog }) {
  const role = mode === 'plan' ? 'po' : agent.role;
  const slug = slugOf(mode === 'plan' ? goal : task.title);
  const steps = STEPS[role].map((s) => s.replace('{slug}', slug).replace('{Slug}', capital(slug)));
  let timer = null;
  let stopped = false;
  let finish;
  const done = new Promise((r) => { finish = r; });

  let i = 0;
  const next = () => {
    if (stopped) return;
    if (i >= steps.length) {
      if (mode === 'plan') return finish({ ok: true, summary: 'Plan listo', tasks: demoPlan(goal, roles), costUsd: 0 });
      return finish({ ok: true, summary: demoSummary(role, task), costUsd: 0, diffStat: demoDiff(role, slug) });
    }
    const step = steps[i++];
    onActivity(step);
    onLog('🔧 ' + step);
    timer = setTimeout(next, 2200 + Math.random() * 2800);
  };
  timer = setTimeout(next, 600);

  return {
    done,
    stop() { stopped = true; clearTimeout(timer); finish({ ok: false, stopped: true, error: 'Parado por el usuario' }); },
  };
}

function demoPlan(goal, roles) {
  const g = String(goal).trim();
  const out = [];
  if (roles.includes('back')) out.push({ title: `API: ${g}`, description: `Endpoints y servicio para «${g}», con validación y errores claros.`, role: 'back', dependsOn: [] });
  if (roles.includes('front')) out.push({ title: `Pantalla: ${g}`, description: `Interfaz para «${g}» conectada a la API.`, role: 'front', dependsOn: roles.includes('back') ? [0] : [] });
  if (roles.includes('qa')) out.push({ title: `QA: ${g}`, description: `Flow de flow-test que verifique «${g}» de punta a punta (casos felices y de error).`, role: 'qa', dependsOn: out.map((_, i) => i) });
  return out;
}

function demoSummary(role, task) {
  if (role === 'qa') return `Flow «QA» creado y ejecutado en flow-test: 4/4 asserts en verde para «${task.title}». (simulado)`;
  return `Implementado «${task.title}»: cambios en 2 ficheros y pruebas en verde. (simulado)`;
}

function demoDiff(role, slug) {
  if (role === 'back') return ` server/routes.js             | 12 ++++++\n server/services/${slug}.js | 48 ++++++++++++++++++\n 2 files changed, 60 insertions(+)`;
  if (role === 'front') return ` src/components/${capital(slug)}.tsx | 74 +++++++++++++++++++\n src/api/${slug}.ts | 21 ++++++\n 2 files changed, 95 insertions(+)`;
  return ` flows/qa-${slug}.flow.json | 120 ++++++++++++++++++++++\n 1 file changed, 120 insertions(+)`;
}
