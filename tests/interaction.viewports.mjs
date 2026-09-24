/**
 * Rendered-surface check for the interaction HUD: the same page at a desktop and
 * a mobile viewport, measuring what actually hit the layout — overflow, clipped
 * text, hit-testing and the reset button — plus a screenshot per size.
 *
 *   npm run build && npm run preview        # serves dist/ on 4173
 *   node tests/interaction.viewports.mjs
 *
 * Env: CHROME_PATH, PAGE_URL, OUT_DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/interaction.html';
const OUT_DIR = process.env.OUT_DIR || 'test-output';

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

const PASS = [];
const FAIL = [];
function check(name, ok, detail = '') {
  const line = name + (detail ? ` -- ${detail}` : '');
  (ok ? PASS : FAIL).push(line);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--window-size=1440,900'],
});

try {
  for (const size of SIZES) {
    console.log(`\n== ${size.name} ${size.width}x${size.height} ==`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push('console: ' + msg.text());
    });
    await page.setViewport({
      width: size.width,
      height: size.height,
      isMobile: !!size.mobile,
      hasTouch: !!size.mobile,
      deviceScaleFactor: 1,
    });
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__VOXEL_INTERACTION', { timeout: 30000 });
    await page.waitForFunction('window.__VOXEL_INTERACTION.stats().world.meshed > 10', { timeout: 30000 });
    await sleep(1500);

    const m = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), right: Math.round(r.right),
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
        };
      };
      const canvas = document.querySelector('#game').getBoundingClientRect();
      const hotbar = document.querySelector('.ix-hotbar');
      const slots = Array.from(document.querySelectorAll('.ix-hotbar .ix-slot')).map((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.width);
      });
      const status = document.querySelector('.ix-status');
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        canvas: { w: Math.round(canvas.width), h: Math.round(canvas.height), left: Math.round(canvas.left), top: Math.round(canvas.top) },
        hotbar: rect('.ix-hotbar'),
        slotWidths: slots,
        status: rect('.ix-status'),
        statusText: status ? status.textContent : '',
        statusClipped: status ? status.scrollWidth > status.clientWidth + 1 : false,
        reset: rect('.ix-reset'),
        crosshair: rect('.ix-crosshair'),
        centreEl: document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2))?.tagName ?? 'none',
        hotbarCentreEl: (() => {
          if (!hotbar) return 'none';
          const r = hotbar.getBoundingClientRect();
          return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))?.tagName ?? 'none';
        })(),
        countFont: getComputedStyle(document.querySelector('.ix-count')).fontSize,
        statusWhiteSpace: status ? getComputedStyle(status).whiteSpace : '',
        hudOverflow: document.querySelector('.ix-root').scrollWidth > window.innerWidth + 1,
      };
    });

    const insideViewport = (r) => r && r.left >= 0 && r.right <= m.vw && r.top >= 0 && r.bottom <= m.vh;
    check(`${size.name}: canvas fills the viewport`, m.canvas.w === size.width && m.canvas.h === size.height && m.canvas.left === 0 && m.canvas.top === 0, JSON.stringify(m.canvas));
    check(`${size.name}: page has no horizontal scroll`, m.docScrollW <= m.docClientW + 1, `${m.docScrollW} vs ${m.docClientW}`);
    check(`${size.name}: hotbar stays inside the viewport`, insideViewport(m.hotbar) && m.hotbar.scrollW <= m.hotbar.clientW + 1, JSON.stringify(m.hotbar));
    check(`${size.name}: hotbar keeps 9 slots, all the same width`, m.slotWidths.length === 9 && new Set(m.slotWidths).size === 1, JSON.stringify(m.slotWidths));
    check(`${size.name}: status line is inside the viewport and not clipped`, insideViewport(m.status) && !m.statusClipped, JSON.stringify({ rect: m.status, clipped: m.statusClipped, whiteSpace: m.statusWhiteSpace }));
    check(`${size.name}: reset button is inside the viewport`, insideViewport(m.reset), JSON.stringify(m.reset));
    check(`${size.name}: crosshair sits on the centre pixel`, Math.abs(m.crosshair.left + m.crosshair.w / 2 - m.vw / 2) <= 1 && Math.abs(m.crosshair.top + m.crosshair.h / 2 - m.vh / 2) <= 1, JSON.stringify(m.crosshair));
    check(`${size.name}: HUD does not steal clicks`, m.centreEl === 'CANVAS' && m.hotbarCentreEl === 'CANVAS', `${m.centreEl} / ${m.hotbarCentreEl}`);
    check(`${size.name}: count text is readable (>= 12 px)`, parseFloat(m.countFont) >= 12, m.countFont);

    // the reset button must stay clickable at every size (two-step confirm)
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.ix-reset');
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      hit?.click();
      return { hit: hit?.tagName ?? 'none', armed: btn.classList.contains('ix-reset-armed'), label: btn.textContent };
    });
    check(`${size.name}: reset button is hit-testable and arms`, clicked.hit === 'BUTTON' && clicked.armed, JSON.stringify(clicked));

    // F3 overlay at this size
    await page.keyboard.press('F3');
    await sleep(350);
    const debug = await page.evaluate(() => {
      const el = document.querySelector('.ix-debug');
      const r = el.getBoundingClientRect();
      return {
        display: getComputedStyle(el).display,
        rect: { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) },
        clipped: el.scrollWidth > el.clientWidth + 1,
        lines: el.textContent.split('\n').length,
      };
    });
    check(`${size.name}: debug overlay fits without clipping`, debug.display === 'block' && debug.rect.right <= m.vw && !debug.clipped, JSON.stringify(debug));
    await page.keyboard.press('F3');

    const shot = path.join(OUT_DIR, `shot-interaction-${size.name}-${size.width}x${size.height}.png`);
    await page.screenshot({ path: shot });
    check(`${size.name}: no page or console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    console.log(`  ..  screenshot ${shot}`);
    console.log(`  ..  hotbar ${JSON.stringify(m.hotbar)} status ${JSON.stringify(m.status)}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
for (const f of FAIL) console.log('  - ' + f);
process.exit(FAIL.length === 0 ? 0 : 1);
