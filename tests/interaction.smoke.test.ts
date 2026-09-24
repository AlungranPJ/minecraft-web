/**
 * Headless smoke test for the interaction layer: hotbar, block edit diff,
 * dig / place rules (including every rejection), save file round trip and world
 * reset. No browser and no WebGL needed.
 *
 *   npm run test:interaction
 */
import * as THREE from 'three';
import { Block } from '../src/engine/blocks';
import { CHUNK_HEIGHT } from '../src/engine/chunk';
import { SEA_LEVEL, TerrainGenerator } from '../src/engine/terrain';
import { World } from '../src/engine/world';
import { FirstPersonPlayer } from '../src/player';
import {
  EditTracker,
  Hotbar,
  InteractionController,
  InteractionSession,
  MAX_STACK,
  MemoryStorage,
  PlayerBody,
  SAVE_VERSION,
  boxOverlapsBlock,
  clampPitch,
  createAABB,
  createCameraPlayerAdapter,
  createFirstPersonPlayerAdapter,
  normalizeSaveData,
  type BlockId,
  type PlaceResult,
} from '../src/interaction';

const SEED = 4242;
const STEP = 1 / 60;
const STRAIGHT_DOWN = -Math.PI / 2;
const TEST_MATERIAL = new THREE.MeshBasicMaterial();

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' -- ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

function section(title: string): void {
  console.log('\n' + title);
}

/** 'placed' on success, otherwise the rejection reason. */
function placeReason(result: PlaceResult): string {
  return result.ok ? 'placed' : result.reason;
}

interface WorldOverrides {
  renderDistance?: number;
  unloadMargin?: number;
}

/**
 * A world with a plain material: enough for getBlock/setBlock/raycast/streaming
 * in node (the atlas would need a DOM).
 */
function makeWorld(over: WorldOverrides = {}): World {
  return new World(null, {
    seed: SEED,
    renderDistance: 2,
    maxChunkOpsPerFrame: 8,
    material: TEST_MATERIAL,
    ...over,
  });
}

/** Column with no tree inside the 3 block tree margin and dry land, so the top block is grass. */
function clearColumn(world: World, startX = 0, startZ = 0): [number, number] {
  for (let x = startX; x < startX + 96; x++) {
    for (let z = startZ; z < startZ + 96; z++) {
      if (world.heightAt(x, z) <= SEA_LEVEL + 3) continue;
      let clear = true;
      for (let dx = -3; dx <= 3 && clear; dx++) {
        for (let dz = -3; dz <= 3 && clear; dz++) {
          if (world.terrain.isTreeAt(x + dx, z + dz)) clear = false;
        }
      }
      if (clear) return [x, z];
    }
  }
  throw new Error('no dry tree-free column found');
}

/** Hollows out the 3x3x4 air space the test player stands in. */
function clearWorkspace(world: World, x: number, z: number, floor: number): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let y = floor + 1; y <= floor + 4; y++) world.setBlock(x + dx, y, z + dz, Block.AIR);
    }
  }
}

/** Terrain value straight out of the generator, independent of the code under test. */
function generatedAt(x: number, y: number, z: number, seed = SEED): BlockId {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const data = new TerrainGenerator(seed).generate(cx, cz);
  return data[(y * 16 + (z - cz * 16)) * 16 + (x - cx * 16)];
}

