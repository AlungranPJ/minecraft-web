/**
 * Browser acceptance test for the interaction layer, on a real Chrome over CDP.
 *
 * Everything here goes through the real page: real mouse buttons for dig/place,
 * real key presses for 1-9 and F3, real wheel for the hotbar, a real page reload
 * for the save file and a real click on the reset button.
 *
 *   npm run build
 *   npm run preview                       # serves dist/ on http://localhost:4173
 *   node tests/interaction.browser.test.mjs
 *
 * Env: CHROME_PATH (default: Windows Chrome), PAGE_URL, OUT_DIR, AUTOSAVE_WAIT_MS
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4173/interaction.html';
const OUT_DIR = process.env.OUT_DIR || 'test-output';
const AUTOSAVE_WAIT_MS = Number(process.env.AUTOSAVE_WAIT_MS || 11_500);
const DIG_HOLD_MS = Number(process.env.DIG_HOLD_MS || 680);

const PASS = [];
const FAIL = [];
let INFO = [];

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
  await page.waitForFunction('!!window.__VOXEL_INTERACTION', { timeout: 30000 });
  check('interaction page boots', true);
  await page.waitForFunction('window.__VOXEL_INTERACTION.stats().world.meshed > 10', { timeout: 30000 });
  await sleep(1200);

  // --------------------------------------------------------------- HUD ------
  const hud = await page.evaluate(() => {
    const root = document.querySelector('.ix-root');
    return {
      root: !!root,
      pointerEvents: root ? getComputedStyle(root).pointerEvents : 'missing',
      crosshair: !!document.querySelector('.ix-crosshair'),
      slots: document.querySelectorAll('.ix-hotbar .ix-slot').length,
      keys: Array.from(document.querySelectorAll('.ix-hotbar .ix-key')).map((el) => el.textContent),
      selected: document.querySelectorAll('.ix-hotbar .ix-slot-active').length,
      debugDisplay: getComputedStyle(document.querySelector('.ix-debug')).display,
      reset: !!document.querySelector('.ix-reset'),
      counts: Array.from(document.querySelectorAll('.ix-hotbar .ix-count')).map((el) => el.textContent),
      centre: document.elementFromPoint(640, 360)?.tagName ?? 'none',
      iconPainted: (() => {
        const canvas = document.querySelector('.ix-hotbar .ix-slot canvas');
        if (!canvas) return false;
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let filled = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) filled++;
        return filled > canvas.width * canvas.height * 0.5;
      })(),
    };
  });
  check('HUD is mounted with a crosshair', hud.root && hud.crosshair);
  check('hotbar has 9 numbered slots', hud.slots === 9 && hud.keys.join(',') === '1,2,3,4,5,6,7,8,9', hud.keys.join(','));
  check('exactly one slot is selected', hud.selected === 1);
  check('starter counts are shown per slot', hud.counts.slice(0, 5).every((c) => c === '64') && hud.counts[5] === '', JSON.stringify(hud.counts));
  check('slot icons come from the atlas', hud.iconPainted);
  check('debug overlay starts hidden', hud.debugDisplay === 'none', hud.debugDisplay);
  check('reset world button exists', hud.reset);
  check('HUD does not block the canvas', hud.pointerEvents === 'none' && hud.centre === 'CANVAS', `${hud.pointerEvents} / ${hud.centre}`);

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-interaction-hud.png') });

  // ------------------------------------------------------- world pick --------
  const spot = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    const B = I.Block;
    const air = (x, y, z) => I.getBlock(x, y, z) === B.AIR;
    for (let x = 0; x < 32; x++) {
      for (let z = 0; z < 32; z++) {
        const h = I.world.heightAt(x, z);
        if (h < 24 || I.getBlock(x, h, z) !== B.GRASS) continue;
        let clear = true;
        for (let y = h + 1; y <= h + 6; y++) if (!air(x, y, z)) clear = false;
        const h2 = I.world.heightAt(x + 2, z);
        if (!clear || h2 !== h || I.getBlock(x + 2, h, z) !== B.GRASS) continue;
        for (let y = h + 1; y <= h + 6; y++) if (!air(x + 2, y, z)) clear = false;
        if (clear) return { x, z, h };
      }
    }
    return null;
  });
  check('found a flat grass spot to work on', !!spot, JSON.stringify(spot));
  const { x, z, h } = spot;
  console.log(`  ..   working at column x=${x} z=${z} surface y=${h}`);

  const readBlock = (bx, by, bz) => page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.getBlock(a, b, c), bx, by, bz);
  const aim = (bx, by, bz) => page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.aimAtBlock(a, b, c), bx, by, bz);
  const target = () => page.evaluate(() => {
    const t = window.__VOXEL_INTERACTION.target();
    return t ? { position: t.position, normal: t.normal, blockId: t.blockId, distance: Number(t.distance.toFixed(2)) } : null;
  });
  const slotDOM = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('.ix-hotbar .ix-slot')).map((el) => ({
      active: el.classList.contains('ix-slot-active'),
      count: el.querySelector('.ix-count').textContent,
    })));
  const counts = async () => (await slotDOM()).map((s) => s.count);
  /** Wait until the page is rendering steadily: a stall mid-hold is what makes a
   *  short press look like a long one and triggers the 0.22 s place repeat. */
  const settle = () => page.waitForFunction(() => window.__VOXEL_INTERACTION.fps >= 30, { timeout: 15000 }).catch(() => {});
  /** Real button press. The hold is far shorter than the place repeat, so one
   *  press means exactly one place attempt. */
  const press = async (button, holdMs = 60) => {
    await settle();
    await page.mouse.down({ button });
    await sleep(holdMs);
    await page.mouse.up({ button });
  };
  /** Dig by holding until the voxel is gone (not for a fixed time), so a slow
   *  frame cannot leave the block standing. */
  const digUntilAir = async (bx, by, bz, onMid) => {
    await settle();
    await page.mouse.down({ button: 'left' });
    if (onMid) await onMid();
    try {
      await page.waitForFunction(
        (a, b, c) => window.__VOXEL_INTERACTION.getBlock(a, b, c) === 0,
        { timeout: DIG_HOLD_MS + 6000 },
        bx, by, bz,
      );
    } catch {
      /* fall through: the follow-up check reports the miss */
    }
    await page.mouse.up({ button: 'left' });
    await sleep(150);
  };

  // stand 3 blocks above the surface and look straight down at it
  await page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.teleport(a, b, c), x + 0.5, h + 3, z + 0.5);
  await aim(x, h, z);
  await page.mouse.move(640, 360);
  await sleep(120);
  const downTarget = await target();
  check('crosshair targets the grass block below', downTarget?.blockId === 1 && downTarget.position.join(',') === `${x},${h},${z}`, JSON.stringify(downTarget));

  // ------------------------------------------------------------ hotbar keys --
  await page.keyboard.press('Digit6');
  await sleep(80);
  let slots = await slotDOM();
  check('key 6 selects hotbar slot 6', slots[5].active && slots.filter((s) => s.active).length === 1);
  check('the model agrees with the HUD', (await page.evaluate(() => window.__VOXEL_INTERACTION.hotbar.selected)) === 5);

  await page.mouse.wheel({ deltaY: 150 });
  await sleep(80);
  slots = await slotDOM();
  check('wheel moves one slot forward', slots[6].active, JSON.stringify(slots.map((s) => (s.active ? 1 : 0)).join('')));
  await page.mouse.wheel({ deltaY: -300 });
  await sleep(80);
  slots = await slotDOM();
  check('wheel moves one slot back and wraps', slots[5].active, JSON.stringify(slots.map((s) => (s.active ? 1 : 0)).join('')));

  // ------------------------------------------------------------- dig ---------
  check('the dig target slot is empty', slots[5].count === '', slots[5].count);
  await digUntilAir(x, h, z, async () => {
    await sleep(320);
    const midDig = await page.evaluate(() => {
      const wrap = document.querySelector('.ix-progress');
      return {
        opacity: getComputedStyle(wrap).opacity,
        width: wrap.querySelector('i').style.width,
        progress: window.__VOXEL_INTERACTION.session.controller.digProgress,
      };
    });
    check(
      'break progress is visible while holding the button',
      midDig.opacity === '1' && parseFloat(midDig.width) > 5 && midDig.progress > 0.2,
      JSON.stringify(midDig),
    );
  });

  check('holding the left button broke the block', (await readBlock(x, h, z)) === 0, String(await readBlock(x, h, z)));
  slots = await slotDOM();
  check('the dropped block landed in the first empty slot', slots[5].count === '1', slots[5].count);
  check('the full starter stack was left alone', slots[0].count === '64', slots[0].count);
  check('progress bar is hidden again', (await page.evaluate(() => getComputedStyle(document.querySelector('.ix-progress')).opacity)) === '0');

  // ------------------------------------------------------------ place --------
  await page.keyboard.press('Digit1');
  await sleep(80);
  await aim(x, h, z);
  await page.mouse.move(640, 360);
  await sleep(120);
  const holeTarget = await target();
  check('the dug hole dropped the aim one block down', holeTarget?.position.join(',') === `${x},${h - 1},${z}` && holeTarget.normal.join(',') === '0,1,0', JSON.stringify(holeTarget));

  const countsBeforePlace = await counts();
  await press('right');
  await sleep(150);
  check('right click placed the block back in the hole', (await readBlock(x, h, z)) === 1, String(await readBlock(x, h, z)));
  slots = await slotDOM();
  check(
    'one press consumed exactly one item',
    Number(countsBeforePlace[0]) - Number(slots[0].count) === 1,
    `${countsBeforePlace[0]} -> ${slots[0].count}`,
  );
  check(
    'dig + place round trip left no diff for that voxel',
    (await page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.edits.has(a, b, c), x, h, z)) === false,
  );

  // ------------------------------------------------- never place inside you --
  await page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.teleport(a, b, c), x + 0.5, h + 1, z + 0.5);
  await aim(x, h, z);
  await sleep(120);
  const rejectsBefore = await page.evaluate(() => ({ ...window.__VOXEL_INTERACTION.session.controller.rejects }));
  await press('right');
  await sleep(150);
  check('placing into your own body is refused', (await readBlock(x, h + 1, z)) === 0, String(await readBlock(x, h + 1, z)));
  const rejectState = await page.evaluate(() => ({
    rejects: window.__VOXEL_INTERACTION.session.controller.rejects,
    toast: document.querySelector('.ix-toast').textContent,
  }));
  check(
    'this press was refused and reported',
    (rejectState.rejects['player-box'] ?? 0) > (rejectsBefore['player-box'] ?? 0) && rejectState.toast.includes('hit you'),
    JSON.stringify(rejectState),
  );

  // -------------------------------------------- leave edits behind for save ---
  await page.evaluate((a, b, c) => window.__VOXEL_INTERACTION.teleport(a, b, c), x + 0.5, h + 3, z + 0.5);
  await aim(x + 2, h, z);
  await sleep(120);
  const sideTarget = await target();
  check('aiming at the neighbour column hits its top face', sideTarget?.position.join(',') === `${x + 2},${h},${z}` && sideTarget.normal.join(',') === '0,1,0', JSON.stringify(sideTarget));

  await press('right');
  await sleep(150);
  check('a block was placed on the neighbour column', (await readBlock(x + 2, h + 1, z)) === 1, String(await readBlock(x + 2, h + 1, z)));

  // dig a hole next door and leave it open
  await aim(x + 1, h, z);
  await sleep(120);
  await digUntilAir(x + 1, h, z);
  check('the second hole is open', (await readBlock(x + 1, h, z)) === 0, String(await readBlock(x + 1, h, z)));

  const preSaveSlots = await counts();
  const beforeSave = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    return { size: I.edits.size, state: I.rig.saveState(), key: I.storageKey, hotbar: I.hotbar.toJSON() };
  });
  check('the diff kept only the two real changes', beforeSave.size === 2, JSON.stringify(beforeSave.size));
  check('storage key is per seed', /^minecraft-web:world:\d+$/.test(beforeSave.key), beforeSave.key);

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-interaction-edited.png') });

  const saved = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    const ok = I.save();
    return { ok, raw: localStorage.getItem(I.storageKey) };
  });
  check('save writes localStorage', saved.ok && !!saved.raw);
  const payload = JSON.parse(saved.raw);
  check(
    'save file documents what it stores',
    payload.version === 1 &&
      typeof payload.seed === 'number' &&
      payload.player &&
      Array.isArray(payload.edits) &&
      payload.edits.length === 2 &&
      Array.isArray(payload.hotbar.slots) &&
      payload.hotbar.slots.length === 9,
    JSON.stringify({ keys: Object.keys(payload), edits: payload.edits.length, player: payload.player }),
  );
  console.log('  ..   save: ' + JSON.stringify(payload).slice(0, 240) + '…');

  // ----------------------------------------------------- autosave ------------
  const autosaveBefore = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    return JSON.parse(localStorage.getItem(I.storageKey)).savedAt;
  });
  console.log(`  ..   waiting ${AUTOSAVE_WAIT_MS} ms for the 10 s autosave (no explicit save call)…`);
  await sleep(AUTOSAVE_WAIT_MS);
  const autosaveAfter = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    return { savedAt: JSON.parse(localStorage.getItem(I.storageKey)).savedAt, saves: I.session.store.saveCount };
  });
  check(
    'the world autosaves every 10 s without being asked',
    autosaveAfter.savedAt > autosaveBefore && autosaveAfter.saves >= 2,
    `${autosaveBefore} -> ${autosaveAfter.savedAt} (${autosaveAfter.saves} saves)`,
  );

  // ------------------------------------------------------------ reload ------
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!window.__VOXEL_INTERACTION', { timeout: 30000 });
  const restored = await page.evaluate(() => window.__VOXEL_INTERACTION.playerRestored);
  check('the save is detected after a page reload', restored === true, String(restored));

  let reloadOk = true;
  try {
    await page.waitForFunction(
      (a, b, c) => window.__VOXEL_INTERACTION.getBlock(a, b, c) === 0,
      { timeout: 30000 },
      x + 1, h, z,
    );
  } catch {
    reloadOk = false;
  }
  check('the dug hole is still there after reload', reloadOk && (await readBlock(x + 1, h, z)) === 0);
  check('the placed block is still there after reload', (await readBlock(x + 2, h + 1, z)) === 1, String(await readBlock(x + 2, h + 1, z)));
  check('the untouched terrain did not change', (await readBlock(x + 2, h, z)) === 1, String(await readBlock(x + 2, h, z)));

  const afterReload = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    return { state: I.rig.saveState(), slots: I.hotbar.toJSON(), edits: I.edits.size };
  });
  check(
    'the player is back where they left off',
    Math.abs(afterReload.state.x - beforeSave.state.x) < 1e-6 &&
      Math.abs(afterReload.state.y - beforeSave.state.y) < 1e-6 &&
      Math.abs(afterReload.state.z - beforeSave.state.z) < 1e-6,
    JSON.stringify(afterReload.state),
  );
  check(
    'the restored hotbar is exactly the one that was saved',
    JSON.stringify(afterReload.slots) === JSON.stringify(beforeSave.hotbar),
    `saved ${JSON.stringify(beforeSave.hotbar.slots)} vs restored ${JSON.stringify(afterReload.slots.slots)}`,
  );
  check('the restored hotbar still holds the items', afterReload.slots.slots.filter(Boolean).length >= 6, String(afterReload.slots.slots.filter(Boolean).length));
  const reloadSlots = await counts();
  check(
    'the HUD shows the restored counts',
    JSON.stringify(reloadSlots) === JSON.stringify(preSaveSlots),
    `${JSON.stringify(preSaveSlots)} vs ${JSON.stringify(reloadSlots)}`,
  );
  await sleep(3000);
  INFO.push(`fps after the reload settled: ${(await page.evaluate(() => window.__VOXEL_INTERACTION.fps)).toFixed(1)}`);

  // ------------------------------------------------------------- F3 ---------
  await page.keyboard.press('F3');
  await sleep(400);
  const debugOn = await page.evaluate(() => {
    const el = document.querySelector('.ix-debug');
    return { display: getComputedStyle(el).display, text: el.textContent };
  });
  check('F3 shows the debug overlay', debugOn.display === 'block');
  await page.screenshot({ path: path.join(OUT_DIR, 'shot-interaction-debug.png') });
  check('debug overlay reports fps', /fps\s+[\d.]+/.test(debugOn.text), debugOn.text.split('\n')[0]);
  check('debug overlay reports coordinates', /pos\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+/.test(debugOn.text));
  check('debug overlay reports loaded chunks', /chunks\s+\d+/.test(debugOn.text), (debugOn.text.match(/chunks[^\n]*/) ?? [''])[0]);
  check('debug overlay is not part of the world text', debugOn.text.includes('edits'));
  await page.keyboard.press('F3');
  await sleep(150);
  check('F3 hides it again', (await page.evaluate(() => getComputedStyle(document.querySelector('.ix-debug')).display)) === 'none');

  // ------------------------------------------------------------ reset -------
  const resetButton = await page.$('.ix-reset');
  await resetButton.click();
  await sleep(120);
  check('the reset button asks for confirmation first', await page.evaluate(() => document.querySelector('.ix-reset').classList.contains('ix-reset-armed')));
  await resetButton.click();
  await sleep(300);
  check('reset restores the generated terrain', (await readBlock(x + 1, h, z)) === 1, String(await readBlock(x + 1, h, z)));
  check('reset removes the player placed block', (await readBlock(x + 2, h + 1, z)) === 0, String(await readBlock(x + 2, h + 1, z)));
  const afterReset = await page.evaluate(() => {
    const I = window.__VOXEL_INTERACTION;
    return { edits: I.edits.size, raw: localStorage.getItem(I.storageKey), slots: I.hotbar.toJSON().slots };
  });
  check('reset empties the diff', afterReset.edits === 0);
  check('reset clears the save file', afterReset.raw === null);
  check('reset puts the starter items back', afterReset.slots[0].id === 1 && afterReset.slots[0].count === 64, JSON.stringify(afterReset.slots.slice(0, 2)));

  // ------------------------------------------------------- errors / lock ----
  INFO.push(`page errors: ${pageErrors.length}`);
  check('no page or console errors during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  const lock = await page.evaluate(async () => {
    const canvas = document.getElementById('game');
    canvas.click();
    await new Promise((r) => setTimeout(r, 250));
    return { locked: document.pointerLockElement === canvas, supported: 'requestPointerLock' in canvas };
  });
  INFO.push(`pointer lock after a real click: ${lock.locked} (api present: ${lock.supported})`);

  await page.screenshot({ path: path.join(OUT_DIR, 'shot-interaction-after-reset.png') });
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
console.log('artifacts: ' + fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('shot-interaction')).join(', '));
