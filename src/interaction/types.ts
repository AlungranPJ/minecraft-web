/**
 * Shared types for the dig / place / inventory / HUD layer.
 *
 * The gameplay layer never imports the concrete engine classes: it only needs
 * this small structural surface, which `World` already satisfies. That keeps
 * the interaction modules testable in node with a stub world.
 */
import type * as THREE from 'three';

export type BlockId = number;

/** Same shape as `RaycastHit` in the engine (kept structural on purpose). */
export interface RaycastHit {
  /** Voxel that was hit: integer world coordinates. */
  position: [number, number, number];
  /** Face normal the ray entered through ([0,0,0] when the ray starts inside a block). */
  normal: [number, number, number];
  blockId: BlockId;
  distance: number;
}

export interface VoxelWorld {
  getBlock(x: number, y: number, z: number): BlockId;
  setBlock(x: number, y: number, z: number, id: BlockId): void;
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number): RaycastHit | null;
}

/** A loaded chunk. Only the identity and the origin matter here. */
export interface ChunkHandle {
  cx: number;
  cz: number;
}

/**
 * World surface the save layer needs: it must be able to tell which chunks are
 * currently in memory, so block edits are re-applied when a chunk streams back.
 */
export interface ChunkAwareWorld extends VoxelWorld {
  getChunk(cx: number, cz: number): ChunkHandle | undefined;
  stats?(): { chunks: number; meshed: number; pending: number };
}

/** Axis aligned box in world space. `min*` is inclusive, `max*` exclusive. */
export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface BlockEdit {
  x: number;
  y: number;
  z: number;
  id: BlockId;
}

/** Everything saved per player. Angles are optional: a host may not have them. */
export interface PlayerSaveState {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
}

/**
 * The interaction layer talks to the player through this adapter, so it works
 * with the demo fly rig, a real first person controller, or a stub in tests.
 */
export interface PlayerAdapter {
  /** Ray origin: the eyes. */
  getEye(out: THREE.Vector3): THREE.Vector3;
  /** Normalised look direction. */
  getLook(out: THREE.Vector3): THREE.Vector3;
  /** Player collision box in world space. */
  getBox(out: AABB): AABB;
  /** Snapshot for the save file. */
  saveState(): PlayerSaveState;
  /** Restore from a save file. */
  loadState(state: PlayerSaveState): void;
}

/** Tolerance so standing exactly on a block does not count as overlapping it. */
export const OVERLAP_EPSILON = 1e-3;

export function createAABB(): AABB {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
}

/** Voxel key, e.g. "12,34,-5". Stable and cheap to compare. */
export function voxelKey(x: number, y: number, z: number): string {
  return x + ',' + y + ',' + z;
}

export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

/** Block occupying [bx,bx+1] x [by,by+1] x [bz,bz+1] overlaps the player box? */
export function boxOverlapsBlock(
  box: AABB,
  bx: number,
  by: number,
  bz: number,
  epsilon = OVERLAP_EPSILON,
): boolean {
  return (
    bx + 1 > box.minX + epsilon &&
    bx < box.maxX - epsilon &&
    by + 1 > box.minY + epsilon &&
    by < box.maxY - epsilon &&
    bz + 1 > box.minZ + epsilon &&
    bz < box.maxZ - epsilon
  );
}

/** True when `a` and `b` are the same voxel. */
export function sameVoxel(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function clampIndex(value: number, size: number): number {
  const n = Math.floor(value) % size;
  return n < 0 ? n + size : n;
}