// ------------------------------------------------------------------ hotbar ---
section('hotbar / inventory');
{
  const starter = Hotbar.starter();
  check('9 slots', starter.size === 9, String(starter.size));
  check(
    'starter items are grass, dirt, stone, sand, wood',
    starter.slots[0]?.id === Block.GRASS &&
      starter.slots[1]?.id === Block.DIRT &&
      starter.slots[2]?.id === Block.STONE &&
      starter.slots[3]?.id === Block.SAND &&
      starter.slots[4]?.id === Block.WOOD &&
      starter.slots.slice(0, 5).every((slot) => slot?.count === MAX_STACK) &&
      starter.slots[5] === null,
  );
  check('default selection is slot 1', starter.selected === 0);

  const hotbar = new Hotbar();
  check('select by index', hotbar.select(3) && hotbar.selected === 3);
  check('select out of range is rejected', !hotbar.select(9) && hotbar.selected === 3);
  check('select by 1-based number', hotbar.selectByNumber(9) && hotbar.selected === 8);

  hotbar.select(0);
  check('wheel steps forward', hotbar.cycle(120) === 1, String(hotbar.selected));
  check('wheel steps backward and wraps', hotbar.cycle(-240) === 0, String(hotbar.selected));

  const stacks = new Hotbar(9, [{ id: Block.STONE, count: 60 }]);
  check('add tops up an existing stack', stacks.add(Block.STONE, 3) === 0 && stacks.slots[0]?.count === 63);
  check('add overflows into the next slot', stacks.add(Block.STONE, 5) === 0 && stacks.slots[0]?.count === MAX_STACK && stacks.slots[1]?.count === 4, String(stacks.slots[1]?.count));
  check('countOf sums the stacks', stacks.countOf(Block.STONE) === 68, String(stacks.countOf(Block.STONE)));

  const full = new Hotbar();
  for (let i = 0; i < full.size; i++) full.setSlot(i, { id: Block.STONE, count: MAX_STACK });
  check('a full inventory reports the leftover', full.add(Block.GRASS, 4) === 4);

  const hand = new Hotbar(9, [{ id: Block.SAND, count: 2 }]);
  check('takeFromSelected decrements', hand.takeFromSelected(1) && hand.slots[0]?.count === 1);
  check('takeFromSelected empties the slot', hand.takeFromSelected(1) && hand.slots[0] === null);
  check('takeFromSelected on an empty hand fails', !hand.takeFromSelected(1));

  const serialised = new Hotbar(9, [{ id: Block.WOOD, count: 5 }], 4).toJSON();
  const roundTrip = Hotbar.fromJSON(serialised);
  check(
    'serialise round trip',
    roundTrip.slots[0]?.id === Block.WOOD && roundTrip.slots[0]?.count === 5 && roundTrip.selected === 4,
  );

  const dirty = Hotbar.fromJSON({
    selected: 42,
    slots: [{ id: 999, count: 3 }, { id: Block.DIRT, count: 500 }, { id: Block.AIR, count: 2 }, null],
  });
  check('corrupt slots are dropped', dirty.slots[0] === null && dirty.slots[2] === null, JSON.stringify(dirty.slots));
  check('counts are clamped to a stack', dirty.slots[1]?.count === MAX_STACK);
  check('out of range selection wraps', dirty.selected === 42 % 9, String(dirty.selected));

  const reset = new Hotbar();
  reset.setSlot(0, null);
  reset.selected = 5;
  reset.resetToStarter();
  check('resetToStarter restores starter items', reset.slots[0]?.id === Block.GRASS && reset.selected === 0);
}

// ------------------------------------------------------------- player body ---
section('player body / placement geometry');
{
  const body = new PlayerBody({ x: 1.5, y: 20, z: -3.5, yaw: 0, pitch: 0 });
  const box = body.getBox(createAABB());
  check(
    'collision box is 0.6 x 1.8 around the feet',
    Math.abs(box.maxX - box.minX - 0.6) < 1e-9 &&
      Math.abs(box.maxY - box.minY - 1.8) < 1e-9 &&
      Math.abs(box.minY - 20) < 1e-9,
    JSON.stringify(box),
  );
  const eye = body.getEye(new THREE.Vector3());
  check('eye sits 1.62 above the feet', Math.abs(eye.y - 21.62) < 1e-9, String(eye.y));

  const down = new PlayerBody({ pitch: STRAIGHT_DOWN }).getLook(new THREE.Vector3());
  check('pitch is clamped and looks straight down', down.y < -0.999, JSON.stringify(down.toArray()));

  const east = new PlayerBody({ yaw: -Math.PI / 2 }).getLook(new THREE.Vector3());
  check('yaw -90 looks toward +x', east.x > 0.999, JSON.stringify(east.toArray()));

  const standing = { minX: 0.5, maxX: 1.1, minY: 20, maxY: 21.8, minZ: 0.5, maxZ: 1.1 };
  check('standing on a block is not an overlap', !boxOverlapsBlock(standing, 0, 19, 0));
  check('a block inside the box overlaps', boxOverlapsBlock(standing, 0, 20, 0));
  check('a neighbouring block does not overlap', !boxOverlapsBlock(standing, 2, 20, 0));

  const camera = new THREE.PerspectiveCamera(70, 1.5, 0.1, 400);
  camera.position.set(4.5, 30.62, -2.5);
  camera.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, 0, 'YXZ'));
  const adapter = createCameraPlayerAdapter(camera);
  const state = adapter.saveState();
  check('camera adapter saves the feet position', Math.abs(state.y - 29) < 1e-6, JSON.stringify(state));
  camera.position.set(-99, -99, -99);
  camera.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
  adapter.loadState(state);
  const reloaded = adapter.saveState();
  check(
    'camera adapter round trip',
    Math.abs(reloaded.x - state.x) < 1e-6 &&
      Math.abs(reloaded.y - state.y) < 1e-6 &&
      Math.abs(reloaded.z - state.z) < 1e-6 &&
      Math.abs((reloaded.yaw ?? 0) - (state.yaw ?? 0)) < 1e-6,
    JSON.stringify(reloaded),
  );
}

