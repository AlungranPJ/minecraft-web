/**
 * Player bodies the interaction layer can drive.
 *
 * `PlayerBody` is a feet-anchored first person body (the shape the interaction
 * and save layers care about: eye ray + 0.6 x 1.8 collision box). The demo rig
 * extends it with input, and a future physics controller can either extend it or
 * implement `PlayerAdapter` directly.
 */
import * as THREE from 'three';
import { createAABB, type AABB, type PlayerAdapter, type PlayerSaveState } from './types';

export interface PlayerBodyOptions {
  /** Feet position. Default (0, 0, 0). */
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  /** Eye height above the feet. Default 1.62 (Minecraft). */
  eyeHeight?: number;
  /** Collision box width. Default 0.6. */
  width?: number;
  /** Collision box height. Default 1.8. */
  height?: number;
}

export const DEFAULT_EYE_HEIGHT = 1.62;
export const DEFAULT_PLAYER_WIDTH = 0.6;
export const DEFAULT_PLAYER_HEIGHT = 1.8;
export const MAX_PITCH = THREE.MathUtils.degToRad(89);

export class PlayerBody implements PlayerAdapter {
  /** Feet (bottom centre of the collision box). */
  readonly feet = new THREE.Vector3();
  yaw: number;
  pitch: number;
  eyeHeight: number;
  width: number;
  height: number;

  constructor(opts: PlayerBodyOptions = {}) {
    this.feet.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    this.yaw = opts.yaw ?? 0;
    this.pitch = clampPitch(opts.pitch ?? 0);
    this.eyeHeight = opts.eyeHeight ?? DEFAULT_EYE_HEIGHT;
    this.width = opts.width ?? DEFAULT_PLAYER_WIDTH;
    this.height = opts.height ?? DEFAULT_PLAYER_HEIGHT;
  }

  setPosition(x: number, y: number, z: number): void {
    this.feet.set(x, y, z);
  }

  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clampPitch(pitch);
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.feet.x, this.feet.y + this.eyeHeight, this.feet.z);
  }

  getLook(out: THREE.Vector3): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch);
  }

  getBox(out: AABB): AABB {
    const half = this.width / 2;
    out.minX = this.feet.x - half;
    out.maxX = this.feet.x + half;
    out.minY = this.feet.y;
    out.maxY = this.feet.y + this.height;
    out.minZ = this.feet.z - half;
    out.maxZ = this.feet.z + half;
    return out;
  }

  saveState(): PlayerSaveState {
    return { x: this.feet.x, y: this.feet.y, z: this.feet.z, yaw: this.yaw, pitch: this.pitch };
  }

  loadState(state: PlayerSaveState): void {
    this.feet.set(state.x, state.y, state.z);
    if (typeof state.yaw === 'number') this.yaw = state.yaw;
    if (typeof state.pitch === 'number') this.pitch = clampPitch(state.pitch);
  }
}

export interface CameraPlayerOptions {
  /** Eye height used to turn the camera height into a feet position. Default 1.62. */
  eyeHeight?: number;
  width?: number;
  height?: number;
}

/**
 * Adapter for hosts whose camera *is* the player (the engine's spectator demo):
 * the feet are derived as `camera.y - eyeHeight`, and `loadState` moves the
 * camera itself.
 */
export function createCameraPlayerAdapter(
  camera: THREE.Camera,
  opts: CameraPlayerOptions = {},
): PlayerAdapter {
  const eyeHeight = opts.eyeHeight ?? DEFAULT_EYE_HEIGHT;
  const width = opts.width ?? DEFAULT_PLAYER_WIDTH;
  const height = opts.height ?? DEFAULT_PLAYER_HEIGHT;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const box = createAABB();

  const readAngles = (): { yaw: number; pitch: number } => {
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return { yaw: euler.y, pitch: euler.x };
  };

  return {
    getEye(out) {
      return out.copy(camera.position);
    },
    getLook(out) {
      camera.getWorldDirection(out);
      return out;
    },
    getBox(out) {
      const feetY = camera.position.y - eyeHeight;
      const half = width / 2;
      out.minX = camera.position.x - half;
      out.maxX = camera.position.x + half;
      out.minY = feetY;
      out.maxY = feetY + height;
      out.minZ = camera.position.z - half;
      out.maxZ = camera.position.z + half;
      box.minX = out.minX;
      box.minY = out.minY;
      box.minZ = out.minZ;
      box.maxX = out.maxX;
      box.maxY = out.maxY;
      box.maxZ = out.maxZ;
      return out;
    },
    saveState() {
      const angles = readAngles();
      return {
        x: camera.position.x,
        y: camera.position.y - eyeHeight,
        z: camera.position.z,
        yaw: angles.yaw,
        pitch: angles.pitch,
      };
    },
    loadState(state) {
      camera.position.set(state.x, state.y + eyeHeight, state.z);
      camera.quaternion.setFromEuler(
        new THREE.Euler(clampPitch(state.pitch ?? 0), state.yaw ?? 0, 0, 'YXZ'),
      );
    },
  };
}

/**
 * Structural shape of the sibling first person module (`src/player`). Only the
 * members the interaction layer needs are named here, so the two lanes never
 * have to import each other.
 */
export interface FirstPersonPlayerLike {
  /** Feet (bottom centre of the collision box). */
  readonly position: { x: number; y: number; z: number; set?: (x: number, y: number, z: number) => void };
  readonly yaw: number;
  readonly pitch: number;
  setLook(yaw: number, pitch: number): void;
  teleport?(x: number, y: number, z: number): void;
}

/**
 * Adapter for the real physics player (`FirstPersonPlayer`): the body already
 * carries feet position + yaw/pitch, so digging and placing use exactly the same
 * geometry the collisions do.
 */
export function createFirstPersonPlayerAdapter(
  player: FirstPersonPlayerLike,
  opts: CameraPlayerOptions = {},
): PlayerAdapter {
  const eyeHeight = opts.eyeHeight ?? DEFAULT_EYE_HEIGHT;
  const width = opts.width ?? DEFAULT_PLAYER_WIDTH;
  const height = opts.height ?? DEFAULT_PLAYER_HEIGHT;

  const moveTo = (x: number, y: number, z: number): void => {
    if (player.teleport) {
      player.teleport(x, y, z);
      return;
    }
    const position = player.position as { x: number; y: number; z: number };
    position.x = x;
    position.y = y;
    position.z = z;
  };

  return {
    getEye(out) {
      return out.set(player.position.x, player.position.y + eyeHeight, player.position.z);
    },
    getLook(out) {
      const cosPitch = Math.cos(player.pitch);
      return out.set(
        -Math.sin(player.yaw) * cosPitch,
        Math.sin(player.pitch),
        -Math.cos(player.yaw) * cosPitch,
      );
    },
    getBox(out) {
      const half = width / 2;
      out.minX = player.position.x - half;
      out.maxX = player.position.x + half;
      out.minY = player.position.y;
      out.maxY = player.position.y + height;
      out.minZ = player.position.z - half;
      out.maxZ = player.position.z + half;
      return out;
    },
    saveState() {
      return {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        yaw: player.yaw,
        pitch: player.pitch,
      };
    },
    loadState(state) {
      moveTo(state.x, state.y, state.z);
      player.setLook(state.yaw ?? player.yaw, clampPitch(state.pitch ?? player.pitch));
    },
  };
}

export function clampPitch(pitch: number): number {
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
}
