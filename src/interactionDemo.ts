/**
 * Dig / place / hotbar / HUD / save-load demo page.
 *
 * This is the standalone harness for the interaction layer (its own page so it
 * can be checked without touching the engine demo or the player controller
 * module):
 *
 *   http://localhost:5173/interaction.html     (dev)
 *   http://localhost:4173/interaction.html     (after npm run build)
 *
 * The fly rig here is deliberately minimal (no block collision): the real first
 * person physics is a separate module. Everything the interaction layer needs
 * from a player is the `PlayerAdapter` surface, which this rig implements.
 */
import * as THREE from 'three';
import { createBlockAtlas } from './engine/atlas';
import { Block } from './engine/blocks';
import { createGame } from './engine/game';
import { InteractionSession, PlayerBody, clampPitch } from './interaction';

const SEED = 20260924;
const AUTOSAVE_MS = 10_000;

const HELP =
  'hold LMB = dig  ·  RMB = place  ·  1-9 / wheel = slot  ·  F3 = debug  ·  WASD/Space/C fly  ·  click to lock';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#game canvas missing');
const hint = document.getElementById('hint') as HTMLDivElement | null;

/** Minimal spectator-ish rig: mouse look + fly, feet anchored like the real player. */
class DemoRig extends PlayerBody {
  walkSpeed = 6;
  sprintSpeed = 10;
  liftSpeed = 4.5;

  private readonly keys = new Set<string>();

  constructor() {
    super({ yaw: 0.6, pitch: -0.3 });
  }

  /** Mouse look in radians per pixel. */
  look(dx: number, dy: number, sensitivity = 0.0022): void {
    this.yaw -= dx * sensitivity;
    this.pitch = clampPitch(this.pitch - dy * sensitivity);
  }

  /** Points the body at a world position (used by the browser test + console). */
  lookAt(x: number, y: number, z: number): void {
    const eye = this.getEye(new THREE.Vector3());
    const dir = new THREE.Vector3(x, y, z).sub(eye).normalize();
    this.pitch = clampPitch(Math.asin(dir.y));
    this.yaw = Math.atan2(-dir.x, -dir.z);
  }

  onKeyDown(event: KeyboardEvent): void {
    this.keys.add(event.code);
    if (event.code === 'Space') event.preventDefault();
  }

  onKeyUp(event: KeyboardEvent): void {
    this.keys.delete(event.code);
  }

  clearKeys(): void {
    this.keys.clear();
  }

  releasedAt = 0;

  update(dt: number, camera: THREE.Camera): void {
    const held = (code: string): boolean => this.keys.has(code);
    const forward = (held('KeyW') ? 1 : 0) - (held('KeyS') ? 1 : 0);
    const strafe = (held('KeyD') ? 1 : 0) - (held('KeyA') ? 1 : 0);
    const lift = (held('Space') ? 1 : 0) - (held('KeyC') ? 1 : 0);
    const speed = held('ShiftLeft') || held('ShiftRight') ? this.sprintSpeed : this.walkSpeed;

    if (forward !== 0 || strafe !== 0) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const vx = -sin * forward + cos * strafe;
      const vz = -cos * forward - sin * strafe;
      const len = Math.hypot(vx, vz) || 1;
      this.feet.x += (vx / len) * speed * dt;
      this.feet.z += (vz / len) * speed * dt;
    }
    if (lift !== 0) this.feet.y += lift * this.liftSpeed * dt;

    camera.position.copy(this.getEye(new THREE.Vector3()));
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}

// ------------------------------------------------------------------ boot ----

const atlas = createBlockAtlas(SEED);
const game = createGame(canvas, {
  seed: SEED,
  renderDistance: 6,
  maxChunkOpsPerFrame: 2,
  controls: 'none',
});

const rig = new DemoRig();
const spawn = game.world.spawnPoint(0, 0);
rig.setPosition(spawn.x, spawn.y, spawn.z);

const session = new InteractionSession({
  world: game.world,
  scene: game.scene,
  player: rig,
  seed: SEED,
  atlasCanvas: atlas.canvas,
  autosaveMs: AUTOSAVE_MS,
  hudOptions: { status: HELP, debug: false },
  highlight: true,
});

game.onFrame((dt) => {
  rig.update(dt, game.camera);
  session.update(dt);
});

const restoredNote = session.playerRestored ? '  (loaded save)' : '';
document.getElementById('boot')?.remove();

// ---------------------------------------------------------------- input ----

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (hint) hint.style.display = locked ? 'none' : '';
  if (!locked) session.controller.reset();
});

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas) return;
  rig.look(event.movementX, event.movementY);
});

canvas.addEventListener('mousedown', (event) => {
  if (event.button === 0) session.controller.beginDig();
  else if (event.button === 2) session.controller.beginPlace();
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) session.controller.endDig();
  else if (event.button === 2) session.controller.endPlace();
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    session.handleWheel(event.deltaY);
  },
  { passive: false },
);

window.addEventListener('keydown', (event) => {
  if (session.handleKeyDown(event)) return;
  rig.onKeyDown(event);
});
window.addEventListener('keyup', (event) => rig.onKeyUp(event));
window.addEventListener('blur', () => {
  rig.clearKeys();
  session.controller.reset();
});

// ------------------------------------------------ debug / test surface ------

const debug = {
  seed: SEED,
  game,
  world: game.world,
  scene: game.scene,
  camera: game.camera,
  renderer: game.renderer,
  THREE,
  session,
  rig,
  hotbar: session.hotbar,
  edits: session.edits,
  hud: session.hud,
  storageKey: session.store.key,
  /** Live getters, so console / tests never read a stale snapshot. */
  get playerRestored(): boolean {
    return session.playerRestored;
  },
  get editsCount(): number {
    return session.edits.size;
  },
  get fps(): number {
    return session.debugInfo().fps;
  },
  note: restoredNote,
  sessionModule: 'src/interaction/index.ts',
  stats: () => game.stats(),
  getBlock: (x: number, y: number, z: number) => game.world.getBlock(x, y, z),
  setBlock: (x: number, y: number, z: number, id: number) => game.world.setBlock(x, y, z, id),
  teleport: (x: number, y: number, z: number) => rig.setPosition(x, y, z),
  setLook: (yaw: number, pitch: number) => rig.setLook(yaw, pitch),
  aimAtBlock: (x: number, y: number, z: number) => rig.lookAt(x + 0.5, y + 0.5, z + 0.5),
  surfaceAt: (x: number, z: number) => game.world.heightAt(x, z),
  goToSurface: (x: number, z: number) => {
    const point = game.world.spawnPoint(x, z);
    rig.setPosition(point.x, point.y, point.z);
    return point.toArray() as [number, number, number];
  },
  target: () => session.controller.target,
  aimInfo: () => session.debugInfo(),
  debugText: () => session.formatDebug(),
  save: () => session.saveNow(false),
  reset: () => session.resetWorld(),
  clearStorage: () => session.store.clear(),
  dig: {
    begin: () => session.controller.beginDig(),
    end: () => session.controller.endDig(),
  },
  place: {
    begin: () => session.controller.beginPlace(),
    end: () => session.controller.endPlace(),
    once: () => session.tryPlace(),
  },
  Block,
};

declare global {
  interface Window {
    __VOXEL_INTERACTION: typeof debug;
  }
}
window.__VOXEL_INTERACTION = debug;
