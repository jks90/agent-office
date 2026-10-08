// FT-161 · seguridad del marketplace (server/marketplace.js): validación de paquetes, saneado, secretos y destinos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sec-mkt-'));
process.env.AO_DATA_DIR = path.join(tmp, 'data');
const catalog = path.join(tmp, 'catalog');
const store = await import('../../server/store.js');
store.get().settings.catalogDir = catalog;
const mkt = await import('../../server/marketplace.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const file = (p, text, extra = {}) => { const b = Buffer.from(text); return { path: p, content: b.toString('base64'), sha256: sha(b), ...extra }; };
const pkg = (o = {}) => ({ format: 'ao-pkg/1', kind: 'skill', name: 'demo', version: '1.0.0', files: [file('SKILL.md', '# demo')], ...o });
const rejects = (p, status, re) => assert.throws(() => mkt.validate(p), (e) => e.status === status && (!re || re.test(e.message)));

test('validate acepta un paquete correcto', () => {
  assert.equal(mkt.validate(pkg()).name, 'demo');
});

test('validate: formato, tipo, nombre y versión', () => {
  rejects(null, 400); rejects(undefined, 400); rejects('x', 400); rejects([], 400);
  rejects(pkg({ format: 'ao-pkg/2' }), 400, /Formato/);
  rejects(pkg({ kind: 'exe' }), 400, /Tipo/);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a b', '-x', 'x'.repeat(65), 42, null, ['a']]) rejects(pkg({ name }), 422, /Nombre/);
  for (const version of ['', 'v1', '1.0', null, 1, {}]) rejects(pkg({ version }), 400, /Versión/);
});

test('validate: rutas peligrosas en ficheros', () => {
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a\0b', '', 'a//b', './', 'a/..', null, 5, ['x']]) {
    rejects(pkg({ files: [file('ok', 'x', { path: p })] }), 422, /Ruta/);
  }
  assert.ok(mkt.validate(pkg({ files: [file('scripts/run.sh', 'echo')] })));
});

test('validate: ficheros repetidos, contenido no string, null y sha alterado', () => {
  rejects(pkg({ files: [file('a', '1'), file('a', '1')] }), 422, /repetido/);
  rejects(pkg({ files: [{ path: 'a', content: 123, sha256: 'x' }] }), 422, /Contenido/);
  rejects(pkg({ files: [null] }), 422);
  rejects(pkg({ files: [{ ...file('a', 'hola'), sha256: 'f'.repeat(64) }] }), 422, /sha256/);
  rejects(pkg({ files: [{ ...file('a', 'hola'), sha256: undefined }] }), 422, /sha256/);
  rejects(pkg({ files: 'no' }), 400, /ficheros/);
  rejects(pkg({ files: undefined }), 400);
});

test('validate: topes de tamaño y de número de ficheros', () => {
  rejects(pkg({ files: [file('big', 'a'.repeat(mkt.MAX_FILE + 1))] }), 422, /512 KB/);
  assert.ok(mkt.validate(pkg({ files: [file('ok', 'a'.repeat(mkt.MAX_FILE))] })));
  const many = Array.from({ length: mkt.MAX_FILES + 1 }, (_, i) => file(`f${i}`, 'x'));
  rejects(pkg({ files: many }), 422, /Demasiados/);
  const huge = Array.from({ length: 5 }, (_, i) => file(`h${i}`, 'a'.repeat(mkt.MAX_FILE)));
  rejects(pkg({ files: huge }), 413, /2 MB/);
});

test('campos inesperados / JSON malicioso no rompen ni contaminan', () => {
  const evil = JSON.parse('{"format":"ao-pkg/1","kind":"skill","name":"demo","version":"1.0.0","__proto__":{"polluted":1},"constructor":{"x":1},"extra":{"a":[1,2]},"files":[]}');
  assert.ok(mkt.validate(evil));
  assert.equal({}.polluted, undefined);
  const item = '{"path":"roles/r.md","content":"","sha256":"' + sha(Buffer.alloc(0)) + '","__proto__":{"exec":true}}';
  const deep = JSON.parse('{"format":"ao-pkg/1","kind":"role","name":"r","version":"1.0.0","files":[' + item + ']}');
  assert.ok(mkt.validate(deep));
  assert.equal({}.exec, undefined);
});

test('sanitizeText reemplaza rutas del usuario por el marcador HOME', () => {
  const t = mkt.sanitizeText(`a ${os.homedir()}/x /home/pepe/y /Users/ana/z C:\\Users\\bob\\w`);
  assert.ok(!t.includes(os.homedir()) && !/pepe|ana|bob/.test(t));
  assert.equal(t.match(/\{\{HOME\}\}/g).length, 4);
});

