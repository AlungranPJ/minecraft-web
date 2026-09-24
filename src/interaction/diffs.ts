/**
 * Block edit tracking: the save file stores only the *difference* between the
 * player modified world and the pristine terrain for the seed.
 *
 * A write that restores the original terrain value is dropped from the diff, so
 * the map only ever holds real changes and cannot grow while a player digs and
 * refills the same hole.
 */
import { Block, BLOCKS, type BlockId } from '../engine/blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z, Chunk } from '../engine/chunk';
import { TerrainGenerator } from '../engine/terrain';
import { chunkKey, voxelKey, type BlockEdit, type ChunkAwareWorld, type ChunkHandle } from './types';

/** Generated chunk arrays kept around while recording edits (16 KB each). */
const TERRAIN_CACHE_LIMIT = 512;

interface ChunkEdits {
  cx: number;
  cz: number;
  edits: Map<string, BlockEdit>;
}

export class EditTracker {
  readonly seed: number;

  private readonly terrain: TerrainGenerator;
  private readonly byChunk = new Map<string, ChunkEdits>();
  private readonly terrainCache = new Map<string, Uint8Array>();
  /** Chunk instance each chunk's edits were last written into. */
  private readonly appliedTo = new Map<string, ChunkHandle>();

  constructor(seed: number, terrain?: TerrainGenerator) {
    this.seed = seed >>> 0;
    this.terrain = terrain ?? new TerrainGenerator(seed);
  }

  get size(): number {
    let total = 0;
    for (const entry of this.byChunk.values()) total += entry.edits.size;
    return total;
  }

  /** Number of chunks that currently hold at least one edit. */
  get chunkCount(): number {
    return this.byChunk.size;
  }

  /**
   * Records a player write. Pass the value the world holds *after* the write:
   * equal to the generated terrain it is treated as "no change" and dropped.
   * Returns true when the diff set actually changed.
   */
  record(x: number, y: number, z: number, id: BlockId): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const keyX = Math.floor(x);
    const keyY = Math.floor(y);
    const keyZ = Math.floor(z);
    const original = this.originalAt(keyX, keyY, keyZ);
    const vkey = voxelKey(keyX, keyY, keyZ);
    const chunkEntry = this.chunkEntryFor(keyX, keyZ);
    const current = chunkEntry.edits.get(vkey);

    if (id === original) {
      if (!current) return false;
      chunkEntry.edits.delete(vkey);
      if (chunkEntry.edits.size === 0) this.byChunk.delete(chunkKey(chunkEntry.cx, chunkEntry.cz));
      return true;
    }
    if (current && current.id === id) return false;
    chunkEntry.edits.set(vkey, { x: keyX, y: keyY, z: keyZ, id });
    return true;
  }

  /** What the terrain generator produced at this voxel, ignoring all edits. */
  originalAt(x: number, y: number, z: number): BlockId {
    if (y < 0 || y >= CHUNK_HEIGHT) return Block.AIR;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const data = this.terrainChunk(cx, cz);
    return data[Chunk.index(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z)];
  }

  has(x: number, y: number, z: number): boolean {
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const entry = this.byChunk.get(chunkKey(cx, cz));
    return !!entry && entry.edits.has(voxelKey(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  /** Flat list of edits, sorted for a stable save file. */
  entries(): BlockEdit[] {
    const out: BlockEdit[] = [];
    for (const entry of this.byChunk.values()) for (const edit of entry.edits.values()) out.push(edit);
    out.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    return out;
  }

  clear(): void {
    this.byChunk.clear();
    this.appliedTo.clear();
  }

  toJSON(): BlockEdit[] {
    return this.entries();
  }

  /** Rebuilds the tracker from a save file, dropping anything malformed. */
  static fromJSON(data: unknown, seed: number): EditTracker {
    const tracker = new EditTracker(seed);
    if (!Array.isArray(data)) return tracker;
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const edit = raw as Partial<BlockEdit>;
      const x = Math.floor(Number(edit.x));
      const y = Math.floor(Number(edit.y));
      const z = Math.floor(Number(edit.z));
      const id = Math.floor(Number(edit.id));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      // id 0 (AIR) is valid: that is a block the player dug out
      if (!Number.isFinite(id) || id < 0 || id >= BLOCKS.length) continue;
      tracker.record(x, y, z, id);
    }
    return tracker;
  }

  /**
   * Writes every recorded edit into the chunks that are currently loaded.
   *
   * Chunks outside memory are skipped: they are regenerated from the seed when
   * they stream back in, and this pass runs again on the new chunk instance
   * (identity compared, so nothing is written twice).
   *
   * Returns how many voxels were written this call.
   */
  applyToLoadedChunks(world: ChunkAwareWorld): number {
    let written = 0;
    for (const [key, entry] of this.byChunk) {
      const handle = world.getChunk(entry.cx, entry.cz);
      if (!handle) {
        this.appliedTo.delete(key);
        continue;
      }
      if (this.appliedTo.get(key) === handle) continue;
      for (const edit of entry.edits.values()) world.setBlock(edit.x, edit.y, edit.z, edit.id);
      this.appliedTo.set(key, handle);
      written += entry.edits.size;
    }
    return written;
  }

  /**
   * Restores the generated terrain inside the loaded chunks (used by "reset
   * world"), then forgets every edit.
   *
   * Returns how many voxels were put back.
   */
  restoreLoadedChunks(world: ChunkAwareWorld): number {
    let restored = 0;
    for (const entry of this.byChunk.values()) {
      if (!world.getChunk(entry.cx, entry.cz)) continue;
      for (const edit of entry.edits.values()) {
        const original = this.originalAt(edit.x, edit.y, edit.z);
        if (original !== edit.id) {
          world.setBlock(edit.x, edit.y, edit.z, original);
          restored++;
        }
      }
    }
    this.clear();
    return restored;
  }

  private chunkEntryFor(x: number, z: number): ChunkEdits {
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const key = chunkKey(cx, cz);
    let entry = this.byChunk.get(key);
    if (!entry) {
      entry = { cx, cz, edits: new Map<string, BlockEdit>() };
      this.byChunk.set(key, entry);
    }
    return entry;
  }

  private terrainChunk(cx: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cz);
    const cached = this.terrainCache.get(key);
    if (cached) return cached;
    const data = this.terrain.generate(cx, cz);
    if (this.terrainCache.size >= TERRAIN_CACHE_LIMIT) {
      const oldest = this.terrainCache.keys().next();
      if (!oldest.done) this.terrainCache.delete(oldest.value);
    }
    this.terrainCache.set(key, data);
    return data;
  }
}