// -------------------------------------------------------------- edit diff ----
section('block edit diff against the terrain');
{
  const world = makeWorld();
  const [x, z] = clearColumn(world);
  const h = world.heightAt(x, z);
  const original = generatedAt(x, h, z);

  const tracker = new EditTracker(SEED);
  check('surface block is grass', original === Block.GRASS, String(original));
  check('originalAt matches an independent generator', tracker.originalAt(x, h, z) === original, String(tracker.originalAt(x, h, z)));
  check('originalAt reads outside the world as air', tracker.originalAt(x, CHUNK_HEIGHT + 5, z) === Block.AIR);

  check('writing the terrain value records nothing', !tracker.record(x, h, z, original) && tracker.size === 0);
  check('writing a different value records an edit', tracker.record(x, h, z, Block.AIR) && tracker.size === 1);
  check('rewriting the same value keeps one entry', !tracker.record(x, h, z, Block.AIR) && tracker.size === 1);
  check('putting the original back drops the edit', tracker.record(x, h, z, original) && tracker.size === 0);
  check('settling on a placed block keeps one entry', tracker.record(x, h, z, Block.STONE) && tracker.size === 1 && tracker.entries()[0].id === Block.STONE);

  const fromJson = EditTracker.fromJSON(
    [
      { x, y: h, z, id: Block.SAND },
      { x: 'nope', y: 1, z: 1, id: 1 },
      { x: 1, y: 2, z: 3, id: Block.AIR },
      { x: 1, y: 2, z: 3, id: 99 },
      null,
    ],
    SEED,
  );
  check(
    'fromJSON keeps valid edits, including a voxel dug out to air',
    fromJson.size === 2 && fromJson.has(x, h, z) && fromJson.has(1, 2, 3),
    String(fromJson.size),
  );

  const applyTracker = new EditTracker(SEED);
  applyTracker.record(x, h, z, Block.WOOD);
  applyTracker.record(x + 1, h, z, Block.AIR);
  check('chunk not loaded yet: nothing applied', applyTracker.applyToLoadedChunks(world) === 0);
  world.getBlock(x, h, z); // forces the chunk into memory
  const written = applyTracker.applyToLoadedChunks(world);
  check('edits are applied to the loaded chunk', written === 2, String(written));
  check('applied block reads back', world.getBlock(x, h, z) === Block.WOOD);
  check('applying twice writes nothing', applyTracker.applyToLoadedChunks(world) === 0);
  world.dispose();
}

// ----------------------------------------------- edits survive an unload -----
section('edits survive chunk unload / reload');
{
  const world = makeWorld({ renderDistance: 1, unloadMargin: 0 });
  const [x, z] = clearColumn(world);
  const h = world.heightAt(x, z);
  const tracker = new EditTracker(SEED);
  tracker.record(x, h, z, Block.STONE);
  world.getBlock(x, h, z);
  check('first apply writes the edit', tracker.applyToLoadedChunks(world) === 1);
  check('block is stone after the first apply', world.getBlock(x, h, z) === Block.STONE);

  world.update(0.016, new THREE.Vector3(400, 40, 400));
  check('chunk was unloaded', world.getChunk(Math.floor(x / 16), Math.floor(z / 16)) === undefined);

  world.update(0.016, new THREE.Vector3(x, h, z));
  check('chunk is back after the player returns', world.getChunk(Math.floor(x / 16), Math.floor(z / 16)) !== undefined);
  const rewritten = tracker.applyToLoadedChunks(world);
  check('edit is re-applied to the fresh chunk', rewritten === 1, String(rewritten));
  check('block is stone again', world.getBlock(x, h, z) === Block.STONE);
  world.dispose();
}

