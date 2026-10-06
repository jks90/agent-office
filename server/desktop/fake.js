// FT-20 · Provider falso (AO_DESKTOP=fake): datos fijos para las pruebas.
import { readFileSync } from 'node:fs';
import { saveCapture } from './capture.js';
import { resolveApp } from './apps.js';
import { filterNodes, pidOfRef, ACTIONS, MAX_DEPTH, MAX_NODES } from './atspi.js';
const WINDOWS = [
  { id: '0x04000001', title: 'agent-office — Visual Studio Code', app: 'code', pid: 1111, active: true },
  { id: '0x04000002', title: 'Terminal', app: 'gnome-terminal-', pid: 2222, active: false },
  { id: '0x04000003', title: 'AgentOffice — Mozilla Firefox', app: 'firefox', pid: 3333, active: false },
];
// PNG pequeño incluido en el repo (FT-21)
const PNG = readFileSync(new URL('./fake.png', import.meta.url));

// FT-24: AO_DESKTOP_FAKE_ACTIVE="AgentOffice" finge que la ventana activa tiene ese título (para probar la regla «solo fuera»).
const windows = () => WINDOWS.map(w => (w.active && process.env.AO_DESKTOP_FAKE_ACTIVE ? { ...w, title: process.env.AO_DESKTOP_FAKE_ACTIVE, app: 'firefox' } : { ...w }));

// FT-29 · Árbol AT-SPI simulado (el mismo para cualquier pid) y registro en memoria de las acciones.
const fakeTree = (pid) => [
  { ref: `${pid}:`, role: 'application', name: 'fake-app', states: ['enabled'], actions: [], bounds: null },
  { ref: `${pid}:0`, role: 'frame', name: 'Documento', states: ['enabled', 'showing'], actions: [], bounds: { x: 0, y: 0, width: 800, height: 600 } },
  { ref: `${pid}:0.0`, role: 'push button', name: 'Guardar', states: ['enabled', 'showing', 'focusable'], actions: ['click'], bounds: { x: 10, y: 10, width: 80, height: 30 } },
  { ref: `${pid}:0.1`, role: 'push button', name: 'Eliminar', states: ['enabled', 'showing', 'focusable'], actions: ['click'], bounds: { x: 100, y: 10, width: 80, height: 30 } },
  { ref: `${pid}:0.2`, role: 'text', name: 'Nombre', states: ['enabled', 'showing', 'editable', 'focusable'], actions: [], bounds: { x: 10, y: 50, width: 300, height: 30 } },
];
const uiActions = [];
// FT-31 · Apps simuladas y registro de lanzamientos
const FAKE_APPS = [
  { id: 'gedit', name: 'Editor de texto', exec: 'gedit %U' },
  { id: 'firefox', name: 'Firefox', exec: 'firefox %u' },
  { id: 'org.gnome.Calculator', name: 'Calculadora', exec: 'gnome-calculator' },
  { id: 'gnome-terminal', name: 'Terminal', exec: 'gnome-terminal' },
  { id: 'agentoffice', name: 'AgentOffice', exec: 'xdg-open http://localhost:7420' },
  { id: 'flowtest', name: 'flow-test', exec: 'flowtest' },
];
const launched = [];
const inputs = []; // FT-30 · entrada simulada (click/scroll/type/keyPress), en memoria
const bad = (status, msg) => Object.assign(new Error(msg), { status });
const depthOf = (n) => (n.ref.split(':')[1] ? n.ref.split(':')[1].split('.').length : 0);

export function createFakeProvider() {
  const targetPid = async ({ pid, windowId } = {}) => {
    if (pid) return pid;
    const ws = windows();
    return (windowId ? ws.find(w => w.id === windowId) : ws.find(w => w.active))?.pid || ws[0].pid;
  };
  return {
    id: 'fake',
    session: 'fake',
    available: () => ({ ok: true, missing: [], captureTool: 'fake' }),
    getActive: async () => { const { active, ...w } = windows().find(x => x.active); return w; },
    list: async () => windows(),
    capture: async () => saveCapture(PNG, 'fake'),
    a11yAvailable: () => ({ ok: true, missing: [] }),
    uiTree: async (o = {}) => fakeTree(await targetPid(o)).filter(n => depthOf(n) <= Math.min(o.depth ?? 3, MAX_DEPTH)).slice(0, Math.min(o.maxNodes ?? 200, MAX_NODES)),
    uiFind: async (o = {}) => filterNodes(fakeTree(await targetPid(o)), o),
    uiNode: async (ref) => {
      const pid = pidOfRef(ref), n = fakeTree(pid).find(x => x.ref === ref);
      if (!n) throw bad(404, `ref no encontrado: ${ref}`);
      return { ...n, pid, app: windows().find(w => w.pid === pid)?.app || 'fake-app' };
    },
    uiAct: async ({ ref, action, text }) => {
      if (!ACTIONS.includes(action)) throw bad(400, `acción no válida: ${action}`);
      const n = fakeTree(pidOfRef(ref)).find(x => x.ref === ref);
      if (!n) throw bad(404, `ref no encontrado: ${ref}`);
      if (action === 'setText' && n.role !== 'text') throw bad(400, 'el control no admite texto');
      uiActions.push({ ts: Date.now(), ref, name: n.name, action, ...(action === 'setText' ? { text } : {}) });
      return { ok: true, node: n };
    },
    listApps: async () => FAKE_APPS.map(a => ({ ...a })),
    openApp: async ({ id } = {}) => { const a = resolveApp(FAKE_APPS, id); launched.push({ ts: Date.now(), id: a.id }); return { ok: true, id: a.id, launcher: 'fake' }; },
    launchedApps: () => launched.slice(),
    uiActions: () => uiActions.slice(),
    // FT-30 · fallback de entrada: solo se registra
    inputAvailable: () => ({ ok: true, missing: [] }),
    click: async (o) => { inputs.push({ ts: Date.now(), kind: 'click', ...o }); return { ok: true }; },
    scroll: async (o) => { inputs.push({ ts: Date.now(), kind: 'scroll', ...o }); return { ok: true }; },
    type: async (o) => { inputs.push({ ts: Date.now(), kind: 'type', ...o }); return { ok: true, chars: [...String(o.text)].length }; },
    keyPress: async (o) => { inputs.push({ ts: Date.now(), kind: 'keyPress', ...o }); return { ok: true }; },
    inputs: () => inputs.slice(),
  };
}
