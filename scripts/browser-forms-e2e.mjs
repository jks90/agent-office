#!/usr/bin/env node
// FT-130 · e2e de formularios con Chromium headless real: todos los tipos de campo, el caso httpbin.org/forms/post
// (mismo HTML, servidor local) y la explicación de la validación cuando el envío no se produce.
// Uso: node scripts/browser-forms-e2e.mjs   (sin navegador se omite)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-forms-'));
process.env.AO_DATA_DIR = dir;
process.env.AO_BROWSER_HEADLESS = '1';
const { createCdpDriver, findBrowser } = await import('../server/browser/cdp.js');

let fails = 0;
const ok = (c, m, d = '') => { console.log(`${c ? '✓' : '✗'} ${m}${!c && d ? ` — ${d}` : ''}`); if (!c) fails++; };
if (!findBrowser()) { console.log('SIN navegador: se omite'); process.exit(0); }

// HTML de httpbin.org/forms/post (campos, restricciones de la hora y botón sin type)
const HTTPBIN = `<!DOCTYPE html><html><head><title>Pizza</title></head><body>
<form method="post" action="/post">
 <p><label>Customer name: <input name="custname"></label></p>
 <p><label>Telephone: <input type=tel name="custtel"></label></p>
 <p><label>E-mail address: <input type=email name="custemail"></label></p>
 <fieldset><legend> Pizza Size </legend>
  <p><label> <input type=radio name=size value="small"> Small </label></p>
  <p><label> <input type=radio name=size value="medium"> Medium </label></p>
  <p><label> <input type=radio name=size value="large"> Large </label></p></fieldset>
 <fieldset><legend> Pizza Toppings </legend>
  <p><label> <input type="checkbox" name="topping" value="bacon"> Bacon </label></p>
  <p><label> <input type="checkbox" name="topping" value="cheese"> Extra Cheese </label></p>
  <p><label> <input type="checkbox" name="topping" value="onion"> Onion </label></p>
  <p><label> <input type="checkbox" name="topping" value="mushroom"> Mushroom </label></p></fieldset>
 <p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
 <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
 <p><button>Submit order</button></p>
</form></body></html>`;

const ALL = `<!doctype html><title>Todos</title>
<form id=f onsubmit="return false">
 <label>Fecha <input type=date name=d></label>
 <label>Hora <input type=time name=t></label>
 <label>Fecha y hora <input type=datetime-local name=dt></label>
 <label>Volumen <input type=range name=r min=0 max=10></label>
 <label>Color <input type=color name=c></label>
 <label>Sabor <select name=s><option value=v>Vainilla</option><option value=ch>Chocolate</option></select></label>
 <label>Extras <select name=m multiple><option value=a>Alfa</option><option value=b>Beta</option><option value=g>Gamma</option></select></label>
 <label>Fichero <input type=file name=file></label><span id=fname></span>
 <div contenteditable id=ce role=textbox aria-label="Notas"></div>
 <label>Texto <input name=x></label>
</form><p id=ev></p>
<script>
 const log=[]; for (const e of document.querySelectorAll('input,select,#ce')) for (const k of ['input','change']) e.addEventListener(k,()=>{log.push((e.name||e.id)+':'+k); document.getElementById('ev').textContent=log.join(',');});
 document.querySelector('[name=file]').addEventListener('change',e=>{document.getElementById('fname').textContent=e.target.files[0]?.name});
</script>`;

const VALID = `<!doctype html><title>Validar</title>
<form method=post action="/post"><label>Correo <input type=email name=mail required></label>
<label>Edad <input type=number name=age min=18 max=99></label><button>Enviar</button></form>`;

