import * as THREE from 'three';
import { createBlockAtlas, createTerrainMaterial } from './atlas';
import { SpectatorController } from './cameraRig';
import { World, type WorldStats } from './world';

export interface GameOptions {
  seed?: number;
  /** Chunk radius streamed around the camera. Default 6. */
  renderDistance?: number;
  /** Chunk (re)builds per frame. Default 2. */
  maxChunkOpsPerFrame?: number;
  fov?: number;
  near?: number;
  far?: number;
  /** World position to start at. Default: surface at 0,0. */
  startPosition?: [number, number, number];
  /** Built-in demo camera. 'none' leaves the camera to gameplay code. Default 'spectator'. */
  controls?: 'spectator' | 'none';
  fog?: boolean;
  background?: number;
  maxPixelRatio?: number;
  /** Start the render loop immediately. Default true. */
  autostart?: boolean;
  /** Reuse an existing terrain material (advanced / tests). */
  worldMaterial?: THREE.Material;
}

export interface GameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  world: WorldStats;
}

export interface Game {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  renderer: THREE.WebGLRenderer;
  controls: SpectatorController | null;
  /** Register a per-frame callback. Runs BEFORE chunk streaming and the draw. */
  onFrame(cb: (dt: number) => void): () => void;
  start(): void;
  stop(): void;
  stats(): GameStats;
  dispose(): void;
}

/**
 * Builds a ready to render voxel world on `canvas`.
 *
 * Frame order is: controls -> onFrame callbacks -> world streaming -> render.
 * Gameplay code (player physics, camera control) belongs in onFrame.
 */
export function createGame(canvas: HTMLCanvasElement, opts: GameOptions = {}): Game {
  const renderDistance = Math.max(1, Math.floor(opts.renderDistance ?? 6));
  const maxChunkOpsPerFrame = Math.max(1, Math.floor(opts.maxChunkOpsPerFrame ?? 2));
  const background = new THREE.Color(opts.background ?? 0x9ec9ef);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(background, 1);

  const scene = new THREE.Scene();
  scene.background = background;

  const atlas = createBlockAtlas(opts.seed ?? 1337);
  const material = opts.worldMaterial ?? createTerrainMaterial(atlas);
  const world = new World(scene, {
    seed: opts.seed,
    renderDistance,
    maxChunkOpsPerFrame,
    material,
  });

  const far = opts.far ?? Math.max(160, renderDistance * 16 * 1.8);
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 70, 1, opts.near ?? 0.1, far);
  const spawn = opts.startPosition
    ? new THREE.Vector3(opts.startPosition[0], opts.startPosition[1], opts.startPosition[2])
    : world.spawnPoint(0, 0);
  camera.position.copy(spawn);
  camera.lookAt(spawn.x + 8, spawn.y - 3, spawn.z + 8);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8fa07a, 2.0);
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  sun.position.set(0.6, 1, 0.35);
  scene.add(hemi);
  scene.add(sun);

  if (opts.fog !== false) {
    scene.fog = new THREE.Fog(background.getHex(), far * 0.45, far * 0.95);
  }

  const controls =
    opts.controls === 'none' ? null : new SpectatorController(camera, canvas, { speed: 14 });

  const callbacks: Array<(dt: number) => void> = [];

  let rafId = 0;
  let running = false;
  let lastTime = 0;
  let fpsWindow = 0;
  let fpsFrames = 0;
  let fps = 0;
  let frameMs = 0;

  const resize = (): void => {
    const parent = canvas.parentElement;
    const width = Math.max(1, Math.floor(parent?.clientWidth || canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.floor(parent?.clientHeight || canvas.clientHeight || window.innerHeight));
    renderer.setPixelRatio(Math.min(opts.maxPixelRatio ?? 1.5, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const rawMs = now - lastTime;
    const dt = Math.min(rawMs / 1000 || 0, 0.1);
    lastTime = now;
    frameMs += (rawMs - frameMs) * 0.1;

    controls?.update(dt, camera);
    // index loop instead of callbacks.slice(): no array allocation per frame.
    // A callback that unsubscribes mid-frame can make one later callback miss
    // this frame (the array shifts); it runs again on the next one.
    const count = callbacks.length;
    for (let i = 0; i < count; i++) {
      const cb = callbacks[i];
      if (cb) cb(dt);
    }
    world.update(dt, camera.position);
    renderer.render(scene, camera);

    fpsWindow += dt;
    fpsFrames++;
    if (fpsWindow >= 0.5) {
      fps = fpsFrames / fpsWindow;
      fpsWindow = 0;
      fpsFrames = 0;
    }
  };

  const start = (): void => {
    if (running) return;
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const onFrame = (cb: (dt: number) => void): (() => void) => {
    callbacks.push(cb);
    return () => {
      const index = callbacks.indexOf(cb);
      if (index >= 0) callbacks.splice(index, 1);
    };
  };

  const resizeObserver =
    typeof ResizeObserver !== 'undefined' && canvas.parentElement
      ? new ResizeObserver(() => resize())
      : null;
  resizeObserver?.observe(canvas.parentElement as Element);
  window.addEventListener('resize', resize);
  resize();

  const game: Game = {
    scene,
    camera,
    world,
    renderer,
    controls,
    onFrame,
    start,
    stop,
    stats(): GameStats {
      return {
        fps,
        frameMs,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
        world: world.stats(),
      };
    },
    dispose(): void {
      stop();
      window.removeEventListener('resize', resize);
      resizeObserver?.disconnect();
      controls?.dispose();
      callbacks.length = 0;
      world.dispose();
      material.dispose();
      atlas.texture.dispose();
      renderer.dispose();
    },
  };

  if (opts.autostart !== false) start();
  return game;
}
