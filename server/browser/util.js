// Carpeta de datos del navegador (perfil de Playwright, capturas y salidas por tarea). Sin importar store.js (arrancaría efectos).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataDir = () => path.join(process.env.AO_DATA_DIR || path.join(ROOT, 'data'), 'browser');
