// FT-54 · Proveedor del Guide con IA LOCAL (LM Studio / Ollama): reutiliza el cliente de openai-api.js con la URL base de
// Ajustes ▸ Motores de IA ▸ IA local (`settings.local.baseUrl`) y la clave opcional. Modelo por defecto: el elegido allí.
import * as openai from './openai-api.js';
import * as auth from '../../engines/auth.js';
import * as server from '../../engines/local-server.js';

// Objeto (no módulo) para que `defaultModel` siga a los Ajustes.
export const provider = {
  label: 'IA local (LM Studio / Ollama)',
  get defaultModel() { return server.config()?.model || ''; },
  ready: () => !!server.config()?.baseUrl && !!server.config()?.model,
  create: () => openai.create({
    who: 'local-api', name: 'IA local', required: false,
    baseUrl: () => { const b = server.config()?.baseUrl; if (!b) throw new Error('IA local sin configurar: Ajustes ▸ Motores de IA ▸ IA local'); return b; },
    key: () => auth.guideApiKey('local'),
  }),
};