// -------------------------------------------------------------------- dig ----
section('dig');
{
  const world = makeWorld();
  const [x, z] = clearColumn(world);
  const h = world.heightAt(x, z);
  clearWorkspace(world, x, z, h);
  check('surface block is grass', world.getBlock(x, h, z) === Block.GRASS, String(world.getBlock(x, h, z)));

  const body = new PlayerBody({ x: x + 0.5, y: h + 1, z: z + 0.5, pitch: STRAIGHT_DOWN });
  const hotbar = new Hotbar(9, [{ id: Block.STONE, count: 10 }]);
  const controller = new InteractionController({ world, player: body, hotbar });

  controller.update(STEP);
  check(
    'crosshair finds the block below',
    !!controller.target && controller.target.blockId === Block.GRASS && controller.target.position[1] === h,
    JSON.stringify(controller.target?.position ?? null),
  );

  controller.beginDig();
  let frames = 0;
  while (controller.digsCompleted === 0 && frames < 600) {
    controller.update(STEP);
    frames++;
  }
  const grassSeconds = frames * STEP;
  check(
    'grass breaks in ~0.6 s (hardness)',
    controller.digsCompleted === 1 && Math.abs(grassSeconds - 0.6) <= 0.04,
    grassSeconds.toFixed(3) + ' s',
  );
  check('dug block is now air', world.getBlock(x, h, z) === Block.AIR);
  check('dug block went into the hotbar', hotbar.countOf(Block.GRASS) === 1, String(hotbar.countOf(Block.GRASS)));
  check('progress reset after the break', controller.digProgress === 0);
  controller.endDig();

  // second column: stone, plus the interrupt / retarget cases
  const [x2, z2] = clearColumn(world, x + 40, z);
  const h2 = world.heightAt(x2, z2);
  clearWorkspace(world, x2, z2, h2);
  world.setBlock(x2, h2, z2, Block.STONE);
  body.setPosition(x2 + 0.5, h2 + 1, z2 + 0.5);
  body.setLook(0, STRAIGHT_DOWN);

  controller.beginDig();
  for (let i = 0; i < 30; i++) controller.update(STEP);
  const partial = controller.digProgress;
  controller.endDig();
  for (let i = 0; i < 30; i++) controller.update(STEP);
  check(
    'releasing the button stops the dig',
    world.getBlock(x2, h2, z2) === Block.STONE && partial > 0.25 && controller.digProgress === 0,
    partial.toFixed(2),
  );

  controller.beginDig();
  for (let i = 0; i < 30; i++) controller.update(STEP);
  const beforeSwitch = controller.digProgress;
  body.setPosition(x2 + 1.5, h2 + 1, z2 + 0.5); // one block over: different voxel
  controller.update(STEP);
  check('aiming at another voxel restarts the progress', beforeSwitch > 0.25 && controller.digProgress < 0.1, beforeSwitch.toFixed(2) + ' -> ' + controller.digProgress.toFixed(3));
  controller.endDig();

  // stone takes the advertised 1.5 s
  body.setPosition(x2 + 0.5, h2 + 1, z2 + 0.5);
  body.setLook(0, STRAIGHT_DOWN);
  controller.beginDig();
  frames = 0;
  while (controller.digsCompleted === 1 && frames < 600) {
    controller.update(STEP);
    frames++;
  }
  const stoneSeconds = frames * STEP;
  check(
    'stone breaks in ~1.5 s (hardness)',
    controller.digsCompleted === 2 && Math.abs(stoneSeconds - 1.5) <= 0.05,
    stoneSeconds.toFixed(3) + ' s',
  );
  check('stone went into the hotbar', hotbar.countOf(Block.STONE) === 11, String(hotbar.countOf(Block.STONE)));
  controller.endDig();

  // full inventory: the drop is reported instead of vanishing silently
  const fullHotbar = new Hotbar();
  for (let i = 0; i < fullHotbar.size; i++) fullHotbar.setSlot(i, { id: Block.DIRT, count: MAX_STACK });
  let overflowReported = false;
  const tiny = new InteractionController({
    world,
    player: body,
    hotbar: fullHotbar,
    onInventoryFull: (id, leftover) => {
      overflowReported = id === Block.DIRT && leftover === 1;
    },
  });
  tiny.beginDig();
  frames = 0;
  while (tiny.digsCompleted === 0 && frames < 600) {
    tiny.update(STEP);
    frames++;
  }
  check('digging works with a full inventory', tiny.digsCompleted === 1);
  check('the overflow is reported', overflowReported);
  world.dispose();
}

