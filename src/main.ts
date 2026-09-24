/**
 * The game (index.html): engine + first person player + dig/place/hotbar/HUD +
 * localStorage save, wired into one boot flow.
 *
 *   loading screen  ->  "click to play"  ->  the game
 *
 * Frame order (all inside the engine's `onFrame`, which runs before chunk
 * streaming and the draw — see README "frame order"):
 *
 *   player.update(dt)   physics, camera, mouse look
 *   session.update(dt)  saved edits -> chunks, dig/place, HUD, autosave
 *   adaptive quality    render distance / pixel ratio when the fps sags
 *
 * The engine API (`world.getBlock/setBlock/raycast`, `createGame`) and the
 * player / interaction modules are used as they are: this file only composes
 * them, so each lane keeps its own tests.
 */
import * as THREE from 'three';
import { createBlockAtlas } from './engine/atlas';
import { Block, type BlockId } from './engine/blocks';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './engine/chunk';
import { createGame, type Game } from './engine/game';
import { createFirstPersonPlayerAdapter, InteractionSession } from './interaction';
import { FirstPersonPlayer } from './player';
import { AdaptiveQuality, type QualityLevel } from './perf/adaptive';

const SEED = 20260924;
const SPAWN_X = 0.5;
const SPAWN_Z = 0.5;
const AUTOSAVE_MS = 10_000;
/** Chunks around the spawn that must be meshed before the loading screen goes. */
const READY_RADIUS = 3;
/** Never keep the player on the loading screen longer than this. */
const BOOT_TIMEOUT_MS = 20_000;

const HELP =
  'คลิกจอ = ล็อกเมาส์ · WASD เดิน · Shift วิ่ง · Space กระโดด · ขยับเมาส์ มอง · ' +
  'คลิกซ้ายค้าง ขุด · คลิกขวา วาง · 1-9 / ล้อเมาส์ เลือกช่อง · F3 ข้อมูล · Reset world = เริ่มโลกใหม่';

// ---------------------------------------------------------------- boot DOM --
const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#game canvas missing');

const bootEl = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar');
const bootText = document.getElementById('boot-text');
const playEl = document.getElementById('play');
const hintEl = document.getElementById('hint');

// ------------------------------------------------------------------ world ---
const atlas = createBlockAtlas(SEED);
const game: Game = createGame(canvas, {
  seed: SEED,
  renderDistance: 6,
  maxChunkOpsPerFrame: 2,
  controls: 'none',
});

const player = new FirstPersonPlayer({
  world: game.world,
  camera: game.camera,
  element: canvas,
  spawnX: SPAWN_X,
  spawnZ: SPAWN_Z,
  yaw: 0.6,
  pitch: 0,
});

/** The interaction layer only needs the adapter surface (eye ray + 0.6x1.8 box). */
const adapter = createFirstPersonPlayerAdapter(player, { eyeHeight: player.eyeHeight });

const session = new InteractionSession({
  world: game.world,
  scene: game.scene,
  player: adapter,
  seed: SEED,
  atlasCanvas: atlas.canvas,
  autosaveMs: AUTOSAVE_MS,
  hudOptions: { status: HELP, debug: false },
  highlight: true,
});

// ------------------------------------------------------- adaptive quality ---
const adaptive = new AdaptiveQuality();

function applyQuality(level: QualityLevel): void {
  game.world.renderDistance = level.renderDistance;
  game.world.maxChunkOpsPerFrame = level.chunkOpsPerFrame;
  // three re-sizes the drawing buffer itself when the pixel ratio changes
  game.renderer.setPixelRatio(Math.min(level.pixelRatio, window.devicePixelRatio || 1));
}

applyQuality(adaptive.current);
// the engine's own resize handler runs first and would reset the pixel ratio
window.addEventListener('resize', () => applyQuality(adaptive.current));

// ----------------------------------------------------------- loading screen -
/** Chunk offsets the loading screen waits for, around wherever the player is. */
const readyOffsets: Array<[number, number]> = [];
for (let dz = -READY_RADIUS; dz <= READY_RADIUS; dz++) {
  for (let dx = -READY_RADIUS; dx <= READY_RADIUS; dx++) {
    if (dx * dx + dz * dz <= READY_RADIUS * READY_RADIUS + READY_RADIUS) readyOffsets.push([dx, dz]);
  }
}

/**
 * How much of the world around the player is meshed, 0..1. Uses the player's
 * chunk, not the spawn chunk: a restored save can start anywhere.
 */
function bootProgress(): number {
  const cx = Math.floor(player.position.x / CHUNK_SIZE_X);
  const cz = Math.floor(player.position.z / CHUNK_SIZE_Z);
  let meshed = 0;
  for (const [dx, dz] of readyOffsets) {
    const chunk = game.world.getChunk(cx + dx, cz + dz);
    if (chunk?.meshed) meshed++;
  }
  return meshed / readyOffsets.length;
}

let booted = false;
let loadMs = 0;
const bootStart = performance.now();

function finishBoot(): void {
  if (booted) return;
  booted = true;
  loadMs = performance.now() - bootStart;
  adaptive.resetTimers();
  if (bootEl) bootEl.style.display = 'none';
  if (playEl) playEl.classList.add('shown');
  if (hintEl) hintEl.style.display = '';
  if (session.playerRestored) session.hud?.toast('โหลดโลกที่บันทึกไว้แล้ว');
  window.dispatchEvent(new CustomEvent('game-ready', { detail: { loadMs } }));
}

