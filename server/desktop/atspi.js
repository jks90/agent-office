// FT-29 · Backend AT-SPI (accesibilidad) del DesktopProvider: leer y actuar sobre controles por semántica, sin píxeles.
// Sin dependencias npm: `python3 -c` con pyatspi vía execFile (timeout de 3 s). El ref de un nodo es `<pid>:<i.j.k>`
// (pid de la app + índices de hijo desde la raíz de la app): estable mientras la UI de la app no cambie su estructura.
// Nota: el fallback con gdbus (org.a11y.Bus) no está implementado; sin pyatspi se responde 503 con `missing`.
import { execFile, spawnSync } from 'node:child_process';

const TIMEOUT = 3000;
export const MAX_DEPTH = 6;
export const MAX_NODES = 500;
export const ACTIONS = ['click', 'press', 'focus', 'setText'];
const fail = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

const PY = String.raw`
import sys, json, pyatspi
a = json.loads(sys.argv[1])
def short(s): return str(s).replace('STATE_', '').lower().replace('_', '-')
def node(acc, ref):
    try: st = [short(s.value_name) for s in acc.getState().getStates()]
    except Exception: st = []
    try:
        ai = acc.queryAction(); acts = [ai.getName(i) for i in range(ai.nActions)]
    except Exception: acts = []
    try:
        e = acc.queryComponent().getExtents(0); b = {'x': e.x, 'y': e.y, 'width': e.width, 'height': e.height}
    except Exception: b = None
    return {'ref': ref, 'role': acc.getRoleName(), 'name': acc.name or '', 'states': st, 'actions': acts, 'bounds': b}
def app_of(pid):
    d = pyatspi.Registry.getDesktop(0)
    for i in range(d.childCount):
        try:
            x = d.getChildAtIndex(i)
            if x is not None and x.get_process_id() == pid: return x
        except Exception: pass
    return None
def at(ref):
    pid, _, path = ref.partition(':'); acc = app_of(int(pid))
    if acc is None: return None, None
    for i in [p for p in path.split('.') if p != '']: acc = acc.getChildAtIndex(int(i))
    return acc, int(pid)
def walk(pid, depth, maxn):
    root = app_of(pid)
    if root is None: return None
    out = []
    def go(acc, path, d):
        if len(out) >= maxn: return
        out.append(node(acc, '%d:%s' % (pid, path)))
        if d >= depth: return
        for i in range(acc.childCount):
            try: c = acc.getChildAtIndex(i)
            except Exception: continue
            if c is not None: go(c, (path + '.' if path else '') + str(i), d + 1)
    go(root, '', 0)
    return out
m = a['mode']
if m == 'tree':
    r = walk(a['pid'], a['depth'], a['maxNodes'])
    print(json.dumps({'error': 'app no encontrada en AT-SPI (pid %d)' % a['pid']} if r is None else {'nodes': r}))
elif m == 'node':
    acc, pid = at(a['ref'])
    print(json.dumps({'error': 'ref no encontrado: ' + a['ref']} if acc is None else {'node': node(acc, a['ref']), 'app': app_of(pid).name}))
elif m == 'act':
    acc, pid = at(a['ref'])
    if acc is None: print(json.dumps({'error': 'ref no encontrado: ' + a['ref']})); sys.exit(0)
    act = a['action']; ok = False
    if act in ('click', 'press'):
        ai = acc.queryAction(); names = [ai.getName(i) for i in range(ai.nActions)]
        want = [n for n in names if n.lower() in ('click', 'press', 'activate', 'jump')]
        ok = ai.doAction(names.index(want[0]) if want else 0) if names else False
    elif act == 'focus': ok = acc.queryComponent().grabFocus()
    elif act == 'setText': ok = acc.queryEditableText().setTextContents(a.get('text', ''))
    print(json.dumps({'ok': bool(ok), 'node': node(acc, a['ref'])}))
`;

let probe = null;
// → { ok, missing[] }. Solo se cachea el éxito (el usuario puede instalar el paquete sin reiniciar).
export function a11yAvailable() {
  if (probe?.ok) return probe;
  const missing = [];
  const py = spawnSync('python3', ['-c', 'import pyatspi'], { encoding: 'utf8', timeout: TIMEOUT });
  if (py.error) missing.push('python3');
  else if (py.status !== 0) missing.push('python3-pyatspi (apt install python3-pyatspi)');
  probe = { ok: !missing.length, missing };
  return probe;
}

const call = (payload) => new Promise((resolve, reject) => {
  const av = a11yAvailable();
  if (!av.ok) return reject(fail(503, `AT-SPI no disponible: falta ${av.missing.join(', ')}`, { missing: av.missing }));
  execFile('python3', ['-c', PY, JSON.stringify(payload)], { timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => {
    if (e) return reject(fail(503, `AT-SPI: ${String(err || '').trim().split('\n').pop() || e.message}`));
    let r; try { r = JSON.parse(out); } catch { return reject(fail(503, 'AT-SPI: respuesta no válida')); }
    if (r.error) return reject(fail(404, r.error));
    resolve(r);
  });
});

const clamp = (v, def, max) => Math.max(0, Math.min(max, Number.isInteger(v) ? v : def));
export const pidOfRef = (ref) => {
  const p = Number(String(ref).split(':')[0]);
  if (!Number.isInteger(p) || p <= 0) throw fail(400, `ref no válido: ${ref}`);
  return p;
};

export async function tree({ pid, depth, maxNodes }) {
  return (await call({ mode: 'tree', pid, depth: clamp(depth, 3, MAX_DEPTH), maxNodes: clamp(maxNodes, 200, MAX_NODES) })).nodes;
}
export const nodeInfo = async (ref) => { const pid = pidOfRef(ref); const r = await call({ mode: 'node', ref }); return { ...r.node, app: r.app, pid }; };
export const act = async ({ ref, action, text }) => {
  pidOfRef(ref);
  if (!ACTIONS.includes(action)) throw fail(400, `acción no válida: ${action}`);
  return call({ mode: 'act', ref, action, text });
};

// Filtro común (real y fake): role exacto, name por subcadena sin distinguir mayúsculas.
export function filterNodes(nodes, { role, name } = {}) {
  const n = name && String(name).toLowerCase();
  return nodes.filter((x) => (!role || x.role === role) && (!n || x.name.toLowerCase().includes(n)));
}
