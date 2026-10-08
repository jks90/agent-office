// FT-149: regenera public/office-v3-data.js (subconjunto minificado) desde docs/oficina-v3/visual-contract-v3.json.
import { readFileSync, writeFileSync } from 'node:fs';
const c = JSON.parse(readFileSync(new URL('../docs/oficina-v3/visual-contract-v3.json', import.meta.url), 'utf8'));
const d = { palette: c.palette, layouts: c.layouts, ambient: c.ambient };
writeFileSync(new URL('../public/office-v3-data.js', import.meta.url),
  '// FT-149: contrato visual v3 (docs/oficina-v3/visual-contract-v3.json) minificado; regenerar con node scripts/gen-office-v3-data.mjs.\nexport default ' + JSON.stringify(d) + ';\n');
console.log('ok');
