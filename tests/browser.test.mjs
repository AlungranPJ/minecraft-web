/**
 * Browser acceptance test for the voxel engine demo page (engine.html).
 *
 * Drives a real Chrome over CDP and checks the things a headless node test
 * cannot: the world actually renders, the frame rate, and that chunk memory
 * stays flat while the camera travels.
 *
 *   npm run build
 *   npm run preview            # serves dist/ on http://localhost:4173
 *   node tests/browser.test.mjs
 *
 * The playable game (index.html) has its own acceptance test:
 * tests/game.browser.test.mjs.
 *
 * Env: CHROME_PATH (default: Windows Chrome), PAGE_URL, OUT_DIR, HOLD_MS
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/engine.html';
const OUT_DIR = process.env.OUT_DIR || 'test-output';
const STEP_HOLD_MS = Number(process.env.HOLD_MS || 900);

const PASS = [];
const FAIL = [];
function check(name, ok, detail = '') {
  const line = name + (detail ? ` -- ${detail}` : '');
  if (ok) {
    PASS.push(line);
    console.log('  ok   ' + line);
  } else {
    FAIL.push(line);
    console.log('  FAIL ' + line);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--window-size=1280,720',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push('console: ' + msg.text());
  });

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__VOXEL', { timeout: 30000 });
  check('page loads and the engine boots', true);

  await page.waitForFunction('window.__VOXEL.stats().world.meshed > 10', { timeout: 30000 });
  await sleep(1500);

  // ------------------------------------------------------------- rendering --
  const info = await page.evaluate(() => {
    const gl = window.__VOXEL.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
  });
  console.log(`  ..   webgl: ${info.renderer} [${info.version}]`);

  const first = await page.evaluate(() => window.__VOXEL.stats());
  check('chunks are meshed', first.world.meshed >= 10, String(first.world.meshed));
  check('geometry is uploaded', first.world.vertices > 1000, String(first.world.vertices));
  check('draw calls happen', first.drawCalls > 0, String(first.drawCalls));
  check('triangles are drawn', first.triangles > 1000, String(first.triangles));

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-start.png') });

  // ------------------------------------------------------------------ fps ---
  await sleep(3000);
  const fpsSample = await page.evaluate(() => window.__VOXEL.stats());
  check('fps >= 40', fpsSample.fps >= 40, fpsSample.fps.toFixed(1));
  console.log(`  ..   fps ${fpsSample.fps.toFixed(1)}  frame ${fpsSample.frameMs.toFixed(2)} ms`);

  // ------------------------------------------------------- walk / leaking --
  // chunks kept in memory: the render distance disc (same rule as World) + 1 ring
  const R = 6;
  const MARGIN = 1;
  let disc = 0;
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz <= R * R + R) disc++;
    }
  }
  const chunkCeiling = disc + (2 * (R + MARGIN) + 1) * 2;

  const samples = [];
  let maxChunks = 0;
  let maxGeometries = 0;
  for (let step = 1; step <= 6; step++) {
    await page.evaluate((s) => window.__VOXEL.teleport(s * 160, 45, s * 160), step);
    await sleep(STEP_HOLD_MS);
    const s = await page.evaluate(() => window.__VOXEL.stats());
    samples.push({
      step,
      chunks: s.world.chunks,
      meshed: s.world.meshed,
      unloads: s.world.unloads,
      geometries: s.geometries,
      drawCalls: s.drawCalls,
      fps: Number(s.fps.toFixed(1)),
    });
    maxChunks = Math.max(maxChunks, s.world.chunks);
    maxGeometries = Math.max(maxGeometries, s.geometries);
  }
  console.table(samples);
  const last = await page.evaluate(() => window.__VOXEL.stats());
  const minChunks = Math.min(...samples.map((s) => s.chunks));
  check(
    'chunk count stays bounded on a long walk',
    maxChunks <= chunkCeiling,
    `${maxChunks} (disc ${disc}, ceiling ${chunkCeiling})`,
  );
  check('chunk count does not grow step over step', maxChunks - minChunks <= 4, `${minChunks}..${maxChunks}`);
  check('gpu geometry count stays bounded on a long walk', maxGeometries <= chunkCeiling, String(maxGeometries));
  check('chunks were unloaded behind the camera', last.world.unloads > 0, String(last.world.unloads));
  check('no chunk leak after the walk', last.world.chunks <= chunkCeiling, String(last.world.chunks));
  await page.screenshot({ path: path.join(OUT_DIR, 'shot-after-walk.png') });

  // ------------------------------------------------- public API in browser --
  const ids = await page.evaluate(() => ({
    wood: window.__VOXEL.Block.WOOD,
    air: window.__VOXEL.Block.AIR,
    stone: window.__VOXEL.Block.STONE,
  }));

  const api = await page.evaluate(async () => {
    const v = window.__VOXEL;
    const w = v.world;
    const THREE = v.THREE;
    const out = {};
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // getBlock / setBlock round trip through the real API
    const cam = v.camera.position;
    const x = Math.floor(cam.x);
    const z = Math.floor(cam.z);
    const y = w.heightAt(x, z);
    out.surfaceBlock = w.getBlock(x, y, z);
    w.setBlock(x, y + 1, z, v.Block.WOOD);
    out.afterSet = w.getBlock(x, y + 1, z);
    w.setBlock(x, y + 1, z, v.Block.AIR);
    out.afterClear = w.getBlock(x, y + 1, z);

    // the mesh must be rebuilt after a block change (the queue drains first)
    for (let i = 0; i < 600 && w.stats().pending > 0; i++) await nextFrame();
    const rebuildsBefore = w.stats().rebuilds;
    w.setBlock(x + 1, y + 3, z, v.Block.STONE);
    w.setBlock(x + 1, y + 3, z, v.Block.AIR);
    let waitedFrames = 0;
    while (w.stats().rebuilds === rebuildsBefore && waitedFrames < 300) {
      await nextFrame();
      waitedFrames++;
    }
    out.rebuilds = w.stats().rebuilds - rebuildsBefore;
    out.rebuildWaitFrames = waitedFrames;

    // raycast straight down onto the surface
    const hit = w.raycast(new THREE.Vector3(x + 0.5, y + 5.5, z + 0.5), new THREE.Vector3(0, -1, 0), 10);
    out.hit = hit ? { position: hit.position, normal: hit.normal, blockId: hit.blockId } : null;
    out.expectedY = y;
    out.hitInRange = !!hit && hit.position[1] <= y && hit.position[1] >= y - 1;
    return out;
  });
  check('getBlock reads a real surface block', api.surfaceBlock > 0, String(api.surfaceBlock));
  check('setBlock writes and clears', api.afterSet === ids.wood && api.afterClear === ids.air, `${api.afterSet}/${api.afterClear}`);
  check('block edits queue a remesh', api.rebuilds > 0, `${api.rebuilds} after ${api.rebuildWaitFrames} frames`);
  check('raycast hits the ground under the camera', api.hitInRange, JSON.stringify(api.hit));
  check('raycast normal points up', api.hit && api.hit.normal[1] === 1, JSON.stringify(api.hit?.normal));

  // ------------------------------------------------- visual coverage check --
  // Objective "is there a world in front of the camera" metric: cast a grid of
  // rays through the actual frustum and count how many hit a block.
  async function coverage(name, view) {
    await page.evaluate(
      (v) => {
        const g = window.__VOXEL.game;
        window.__VOXEL.teleport(v.x, v.y, v.z);
        if (g.controls) {
          g.controls.yaw = v.yaw;
          g.controls.pitch = v.pitch;
        }
      },
      view,
    );
    await sleep(700);
    const result = await page.evaluate(() => {
      const v = window.__VOXEL;
      const cam = v.camera;
      const w = v.world;
      const THREE = v.THREE;
      cam.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      raycaster.far = 400;
      const target = new THREE.Vector3();
      const dir = new THREE.Vector3();
      let hits = 0;
      let dataHits = 0;
      let total = 0;
      let water = 0;
      const distances = [];
      for (let ny = -0.95; ny <= 0.95; ny += 0.19) {
        for (let nx = -0.95; nx <= 0.95; nx += 0.19) {
          target.set(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();
          total++;
          // what the chunk meshes actually render
          raycaster.set(cam.position, dir.copy(target));
          const meshHits = raycaster.intersectObjects(w.group.children, false);
          if (meshHits.length > 0) {
            hits++;
            distances.push(meshHits[0].distance);
          }
          // what the block data says (independent of meshing)
          const hit = w.raycast(cam.position, dir.copy(target), 400);
          if (hit) {
            dataHits++;
            if (hit.blockId === v.Block.WATER) water++;
          }
        }
      }
      distances.sort((a, b) => a - b);
      return {
        total,
        hits,
        dataHits,
        ratio: hits / total,
        dataRatio: dataHits / total,
        water,
        medianDist: distances.length ? distances[Math.floor(distances.length / 2)] : null,
        fps: v.stats().fps,
        meshed: w.stats().meshed,
        pending: w.stats().pending,
      };
    });
    await page.screenshot({ path: path.join(OUT_DIR, `view-${name}.png`) });
    console.log(
      `  ..   ${name}: rendered ${(result.ratio * 100).toFixed(1)}% / data ${(result.dataRatio * 100).toFixed(1)}% ` +
        `(median ${result.medianDist?.toFixed(1)} m, water rays ${result.water}, chunks ${result.meshed}, fps ${result.fps.toFixed(1)})`,
    );
    return result;
  }

  const spaceView = await coverage('sky', { x: 0, y: 60, z: 0, yaw: 0, pitch: -1.2 });
  check('looking down from above, the rendered ground is solid', spaceView.ratio >= 0.95, spaceView.ratio.toFixed(3));
  check('rendered geometry matches the block data', Math.abs(spaceView.ratio - spaceView.dataRatio) < 0.12, `${spaceView.ratio.toFixed(3)} vs ${spaceView.dataRatio.toFixed(3)}`);

  const groundView = await coverage('ground', { x: 0, y: 34, z: 0, yaw: -0.7, pitch: -0.35 });
  check('from just above the surface, terrain fills the lower frame', groundView.ratio >= 0.35, groundView.ratio.toFixed(3));

  const horizon = await coverage('horizon', { x: 0, y: 34, z: 0, yaw: 2.4, pitch: 0 });
  check('horizon view still shows terrain or water', horizon.ratio >= 0.2, horizon.ratio.toFixed(3));

  // ------------------------------- pixel check: no holes in the ground ------
  // Paint the background magenta and drop the fog, then look straight down:
  // every background-coloured pixel below the horizon is a missing mesh face.
  await page.evaluate(() => {
    const V = window.__VOXEL;
    V.teleport(0, 44, 0);
    if (V.game.controls) {
      V.game.controls.yaw = 0;
      V.game.controls.pitch = -1.2;
    }
    window.__probeFog = V.scene.fog;
  });
  await page.waitForFunction('window.__VOXEL.world.stats().pending === 0', { timeout: 60000 });
  await sleep(600);
  await page.evaluate(() => {
    const V = window.__VOXEL;
    V.scene.background = new V.THREE.Color(0xff00ff);
    V.scene.fog = null;
  });
  await sleep(300);
  const holePng = await page.screenshot({ encoding: 'base64' });
  fs.writeFileSync(path.join(OUT_DIR, 'holes-downward.png'), Buffer.from(holePng, 'base64'));
  const holes = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0;
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      total++;
      if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] > 180) magenta++;
    }
    return { magenta, total, ratio: magenta / total };
  }, holePng);
  await page.evaluate(() => {
    const V = window.__VOXEL;
    V.scene.background = new V.THREE.Color(0x8fc7f0);
    V.scene.fog = window.__probeFog || null;
  });
  check(
    'looking straight down, no background pixels show through the ground',
    holes.ratio < 0.02,
    `${(holes.ratio * 100).toFixed(2)}% background`,
  );

  // ------------------------------------------------------------- idle fps ---
  await sleep(2500);
  const idle = await page.evaluate(() => window.__VOXEL.stats());
  check('fps stays >= 40 after the walk', idle.fps >= 40, idle.fps.toFixed(1));
  console.log(`  ..   fps after walk ${idle.fps.toFixed(1)}  pending ${idle.world.pending}`);

  check(
    'no page errors',
    pageErrors.filter((e) => !e.includes('favicon')).length === 0,
    pageErrors.slice(0, 3).join(' | '),
  );

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    for (const f of FAIL) console.log('  - ' + f);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
