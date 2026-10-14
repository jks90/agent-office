// 🫧 Instancia única de la burbuja del agente (ver overlay.js): se alimenta del Activity Stream (tools de Playwright de
// los workers), del Guía (guide/index.js) y de cada cambio de estado (preguntas nuevas, tareas que acaban).
import * as store from '../store.js';
import * as questions from '../questions.js';
import { createOverlay, GUIDE } from './overlay.js';

const port = Number(process.env.AO_PORT || 7420);
export { GUIDE };
export const overlay = createOverlay({
  url: () => `http://127.0.0.1:${port}`,
  getState: () => store.get(),
  listQuestions: () => questions.list(),
  enabled: () => process.env.AO_OVERLAY !== 'off' && store.get().settings?.agentOverlay !== false,
  log: (line) => console.log(line),
});

let pending = null; // los cambios de estado llegan a ráfagas: se agrupan
store.bus.on('state', () => { if (!pending) pending = setTimeout(() => { pending = null; overlay.sync(); }, 300); });
store.bus.on('activity', (ev) => overlay.onActivity(ev));
setInterval(() => overlay.sync(), 15_000).unref(); // caduca a quien lleva IDLE_MS sin usar el navegador
