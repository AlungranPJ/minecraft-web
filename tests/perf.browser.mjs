/**
 * Frame rate report for the playable game (index.html).
 *
 * Measures fps at each quality level of the adaptive ladder, at the two screen
 * sizes that matter (1280x720 and 1920x1080), and writes the numbers to
 * test-output/perf-report.json so a README claim can be traced back to a run.
 *
 *   npm run build
 *   npm run preview
 *   node tests/perf.browser.mjs
 *
 * Env: CHROME_PATH, PAGE_URL, OUT_DIR, SAMPLE_MS
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/';
const BASE = PAGE_URL.replace(/[^/]*$/, '');
const OUT_DIR = process.env.OUT_DIR || 'test-output';
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const LEVELS = [0, 1, 2, 3];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--window-size=1920,1080',
  ],
});

const report = { url: PAGE_URL, sampledAt: new Date().toISOString(), samples: [] };

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.setViewport(VIEWPORTS[0]);
  await page.goto(BASE + 'engine.html', { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.bootInfo().ready === true', { timeout: 30000 });

  report.gpu = await page.evaluate(() => {
    const gl = window.__GAME.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    };
  });

  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport);
    await sleep(1500);
    for (const level of LEVELS) {
      await page.evaluate((l) => window.__GAME.forceQuality(l), level);
      // let the chunk ring settle at the new render distance (a couple of frames
      // for the world to notice, then wait for the mesh queue to drain)
      await sleep(400);
      await page.waitForFunction('window.__GAME.world.stats().pending === 0', { timeout: 30000 }).catch(() => {});
      await sleep(800);
      const before = await page.evaluate(() => window.__GAME.game.stats().fps);
      await sleep(SAMPLE_MS);
      const sample = await page.evaluate(() => {
        const G = window.__GAME;
        const s = G.game.stats();
        return {
          quality: G.quality,
          renderDistance: G.renderDistance,
          pixelRatio: Number(G.renderer.getPixelRatio().toFixed(2)),
          drawingBuffer: [G.renderer.domElement.width, G.renderer.domElement.height],
          fps: Number(s.fps.toFixed(1)),
          frameMs: Number(s.frameMs.toFixed(2)),
          drawCalls: s.drawCalls,
          triangles: s.triangles,
          chunks: s.world.chunks,
          meshed: s.world.meshed,
          pending: s.world.pending,
        };
      });
      sample.viewport = viewport.name;
      sample.sampleMs = SAMPLE_MS;
      sample.warmupFps = Number(before.toFixed(1));
      report.samples.push(sample);
      console.log(
        `  ${viewport.name.padEnd(10)} ${sample.quality.padEnd(8)} RD ${String(sample.renderDistance).padEnd(2)} ` +
          `dpr ${String(sample.pixelRatio).padEnd(5)} buffer ${sample.drawingBuffer.join('x').padEnd(11)} ` +
          `${String(sample.fps).padStart(6)} fps (${sample.frameMs} ms)  ${sample.drawCalls} draws  ` +
          `${sample.triangles} tris  ${sample.meshed}/${sample.chunks} chunks`,
      );
    }
    await page.evaluate(() => window.__GAME.forceQuality(0));
  }

  // idle vs walking: does streaming cost frames?
  await page.setViewport(VIEWPORTS[0]);
  await sleep(1000);
  await page.evaluate(() => window.__GAME.goToSurface(0, 0));
  await sleep(1500);
  const idle = await page.evaluate(() => window.__GAME.game.stats().fps);
  await page.keyboard.down('KeyW');
  await sleep(1000);
  const walking = await page.evaluate(() => window.__GAME.game.stats().fps);
  await page.keyboard.up('KeyW');
  await sleep(500);
  report.walk = { idle: Number(idle.toFixed(1)), walking: Number(walking.toFixed(1)) };
  console.log(`  idle ${report.walk.idle} fps, while walking ${report.walk.walking} fps (1280x720, high)`);

  // ------------------------------------------------ emulated slower machine ---
  // This laptop pins at 60 fps (vsync) at every level, so the ladder is proven
  // against a CPU-throttled Chrome that is also streaming chunks (walking is
  // what costs: one chunk mesh is ~6 ms here, so a slower CPU feels it first).
  // 12x slower CPU is the "mid range notebook" stand-in used for the numbers in
  // the README: at 12x this machine starts at 26 fps on high and the ladder
  // brings it back to 50 fps on its own.
  const CPU_RATE = Number(process.env.CPU_THROTTLE || 12);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  await page.evaluate(() => {
    window.__GAME.forceQuality(0);
    window.__GAME.adaptive.reset();
    window.__GAME.goToSurface(0, 0);
    window.__GAME.setLook(0, -0.2);
  });
  await sleep(1200);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  const throttledStart = await page.evaluate(() => ({ fps: Number(window.__GAME.fps.toFixed(1)), quality: window.__GAME.quality }));
  console.log(`  cpu throttled ${CPU_RATE}x: starting at ${throttledStart.quality} with ${throttledStart.fps} fps`);
  let throttledSettled = null;
  for (let i = 0; i < 24; i++) {
    await sleep(1000);
    throttledSettled = await page.evaluate(() => ({
      fps: Number(window.__GAME.fps.toFixed(1)),
      quality: window.__GAME.quality,
      renderDistance: window.__GAME.renderDistance,
      level: window.__GAME.adaptive.level,
      changes: window.__GAME.qualityChanges,
    }));
    if (throttledSettled.fps >= 45 && throttledSettled.level > 0) break;
  }
  report.throttled = { cpuRate: CPU_RATE, start: throttledStart, settled: throttledSettled };
  console.log(
    `  cpu throttled ${CPU_RATE}x: settled at ${throttledSettled.quality} (RD ${throttledSettled.renderDistance}) ` +
      `with ${throttledSettled.fps} fps, ladder moves ${JSON.stringify(throttledSettled.changes.map((c) => `${c.from}->${c.to}@${c.fps.toFixed(0)}fps`))}`,
  );

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  let recovered = null;
  for (let i = 0; i < 24; i++) {
    await sleep(1000);
    recovered = await page.evaluate(() => ({ fps: Number(window.__GAME.fps.toFixed(1)), quality: window.__GAME.quality, level: window.__GAME.adaptive.level }));
    if (recovered.level === 0) break;
  }
  report.recovered = recovered;
  console.log(`  cpu back to normal: recovered to ${recovered.quality} with ${recovered.fps} fps`);

  report.errors = errors;
  report.passed30fps = report.samples.every((s) => s.fps >= 30);
  report.throttledHeldTarget = throttledSettled.fps >= 30;
  report.ladderDegraded = throttledSettled.level > 0;
  report.ladderRecovered = recovered.level === 0;
} finally {
  await browser.close();
}

const out = path.join(OUT_DIR, 'perf-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
console.log(`every sample >= 30 fps: ${report.passed30fps}`);
console.log(`throttled run held 30 fps: ${report.throttledHeldTarget}`);
console.log(`ladder degraded under load: ${report.ladderDegraded}, recovered afterwards: ${report.ladderRecovered}`);
if (!report.passed30fps || !report.throttledHeldTarget || !report.ladderDegraded || !report.ladderRecovered) process.exit(1);