// ------------------------------------------------------------------ place ----
section('place');
{
  const world = makeWorld();
  const [x, z] = clearColumn(world);
  const h = world.heightAt(x, z);
  clearWorkspace(world, x, z, h);

  const body = new PlayerBody({ x: x + 0.5, y: h + 2, z: z + 0.5, pitch: STRAIGHT_DOWN });
  const hotbar = new Hotbar(9, [{ id: Block.STONE, count: 10 }]);
  const controller = new InteractionController({ world, player: body, hotbar });

  body.setLook(0, Math.PI / 2); // straight up: nothing in reach
  controller.update(STEP);
  check('nothing in reach is rejected', placeReason(controller.tryPlace()) === 'no-target');

  body.setLook(0, STRAIGHT_DOWN);
  controller.update(STEP);
  const onGround = controller.tryPlace();
  check(
    'placing on the face below works',
    onGround.ok && onGround.position[0] === x && onGround.position[1] === h + 1 && onGround.position[2] === z && onGround.id === Block.STONE,
    JSON.stringify(onGround),
  );
  check('placing consumed one item', hotbar.slots[0]?.count === 9, String(hotbar.slots[0]?.count));
  check('the block is in the world', world.getBlock(x, h + 1, z) === Block.STONE);
  check('placing into an occupied voxel is rejected', placeReason(controller.tryPlace()) === 'occupied');

  // a block that would land inside the player is refused
  world.setBlock(x + 1, h + 1, z, Block.STONE);
  world.setBlock(x + 1, h + 2, z, Block.STONE);
  body.setPosition(x + 0.5, h + 1, z + 0.5); // stand on the floor
  body.setLook(-Math.PI / 2, 0); // look at the wall: the candidate is our own head voxel
  controller.update(STEP);
  const intoSelf = controller.tryPlace();
  check('a block landing inside the player box is rejected', placeReason(intoSelf) === 'player-box', JSON.stringify(intoSelf));
  check('nothing was written for the rejected place', world.getBlock(x, h + 2, z) === Block.AIR);

  // hovering above the same spot: the face is free again
  world.setBlock(x, h + 1, z, Block.AIR);
  body.setPosition(x + 0.5, h + 4, z + 0.5);
  body.setLook(0, STRAIGHT_DOWN);
  controller.update(STEP);
  const hovered = controller.tryPlace();
  check('hovering above places cleanly', hovered.ok && hovered.position[1] === h + 1, JSON.stringify(hovered));
  check('hovering place consumed an item', hotbar.slots[0]?.count === 8, String(hotbar.slots[0]?.count));

  // empty hand
  world.setBlock(x, h + 1, z, Block.AIR);
  hotbar.select(7);
  controller.update(STEP);
  check('an empty slot cannot place', placeReason(controller.tryPlace()) === 'empty-hand');

  // the ray starting inside a block has no face to build on
  hotbar.select(0);
  world.setBlock(x, h + 5, z, Block.STONE);
  body.setPosition(x + 0.5, h + 5.05 - 1.62, z + 0.5); // eye inside the stone voxel
  controller.update(STEP);
  check('a ray starting inside a block cannot build', placeReason(controller.tryPlace()) === 'inside-block');
  world.setBlock(x, h + 5, z, Block.AIR);

  // above the world ceiling
  world.setBlock(x, CHUNK_HEIGHT - 1, z, Block.STONE);
  body.setPosition(x + 0.5, CHUNK_HEIGHT + 0.5 - 1.62, z + 0.5);
  body.setLook(0, STRAIGHT_DOWN);
  controller.update(STEP);
  const above = controller.tryPlace();
  check('placing above the world is refused', placeReason(above) === 'out-of-world', JSON.stringify(above));

  check(
    'reject counters are tallied',
    controller.rejects['player-box'] === 1 && (controller.rejects['occupied'] ?? 0) >= 1 && controller.rejects['no-target'] === 1,
    JSON.stringify(controller.rejects),
  );
  world.dispose();
}

