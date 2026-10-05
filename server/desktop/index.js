// FT-20 · DesktopProvider: ventana activa y lista de ventanas del escritorio.
//
// Contrato (todo provider exporta un objeto con esta forma):
//   {
//     id:        'linux' | 'fake' | 'unsupported',
//     session:   'x11' | 'wayland-gnome' | 'wayland' | 'none' | 'fake' | <so>,
//     available(): { ok: boolean, missing: string[] }      // síncrono; qué falta si ok=false
//     getActive(): Promise<{ id, title, app, pid }>
//     list():      Promise<[{ id, title, app, pid, active }]>
//     capture(opts): Promise<{ mime, data: Buffer }>        // opts: { window?: id } (sin id = pantalla completa)
//   }
// Los errores llevan `.status` (501 no soportado, 503 faltan herramientas) para que index.js los enrute.
// Selección: AO_DESKTOP=fake → fake; si no, por process.platform (solo linux de momento).
import { createLinuxProvider } from './linux.js';
import { createFakeProvider } from './fake.js';

export function createUnsupportedProvider(os = process.platform) {
  const err = () => Object.assign(new Error(`aún no disponible en ${os}`), { status: 501 });
  return {
    id: 'unsupported',
    session: os,
    available: () => ({ ok: false, missing: [`soporte para ${os}`] }),
    getActive: async () => { throw err(); },
    list: async () => { throw err(); },
    capture: async () => { throw err(); },
  };
}

export function getProvider() {
  if (process.env.AO_DESKTOP === 'fake') return createFakeProvider();
  if (process.platform === 'linux') return createLinuxProvider();
  return createUnsupportedProvider();
}
