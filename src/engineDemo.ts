/**
 * Engine demo page (engine.html): the voxel world with the built-in spectator
 * camera and a HUD. This is the page the engine acceptance test
 * (tests/browser.test.mjs) drives, because it exposes the raw engine surface
 * (`window.__VOXEL`) without gameplay on top of it.
 *
 * The playable game is src/main.ts / index.html.
 */
import * as THREE from 'three';
import { Block, type BlockId } from './engine/blocks';
import { createGame, type Game } from './engine/game';
import { isSolid } from './engine/blocks';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#game canvas missing');

const hud = document.getElementById('hud') as HTMLDivElement;
const help = document.getElementById('help') as HTMLDivElement;

const game: Game = createGame(canvas, {
  seed: 20260924,
  renderDistance: 6,
  maxChunkOpsPerFrame: 2,
});

// ---------------------------------------------------------------- HUD -------
let hudTimer = 0;
game.onFrame((dt) => {
  hudTimer += dt;
  if (hudTimer < 0.25) return;
  hudTimer = 0;
  const stats = game.stats();
  const world = stats.world;
  const p = game.camera.position;
  hud.textContent = [
    `fps ${stats.fps.toFixed(0)}  (${stats.frameMs.toFixed(1)} ms)`,
    `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`,
    `chunks ${world.meshed}/${world.chunks}  pending ${world.pending}`,
    `draws ${stats.drawCalls}  tris ${stats.triangles}`,
    `speed ${game.controls ? game.controls.speed.toFixed(0) : '-'} b/s`,
  ].join('\n');
});

help.textContent =
  'drag = look  |  WASD = move  |  Space/Shift = up/down  |  wheel = speed  |  click = block info';

// -------------------------------------------------- debug / test surface ----
/**
 * Small surface used by the automated browser test (tests/browser.test.mjs) and
 * by anyone poking at the page from the console. It is not part of the engine API.
 */
const debug = {
  game,
  world: game.world,
  camera: game.camera,
  renderer: game.renderer,
  scene: game.scene,
  THREE,
  stats: () => game.stats(),
  teleport(x: number, y: number, z: number): void {
    game.camera.position.set(x, y, z);
  },
  placeLayer(y: number, id: BlockId, radius = 4): number {
    const cx = Math.floor(game.camera.position.x);
    const cz = Math.floor(game.camera.position.z);
    let n = 0;
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        game.world.setBlock(x, y, z, id);
        n++;
      }
    }
    return n;
  },
  getBlock: (x: number, y: number, z: number) => game.world.getBlock(x, y, z),
  setBlock: (x: number, y: number, z: number, id: BlockId) => game.world.setBlock(x, y, z, id),
  raycastFromCamera(maxDist = 5) {
    const dir = new THREE.Vector3();
    game.camera.getWorldDirection(dir);
    return game.world.raycast(game.camera.position, dir, maxDist);
  },
  Block,
  isSolid,
};

declare global {
  interface Window {
    __VOXEL: typeof debug;
  }
}
window.__VOXEL = debug;
