// FT-20 · DesktopProvider: ventana activa y lista de ventanas del escritorio.
//
// Contrato (todo provider exporta un objeto con esta forma):
//   {
//     id:        'linux' | 'fake' | 'unsupported',
//     session:   'x11' | 'wayland-gnome' | 'wayland' | 'none' | 'fake' | <so>,
//     available(): { ok, missing: string[], captureTool }    // síncrono; qué falta si ok=false
//     getActive(): Promise<{ id, title, app, pid }>
//     list():      Promise<[{ id, title, app, pid, active }]>
//     capture({target:'screen'|'window', windowId?}): Promise<{ path, width, height, bytes, tool, ts }>  // FT-21: guarda el PNG en data/desktop/captures/ (capture.js)
//     // FT-29 · AT-SPI, actuar por semántica (atspi.js):
//     a11yAvailable(): { ok, missing[] }
//     uiTree({pid|windowId, depth≤6, maxNodes≤500}) / uiFind({pid|windowId, role?, name?}) → [{ref, role, name, states[], actions[], bounds}]
//     uiNode(ref) → nodo + {pid, app} · uiAct({ref, action:'click'|'press'|'focus'|'setText', text?}) → {ok, node}
//   }
// Los errores llevan `.status` (501 no soportado, 503 faltan herramientas) para que index.js los enrute.
// FT-24: AO_DESKTOP_PLATFORM=darwin|win32 simula otra plataforma (pruebas del 501).
// Selección: AO_DESKTOP=fake → fake; si no, por process.platform (solo linux de momento).
import { createLinuxProvider } from './linux.js';
import { createFakeProvider } from './fake.js';

export function createUnsupportedProvider(os = process.platform) {
  const err = () => Object.assign(new Error(`aún no disponible en ${os}`), { status: 501 });
  return {
    id: 'unsupported',
    session: os,
    available: () => ({ ok: false, missing: [`soporte para ${os}`], captureTool: null }),
    getActive: async () => { throw err(); },
    list: async () => { throw err(); },
    capture: async () => { throw err(); },
    a11yAvailable: () => ({ ok: false, missing: [`soporte para ${os}`] }),
    uiTree: async () => { throw err(); },
    uiFind: async () => { throw err(); },
    uiNode: async () => { throw err(); },
    uiAct: async () => { throw err(); },
  };
}

export function getProvider() {
  if (process.env.AO_DESKTOP === 'fake') return createFakeProvider();
  const os = process.env.AO_DESKTOP_PLATFORM || process.platform;
  if (os === 'linux') return createLinuxProvider();
  return createUnsupportedProvider(os);
}
