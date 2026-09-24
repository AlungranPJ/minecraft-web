import type * as THREE from 'three';
import { Block, type BlockId } from './blocks';

/** Chunk footprint in blocks. Part of the public API. */
export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Z = 16;
/** Vertical world height in blocks. y is always in [0, CHUNK_HEIGHT). */
export const CHUNK_HEIGHT = 64;
export const CHUNK_VOLUME = CHUNK_SIZE_X * CHUNK_SIZE_Z * CHUNK_HEIGHT;

/**
 * A 16x16x64 column of blocks stored as one flat Uint8Array.
 * Data only: the mesh lives on the parent World so it can be rebuilt in place.
 */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly data: Uint8Array;
  mesh: THREE.Mesh | null = null;
  /** Queued for a (re)build. */
  needsMesh = false;
  /** Has at least been meshed once. */
  meshed = false;

  constructor(cx: number, cz: number, data?: Uint8Array) {
    this.cx = cx;
    this.cz = cz;
    this.data = data ?? new Uint8Array(CHUNK_VOLUME);
  }

  static index(x: number, y: number, z: number): number {
    return (y * CHUNK_SIZE_Z + z) * CHUNK_SIZE_X + x;
  }

  static key(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  get key(): string {
    return Chunk.key(this.cx, this.cz);
  }

  get originX(): number {
    return this.cx * CHUNK_SIZE_X;
  }

  get originZ(): number {
    return this.cz * CHUNK_SIZE_Z;
  }

  /** Chunk-local read. Out of range reads return air. */
  get(x: number, y: number, z: number): BlockId {
    if (x < 0 || x >= CHUNK_SIZE_X || z < 0 || z >= CHUNK_SIZE_Z || y < 0 || y >= CHUNK_HEIGHT) {
      return Block.AIR;
    }
    return this.data[Chunk.index(x, y, z)];
  }

  /** Chunk-local write. Out of range writes are ignored. */
  set(x: number, y: number, z: number, id: BlockId): void {
    if (x < 0 || x >= CHUNK_SIZE_X || z < 0 || z >= CHUNK_SIZE_Z || y < 0 || y >= CHUNK_HEIGHT) {
      return;
    }
    this.data[Chunk.index(x, y, z)] = id;
  }
}
