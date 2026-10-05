// FT-20 · Provider falso (AO_DESKTOP=fake): datos fijos para las pruebas.
import { readFileSync } from 'node:fs';
import { saveCapture } from './capture.js';
const WINDOWS = [
  { id: '0x04000001', title: 'agent-office — Visual Studio Code', app: 'code', pid: 1111, active: true },
  { id: '0x04000002', title: 'Terminal', app: 'gnome-terminal-', pid: 2222, active: false },
  { id: '0x04000003', title: 'AgentOffice — Mozilla Firefox', app: 'firefox', pid: 3333, active: false },
];
// PNG pequeño incluido en el repo (FT-21)
const PNG = readFileSync(new URL('./fake.png', import.meta.url));

export function createFakeProvider() {
  return {
    id: 'fake',
    session: 'fake',
    available: () => ({ ok: true, missing: [], captureTool: 'fake' }),
    getActive: async () => { const { active, ...w } = WINDOWS.find(x => x.active); return w; },
    list: async () => WINDOWS.map(w => ({ ...w })),
    capture: async () => saveCapture(PNG, 'fake'),
  };
}