// ------------------------------------------------------------------- loop ---
let perfTimer = 0;
let perfDt = 0;

game.onFrame((dt) => {
  player.update(dt);
  session.update(dt);

  if (!booted) {
    const progress = bootProgress();
    if (bootBar) bootBar.style.width = (progress * 100).toFixed(1) + '%';
    if (bootText) bootText.textContent = `กำลังสร้างโลก… ${Math.round(progress * 100)}%`;
    if (progress >= 1 || performance.now() - bootStart > BOOT_TIMEOUT_MS) finishBoot();
    return;
  }

  // one fps sample every 0.5 s instead of a stats() object per frame
  perfTimer += dt;
  perfDt += dt;
  if (perfTimer >= 0.5) {
    perfTimer = 0;
    const fps = game.stats().fps;
    if (adaptive.update(perfDt, fps)) applyQuality(adaptive.current);
    perfDt = 0;
  }
});

// ------------------------------------------------------------------ input ---
if (playEl) {
  playEl.addEventListener('click', () => {
    playEl.classList.remove('shown');
    playEl.classList.add('dismissed');
    player.look.requestLock();
  });
}

player.look.onLockChange = (locked) => {
  if (!locked) session.controller.reset();
  if (hintEl) hintEl.style.display = locked ? 'none' : '';
};

canvas.addEventListener('mousedown', (event) => {
  if (event.button === 0) session.controller.beginDig();
  else if (event.button === 2) session.controller.beginPlace();
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 0) session.controller.endDig();
  else if (event.button === 2) session.controller.endPlace();
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    session.handleWheel(event.deltaY);
  },
  { passive: false },
);

// hotbar digits + F3 (the player keymap owns WASD/Space/Shift: no overlap)
window.addEventListener('keydown', (event) => {
  session.handleKeyDown(event);
});

window.addEventListener('blur', () => session.controller.reset());

// ------------------------------------------------------- debug / test API ---
/**
 * Surface for tests and the browser console. The player, the session and the
 * engine are all reachable from here, so an acceptance test can drive the real
 * page instead of a mock.
 */
const debug = {
  seed: SEED,
  game,
  world: game.world,
  scene: game.scene,
  camera: game.camera,
  renderer: game.renderer,
  THREE,
  player,
  session,
  adapter,
  hotbar: session.hotbar,
  edits: session.edits,
  hud: session.hud,
  storageKey: session.store.key,
  adaptive,
  Block,
  get ready(): boolean {
    return booted;
  },
  get loadMs(): number {
    return loadMs;
  },
  get fps(): number {
    return game.stats().fps;
  },
  get renderDistance(): number {
    return game.world.renderDistance;
  },
  get quality(): string {
    return adaptive.current.name;
  },
  get qualityChanges(): Array<{ at: number; from: string; to: string; fps: number }> {
    return adaptive.changes.map((change) => ({ ...change }));
  },
  get playerRestored(): boolean {
    return session.playerRestored;
  },
  get editsCount(): number {
    return session.edits.size;
  },
  bootInfo: () => ({
    ready: booted,
    loadMs: Number(loadMs.toFixed(1)),
    quality: adaptive.current.name,
    renderDistance: game.world.renderDistance,
    pixelRatio: game.renderer.getPixelRatio(),
    restored: session.playerRestored,
  }),
  stats: () => game.stats(),
  aimInfo: () => session.debugInfo(),
  debugText: () => session.formatDebug(),
  getBlock: (x: number, y: number, z: number) => game.world.getBlock(x, y, z),
  setBlock: (x: number, y: number, z: number, id: BlockId) => game.world.setBlock(x, y, z, id),
  surfaceAt: (x: number, z: number) => game.world.heightAt(x, z),
  teleport: (x: number, y: number, z: number) => player.teleport(x, y, z),
  goToSurface: (x: number, z: number) => {
    const point = game.world.spawnPoint(x, z);
    player.teleport(point.x, point.y, point.z);
    return point.toArray() as [number, number, number];
  },
  setLook: (yaw: number, pitch: number) => player.setLook(yaw, pitch),
  /** Points the player's view at the centre of a voxel (tests / console). */
  aimAtBlock: (x: number, y: number, z: number) => {
    const eye = adapter.getEye(new THREE.Vector3());
    const dir = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5).sub(eye).normalize();
    player.setLook(Math.atan2(-dir.x, -dir.z), Math.asin(dir.y));
  },
  target: () => session.controller.target,
  save: () => session.saveNow(false),
  reset: () => session.resetWorld(),
  clearStorage: () => session.store.clear(),
  /** Jumps the quality ladder (perf runs); returns true when it moved. */
  forceQuality: (index: number) => {
    const moved = adaptive.forceLevel(index);
    applyQuality(adaptive.current);
    return moved;
  },
  dig: {
    begin: () => session.controller.beginDig(),
    end: () => session.controller.endDig(),
  },
  place: {
    begin: () => session.controller.beginPlace(),
    end: () => session.controller.endPlace(),
    once: () => session.tryPlace(),
  },
};

declare global {
  interface Window {
    __GAME: typeof debug;
  }
}
window.__GAME = debug;
