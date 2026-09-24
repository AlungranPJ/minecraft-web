/**
 * First person demo page for the player module (`player.html`).
 *
 * The engine's own demo (`index.html` / `src/main.ts`) still runs the spectator
 * camera; this page is the gameplay one: the player physics owns the camera, the
 * mouse is locked to the view, and the HUD reads position/velocity from the
 * per frame callback.
 *
 * It also exposes `window.__PLAYER`, a debug/rig surface used by
 * tests/player.browser.test.mjs to build flat test areas and to record what the
 * player did on every rendered frame.
 */
import * as THREE from 'three';
import { Block, type BlockId } from './engine/blocks';
import { createGame } from './engine/game';
import { FirstPersonPlayer } from './player';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#game canvas missing');

const hud = document.getElementById('hud') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;
const help = document.getElementById('help') as HTMLDivElement;

const game = createGame(canvas, {
  seed: 20260924,
  renderDistance: 6,
  maxChunkOpsPerFrame: 2,
  // the player drives the camera, so the engine must not add its own rig
  controls: 'none',
});

const player = new FirstPersonPlayer({
  world: game.world,
  camera: game.camera,
  element: canvas,
});

player.mount(game);

// ------------------------------------------------------------------- HUD -----

let hudTimer = 0;
player.onUpdate((dt, state) => {
  hudTimer += dt;
  if (hudTimer < 0.2) return;
  hudTimer = 0;
  const stats = game.stats();
  hud.textContent = [
    `fps ${stats.fps.toFixed(0)}  (${stats.frameMs.toFixed(1)} ms)`,
    `feet ${state.x.toFixed(2)} ${state.y.toFixed(2)} ${state.z.toFixed(2)}`,
    `eye  ${state.eyeY.toFixed(2)}   yaw ${state.yaw.toFixed(2)}  pitch ${state.pitch.toFixed(2)}`,
    `vel  ${state.vx.toFixed(2)} ${state.vy.toFixed(2)} ${state.vz.toFixed(2)}  (${state.speed.toFixed(2)} b/s)`,
    `ground ${state.onGround ? 'yes' : 'no '}  sprint ${state.sprinting ? 'yes' : 'no '}  stuck ${player.isStuck ? 'YES' : 'no'}`,
    `chunks ${stats.world.meshed}/${stats.world.chunks}  pending ${stats.world.pending}`,
    `draws ${stats.drawCalls}  tris ${stats.triangles}`,
  ].join('\n');
});

help.textContent = 'WASD = walk  |  Shift = sprint  |  Space = jump  |  mouse = look  |  click = lock  |  ESC = unlock';

const refreshHint = (): void => {
  hint.textContent = player.look.locked ? '' : 'click to play (mouse look)';
  hint.style.display = player.look.locked ? 'none' : 'block';
};
player.look.onLockChange = refreshHint;
refreshHint();

// ---------------------------------------------------- debug / test surface ---

/**
 * Not part of the player API. The browser test uses it to build flat ground and
 * walls, and to record the player state on every rendered frame.
 */
const recorder = {
  active: false,
  frames: 0,
  insideFrames: 0,
  minY: Infinity,
  maxY: -Infinity,
  maxSpeed: 0,
  samples: [] as Array<{ x: number; y: number; z: number; speed: number; onGround: boolean }>,
  reset(): void {
    this.frames = 0;
    this.insideFrames = 0;
    this.minY = Infinity;
    this.maxY = -Infinity;
    this.maxSpeed = 0;
    this.samples = [];
  },
  start(): void {
    this.reset();
    this.active = true;
  },
  stop(): { frames: number; insideFrames: number; minY: number; maxY: number; maxSpeed: number } {
    this.active = false;
    return {
      frames: this.frames,
      insideFrames: this.insideFrames,
      minY: this.minY,
      maxY: this.maxY,
      maxSpeed: this.maxSpeed,
    };
  },
};

player.onUpdate((_dt, state) => {
  if (!recorder.active) return;
  recorder.frames++;
  if (player.isStuck) recorder.insideFrames++;
  recorder.minY = Math.min(recorder.minY, state.y);
  recorder.maxY = Math.max(recorder.maxY, state.y);
  recorder.maxSpeed = Math.max(recorder.maxSpeed, state.speed);
  if (recorder.samples.length < 4000) {
    recorder.samples.push({ x: state.x, y: state.y, z: state.z, speed: state.speed, onGround: state.onGround });
  }
});

const debug = {
  game,
  player,
  world: game.world,
  camera: game.camera,
  renderer: game.renderer,
  scene: game.scene,
  THREE,
  Block,
  stats: () => game.stats(),
  state: () => ({ ...player.state, stuck: player.isStuck, locked: player.look.locked }),

  /** Feet position; the camera ends up `eyeHeight` above it. */
  teleport(x: number, y: number, z: number): void {
    player.teleport(x, y, z);
  },

  /** Teleports and switches gravity off, so the camera stays where it was put. */
  park(x: number, y: number, z: number): void {
    player.teleport(x, y, z);
    player.physics.flying = true;
    player.physics.onGround = false;
  },

  /** Back to normal gravity. */
  land(): void {
    player.physics.flying = false;
  },

  look(yaw: number, pitch: number): void {
    player.setLook(yaw, pitch);
  },

  /** Drives the input without a keyboard (tests, replays). */
  hold(action: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint', down: boolean): void {
    player.input.setAction(action, down);
  },

  releaseAll(): void {
    for (const action of ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const) {
      player.input.setAction(action, false);
    }
  },

  recorder,

  rig: {
    set(x: number, y: number, z: number, id: number): void {
      game.world.setBlock(x, y, z, id);
    },
    /** Clears a box (air) so the test area is free of terrain and trees. */
    clear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
      let n = 0;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            game.world.setBlock(x, y, z, Block.AIR);
            n++;
          }
        }
      }
      return n;
    },
    /** Flat floor of `id` at y, spanning [x-r, x+r] x [z-r, z+r]. */
    platform(x: number, y: number, z: number, r = 10, id: number = Block.STONE): number {
      let n = 0;
      for (let bx = x - r; bx <= x + r; bx++) {
        for (let bz = z - r; bz <= z + r; bz++) {
          game.world.setBlock(bx, y, bz, id);
          n++;
        }
      }
      return n;
    },
    /** Empty space for the player box above a floor at y (feet rest on y + 1). */
    arena(x: number, y: number, z: number, r = 10): void {
      debug.rig.clear(x - r, y + 1, z - r, x + r, y + 6, z + r);
      debug.rig.platform(x, y, z, r, Block.STONE);
    },
    /** Wall in the +x direction of (x, z): blocks at x, `height` tall, spanning z. */
    wallAtX(x: number, y: number, z: number, length = 4, height = 4, id: number = Block.STONE): number {
      let n = 0;
      for (let dz = -length; dz <= length; dz++) {
        for (let dy = 0; dy < height; dy++) {
          game.world.setBlock(x, y + 1 + dy, z + dz, id);
          n++;
        }
      }
      return n;
    },
    block(x: number, y: number, z: number, id: BlockId = Block.STONE): void {
      game.world.setBlock(x, y, z, id);
    },
    getBlock: (x: number, y: number, z: number) => game.world.getBlock(x, y, z),
    /** is the player box overlapping a solid block right now? */
    overlaps: () => player.isStuck,
  },
};

declare global {
  interface Window {
    __PLAYER: typeof debug;
  }
}
window.__PLAYER = debug;
