import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

(async () => {
  const chrome = [process.env.AO_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((c) => c && fs.existsSync(c));
  if (!chrome) {
    console.error('No Chrome found');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  page.setViewport({ width: 1024, height: 768 });

  try {
    await page.goto('http://localhost:7420/?view=building', { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (e) {
    console.log('Timeout waiting for navigation, continuing anyway:', e.message);
  }

  // Wait for office to be ready
  await page.waitForFunction(() => window.aoOffice?.ready, { timeout: 15000 });

  // Take screenshot
  await page.screenshot({ path: '/home/keromanix/dev/agent-office/data/worktrees/x81yoi/AO-6/building-capture.png' });

  console.log('Screenshot saved to building-capture.png');
  await browser.close();
})();
