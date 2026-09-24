/**
 * Browser acceptance test for the playable game (index.html).
 *
 * This is the acceptance checklist, driven on a real Chrome over CDP:
 *   - the first page loads in under 5 s (loading screen -> game)
 *   - keyboard + mouse actually play it
 *   - dig and place work through real mouse buttons
 *   - save / load survives a page reload
 *   - no console or page errors
 *   - the frame rate target (>= 30 fps) holds, and the adaptive quality ladder
 *     moves the render distance the way it is supposed to
 *
 *   npm run build
 *   npm run preview            # serves dist/ on http://localhost:4173
 *   node tests/game.browser.test.mjs
 *
 * Point it at the deployed site to re-run the same checklist there:
 *   PAGE_URL=https://<user>.github.io/<repo>/ node tests/game.browser.test.mjs
 *
 * Two things about the harness that cost real debugging time, kept here so the
 * next person does not repeat them:
 *   - while pointer lock is active the browser sends every mouse event to the
 *     locked canvas, so a HUD button (Reset world) can only be clicked after
 *     the lock is released (Escape) — the test does exactly that
 *   - the player has gravity, so a test must never dig the block it is standing
 *     on: it falls into the hole and can no longer place the block back
 *     (correctly refused with "block would hit you")
 *
 * Env: CHROME_PATH (default: Windows Chrome), PAGE_URL, OUT_DIR, DIG_HOLD_MS
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/';
/** Same origin, one directory up: engine.html is the engine demo page. */
const BASE = PAGE_URL.replace(/[^/]*$/, '');
const ENGINE_URL = BASE + 'engine.html';
const OUT_DIR = process.env.OUT_DIR || 'test-output';
const DIG_HOLD_MS = Number(process.env.DIG_HOLD_MS || 3000);

const PASS = [];
const FAIL = [];
const INFO = [];
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

