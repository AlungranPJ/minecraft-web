/**
 * Responsive + interaction test for the demo page.
 *
 * Renders the built app at desktop, laptop and mobile viewport sizes, checks the
 * canvas/HUD layout, then drives real mouse/keyboard/wheel events and a live
 * resize. Requires a running static server (npm run preview) and Chrome.
 *
 *   npm run test:responsive
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [];
const FAIL = [];
function check(name, ok, detail = '') {
  if (ok) {
    PASS.push(name);
    console.log(`  ok   ${name}${detail ? ' -- ' + detail : ''}`);
  } else {
    FAIL.push(`${name} -- ${detail}`);
    console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

const viewports = [
  { name: 'desktop-1920x1080', width: 1920, height: 1080, deviceScaleFactor: 1 },
  { name: 'laptop-1366x768', width: 1366, height: 768, deviceScaleFactor: 1 },
  { name: 'mobile-390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) pageErrors.push('console: ' + m.text());
});

for (const vp of viewports) {
  console.log(`\n== ${vp.name}`);
  await page.setViewport(vp);
  await page.goto(PAGE_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.__VOXEL && window.__VOXEL.world.stats().meshed > 10', { timeout: 30000 });
  await sleep(1200);

  const layout = await page.evaluate(() => {
    const V = window.__VOXEL;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= window.innerWidth + 1 && r.y + r.h <= window.innerHeight + 1;
    const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const el = (id) => document.getElementById(id);
    const hud = rect(el('hud'));
    const help = rect(el('help'));
    const cross = rect(el('crosshair'));
    const canvas = el('game');
    const size = V.renderer.getSize(new V.THREE.Vector2());
    return {
      viewport: [window.innerWidth, window.innerHeight],
      scroll: [document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight],
      canvasCss: rect(canvas),
      buffer: [canvas.width, canvas.height],
      pixelRatio: V.renderer.getPixelRatio(),
      drawnCss: [size.x, size.y],
      cameraAspect: +V.camera.aspect.toFixed(4),
      hud,
      help,
      cross,
      hudInside: inside(hud),
      helpInside: inside(help),
      hudOverlapsHelp: overlaps(hud, help),
      helpOverlapsCross: overlaps(help, cross),
      hudText: el('hud').textContent,
      helpText: el('help').textContent,
      fps: +V.stats().fps.toFixed(1),
      draws: V.stats().drawCalls,
    };
  });

  const ratio = vp.width / vp.height;
  check('canvas fills the viewport', layout.canvasCss.w === vp.width && layout.canvasCss.h === vp.height, JSON.stringify(layout.canvasCss));
  check('no page scrollbars', layout.scroll[0] === vp.width && layout.scroll[1] === vp.height, JSON.stringify(layout.scroll));
  check('camera aspect matches the viewport', Math.abs(layout.cameraAspect - ratio) < 0.01, `${layout.cameraAspect} vs ${ratio.toFixed(4)}`);
  check(
    'drawing buffer matches css size x capped pixel ratio',
    layout.buffer[0] === Math.round(vp.width * layout.pixelRatio) && layout.buffer[1] === Math.round(vp.height * layout.pixelRatio),
    `${layout.buffer} at ratio ${layout.pixelRatio}`,
  );
  check('hud stays inside the viewport', layout.hudInside, JSON.stringify(layout.hud));
  check('control bar stays inside the viewport', layout.helpInside, JSON.stringify(layout.help));
  check('hud and control bar do not overlap', !layout.hudOverlapsHelp, `${JSON.stringify(layout.hud)} / ${JSON.stringify(layout.help)}`);
  check('control bar does not cover the crosshair', !layout.helpOverlapsCross, JSON.stringify(layout.cross));
  check('hud shows live numbers', /\d/.test(layout.hudText) && layout.hudText.includes('fps'), JSON.stringify(layout.hudText));
  check('fps >= 40', layout.fps >= 40, String(layout.fps));

  // ---- real input events
  const before = await page.evaluate(() => {
    const V = window.__VOXEL;
    return { yaw: V.game.controls.yaw, pitch: V.game.controls.pitch, speed: V.game.controls.speed, pos: V.camera.position.toArray() };
  });
  const cx = Math.round(vp.width / 2);
  const cy = Math.round(vp.height / 2);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.down('KeyW');
  await sleep(500);
  await page.keyboard.up('KeyW');
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(250);
  const after = await page.evaluate(() => {
    const V = window.__VOXEL;
    return { yaw: V.game.controls.yaw, pitch: V.game.controls.pitch, speed: V.game.controls.speed, pos: V.camera.position.toArray(), fps: V.stats().fps };
  });
  const moved = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
  check('dragging rotates the camera', Math.abs(after.yaw - before.yaw) > 0.05 && Math.abs(after.pitch - before.pitch) > 0.01, `dyaw ${(after.yaw - before.yaw).toFixed(3)} dpitch ${(after.pitch - before.pitch).toFixed(3)}`);
  check('W moves the camera', moved > 1, `${moved.toFixed(2)} blocks`);
  check('mouse wheel changes the speed', after.speed !== before.speed, `${before.speed.toFixed(1)} -> ${after.speed.toFixed(1)}`);
  check('fps >= 40 while interacting', after.fps >= 40, after.fps.toFixed(1));

  await page.screenshot({ path: path.join(OUT, `responsive-${vp.name}.png`) });

  // ---- live resize, same tab
  const resized = { width: Math.max(320, Math.round(vp.width * 0.7)), height: Math.max(240, Math.round(vp.height * 0.6)) };
  await page.setViewport({ ...vp, ...resized });
  await sleep(500);
  const afterResize = await page.evaluate(() => {
    const V = window.__VOXEL;
    const canvas = document.getElementById('game');
    const size = V.renderer.getSize(new V.THREE.Vector2());
    return {
      viewport: [window.innerWidth, window.innerHeight],
      buffer: [canvas.width, canvas.height],
      pixelRatio: V.renderer.getPixelRatio(),
      drawnCss: [size.x, size.y],
      cameraAspect: +V.camera.aspect.toFixed(4),
      fps: +V.stats().fps.toFixed(1),
    };
  });
  check(
    'live resize re-sizes the renderer',
    afterResize.viewport[0] === resized.width && afterResize.drawnCss[0] === resized.width && afterResize.drawnCss[1] === resized.height,
    `${JSON.stringify(afterResize.viewport)} drawn ${JSON.stringify(afterResize.drawnCss)}`,
  );
  check(
    'live resize updates the camera aspect',
    Math.abs(afterResize.cameraAspect - resized.width / resized.height) < 0.01,
    `${afterResize.cameraAspect} vs ${(resized.width / resized.height).toFixed(4)}`,
  );
  await page.screenshot({ path: path.join(OUT, `responsive-${vp.name}-resized.png`) });
}

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
await browser.close();
if (FAIL.length) {
  console.log('failures:');
  for (const f of FAIL) console.log('  - ' + f);
  process.exitCode = 1;
}