const posts = [];
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => { const raw = Buffer.concat(chunks).toString(); posts.push(raw); res.end(`<title>Enviado</title><h1>Pedido recibido</h1><pre>${raw.replace(/</g, '&lt;')}</pre>`); });
  }
  const p = req.url.split('?')[0];
  res.end(p === '/forms/post' ? HTTPBIN : p === '/todos' ? ALL : p === '/valida' ? VALID : 'no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const d = createCdpDriver();
const ref = async (role, name) => {
  const s = await d.snapshot();
  const n = s.nodes.find((x) => x.role === role && (x.name === name || x.name.includes(name)));
  if (!n) throw new Error(`no hay ${role} «${name}»:\n${s.nodes.map((x) => `${x.ref} ${x.role} ${x.name}`).join('\n')}`);
  return n.ref;
};
const val = async (sel) => d.evaluate({ expression: `(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e.type==='checkbox'||e.type==='radio'?e.checked:e.isContentEditable&&e.tagName==='DIV'?e.textContent:e.value})()` }).then((r) => r.value);

try {
  // ── 1. Tipos de campo ──
  await d.navigate({ url: `${base}/todos` });
  // los controles de fecha/hora/color/rango tienen roles distintos según el navegador: se buscan por nombre
  const byName = async (name) => { const s = await d.snapshot(); const n = s.nodes.find((x) => x.role !== 'StaticText' && x.name.includes(name)); if (!n) throw new Error(`sin «${name}»`); return n.ref; };
  await d.type({ ref: await byName('Fecha'), text: '2026-10-08' });
  await d.type({ ref: await byName('Fecha y hora'), text: '2026-10-08T14:30' });
  await d.type({ ref: await byName('Hora'), text: '12:45' });
  await d.type({ ref: await byName('Volumen'), text: '7' });
  await d.type({ ref: await byName('Color'), text: '#ff8800' });
  ok(await val('[name=d]') === '2026-10-08', 'date', await val('[name=d]'));
  ok(await val('[name=dt]') === '2026-10-08T14:30', 'datetime-local');
  ok(await val('[name=t]') === '12:45', 'time');
  ok(await val('[name=r]') === '7', 'range');
  ok(await val('[name=c]') === '#ff8800', 'color');
  const evText = (await d.evaluate({ expression: 'document.getElementById("ev").textContent' })).value;
  ok(/d:input/.test(evText) && /d:change/.test(evText) && /dt:change/.test(evText) && /c:change/.test(evText), 'dispara input y change', evText);
  await d.type({ ref: await byName('Fecha'), text: 'mañana' }).then(() => ok(false, 'date con formato malo debe fallar'), (e) => ok(e.status === 400 && /AAAA-MM-DD/.test(e.message), 'date inválida → 400 con el formato esperado'));

  await d.act({ ref: await byName('Sabor'), action: 'select', value: 'Chocolate' });
  ok(await val('[name=s]') === 'ch', 'select nativo por texto');
  await d.act({ ref: await byName('Extras'), action: 'select', value: 'Alfa|Gamma' });
  ok((await d.evaluate({ expression: '[...document.querySelector("[name=m]").selectedOptions].map(o=>o.value).join()' })).value === 'a,g', 'select múltiple');
  await d.act({ ref: await byName('Sabor'), action: 'select', value: 'Menta' }).then(() => ok(false, 'opción inexistente debe fallar'), (e) => ok(e.status === 400 && /Vainilla/.test(e.message), 'select con opción inexistente lista las disponibles'));

  await d.type({ ref: await ref('textbox', 'Notas'), text: 'hola ' });
  await d.type({ ref: await ref('textbox', 'Notas'), text: 'mundo' });
  ok(await val('#ce') === 'hola mundo', 'contenteditable (añade)');
  await d.type({ ref: await ref('textbox', 'Notas'), text: 'nuevo', clear: true });
  ok(await val('#ce') === 'nuevo', 'contenteditable (clear)');
  await d.type({ ref: await ref('textbox', 'Texto'), text: 'abc' });
  await d.type({ ref: await ref('textbox', 'Texto'), text: 'def' });
  ok(await val('[name=x]') === 'abcdef', 'texto (añade al final)');
  await d.type({ ref: await ref('textbox', 'Texto'), text: 'z', clear: true });
  ok(await val('[name=x]') === 'z', 'texto (clear)');

  const up = path.join(dir, 'subida.txt');
  fs.writeFileSync(up, 'hola');
  const fileRef = await byName('Fichero');
  await d.type({ ref: fileRef, text: 'x' }).then(() => ok(false, 'type en file debe fallar'), (e) => ok(e.status === 400 && /upload/.test(e.message), 'type en file remite a browser.upload'));
  await d.upload({ ref: fileRef, files: [up] });
  ok((await d.evaluate({ expression: 'document.getElementById("fname").textContent' })).value === 'subida.txt', 'file: DOM.setFileInputFiles dispara change');
  await d.upload({ ref: await ref('textbox', 'Texto'), files: [up] }).then(() => ok(false, 'upload a no-file debe fallar'), (e) => ok(e.status === 400, 'upload a un campo que no es file → 400'));

  // ── 2. Caso httpbin.org/forms/post ──
  await d.navigate({ url: `${base}/forms/post` });
  await d.type({ ref: await ref('textbox', 'Customer name'), text: 'Ana' });
  await d.type({ ref: await ref('textbox', 'Telephone'), text: '600123123' });
  await d.type({ ref: await ref('textbox', 'E-mail'), text: 'ana@example.test' });
  await d.act({ ref: await ref('radio', 'Large'), action: 'click' });
  await d.act({ ref: await ref('checkbox', 'Bacon'), action: 'click' });
  await d.act({ ref: await ref('checkbox', 'Onion'), action: 'click' });
  await d.type({ ref: await ref('textbox', 'Delivery instructions'), text: 'Timbre roto, llamar' });
  // primero la hora fuera de rango: no se envía y se explica por qué (esto era lo que fallaba en la demo)
  const timeRef = async () => { const s = await d.snapshot(); return s.nodes.find((x) => x.role !== 'StaticText' && /delivery time/i.test(x.name)).ref; };
  await d.type({ ref: await timeRef(), text: '08:00' });
  const bad = await d.act({ ref: await ref('button', 'Submit order'), action: 'click' });
  ok(bad.navigated === false && bad.submitted === false, 'hora fuera de rango: no navega y lo dice', JSON.stringify(bad));
  ok(bad.validation?.length === 1 && /delivery time/i.test(bad.validation[0].field) && bad.validation[0].message.length > 0, 'validation explica el campo y el mensaje', JSON.stringify(bad.validation));
  ok(/forms\/post$/.test(bad.url) && posts.length === 0, 'sigue en el formulario, sin POST');
  // corregida, se envía de verdad y devuelve {navigated,url,title}
  await d.type({ ref: await timeRef(), text: '19:30', clear: true });
  const good = await d.act({ ref: await ref('button', 'Submit order'), action: 'click' });
  ok(good.navigated === true && /\/post$/.test(good.url) && good.title === 'Enviado', 'Submit order navega a /post con título', JSON.stringify(good));
  ok(good.validation === undefined, 'sin errores de validación al enviar');
  const body = decodeURIComponent(posts[0] || '').replace(/\+/g, ' ');
  ok(/custname=Ana/.test(body) && /size=large/.test(body) && /topping=bacon/.test(body) && /topping=onion/.test(body) && /delivery=19:30/.test(body) && /comments=Timbre roto, llamar/.test(body) && /custemail=ana@example.test/.test(body), 'el servidor recibió todos los campos', body);

  // ── 3. Validación genérica (Enter y botón) ──
  await d.navigate({ url: `${base}/valida` });
  await d.type({ ref: await ref('textbox', 'Correo'), text: 'no-es-correo' });
  const enter = await d.type({ ref: await ref('textbox', 'Correo'), key: 'Enter' });
  ok(enter.navigated === false && enter.validation?.[0]?.field === 'Correo' && enter.validation[0].type === 'email', 'Enter con correo inválido explica el error', JSON.stringify(enter));
  await d.type({ ref: await ref('textbox', 'Correo'), text: 'a@b.co', clear: true });
  const sent = await d.type({ ref: await ref('textbox', 'Correo'), submit: true });
  ok(sent.navigated === true && /\/post$/.test(sent.url), 'type + submit navega', JSON.stringify(sent));
  // un clic normal no espera 5 s
  await d.navigate({ url: `${base}/todos` });
  const t0 = Date.now();
  const r = await d.act({ ref: await byName('Texto'), action: 'focus' });
  ok(r.navigated === false && Date.now() - t0 < 2500, 'una acción sin envío no espera', `${Date.now() - t0} ms`);
} catch (e) {
  ok(false, `excepción: ${e.stack || e.message}`);
} finally {
  await d.close().catch(() => {});
  srv.close();
}
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
