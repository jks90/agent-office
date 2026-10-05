// Descripción de imágenes con el proveedor multimodal del Guide (FT-23). Solo `anthropic-api` y `openai-api` admiten imágenes;
// `claude-cli` no (501) y `fake` devuelve una descripción fija si AO_DESKTOP=fake. Por `fetch`, sin SDK, como el resto de proveedores.
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as auth from '../engines/auth.js';
import { capturesDir } from '../desktop/capture.js';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
export const NO_IMAGES = 'el proveedor actual no admite imágenes';
const PROMPT = 'Describe con detalle lo que se ve en esta captura de pantalla del escritorio del usuario: aplicaciones y ventanas visibles, texto relevante y estado. Responde en español.';

export const providerName = () => store.get().settings.guideProvider || 'claude-cli';
// Falla con 501 antes de capturar/pedir confirmación si el proveedor no puede ver imágenes.
export function assertSupported() {
  const p = providerName();
  if (p === 'anthropic-api' || p === 'openai-api') return p;
  if (p === 'fake' && process.env.AO_DESKTOP === 'fake') return p;
  throw fail(501, NO_IMAGES);
}

// capturePath debe ser un PNG de data/desktop/captures/ (nada de rutas arbitrarias).
export function resolveCapture(p) {
  const dir = path.resolve(capturesDir());
  const full = path.resolve(String(p));
  if (path.dirname(full) !== dir || !/\.png$/i.test(full)) throw fail(400, 'capturePath debe ser una captura de data/desktop/captures/');
  if (!fs.existsSync(full)) throw fail(404, 'No existe esa captura');
  return full;
}

export async function describeImage(file, question) {
  const provider = assertSupported();
  if (provider === 'fake') return { description: 'Escritorio de prueba (fake): una ventana de VS Code abierta con código.', provider };
  const { modelFor } = await import('./index.js'); // import perezoso: index.js → proveedores → tools.js → vision.js
  const model = modelFor(provider);
  const b64 = fs.readFileSync(file).toString('base64');
  const text = question ? `${PROMPT}\n\nPregunta concreta: ${question}` : PROMPT;
  let res;
  if (provider === 'anthropic-api') {
    const key = auth.guideApiKey('anthropic');
    if (!key) throw fail(503, 'Falta la clave API de Anthropic (Ajustes ▸ Motores de IA)');
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text }] }] }),
    });
  } else {
    const key = auth.guideApiKey('openai');
    if (!key) throw fail(503, 'Falta la clave API de OpenAI (Ajustes ▸ Motores de IA)');
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] }),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t.slice(0, 300);
    try { const j = JSON.parse(t); msg = j.error?.message || j.message || msg; } catch { /* texto plano */ }
    throw fail(502, `${provider} → ${res.status}: ${msg}`);
  }
  const j = await res.json();
  const description = provider === 'anthropic-api' ? (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') : j.choices?.[0]?.message?.content || '';
  return { description: description.trim(), provider, model };
}