test('scanSecrets detecta secretos sin devolver su valor, y no da falsos positivos', () => {
  const bad = {
    sk: 'k=sk-abcdefghijklmnop1234', gh: 'ghp_' + 'a'.repeat(24), slack: 'xoxb-1234567890-abc', aws: 'AKIA' + 'A'.repeat(16),
    pem: '-----BEGIN RSA PRIVATE KEY-----', jwt: 'eyJabcdefghij.eyJabcdefghij.abcdefghij', bearer: 'Bearer ' + 'a'.repeat(30),
    pass: 'password = abc123def456ghi',
  };
  for (const [k, text] of Object.entries(bad)) {
    const r = mkt.scanSecrets([{ where: k, text }]);
    assert.ok(r.length >= 1, k);
    assert.ok(!JSON.stringify(r).includes(text), 'no filtra el valor');
  }
  assert.deepEqual(mkt.scanSecrets([{ where: 'a', text: 'Usa password = ${PASS} y token: <tu-token>. Hola mundo.' }]), []);
});

test('inspect: avisa de secretos y de código ejecutable', () => {
  const i = mkt.inspect(pkg({ files: [file('SKILL.md', '# x'), file('run.sh', 'echo hi'), file('n.md', 'api_key: abc123def456ghi789')] }));
  assert.equal(i.hasCode, true);
  assert.equal(i.secrets.length, 1);
});

test('importPackage rechaza paquetes con secretos sin escribir nada', () => {
  const p = pkg({ name: 'leaky', files: [file('SKILL.md', 'ghp_' + 'b'.repeat(25))] });
  assert.throws(() => mkt.importPackage(p), (e) => e.status === 422 && Array.isArray(e.findings));
  assert.ok(!fs.existsSync(path.join(catalog, 'skills', 'leaky')));
});

test('importPackage: una ruta mala aborta el paquete entero antes de escribir', () => {
  const p = pkg({ name: 'trav', files: [file('SKILL.md', '# ok'), file('x', 'x', { path: '../../escape.txt' })] });
  assert.throws(() => mkt.importPackage(p), (e) => e.status === 422);
  assert.ok(!fs.existsSync(path.join(catalog, 'skills', 'trav')));
  assert.ok(!fs.existsSync(path.join(catalog, 'escape.txt')));
});

test('importPackage: skill válida se instala; con código pide confirmación; sobrescribir también', () => {
  const p = pkg({ name: 'okskill', files: [file('SKILL.md', 'ruta /home/pepe/x'), file('run.sh', 'echo', { exec: true })] });
  assert.throws(() => mkt.importPackage(p), (e) => e.status === 409 && e.needsConfirm === 'code');
  const r = mkt.importPackage(p, { confirmCode: true });
  assert.equal(r.target, path.join(catalog, 'skills', 'okskill'));
  assert.ok(fs.statSync(path.join(r.target, 'run.sh')).mode & 0o100);
  assert.throws(() => mkt.importPackage(p, { confirmCode: true }), (e) => e.status === 409 && e.needsConfirm === 'overwrite');
  assert.ok(mkt.importPackage(p, { confirmCode: true, overwrite: true }));
});

test('importPackage: un enlace simbólico en el destino se rechaza y no se sigue', () => {
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(catalog, 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(catalog, 'skills', 'linked'));
  const p = pkg({ name: 'linked', files: [file('SKILL.md', '# x')] });
  assert.throws(() => mkt.importPackage(p, { overwrite: true }), (e) => e.status === 422 && /enlace/.test(e.message));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('importPackage de rol: organización no válida y destino existente', () => {
  const r = { format: 'ao-pkg/1', kind: 'role', name: 'revisor', version: '1.0.0', files: [file('roles/revisor.md', 'hola')] };
  // FT-144 normaliza el nombre de la org a una carpeta segura (no rechaza '../x'); FT-162 ajusta el test.
  for (const org of ['..', '///', '...']) assert.throws(() => mkt.importPackage(r, { org }), (e) => e.status === 422);
  const t = mkt.importPackage(r, { org: '../x', overwrite: true }).target;
  assert.equal(t, path.join(path.dirname(path.dirname(t)), 'x', 'revisor.md'), '../x se normaliza a «x», sin salir de marketplace/');
  assert.ok(mkt.importPackage(r, { org: 'Acme' }).target.endsWith(path.join('marketplace', 'acme', 'revisor.md')));
  assert.throws(() => mkt.importPackage(r, { org: 'Acme' }), (e) => e.status === 409);
  assert.throws(() => mkt.importPackage({ ...r, files: [] }), (e) => e.status === 400);
});

test('exportPackage: argumentos inválidos', () => {
  assert.throws(() => mkt.exportPackage('exe', 'x'), (e) => e.status === 400);
  assert.throws(() => mkt.exportPackage('role', 'x', 'otro'), (e) => e.status === 400);
  assert.throws(() => mkt.exportPackage('agent', 'x', 'public'), (e) => e.status === 400);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
