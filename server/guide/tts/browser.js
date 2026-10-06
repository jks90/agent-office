// TTS del navegador (FT-52): respaldo con speechSynthesis. Lo sintetiza el cliente (public/app.js elige una voz femenina en español
// de `speechSynthesis.getVoices()`); el servidor solo lo declara para poder elegirlo en Ajustes.
export const label = 'Navegador (speechSynthesis)';
export const DEFAULT_VOICE = 'auto';
export const client = true;
export const voices = () => [{ id: 'auto', label: 'Automática (voz femenina en español del navegador)', lang: 'es', gender: 'female' }];
export async function available() { return { ok: true, detail: 'se decide en el navegador' }; }
export async function synthesize() { throw Object.assign(new Error('El proveedor «browser» sintetiza en el navegador'), { status: 503 }); }
