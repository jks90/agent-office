import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(directory, 'visual-contract-v3.json'), 'utf8'));
const epsilon = 0.000001;
const expectedZones = ['development', 'qa', 'board', 'meeting', 'po', 'user', 'idle', 'recreation', 'reception'];
const expectedStates = ['working', 'reviewing', 'waiting', 'blocked', 'failed'];
assert.equal(contract.task, 'FT-146');
assert.deepEqual(contract.mockup.agents.map(agent => agent.state), expectedStates);
assert.equal(contract.mockup.agents.length, 5);
assert.equal(contract.ambient.characters.length, 2);
assert.equal(contract.mockup.ambientPositions.length, 2);

for (const layout of contract.layouts) {
  assert.deepEqual(Object.keys(layout.floorZones), expectedZones);
  const anchors = new Map(layout.anchors.map(anchor => [anchor.id, anchor]));
  assert.equal(anchors.size, layout.anchors.length);
  const zones = Object.values(layout.floorZones);
  for (const zone of zones) {
    assert(zone.w > 0 && zone.d > 0);
    assert(zone.x - zone.w / 2 >= 0 && zone.x + zone.w / 2 <= layout.floor.rx + epsilon);
    assert(zone.z - zone.d / 2 >= 0 && zone.z + zone.d / 2 <= layout.floor.rz + epsilon);
    assert.equal(zone.labelX, zone.labelAnchor.x);
    assert.equal(zone.labelZ, zone.labelAnchor.z);
  }
  for (const [index, zone] of zones.entries()) {
    for (const other of zones.slice(index + 1)) {
      assert(Math.abs(zone.x - other.x) >= (zone.w + other.w) / 2 - epsilon || Math.abs(zone.z - other.z) >= (zone.d + other.d) / 2 - epsilon, `Zones overlap: ${zone.label}, ${other.label}`);
    }
  }
  for (const anchor of anchors.values()) {
    const zone = layout.floorZones[anchor.zone];
    assert(zone, `Unknown zone: ${anchor.zone}`);
    assert(Number.isFinite(anchor.rotationY));
    assert(Math.abs(anchor.x - zone.x) + anchor.w / 2 <= zone.w / 2 + epsilon, `${layout.id}: ${anchor.id} outside zone x`);
    if (!anchor.boundary && anchor.kind !== 'door') assert(Math.abs(anchor.z - zone.z) + anchor.d / 2 <= zone.d / 2 + epsilon, `${layout.id}: ${anchor.id} outside zone z`);
    if (anchor.kind === 'door' && !anchor.boundary) assert(Math.abs(anchor.z - zone.z - zone.d / 2) < epsilon);
    if (anchor.boundary) assert(Math.abs(anchor.z - layout.floor.rz) < epsilon);
    if (anchor.seatId) assert.equal(anchors.get(anchor.seatId)?.deskId, anchor.id);
    if (anchor.deskId) assert.equal(anchors.get(anchor.deskId)?.seatId, anchor.id);
  }
  for (const prefix of ['chair-', 'qa-chair-', 'wait-']) {
    assert.equal(layout.anchors.filter(anchor => anchor.id.startsWith(prefix)).length, layout.maxAgents);
  }
  for (const route of Object.values(layout.routes)) {
    for (const point of route) assert(point.x >= 0 && point.x <= layout.floor.rx + epsilon && point.z >= 0 && point.z <= layout.floor.rz + epsilon);
  }
}

const fixtureLayout = contract.layouts.find(layout => layout.id === contract.mockup.layoutId);
assert(fixtureLayout);
const occupied = new Set();
for (const agent of contract.mockup.agents) {
  assert(fixtureLayout.anchors.some(anchor => anchor.id === agent.anchor));
  assert(!occupied.has(agent.anchor));
  occupied.add(agent.anchor);
}

const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find(candidate => candidate && fs.existsSync(candidate));
assert(chrome, 'Chrome/Chromium required; set AO_CHROME');
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const name of ['planta-iso', 'planta-cenital']) {
    const source = fs.readFileSync(path.join(directory, 'mockups', `${name}.svg`), 'utf8');
    const raster = await page.evaluate(async svg => {
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (document.querySelector('parsererror')) throw new Error('Invalid SVG XML');
      const root = document.documentElement;
      if (root.getAttribute('width') !== '1920' || root.getAttribute('height') !== '1080') throw new Error('Incorrect mockup dimensions');
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = window.document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, source);
    fs.writeFileSync(path.join(directory, 'mockups', `${name}.png`), Buffer.from(raster, 'base64'));
  }
} finally {
  await browser.close();
}
console.log('FT-146: four layouts validated; both SVG mockups rasterized at 1920 × 1080.');
