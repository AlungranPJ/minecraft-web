/**
 * First person player: input + mouse look + physics, driven from the engine's
 * per frame callback.
 *
 *   const game = createGame(canvas, { controls: 'none' });
 *   const player = new FirstPersonPlayer({ world: game.world, camera: game.camera, element: canvas });
 *   player.mount(game);                     // runs the step inside game.onFrame
 *   player.onUpdate((dt, state) => hud(state));
 *
 * Position/velocity are the feet of the player box: the camera sits `eyeHeight`
 * above them. `player.state` is a single live object that is rewritten every
 * frame (no allocation in the loop) and is what `onUpdate` listeners receive.
 */
import * as THREE from 'three';
import type { Game } from '../engine/game';
import { KeyboardInput, type KeyEventTarget, type Keymap } from './input';
import { MouseLook, type LookOptions } from './look';
import {
  PLAYER_DEFAULTS,
  PlayerPhysics,
  type PhysicsOptions,
  type PhysicsState,
  type SurfaceSource,
} from './physics';

export interface PlayerOptions {
  /** The engine world (anything with `getBlock(x,y,z)` works). */
  world: SurfaceSource;
  /** The camera the player drives. */
  camera: THREE.PerspectiveCamera;
  /** Element used for mouse look / pointer lock. Omit for a headless player. */
  element?: HTMLElement | null;
  /** Where key events are listened on. Defaults to `window` in a browser, else the element. */
  keyTarget?: KeyEventTarget;
  /** Feet position. Default: on the surface at `spawnX`/`spawnZ`. */
  position?: [number, number, number];
  /** Spawn column used when `position` is omitted. Default 0, 0. */
  spawnX?: number;
  spawnZ?: number;
  /** Eye height above the feet. Default 1.62. */
  eyeHeight?: number;
  /** Initial yaw (radians). Default 0. */
  yaw?: number;
  /** Initial pitch (radians). Default 0. */
  pitch?: number;
  keymap?: Partial<Keymap>;
  physics?: PhysicsOptions;
  look?: LookOptions;
}

export interface PlayerState extends PhysicsState {
  /** Camera (eye) position on y. */
  eyeY: number;
  yaw: number;
  pitch: number;
  /** Pointer lock active (mouse look through movement deltas). */
  locked: boolean;
}

export type PlayerUpdateListener = (dt: number, state: PlayerState) => void;

export class FirstPersonPlayer {
  readonly camera: THREE.PerspectiveCamera;
  readonly physics: PlayerPhysics;
  readonly input: KeyboardInput;
  readonly look: MouseLook;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  eyeHeight: number;

  /** Live state object, rewritten every update (copy the fields if you keep it). */
  readonly state: PlayerState = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    onGround: false,
    sprinting: false,
    flying: false,
    eyeY: 0,
    yaw: 0,
    pitch: 0,
    locked: false,
  };

  private readonly listeners: PlayerUpdateListener[] = [];
  private readonly keyTarget: KeyEventTarget | null;
  private disposed = false;

  constructor(options: PlayerOptions) {
    this.camera = options.camera;
    this.eyeHeight = options.eyeHeight ?? PLAYER_DEFAULTS.eyeHeight;
    this.physics = new PlayerPhysics(options.world, options.physics);

    const element = options.element ?? null;
    this.keyTarget =
      options.keyTarget ??
      ((typeof window !== 'undefined' ? window : element) as unknown as KeyEventTarget | null);
    if (!this.keyTarget) throw new Error('FirstPersonPlayer: needs an element or a keyTarget for keyboard input');

    this.input = new KeyboardInput(this.keyTarget, options.keymap);
    this.look = new MouseLook(element, {
      yaw: options.yaw,
      pitch: options.pitch,
      ...options.look,
    });

    if (options.position) {
      const [x, y, z] = options.position;
      this.physics.teleport(x, y, z);
      this.physics.spawnX = x;
      this.physics.spawnY = y;
      this.physics.spawnZ = z;
    } else {
      this.physics.spawnOnSurface(options.spawnX ?? 0.5, options.spawnZ ?? 0.5);
    }
    this.physics.settle();

    this.sync();
    this.applyCamera();
  }

  get yaw(): number {
    return this.look.yaw;
  }

  get pitch(): number {
    return this.look.pitch;
  }

  get onGround(): boolean {
    return this.physics.onGround;
  }

  /** True while the player box is inside a solid block. */
  get isStuck(): boolean {
    return this.physics.isStuck;
  }

  /** Registers a per-step listener (HUD, camera shake, netcode...). Returns an unsubscribe. */
  onUpdate(listener: PlayerUpdateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Runs inside the engine's frame callback, so it happens before streaming and the draw. */
  mount(game: Game): () => void {
    return game.onFrame((dt) => this.update(dt));
  }

  /**
   * One frame: read the keys, step the physics, aim and move the camera, then
   * report the fresh state to every listener.
   */
  update(dt: number): void {
    if (this.disposed) return;
    const axes = this.input.axes();
    const sin = Math.sin(this.look.yaw);
    const cos = Math.cos(this.look.yaw);

    // three cameras look down -z, so yaw 0 walks toward -z (same as the engine rig)
    this.physics.step(dt, {
      wishX: -sin * axes.forward + cos * axes.strafe,
      wishZ: -cos * axes.forward - sin * axes.strafe,
      sprint: this.input.isDown('sprint'),
      jump: this.input.isDown('jump'),
    });

    this.sync();
    this.applyCamera();

    this.physics.readState(this.state);
    this.state.eyeY = this.camera.position.y;
    this.state.yaw = this.look.yaw;
    this.state.pitch = this.look.pitch;
    this.state.locked = this.look.locked;
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](dt, this.state);
  }

  /** Points the camera along yaw/pitch and moves it to eye height. */
  private applyCamera(): void {
    this.look.applyTo(this.camera);
    this.camera.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Sets the feet position (debug / respawn) and clears momentum. */
  teleport(x: number, y: number, z: number): void {
    this.physics.teleport(x, y, z);
    this.sync();
  }

  /** Puts the player on the surface at x,z (world coordinates). */
  spawnOnSurface(x = 0.5, z = 0.5): void {
    this.physics.spawnOnSurface(x, z);
    this.sync();
  }

  setLook(yaw: number, pitch: number): void {
    this.look.setLook(yaw, pitch);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.length = 0;
    this.input.dispose();
    this.look.dispose();
  }

  private sync(): void {
    this.position.set(this.physics.x, this.physics.y, this.physics.z);
    this.velocity.set(this.physics.vx, this.physics.vy, this.physics.vz);
  }
}
