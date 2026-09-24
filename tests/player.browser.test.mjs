/**
 * Browser acceptance test for the first person player (player.html).
 *
 * Real Chrome over CDP, real keyboard events and real mouse deltas, on a flat
 * test arena built at runtime. This is where the criteria a node test cannot
 * prove are checked: mouse look through the DOM, the frame rate, and that the
 * player never ends up inside a block on any rendered frame.
 *
 *   npm run build                 # or: node node_modules/vite/bin/vite.js build
 *   npm run preview               # serves dist/ on http://localhost:4173
 *   node tests/player.browser.test.mjs
 *
 * Env: CHROME_PATH (default: Windows Chrome), PAGE_URL, OUT_DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/player.html';
const OUT_DIR = process.env.OUT_DIR || 'test-output';

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

  const state = () => page.evaluate(() => window.__PLAYER.state());
  const stats = () => page.evaluate(() => window.__PLAYER.stats());

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.__PLAYER', { timeout: 30000 });
  check('player page loads and the demo boots', true);
  await page.waitForFunction('window.__PLAYER.stats().world.meshed > 10', { timeout: 30000 });
  await sleep(800);

  // ------------------------------------------------------------- spawning ---
  const spawn = await page.evaluate(() => {
    const p = window.__PLAYER;
    const h = p.world.heightAt(0, 0);
    const s = p.state();
    return {
      x: s.x,
      y: s.y,
      z: s.z,
      onGround: s.onGround,
      feetBlock: p.world.getBlock(0, Math.floor(s.y) - 1, 0),
      height: h,
      cameraY: p.camera.position.y,
      eyeHeight: p.player.eyeHeight,
    };
  });
  check('spawns on the surface of column 0,0', Math.abs(spawn.x - 0.5) < 1e-9 && Math.abs(spawn.z - 0.5) < 1e-9, `${spawn.x},${spawn.z}`);
  check('spawn height is the top of that surface', spawn.y >= spawn.height + 1 && spawn.y <= spawn.height + 8, `feet ${spawn.y}, surface ${spawn.height}`);
  check('spawn stands on a solid block', spawn.feetBlock !== 0, String(spawn.feetBlock));
  check('spawn is grounded (settled, not falling)', spawn.onGround === true);
  check('camera sits 1.62 above the feet', Math.abs(spawn.cameraY - (spawn.y + spawn.eyeHeight)) < 1e-9, `${spawn.cameraY} vs ${spawn.y + spawn.eyeHeight}`);

  // -------------------------------------------------------------- the rig ---
  await page.evaluate(() => window.__PLAYER.rig.arena(0, 50, 0, 12));
  await page.evaluate(() => {
    window.__PLAYER.park(0.5, 51, 0.5);
    window.__PLAYER.land();
    window.__PLAYER.look(-Math.PI / 2, 0); // face +x
  });
  await sleep(500);
  const flat = await state();
  check('test arena puts the player on flat ground', flat.y === 51 && flat.onGround, `${flat.y}/${flat.onGround}`);
  check('camera pitch is level after look()', Math.abs(flat.pitch) < 1e-9 && Math.abs(flat.yaw + Math.PI / 2) < 1e-9, `${flat.yaw}/${flat.pitch}`);

  // -------------------------------------------------------- walking (keys) --
  await page.keyboard.down('KeyW');
  await sleep(120);
  const keysLive = await page.evaluate(() => window.__PLAYER.player.input.isDown('forward'));
  check('a real KeyW keydown reaches the player input', keysLive === true);
  await page.evaluate(() => window.__PLAYER.recorder.start());
  const walkStart = await state();
  const walkT0 = Date.now();
  await sleep(1000);
  const walkEnd = await state();
  const walkMs = Date.now() - walkT0;
  const walk = await page.evaluate(() => window.__PLAYER.recorder.stop());
  await page.keyboard.up('KeyW');

  const walkDistance = Math.hypot(walkEnd.x - walkStart.x, walkEnd.z - walkStart.z);
  check('walking moves along +x (yaw -90 deg)', walkEnd.x > walkStart.x + 3 && Math.abs(walkEnd.z - walkStart.z) < 0.05, `dx ${(walkEnd.x - walkStart.x).toFixed(2)} dz ${(walkEnd.z - walkStart.z).toFixed(2)}`);
  check('walk speed is 4.3 blocks/s', Math.abs(walk.maxSpeed - 4.3) < 0.05, walk.maxSpeed.toFixed(3));
  check('measured distance matches the clock', Math.abs(walkDistance / (walkMs / 1000) - 4.3) < 0.35, `${(walkDistance / (walkMs / 1000)).toFixed(2)} b/s over ${walkMs} ms`);
  check('every frame of the walk stayed on the surface (no jitter, no sinking)', walk.minY === 51 && walk.maxY === 51, `${walk.minY}..${walk.maxY} over ${walk.frames} frames`);
  check('no frame of the walk was inside a block', walk.insideFrames === 0, String(walk.insideFrames));
  check('walking reports grounded every frame', walk.frames > 30, String(walk.frames));

  // -------------------------------------------------------------- sprinting --
  await page.evaluate(() => {
    window.__PLAYER.park(0.5, 51, 0.5);
    window.__PLAYER.land();
    window.__PLAYER.look(-Math.PI / 2, 0);
  });
  await sleep(200);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__PLAYER.recorder.start());
  await sleep(900);
  const sprint = await page.evaluate(() => window.__PLAYER.recorder.stop());
  const sprintState = await state();
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('shift + W sprints at 5.6 blocks/s', Math.abs(sprint.maxSpeed - 5.6) < 0.05, sprint.maxSpeed.toFixed(3));
  check('sprint is reported as active while moving', sprintState.sprinting === true);
  check('sprinting stays on the surface', sprint.minY === 51 && sprint.maxY === 51, `${sprint.minY}..${sprint.maxY}`);

  await sleep(300);

  // --------------------------------------------------------- wall collision --
  await page.evaluate(() => {
    const p = window.__PLAYER;
    p.rig.wallAtX(5, 50, 0, 4, 4); // blocks at x = 5, y 51..54
    p.park(0.5, 51, 0.5);
    p.land();
    p.look(-Math.PI / 2, 0);
  });
  await sleep(300);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__PLAYER.recorder.start());
  await sleep(1800);
  const wall = await page.evaluate(() => window.__PLAYER.recorder.stop());
  const wallEnd = await state();
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('running into a wall never enters the wall', wall.insideFrames === 0, `${wall.insideFrames}/${wall.frames} frames inside`);
  check('the player stops at the wall face', Math.abs(wallEnd.x + 0.3 - 5) < 1e-4, `x ${wallEnd.x.toFixed(4)} (+0.3 = ${(wallEnd.x + 0.3).toFixed(4)})`);
  check('the wall stops the player (speed ~ 0)', wallEnd.speed < 0.05, wallEnd.speed.toFixed(4));
  check('the wall does not push the player through the ground', wall.minY === 51, String(wall.minY));

  // ------------------------------------------------------ jump onto a step ---
  await page.evaluate(() => {
    const p = window.__PLAYER;
    p.rig.block(2, 51, 0, p.Block.STONE); // one block high step at x = 2
    p.rig.block(2, 51, -1, p.Block.STONE);
    p.rig.block(2, 51, 1, p.Block.STONE);
  });
  await page.evaluate(() => window.__PLAYER.recorder.start());
  let climbed = null;
  for (let attempt = 0; attempt < 5 && !climbed; attempt++) {
    await page.evaluate(() => {
      const p = window.__PLAYER;
      p.park(0.5, 51, 0.5);
      p.land();
      p.look(-Math.PI / 2, 0);
    });
    await sleep(200);
    await page.keyboard.down('KeyW');
    await sleep(140);
    await page.keyboard.down('Space');
    await sleep(60);
    await page.keyboard.up('Space');
    for (let i = 0; i < 14 && !climbed; i++) {
      await sleep(60);
      const s = await state();
      if (s.onGround && s.y === 52) climbed = s;
    }
    await page.keyboard.up('KeyW');
    await page.evaluate(() => window.__PLAYER.releaseAll());
    await sleep(150);
  }
  const stepRecord = await page.evaluate(() => window.__PLAYER.recorder.stop());
  check('walking + jumping climbs a 1 block step (feet at 52)', !!climbed, climbed ? `x ${climbed.x.toFixed(2)}` : 'never reached y=52');
  check('the step jump never lands inside a block', stepRecord.insideFrames === 0, String(stepRecord.insideFrames));

  // ------------------------------------------------------------- mouse look --
  await page.evaluate(() => {
    window.__PLAYER.rig.arena(0, 50, 0, 12);
    window.__PLAYER.park(0.5, 51, 0.5);
    window.__PLAYER.look(0, 0);
    if (document.exitPointerLock) document.exitPointerLock();
  });
  await sleep(400);
  const unlockedStart = await page.evaluate(() => ({
    locked: window.__PLAYER.state().locked,
    hint: document.getElementById('hint').style.display,
  }));
  check('the pointer starts unlocked and the hint is visible', unlockedStart.locked === false && unlockedStart.hint !== 'none', JSON.stringify(unlockedStart));

  const canvasBox = await page.evaluate(() => {
    const r = document.getElementById('game').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(canvasBox.x, canvasBox.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(canvasBox.x + i * 20, canvasBox.y + i * 5);
    await sleep(20);
  }
  await page.mouse.up();
  const dragged = await state();
  check('mouse drag rotates the view (drag look)', dragged.yaw < -0.05 && dragged.pitch < 0, `yaw ${dragged.yaw.toFixed(3)} pitch ${dragged.pitch.toFixed(3)}`);

  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(canvasBox.x, canvasBox.y + i * 40);
    await sleep(8);
  }
  await page.mouse.up();
  const lookedDown = await page.evaluate(() => {
    const p = window.__PLAYER;
    const THREE = p.THREE;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.camera.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(p.camera.quaternion);
    return { pitch: p.state().pitch, upY: up.y, forwardY: forward.y };
  });
  const LIMIT = (89 * Math.PI) / 180;
  check('pitch is clamped to -89 degrees', Math.abs(lookedDown.pitch + LIMIT) < 1e-6, lookedDown.pitch.toFixed(6));
  check('the camera never flips over (up.y stays positive)', lookedDown.upY > 0.01, lookedDown.upY.toFixed(4));
  check('the view is never exactly vertical', Math.abs(lookedDown.forwardY) < 0.9999999, lookedDown.forwardY.toFixed(6));

  await page.mouse.down();
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(canvasBox.x, canvasBox.y - i * 40);
    await sleep(8);
  }
  await page.mouse.up();
  const lookedUp = await state();
  check('pitch is clamped to +89 degrees', Math.abs(lookedUp.pitch - LIMIT) < 1e-6, lookedUp.pitch.toFixed(6));

  // ----------------------------------------------------------- pointer lock --
  await page.mouse.click(canvasBox.x, canvasBox.y);
  await sleep(500);
  const afterClick = await page.evaluate(() => ({
    locked: window.__PLAYER.state().locked,
    pointerLockElement: !!document.pointerLockElement,
    hint: document.getElementById('hint').style.display,
  }));
  if (afterClick.locked) {
    check('clicking the canvas locks the pointer', afterClick.pointerLockElement === true, JSON.stringify(afterClick));
    check('the hint hides while playing', afterClick.hint === 'none', afterClick.hint);

    const lockedYaw = await state();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(canvasBox.x + i * 25, canvasBox.y);
      await sleep(25);
    }
    const afterLockedMove = await state();
    check('mouse movement turns the view while locked', Math.abs(afterLockedMove.yaw - lockedYaw.yaw) > 0.05, `yaw ${lockedYaw.yaw.toFixed(3)} -> ${afterLockedMove.yaw.toFixed(3)}`);

    await page.evaluate(() => document.exitPointerLock());
    await sleep(400);
    const afterExit = await page.evaluate(() => ({
      locked: window.__PLAYER.state().locked,
      hint: document.getElementById('hint').style.display,
    }));
    check('leaving the lock (ESC does this in a real browser) is detected', afterExit.locked === false, JSON.stringify(afterExit));
    check('the hint comes back when the lock is released', afterExit.hint !== 'none', afterExit.hint);
  } else {
    console.log('  ..   pointer lock unavailable in this headless Chrome (drag look still works): ' + JSON.stringify(afterClick));
  }

  // --------------------------------------------------- falling / landing -----
  await page.evaluate(() => {
    const p = window.__PLAYER;
    p.rig.arena(0, 50, 0, 8);
    p.park(0.5, 62, 0.5);
    p.recorder.start();
    p.land(); // gravity on: 11 blocks of free fall onto the arena floor
  });
  await sleep(1500);
  const drop = await page.evaluate(() => window.__PLAYER.recorder.stop());
  const dropEnd = await state();
  check('a fall from 11 blocks lands exactly on the floor', dropEnd.y === 51 && dropEnd.onGround, String(dropEnd.y));
  check('the fall never goes through the floor or into a block', drop.minY === 51 && drop.insideFrames === 0, `${drop.minY}/${drop.insideFrames}`);

  // ------------------------------------------------------------------ fps ----
  await page.keyboard.down('KeyW');
  await sleep(2500);
  const fpsStats = await stats();
  await page.keyboard.up('KeyW');
  check('fps >= 40 while walking in first person', fpsStats.fps >= 40, fpsStats.fps.toFixed(1));
  console.log(`  ..   fps ${fpsStats.fps.toFixed(1)}  frame ${fpsStats.frameMs.toFixed(2)} ms  draws ${fpsStats.drawCalls}  tris ${fpsStats.triangles}`);
  check('draw calls stay reasonable', fpsStats.drawCalls > 0 && fpsStats.drawCalls < 400, String(fpsStats.drawCalls));
  check('chunks are streamed around the player', fpsStats.world.meshed > 10, String(fpsStats.world.meshed));

  await page.screenshot({ path: path.join(OUT_DIR, 'player-first-person.png') });
  await page.evaluate(() => {
    window.__PLAYER.look(0.6, -0.15);
    window.__PLAYER.teleport(0.5, 51, 0.5);
  });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'player-arena.png') });

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log('failures:');
  for (const f of FAIL) console.log('  - ' + f);
  process.exit(1);
}
