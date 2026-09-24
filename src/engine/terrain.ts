import { Block } from './blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z } from './chunk';
import { fbm2, hash01, SimplexNoise } from './noise';

/** Water fills every air block at or below this y. */
export const SEA_LEVEL = 26;
/** Chance that a grass column spawns a tree. */
const TREE_CHANCE = 0.008;
/** How far trees may reach into a neighbouring chunk. */
export const TREE_MARGIN = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Deterministic terrain: the same seed and the same world coordinates always
 * produce the same blocks, independent of chunk load order.
 */
export class TerrainGenerator {
  readonly seed: number;
  private readonly noise: SimplexNoise;

  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    this.noise = new SimplexNoise(seedRng(this.seed));
  }

  /** Surface height (the y of the topmost solid block) at world x,z. */
  heightAt(x: number, z: number): number {
    const cont = fbm2(this.noise, x * 0.0045, z * 0.0045, 4, 2, 0.5);
    const hills = fbm2(this.noise, x * 0.021 + 31.7, z * 0.021 - 17.3, 3, 2, 0.5);
    const ridge = 1 - Math.abs(fbm2(this.noise, x * 0.009 - 91.2, z * 0.009 + 55.5, 2, 2, 0.5));
    const h = SEA_LEVEL + 3 + cont * 11 + hills * 5 + ridge * 3.5;
    return clamp(Math.round(h), 4, CHUNK_HEIGHT - 18);
  }

  /** True when a tree trunk starts at this world column. */
  isTreeAt(x: number, z: number): boolean {
    if (hash01(x, z, this.seed ^ 0x9e3779b9) >= TREE_CHANCE) return false;
    return this.heightAt(x, z) > SEA_LEVEL + 1;
  }

  private treeHeight(x: number, z: number): number {
    return 4 + Math.floor(hash01(x, z, this.seed ^ 0x85ebca6b) * 3);
  }

  /**
   * Fills a whole chunk. Trees of neighbouring columns are stamped in too, so
   * a canopy crossing a chunk border is the same from both sides.
   */
  generate(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_SIZE_X * CHUNK_SIZE_Z * CHUNK_HEIGHT);
    const originX = cx * CHUNK_SIZE_X;
    const originZ = cz * CHUNK_SIZE_Z;

    const set = (x: number, y: number, z: number, id: number): void => {
      if (x < 0 || x >= CHUNK_SIZE_X || z < 0 || z >= CHUNK_SIZE_Z || y < 0 || y >= CHUNK_HEIGHT) {
        return;
      }
      data[(y * CHUNK_SIZE_Z + z) * CHUNK_SIZE_X + x] = id;
    };

    for (let x = 0; x < CHUNK_SIZE_X; x++) {
      for (let z = 0; z < CHUNK_SIZE_Z; z++) {
        const wx = originX + x;
        const wz = originZ + z;
        const h = this.heightAt(wx, wz);
        const beach = h <= SEA_LEVEL + 1;
        const top = beach ? Block.SAND : Block.GRASS;
        const sub = beach ? Block.SAND : Block.DIRT;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) id = Block.STONE;
          else if (y >= h - 3) id = y === h ? top : sub;
          else id = Block.STONE;
          set(x, y, z, id);
        }
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          set(x, y, z, Block.WATER);
        }
      }
    }

    // trees (including the ones rooted in the neighbour margin)
    const get = (x: number, y: number, z: number): number => {
      if (x < 0 || x >= CHUNK_SIZE_X || z < 0 || z >= CHUNK_SIZE_Z || y < 0 || y >= CHUNK_HEIGHT) {
        return Block.AIR;
      }
      return data[(y * CHUNK_SIZE_Z + z) * CHUNK_SIZE_X + x];
    };

    for (let wx = originX - TREE_MARGIN; wx < originX + CHUNK_SIZE_X + TREE_MARGIN; wx++) {
      for (let wz = originZ - TREE_MARGIN; wz < originZ + CHUNK_SIZE_Z + TREE_MARGIN; wz++) {
        if (!this.isTreeAt(wx, wz)) continue;
        this.stampTree(set, get, wx, wz, originX, originZ);
      }
    }

    return data;
  }

  private stampTree(
    set: (x: number, y: number, z: number, id: number) => void,
    get: (x: number, y: number, z: number) => number,
    wx: number,
    wz: number,
    originX: number,
    originZ: number,
  ): void {
    const h = this.heightAt(wx, wz);
    const trunk = this.treeHeight(wx, wz);
    const lx = wx - originX;
    const lz = wz - originZ;
    const topY = h + trunk;

    for (let i = 1; i <= trunk; i++) {
      set(lx, h + i, lz, Block.WOOD);
    }

    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy;
      const radius = dy >= 0 ? 1 : 2;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
          if (dy === 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
          const tx = lx + dx;
          const tz = lz + dz;
          if (tx < 0 || tx >= CHUNK_SIZE_X || tz < 0 || tz >= CHUNK_SIZE_Z) continue;
          if (y < 0 || y >= CHUNK_HEIGHT) continue;
          if (get(tx, y, tz) === Block.WOOD) continue;
          set(tx, y, tz, Block.LEAVES);
        }
      }
    }
  }
}

function seedRng(seed: number): () => number {
  // small local PRNG so the noise permutation table is a pure function of the seed
  let a = (seed ^ 0x2545f491) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