// -------------------------------------------------------------- save / load --
section('autosave / load round trip');
{
  const storage = new MemoryStorage();
  const KEY = 'test:world';
  const worldA = makeWorld();
  const [x, z] = clearColumn(worldA);
  const h = worldA.heightAt(x, z);
  clearWorkspace(worldA, x, z, h);

  const bodyA = new PlayerBody({ x: x + 0.5, y: h + 1, z: z + 0.5, yaw: 0.25, pitch: STRAIGHT_DOWN });
  const hotbarA = new Hotbar(9, [{ id: Block.STONE, count: 5 }], 0);
  const sessionA = new InteractionSession({
    world: worldA,
    player: bodyA,
    hotbar: hotbarA,
    seed: SEED,
    storage,
    storageKey: KEY,
    autosaveMs: 1000,
    hud: false,
    highlight: false,
  });

  check('nothing to restore on a fresh world', sessionA.loaded === null && !sessionA.playerRestored);
  check('no save file yet', storage.getItem(KEY) === null);

  sessionA.controller.beginDig();
  let frames = 0;
  while (worldA.getBlock(x, h, z) !== Block.AIR && frames < 600) {
    sessionA.update(STEP);
    frames++;
  }
  check('the session digs through the crosshair', worldA.getBlock(x, h, z) === Block.AIR, String(frames) + ' frames');
  check('the session recorded one edit', sessionA.edits.size === 1 && sessionA.edits.entries()[0].id === Block.AIR);
  sessionA.controller.endDig(); // stop holding the button, or the hole keeps growing
  sessionA.controller.update(STEP);
  check('releasing the button does not dig further', sessionA.edits.size === 1);

  check('saveNow works and resets the timer', sessionA.saveNow(false) && sessionA.autosaveElapsed === 0);
  const savesBefore = sessionA.store.saveCount;
  sessionA.update(0.5);
  check('autosave waits for the interval', sessionA.store.saveCount === savesBefore && sessionA.autosaveElapsed > 0.4, sessionA.autosaveElapsed.toFixed(2));
  sessionA.update(0.6);
  check('autosave fires after the interval', sessionA.store.saveCount === savesBefore + 1 && sessionA.autosaveElapsed < 0.2, sessionA.autosaveElapsed.toFixed(2));
  check('default autosave interval is 10 s', new InteractionSession({ world: worldA, player: bodyA, seed: SEED, storage, storageKey: 'other', hud: false, highlight: false }).autosaveMs === 10_000);

  const payload = JSON.parse(storage.getItem(KEY) as string);
  check(
    'save file has the documented shape',
    payload.version === SAVE_VERSION &&
      payload.seed === SEED &&
      Array.isArray(payload.edits) &&
      payload.edits.length === 1 &&
      !!payload.player &&
      Array.isArray(payload.hotbar.slots),
    JSON.stringify({
      version: payload.version,
      seed: payload.seed,
      player: !!payload.player,
      edits: payload.edits?.length,
      slots: payload.hotbar?.slots?.length,
      keys: Object.keys(payload).join(','),
    }),
  );
  check(
    'player position and look are saved',
    Math.abs(payload.player.x - (x + 0.5)) < 1e-9 &&
      Math.abs(payload.player.y - (h + 1)) < 1e-9 &&
      Math.abs(payload.player.yaw - 0.25) < 1e-9,
    JSON.stringify(payload.player),
  );
  check('hotbar is saved', payload.hotbar.slots[0].id === Block.STONE && payload.hotbar.slots[0].count === 5);
  console.log('  ..   save payload: ' + JSON.stringify(payload).slice(0, 200) + '…');

  // ---- reload: fresh world, same storage (like a page refresh) -------------
  const worldB = makeWorld();
  const bodyB = new PlayerBody();
  const sessionB = new InteractionSession({
    world: worldB,
    player: bodyB,
    seed: SEED,
    storage,
    storageKey: KEY,
    hud: false,
    highlight: false,
  });
  check('save is restored', sessionB.loaded !== null && sessionB.playerRestored);
  check(
    'player is back where they left',
    Math.abs(bodyB.feet.x - bodyA.feet.x) < 1e-9 && Math.abs(bodyB.feet.y - bodyA.feet.y) < 1e-9 && Math.abs(bodyB.feet.z - bodyA.feet.z) < 1e-9,
    JSON.stringify(bodyB.feet.toArray()),
  );
  check('look direction is restored', Math.abs(bodyB.yaw - 0.25) < 1e-6 && Math.abs(bodyB.pitch - clampPitch(STRAIGHT_DOWN)) < 1e-9);
  check('hotbar is restored', sessionB.hotbar.countOf(Block.STONE) === 5 && sessionB.hotbar.slots[0]?.id === Block.STONE);
  check('edits are restored', sessionB.edits.size === 1);

  worldB.getBlock(x, h, z); // stream that chunk in
  sessionB.update(STEP);
  check('the dug hole is back after reload', worldB.getBlock(x, h, z) === Block.AIR);
  check('the apply pass reported the write', sessionB.editsApplied === 1, String(sessionB.editsApplied));

  // ---- dig then place in the same spot: the diff keeps the final state -----
  bodyB.setPosition(x + 0.5, h + 3, z + 0.5); // eye h+4.62: the floor one block down is in reach
  bodyB.setLook(0, STRAIGHT_DOWN);
  sessionB.hotbar.select(0);
  sessionB.update(STEP);
  const placed = sessionB.tryPlace();
  check('placing back into the hole works', placed.ok && worldB.getBlock(x, h, z) === Block.STONE, JSON.stringify(placed));
  check(
    'the diff holds the final value only',
    sessionB.edits.size === 1 && sessionB.edits.entries()[0].id === Block.STONE,
    JSON.stringify(sessionB.edits.entries()),
  );
  check('saveNow works', sessionB.saveNow(false) && sessionB.autosaveElapsed === 0);

  // ---- second reload ------------------------------------------------------
  const worldC = makeWorld();
  const bodyC = new PlayerBody();
  const spawnC = bodyC.saveState();
  const sessionC = new InteractionSession({
    world: worldC,
    player: bodyC,
    seed: SEED,
    storage,
    storageKey: KEY,
    hud: false,
    highlight: false,
  });
  worldC.getBlock(x, h, z);
  sessionC.update(STEP);
  check('the placed block survives the second reload', worldC.getBlock(x, h, z) === Block.STONE, String(worldC.getBlock(x, h, z)));

  // ---- reset world --------------------------------------------------------
  const pristineTop = generatedAt(x, h, z);
  sessionC.resetWorld();
  check('terrain is regenerated on reset', worldC.getBlock(x, h, z) === pristineTop, `${worldC.getBlock(x, h, z)} vs ${pristineTop}`);
  check('diff is emptied on reset', sessionC.edits.size === 0);
  check('storage is cleared on reset', storage.getItem(KEY) === null);
  check('hotbar is back to starter items', sessionC.hotbar.slots[0]?.id === Block.GRASS && sessionC.hotbar.countOf(Block.GRASS) === MAX_STACK);
  check(
    'player is back on the spawn captured at construction',
    Math.abs(bodyC.feet.x - spawnC.x) < 1e-9 && Math.abs(bodyC.feet.y - spawnC.y) < 1e-9 && Math.abs(bodyC.feet.z - spawnC.z) < 1e-9,
    JSON.stringify(bodyC.feet.toArray()),
  );
  check('saving works again after reset', sessionC.saveNow(false) && storage.getItem(KEY) !== null);

  worldA.dispose();
  worldB.dispose();
  worldC.dispose();
}

