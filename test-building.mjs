import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

const browser = await puppeteer.launch({ headless: 'new', args: ['--use-gl=swiftshader'] });
const page = await browser.newPage();
page.setViewport({ width: 1920, height: 1080 });

const server = spawn('node', ['bin/ao-run.mjs']);
await new Promise(r => setTimeout(r, 2000));

try {
  await page.goto('http://localhost:7420/?projects=demo1,demo2,demo3&view=building', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    return {
      mode: window.aoOffice?.officeLevel,
      floorCount: window.aoOffice?.floors?.length,
      decorTemplates: window.aoOffice?.buildingDecorTemplates?.size,
    };
  });

  console.log('Estado:', JSON.stringify(state));

  await page.screenshot({ path: 'ao7-building-decor.png' });
  console.log('✓ Captura guardada: ao7-building-decor.png');
} finally {
  await browser.close();
  server.kill();
}
