// FT-54 · Motor «local»: IA local (LM Studio / Ollama, API compatible con OpenAI) ejecutada por el runner de Codex.
// Se reutiliza TODO codex.js (worktree, stream JSON, allowlist, mensajes en caliente por reencolado): solo cambia el
// proveedor, que se define por línea de comandos (`-c model_provider=aolocal -c model_providers.aolocal.…`) sin tocar
// el ~/.codex/config.toml del usuario. Sin cuota ni coste (costUsd 0); los tokens se cuentan igual (turn.completed).
import * as codex from './codex.js';
import * as server from './local-server.js';
import { localKey } from './auth.js';

const ID = 'aolocal';
const KEY_ENV = 'AO_LOCAL_API_KEY';
// Codex ya NO admite wire_api="chat" (solo "responses", que LM Studio ≥0.3.29 y Ollama ≥0.13 sirven en /v1/responses); AO_LOCAL_WIRE_API=chat para un Codex antiguo.
const wireApi = () => process.env.AO_LOCAL_WIRE_API || 'responses';

// Argumentos `-c` del proveedor (pura: la usa la prueba). `-m` lo pone codex.js con el modelo.
export function providerArgs(baseUrl, hasKey = false) {
  const c = (k, v) => ['-c', `model_providers.${ID}.${k}=${JSON.stringify(v)}`];
  return ['-c', `model_provider=${ID}`, ...c('name', 'AgentOffice local'), ...c('base_url', baseUrl), ...c('wire_api', wireApi()), ...(hasKey ? c('env_key', KEY_ENV) : [])];
}

// Modelos pequeños: pasos cortos y verificar con órdenes (se añade al prompt de sistema; el de la tarea es el de Codex).
export const NOTE = 'Nota (modelo local, pequeño): trabaja en pasos cortos, una herramienta cada vez; no inventes rutas ni resultados: comprueba con órdenes (ls, cat, git diff, los tests) antes de dar algo por hecho; respuestas breves.';

// Un fallo del servidor por un modelo sin herramientas se traduce a un mensaje claro.
const friendly = (err, model) => (/tool|function/i.test(err || '') && /support|invalid|unknown|not /i.test(err || '') ? `${server.noToolsMessage(model)} (${String(err).split('\n')[0].slice(0, 160)})` : err);

export async function start(opts) {
  const cfg = server.config();
  if (!cfg?.baseUrl) throw new Error('IA local sin configurar: Ajustes ▸ Motores de IA ▸ IA local (URL del servidor y «Probar»)');
  const model = opts.model || cfg.model;
  if (!model) throw new Error('IA local: elige un modelo en Ajustes ▸ Motores de IA ▸ IA local');
  const key = localKey();
  if ((await server.toolSupport(cfg.baseUrl, model, key)) === false) throw new Error(server.noToolsMessage(model));
  let tools = 0;
  const job = codex.start({
    ...opts, model, system: `${opts.system}\n\n${NOTE}`, extraArgs: providerArgs(cfg.baseUrl, !!key),
    env: { ...opts.env, ...(key ? { [KEY_ENV]: key } : {}) },
    onTool: (c) => { if (c.phase === 'started') tools++; opts.onTool?.(c); },
    onUsage: (u) => opts.onUsage?.({ ...u, costUsd: 0 }),
  });
  const done = job.done.then((r) => {
    if (!r.ok) return { ...r, error: friendly(r.error, model) };
    if (!tools && opts.mode !== 'plan') opts.onLog(`⚠ ${model} no ejecutó ninguna herramienta: si la tarea pedía cambios, prueba con un modelo con soporte de tools`);
    return { ...r, costUsd: 0 };
  });
  return { ...job, done };
}