// ------------------------------------------------------------- save format ---
section('save file validation');
{
  const good = {
    version: SAVE_VERSION,
    seed: 7,
    savedAt: 1,
    player: { x: 1, y: 2, z: 3 },
    hotbar: { selected: 1, slots: [] },
    edits: [{ x: 1, y: 2, z: 3, id: Block.STONE }],
  };
  check('a well formed document is accepted', normalizeSaveData(good) !== null);
  check('another version is rejected', normalizeSaveData({ ...good, version: 2 }) === null);
  check('a document without a version is rejected', normalizeSaveData({ seed: 7 }) === null);
  check('broken player data is dropped, the rest survives', (normalizeSaveData({ ...good, player: { x: 'nope' } })?.player ?? null) === null);
  check('out of range block ids are filtered', normalizeSaveData({ ...good, edits: [{ x: 1, y: 2, z: 3, id: 99 }] })?.edits.length === 0);
  check(
    'a voxel dug out to air survives normalisation',
    normalizeSaveData({ ...good, edits: [{ x: 1, y: 2, z: 3, id: Block.AIR }] })?.edits.length === 1,
  );
  check('garbage is rejected', normalizeSaveData('nope') === null && normalizeSaveData(null) === null);

  const corruptStorage = new MemoryStorage();
  corruptStorage.setItem('k', '{not json');
  const corruptWorld = makeWorld();
  const corruptSession = new InteractionSession({
    world: corruptWorld,
    player: new PlayerBody(),
    seed: SEED,
    storage: corruptStorage,
    storageKey: 'k',
    hud: false,
    highlight: false,
  });
  check('corrupt storage is ignored, not thrown', corruptSession.loaded === null && corruptSession.store.lastError !== '', corruptSession.store.lastError);

  const otherSeedStorage = new MemoryStorage();
  otherSeedStorage.setItem(
    'k2',
    JSON.stringify({ version: SAVE_VERSION, seed: 4242, savedAt: 0, player: { x: 1, y: 2, z: 3 }, hotbar: { selected: 0, slots: [] }, edits: [] }),
  );
  const otherSeedWorld = makeWorld();
  const otherSeedSession = new InteractionSession({
    world: otherSeedWorld,
    player: new PlayerBody(),
    seed: 99,
    storage: otherSeedStorage,
    storageKey: 'k2',
    hud: false,
    highlight: false,
  });
  check('a save from another seed is not restored', otherSeedSession.loaded === null && !otherSeedSession.playerRestored);

  corruptWorld.dispose();
  otherSeedWorld.dispose();
}