function section(title) {
  console.log('\n' + title);
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

  const readBlock = (bx, by, bz) =>
    page.evaluate((a, b, c) => window.__GAME.getBlock(a, b, c), bx, by, bz);
  /**
   * Aim at a voxel and read the crosshair back. The mouse is parked first and
   * NOT moved afterwards: while pointer lock is active every move is a look
   * delta, so moving after the aim would throw the aim away.
   */
  const look = async (bx, by, bz) => {
    await page.mouse.move(640, 360);
    await page.evaluate((a, b, c) => window.__GAME.aimAtBlock(a, b, c), bx, by, bz);
    await sleep(200);
    return target();
  };
  const playerState = () =>
    page.evaluate(() => {
      const s = window.__GAME.player.state;
      return {
        x: s.x,
        y: s.y,
        z: s.z,
        vx: s.vx,
        vy: s.vy,
        vz: s.vz,
        onGround: s.onGround,
        sprinting: s.sprinting,
        yaw: s.yaw,
        pitch: s.pitch,
      };
    });
  const bootInfo = () => page.evaluate(() => window.__GAME.bootInfo());
  const locked = () => page.evaluate(() => document.pointerLockElement === document.getElementById('game'));
  const target = () =>
    page.evaluate(() => {
      const t = window.__GAME.target();
      return t ? { position: t.position, normal: t.normal, blockId: t.blockId } : null;
    });
  const slotDOM = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.ix-hotbar .ix-slot')).map((el) => ({
        active: el.classList.contains('ix-slot-active'),
        count: el.querySelector('.ix-count').textContent,
      })),
    );
  const settle = () =>
    page.waitForFunction(() => window.__GAME.fps >= 30, { timeout: 15000 }).catch(() => {});
  /** Real button press. The hold is far shorter than the place repeat, so one
   *  press means exactly one place attempt. */
  const press = async (button, holdMs = 60) => {
    await settle();
    await page.mouse.down({ button });
    await sleep(holdMs);
    await page.mouse.up({ button });
  };
  /** Hold the left button until the voxel is gone, so a slow frame cannot
   *  leave the block standing. */
  const digUntilAir = async (bx, by, bz) => {
    await settle();
    await page.mouse.down({ button: 'left' });
    try {
      await page.waitForFunction(
        (a, b, c) => window.__GAME.getBlock(a, b, c) === 0,
        { timeout: DIG_HOLD_MS + 8000 },
        bx, by, bz,
      );
    } catch {
      /* the follow-up check reports the miss */
    }
    await page.mouse.up({ button: 'left' });
    await sleep(150);
  };

  // ------------------------------------------------------------- loading ----
  section('loading screen -> game');
  // Land on the engine demo page first and clear the save from there: leaving
  // the game page would write a save on pagehide and the next boot would
  // restore it.
  await page.goto(ENGINE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.clear());

  const t0 = Date.now();
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.__GAME', { timeout: 30000 });
  check('the game page boots and exposes its debug surface', true);
  await page.waitForFunction('window.__GAME.bootInfo().ready === true', { timeout: 30000 });
  const readyMs = Date.now() - t0;
  const boot = await bootInfo();
  INFO.push(`first load: ${readyMs} ms wall clock, ${boot.loadMs} ms from module start to playable`);
  check('the loading screen is gone once the game is playable', await page.evaluate(() => document.getElementById('boot').style.display === 'none'));
  check('the world is meshed around the player before play starts', (await page.evaluate(() => window.__GAME.world.stats().meshed)) > 20);
  check('the click-to-play overlay is offered', await page.evaluate(() => document.getElementById('play').classList.contains('shown')));
  check('first page is playable in under 5 s', readyMs < 5000, `${readyMs} ms`);
  check('the in-page load timer agrees', boot.loadMs < 5000, `${boot.loadMs} ms`);
  INFO.push(`quality at boot: ${boot.quality} (render distance ${boot.renderDistance}, pixel ratio ${boot.pixelRatio})`);
  check('boots on the best quality level', boot.quality === 'high' && boot.renderDistance === 6, `${boot.quality}/${boot.renderDistance}`);
  check('a clean start has nothing restored', boot.restored === false);

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-game-loading.png') });

  // ------------------------------------------------------------ click/UI ----
  section('click to play, HUD and keyboard');
  const hud = await page.evaluate(() => {
    const root = document.querySelector('.ix-root');
    return {
      root: !!root,
      crosshair: !!document.querySelector('.ix-crosshair'),
      slots: document.querySelectorAll('.ix-hotbar .ix-slot').length,
      reset: !!document.querySelector('.ix-reset'),
      pointerEvents: root ? getComputedStyle(root).pointerEvents : null,
      status: document.querySelector('.ix-status')?.textContent ?? '',
    };
  });
  check('the HUD is mounted', hud.root && hud.crosshair && hud.reset);
  check('the hotbar has 9 slots', hud.slots === 9, String(hud.slots));
  check('the HUD does not block the canvas', hud.pointerEvents === 'none');
  check('the control hints are on screen', hud.status.includes('WASD') && hud.status.includes('ขุด'), hud.status.slice(0, 60));

  await page.click('#play');
  await sleep(300);
  const afterPlayClick = await page.evaluate(() => {
    const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      dismissed: document.getElementById('play').classList.contains('dismissed'),
      shown: document.getElementById('play').classList.contains('shown'),
      centre: centre.tagName,
      pointerLock: document.pointerLockElement === document.getElementById('game'),
      lockSupported: 'requestPointerLock' in document.getElementById('game'),
    };
  });
  check('clicking the overlay dismisses it and hands over the canvas', afterPlayClick.dismissed && !afterPlayClick.shown && afterPlayClick.centre === 'CANVAS');
  INFO.push(`pointer lock after the click: ${afterPlayClick.pointerLock} (api present: ${afterPlayClick.lockSupported})`);

  await page.evaluate(() => window.__GAME.goToSurface(0, 0));
  await page.evaluate(() => window.__GAME.setLook(0.6, 0));
  await sleep(400);
  const beforeWalk = await playerState();
  await page.keyboard.down('KeyW');
  await sleep(120);
  check('a real KeyW keydown reaches the player input', await page.evaluate(() => window.__GAME.player.input.isDown('forward')));
  await sleep(900);
  const walking = await playerState();
  await page.keyboard.up('KeyW');
  const walked = Math.hypot(walking.x - beforeWalk.x, walking.z - beforeWalk.z);
  check('holding W walks the player forward', walked > 2, `${walked.toFixed(2)} blocks in ~1 s`);
  check('the camera is still on the player after walking', await page.evaluate(() => {
    const g = window.__GAME;
    return Math.abs(g.camera.position.x - g.player.position.x) < 1e-9 && Math.abs(g.camera.position.z - g.player.position.z) < 1e-9;
  }));
  const streamedChunks = await page.evaluate(() => window.__GAME.world.stats().chunks);
  check('chunks streamed in around the new position', streamedChunks > 40, String(streamedChunks));

  await sleep(200);
  const beforeSprint = await playerState();
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await sleep(900);
  const sprinting = await playerState();
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  const sprintDist = Math.hypot(sprinting.x - beforeSprint.x, sprinting.z - beforeSprint.z);
  check('Shift + W sprints (further than walking)', sprinting.sprinting === true && sprintDist > walked, `${sprintDist.toFixed(2)} vs ${walked.toFixed(2)} blocks`);
  await sleep(400);

  const grounded = await playerState();
  await page.keyboard.down('Space');
  await sleep(200);
  const jumping = await playerState();
  await page.keyboard.up('Space');
  check('Space jumps', jumping.y > grounded.y + 0.05 || jumping.vy > 0.1, `y ${grounded.y.toFixed(2)} -> ${jumping.y.toFixed(2)}, vy ${jumping.vy.toFixed(2)}`);
  await sleep(1400);
  const landed = await playerState();
  check('gravity brings the player back down to the ground', landed.onGround === true, `y ${landed.y.toFixed(2)}`);

  // --------------------------------------------------------------- mouse ----
  section('mouse look');
  const wasLocked = await locked();
  // look at the sky first: a drag (the fallback when pointer lock is not
  // available) must not dig a tunnel while the look is being tested
  await page.evaluate(() => window.__GAME.setLook(0, 1.0));
  await sleep(120);
  await page.mouse.move(640, 360);
  if (wasLocked) {
    // pointer lock: plain moves are look deltas
    for (let i = 0; i < 6; i++) await page.mouse.move(640 + (i + 1) * 25, 360, { steps: 4 });
  } else {
    await page.mouse.down();
    await page.mouse.move(940, 360, { steps: 12 });
    await page.mouse.up();
  }
  await sleep(200);
  const turned = await playerState();
  check('moving the mouse turns the view', Math.abs(turned.yaw) > 0.05, `yaw ${turned.yaw.toFixed(3)}${wasLocked ? ' (pointer lock)' : ' (drag fallback)'}`);

  if (wasLocked) {
    for (let i = 0; i < 8; i++) await page.mouse.move(640, 360 - (i + 1) * 60, { steps: 4 });
  } else {
    await page.mouse.down();
    await page.mouse.move(640, -3000, { steps: 20 });
    await page.mouse.up();
  }
  await sleep(200);
  const lookedUp = await playerState();
  check('pitch is clamped to +/- 90 degrees', lookedUp.pitch > 1.2 && lookedUp.pitch <= Math.PI / 2 + 1e-6, `${((lookedUp.pitch * 180) / Math.PI).toFixed(1)} deg`);

  // ---------------------------------------------------------- dig / place ---
  section('dig and place with the real mouse buttons');
  const spot = await page.evaluate(() => {
    const G = window.__GAME;
    const B = G.Block;
    const air = (x, y, z) => G.getBlock(x, y, z) === B.AIR;
    for (let x = 0; x < 32; x++) {
      for (let z = 0; z < 32; z++) {
        const h = G.surfaceAt(x, z);
        if (h < 24 || G.getBlock(x, h, z) !== B.GRASS) continue;
        let clear = true;
        for (let y = h + 1; y <= h + 6; y++) if (!air(x, y, z)) clear = false;
        if (!clear) continue;
        let flat = true;
        for (let dx = 1; dx <= 2; dx++) {
          if (G.surfaceAt(x + dx, z) !== h || G.getBlock(x + dx, h, z) !== B.GRASS) flat = false;
          for (let y = h + 1; y <= h + 6; y++) if (!air(x + dx, y, z)) flat = false;
        }
        if (flat) return { x, z, h };
      }
    }
    return null;
  });
  check('found a flat grass spot to work on', !!spot, JSON.stringify(spot));
  const { x, z, h } = spot;
  INFO.push(`dig/place test column: x=${x} z=${z} surface y=${h}`);

  // Stand ON the surface: the player has gravity, and digging the block under
  // your own feet would drop you into the hole and refuse the place back.
  await page.evaluate((a, b, c) => window.__GAME.teleport(a, b, c), x + 0.5, h + 1, z + 0.5);
  const sideTarget = await look(x + 2, h, z);
  check('the crosshair targets the neighbour grass block', sideTarget?.blockId === 1 && sideTarget.position.join(',') === `${x + 2},${h},${z}`, JSON.stringify(sideTarget));

  await page.keyboard.press('Digit6');
  await sleep(100);
  let slots = await slotDOM();
  check('key 6 selects hotbar slot 6', slots[5].active && slots.filter((s) => s.active).length === 1);
  check('the target slot starts empty', slots[5].count === '', slots[5].count);

  await digUntilAir(x + 2, h, z);
  check('holding the left button dug the block', (await readBlock(x + 2, h, z)) === 0, String(await readBlock(x + 2, h, z)));
  slots = await slotDOM();
  check('the dug block landed in the hotbar', slots[5].count === '1', slots[5].count);
  check('the dig is recorded in the save diff', await page.evaluate((a, b, c) => window.__GAME.edits.has(a, b, c), x + 2, h, z));

  await page.keyboard.press('Digit1');
  const holeTarget = await look(x + 2, h, z);
  check('the hole dropped the aim one block down', holeTarget?.position.join(',') === `${x + 2},${h - 1},${z}` && holeTarget.normal.join(',') === '0,1,0', JSON.stringify(holeTarget));
  const beforePlace = await slotDOM();
  await press('right');
  await sleep(200);
  check('right click placed a block back in the hole', (await readBlock(x + 2, h, z)) === 1, String(await readBlock(x + 2, h, z)));
  slots = await slotDOM();
  check('one press consumed exactly one item', Number(beforePlace[0].count) - Number(slots[0].count) === 1, `${beforePlace[0].count} -> ${slots[0].count}`);
  check('dig + place round trip left no diff behind', (await page.evaluate((a, b, c) => window.__GAME.edits.has(a, b, c), x + 2, h, z)) === false);

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-game-playing.png') });

  // ------------------------------------------------------------ save/load ---
  section('save and load');
  await look(x + 1, h, z);
  await digUntilAir(x + 1, h, z);
  check('dug a hole to leave behind', (await readBlock(x + 1, h, z)) === 0, String(await readBlock(x + 1, h, z)));

  await look(x + 2, h, z);
  await press('right');
  await sleep(200);
  check('placed a block to leave behind', (await readBlock(x + 2, h + 1, z)) === 1, String(await readBlock(x + 2, h + 1, z)));

  const before = await page.evaluate(() => {
    const G = window.__GAME;
    return { edits: G.editsCount, state: G.adapter.saveState(), key: G.storageKey };
  });
  check('the diff holds the two changes', before.edits === 2, String(before.edits));
  check('the save key is per seed', /^minecraft-web:world:\d+$/.test(before.key), before.key);

  const saved = await page.evaluate(() => {
    const G = window.__GAME;
    const ok = G.save();
    return { ok, raw: localStorage.getItem(G.storageKey) };
  });
  check('the save button writes localStorage', saved.ok && !!saved.raw);
  const payload = JSON.parse(saved.raw);
  check(
    'the save file holds version, seed, player and edits',
    payload.version === 1 && typeof payload.seed === 'number' && !!payload.player && payload.edits.length === 2,
    JSON.stringify({ version: payload.version, edits: payload.edits.length }),
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!window.__GAME', { timeout: 30000 });
  await page.waitForFunction('window.__GAME.bootInfo().ready === true', { timeout: 30000 });
  const reloaded = await bootInfo();
  check('the save is detected after a reload', reloaded.restored === true, String(reloaded.restored));
  check('the loading screen clears on a restored world too', await page.evaluate(() => document.getElementById('boot').style.display === 'none'));
  check('the click-to-play overlay is offered again', await page.evaluate(() => document.getElementById('play').classList.contains('shown')));
  await page.click('#play');
  await sleep(300);

  let holeBack = true;
  try {
    await page.waitForFunction((a, b, c) => window.__GAME.getBlock(a, b, c) === 0, { timeout: 30000 }, x + 1, h, z);
  } catch {
    holeBack = false;
  }
  check('the dug hole is still there after the reload', holeBack && (await readBlock(x + 1, h, z)) === 0);
  check('the placed block is still there after the reload', (await readBlock(x + 2, h + 1, z)) === 1, String(await readBlock(x + 2, h + 1, z)));
  check('untouched terrain did not change', (await readBlock(x + 2, h, z)) === 1, String(await readBlock(x + 2, h, z)));
  const afterReload = await page.evaluate(() => ({
    state: window.__GAME.adapter.saveState(),
    edits: window.__GAME.editsCount,
  }));
  check(
    'the player is back where they left off',
    Math.abs(afterReload.state.x - before.state.x) < 1e-6 &&
      Math.abs(afterReload.state.y - before.state.y) < 1e-6 &&
      Math.abs(afterReload.state.z - before.state.z) < 1e-6,
    JSON.stringify(afterReload.state),
  );
  check('the restored diff holds the same two edits', afterReload.edits === 2, String(afterReload.edits));

  // --------------------------------------------------------------- perf -----
  section('frame rate and adaptive quality');
  await sleep(2500);
  const perf = await page.evaluate(() => {
    const G = window.__GAME;
    const s = G.stats();
    return {
      fps: Number(s.fps.toFixed(1)),
      frameMs: Number(s.frameMs.toFixed(2)),
      drawCalls: s.drawCalls,
      triangles: s.triangles,
      chunks: s.world.chunks,
      meshed: s.world.meshed,
      pending: s.world.pending,
      quality: G.quality,
      renderDistance: G.renderDistance,
      pixelRatio: Number(G.renderer.getPixelRatio().toFixed(2)),
      changes: G.qualityChanges,
    };
  });
  INFO.push(
    `fps ${perf.fps} (${perf.frameMs} ms/frame), ${perf.chunks} chunks (${perf.meshed} meshed), ` +
      `${perf.drawCalls} draw calls, ${perf.triangles} triangles, quality ${perf.quality} (RD ${perf.renderDistance}, dpr ${perf.pixelRatio})`,
  );
  check('holds the 30 fps target on this machine', perf.fps >= 30, `${perf.fps} fps`);
  check('the render loop is drawing the world', perf.drawCalls > 0 && perf.triangles > 1000, `${perf.drawCalls} calls / ${perf.triangles} tris`);
  check('chunk streaming is caught up', perf.pending === 0, String(perf.pending));
  check('a fast machine stays on the best quality level', perf.quality === 'high' && perf.changes.length === 0, `${perf.quality} / ${JSON.stringify(perf.changes)}`);

  const forced = await page.evaluate(async () => {
    const G = window.__GAME;
    G.forceQuality(1);
    const mid = { quality: G.quality, renderDistance: G.renderDistance, pixelRatio: G.renderer.getPixelRatio() };
    await new Promise((r) => setTimeout(r, 1200));
    const fps = G.fps;
    const pending = G.world.stats().pending;
    G.forceQuality(0);
    await new Promise((r) => setTimeout(r, 600));
    return { mid, fps, pending, back: { quality: G.quality, renderDistance: G.renderDistance } };
  });
  check('a lower quality level drops the render distance', forced.mid.renderDistance === 5 && forced.mid.quality === 'medium', JSON.stringify(forced.mid));
  check('and lowers the pixel ratio', forced.mid.pixelRatio <= 1.25, String(forced.mid.pixelRatio));
  check('the world keeps rendering at the lower level', forced.fps >= 30, `${forced.fps.toFixed(1)} fps`);
  check('and the level can be restored', forced.back.quality === 'high' && forced.back.renderDistance === 6, JSON.stringify(forced.back));
  const loggedMoves = await page.evaluate(() => window.__GAME.qualityChanges.length);
  check('forced moves are logged for the debug overlay', loggedMoves === 2, String(loggedMoves));

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-game-perf.png') });

  // -------------------------------------------------------------- reset -----
  section('Escape releases the mouse, reset world');
  // While pointer lock is active every mouse event goes to the canvas, so a HUD
  // button is only clickable after Escape. A synthetic Escape key press is not
  // honored by headless Chrome (the browser, not the page, owns that shortcut),
  // so the test calls the same API the player's Escape ends up in.
  await page.evaluate(() => document.exitPointerLock?.());
  await sleep(400);
  const afterEscape = await page.evaluate(() => ({
    locked: document.pointerLockElement === document.getElementById('game'),
    hint: getComputedStyle(document.getElementById('hint')).display,
    resetAt: (() => {
      const b = document.querySelector('.ix-reset').getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return el.tagName + (el.className ? '.' + el.className : '');
    })(),
  }));
  check('Escape releases pointer lock', afterEscape.locked === false);
  check('the click hint comes back when the lock is lost', afterEscape.hint !== 'none', afterEscape.hint);
  check('the reset button is reachable once the mouse is free', afterEscape.resetAt.startsWith('BUTTON'), afterEscape.resetAt);

  const resetButton = await page.$('.ix-reset');
  await resetButton.click();
  await sleep(200);
  check('reset asks for confirmation first', await page.evaluate(() => window.__GAME.hud.resetIsArmed && document.querySelector('.ix-reset').classList.contains('ix-reset-armed')));
  await resetButton.click();
  await sleep(500);
  check('reset restores the generated terrain', (await readBlock(x + 1, h, z)) === 1, String(await readBlock(x + 1, h, z)));
  check('reset removes the player placed block', (await readBlock(x + 2, h + 1, z)) === 0, String(await readBlock(x + 2, h + 1, z)));
  const afterReset = await page.evaluate(() => ({ edits: window.__GAME.editsCount, raw: localStorage.getItem(window.__GAME.storageKey) }));
  check('reset empties the diff and the save file', afterReset.edits === 0 && afterReset.raw === null, JSON.stringify(afterReset));

  // -------------------------------------------------------------- errors ----
  section('console');
  check('no page or console errors during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log('');
for (const line of INFO) console.log('  ..   ' + line);
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length > 0) {
  console.log('failures:');
  for (const f of FAIL) console.log('  - ' + f);
  process.exit(1);
}
console.log('artifacts: ' + fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('shot-game')).join(', '));