// --------------------------------------- integration with the physics player --
section('wiring to the real physics player (src/player)');
{
  const world = makeWorld();
  const [x, z] = clearColumn(world);
  const h = world.heightAt(x, z);
  clearWorkspace(world, x, z, h);

  // minimal DOM stub, same trick the player smoke test uses
  const ownerDocument = {
    pointerLockElement: null as unknown,
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  const element = {
    ownerDocument,
    addEventListener(): void {},
    removeEventListener(): void {},
    requestPointerLock(): void {},
  } as unknown as HTMLElement;

  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  const player = new FirstPersonPlayer({
    world,
    camera,
    element,
    keyTarget: element as unknown as never,
    position: [x + 0.5, h + 3, z + 0.5],
    yaw: 0,
  });

  const adapter = createFirstPersonPlayerAdapter(player);
  const eye = adapter.getEye(new THREE.Vector3());
  check(
    'adapter puts the eye 1.62 above the player feet',
    Math.abs(eye.y - (player.position.y + 1.62)) < 1e-9,
    `eye ${eye.y} vs feet ${player.position.y}`,
  );
  const box = adapter.getBox(createAABB());
  check(
    'adapter collision box matches the player body',
    Math.abs(box.minX - player.position.x + 0.3) < 1e-9 && Math.abs(box.maxY - (player.position.y + 1.8)) < 1e-9,
    JSON.stringify(box),
  );

  const hotbar = new Hotbar(9, [{ id: Block.STONE, count: 10 }]);
  const controller = new InteractionController({ world, player: adapter, hotbar });
  player.setLook(0, STRAIGHT_DOWN);
  controller.update(STEP);
  check('looking down through the adapter hits the floor', controller.target?.position.join(',') === `${x},${h},${z}`, JSON.stringify(controller.target?.position ?? null));

  controller.beginDig();
  let frames = 0;
  while (controller.digsCompleted === 0 && frames < 600) {
    controller.update(STEP);
    frames++;
  }
  controller.endDig();
  check('digging through the real player works', world.getBlock(x, h, z) === Block.AIR && hotbar.countOf(Block.GRASS) === 1, String(frames));

  const state = adapter.saveState();
  check(
    'adapter saves the player feet and look',
    state.y === player.position.y && state.yaw === 0 && state.x === player.position.x,
    JSON.stringify(state),
  );
  adapter.loadState({ x: x + 4.5, y: h + 6, z: z + 0.5, yaw: 1.25, pitch: -0.5 });
  check(
    'adapter loadState moves the real player',
    player.position.x === x + 4.5 && player.position.y === h + 6 && Math.abs(player.yaw - 1.25) < 1e-9 && Math.abs(player.pitch + 0.5) < 1e-9,
    JSON.stringify([player.position.toArray(), player.yaw, player.pitch]),
  );

  player.dispose();
  world.dispose();
}

// ------------------------------------------------------------------ report ---
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const f of failures) console.log('  - ' + f);
  throw new Error(`${failures.length} interaction smoke test failure(s)`);
}
