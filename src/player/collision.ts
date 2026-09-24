/**
 * Axis separated AABB collision against voxel blocks.
 *
 * The player is a box (`width` on x and z, centered on the entity position;
 * `height` tall with `y` at the feet). Standing exactly on the ground therefore
 * means `y = topBlockY + 1` and the box touches, but does not overlap, the block
 * below it.
 *
 * Everything here is pure numbers plus one `getBlock(x,y,z)` source, so it runs
 * headless in node tests as well as in the browser against the real `World`.
 */
import { isSolid } from '../engine/blocks';

/** The only thing collision needs from the world: the engine's `World` qualifies. */
export interface BlockSource {
  getBlock(x: number, y: number, z: number): number;
}

export interface PlayerSize {
  /** Full width of the box on x and z. Vanilla player: 0.6. */
  width: number;
  /** Full height of the box. Vanilla player: 1.8. */
  height: number;
}

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  /** The move was stopped from below, i.e. the entity landed on a block. */
  landed: boolean;
  /** A block above stopped an upward move. */
  hitCeiling: boolean;
}

/** A box that merely touches a face must not count as an overlap, so shrink it a hair. */
const SKIN = 1e-4;
/** Upper bound on blocks remembered from one scan (a 0.6x1.8 box can never need this many). */
const MAX_OVERLAP_BLOCKS = 64;
/** Hard cap on substeps per move: a broken frame cannot stall the loop. */
const MAX_SUBSTEPS = 256;

export function createMoveResult(): MoveResult {
  return {
    x: 0,
    y: 0,
    z: 0,
    hitX: false,
    hitY: false,
    hitZ: false,
    landed: false,
    hitCeiling: false,
  };
}

export class PlayerCollider {
  readonly size: PlayerSize;
  /** Longest distance one resolved substep may cover. Must stay below half the box width. */
  maxSubstep: number;

  private readonly source: BlockSource;
  /** xyz triples of the solid blocks found by the last scan. */
  private readonly found = new Int32Array(MAX_OVERLAP_BLOCKS * 3);
  private readonly position = [0, 0, 0];
  private readonly moveResult: MoveResult = createMoveResult();
  private readonly unstickResult = { x: 0, y: 0, z: 0, passes: 0 };

  constructor(source: BlockSource, size: PlayerSize, maxSubstep = 0.1) {
    this.source = source;
    this.size = { width: size.width, height: size.height };
    this.maxSubstep = maxSubstep;
  }

  get halfWidth(): number {
    return this.size.width / 2;
  }

  /** Coordinates of the nth block remembered by the last scan. */
  blockAt(index: number): [number, number, number] {
    return [this.found[index * 3], this.found[index * 3 + 1], this.found[index * 3 + 2]];
  }

  /** Solid blocks overlapping the given box. Returns the count (coordinates land in `blockAt`). */
  scanBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): number {
    const x0 = Math.floor(minX + SKIN);
    const x1 = Math.floor(maxX - SKIN);
    const y0 = Math.floor(minY + SKIN);
    const y1 = Math.floor(maxY - SKIN);
    const z0 = Math.floor(minZ + SKIN);
    const z1 = Math.floor(maxZ - SKIN);
    let count = 0;
    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        for (let bz = z0; bz <= z1; bz++) {
          if (!isSolid(this.source.getBlock(bx, by, bz))) continue;
          if (count < MAX_OVERLAP_BLOCKS) {
            this.found[count * 3] = bx;
            this.found[count * 3 + 1] = by;
            this.found[count * 3 + 2] = bz;
          }
          count++;
        }
      }
    }
    return count;
  }

  /** Solid blocks overlapping the entity box at this position. */
  scanAt(x: number, y: number, z: number): number {
    const half = this.halfWidth;
    return this.scanBox(x - half, y, z - half, x + half, y + this.size.height, z + half);
  }

  /** True when the entity box would overlap a solid block. */
  overlapsAt(x: number, y: number, z: number): boolean {
    return (
      this.scanBox(x - this.halfWidth, y, z - this.halfWidth, x + this.halfWidth, y + this.size.height, z + this.halfWidth) > 0
    );
  }

  /** True when a solid block sits within `distance` below the entity's feet. */
  overlapsBelow(x: number, y: number, z: number, distance: number): boolean {
    if (distance <= 0) return false;
    const half = this.halfWidth;
    return this.scanBox(x - half, y - distance, z - half, x + half, y, z + half) > 0;
  }

  /**
   * Swept move: shifts the box by (dx,dy,dz), resolving x, then y, then z on
   * every substep. Substeps are at most `maxSubstep` blocks long, which is
   * smaller than the box, so the box can never end up on the far side of a one
   * block wall however fast it travels.
   *
   * The resolved position is written into `out` (a fresh object when omitted).
   */
  move(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    out: MoveResult = this.moveResult,
  ): MoveResult {
    const p = this.position;
    p[0] = x;
    p[1] = y;
    p[2] = z;

    let hitX = false;
    let hitY = false;
    let hitZ = false;
    let landed = false;
    let hitCeiling = false;

    const longest = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    let steps = Math.ceil(longest / this.maxSubstep);
    if (!Number.isFinite(steps) || steps < 1) steps = 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;

    let sx = dx / steps;
    let sy = dy / steps;
    let sz = dz / steps;

    for (let i = 0; i < steps; i++) {
      if (sx !== 0 && this.moveAxis(p, 0, sx)) {
        hitX = true;
        sx = 0; // stop pushing into the wall: no re-collide jitter
      }
      if (sy !== 0 && this.moveAxis(p, 1, sy)) {
        hitY = true;
        if (sy < 0) landed = true;
        else hitCeiling = true;
        sy = 0;
      }
      if (sz !== 0 && this.moveAxis(p, 2, sz)) {
        hitZ = true;
        sz = 0;
      }
    }

    out.x = p[0];
    out.y = p[1];
    out.z = p[2];
    out.hitX = hitX;
    out.hitY = hitY;
    out.hitZ = hitZ;
    out.landed = landed;
    out.hitCeiling = hitCeiling;
    return out;
  }

  /**
   * Pushes the box out of any block it is stuck inside (for example after
   * gameplay code placed a block where the player stands). The smallest
   * penetration wins, so the player pops out the nearest face.
   */
  unstick(x: number, y: number, z: number): { x: number; y: number; z: number; passes: number } {
    const p = this.position;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    const half = this.halfWidth;
    let passes = 0;

    for (let pass = 0; pass < 8; pass++) {
      const count = this.scanAt(p[0], p[1], p[2]);
      if (count === 0) break;
      passes++;

      let bestPen = Number.POSITIVE_INFINITY;
      let bestAxis = -1;
      let bestDir = 1;

      for (let i = 0; i < count; i++) {
        const bx = this.found[i * 3];
        const by = this.found[i * 3 + 1];
        const bz = this.found[i * 3 + 2];
        const penX = Math.min(p[0] + half - bx, bx + 1 - (p[0] - half));
        const penY = Math.min(p[1] + this.size.height - by, by + 1 - p[1]);
        const penZ = Math.min(p[2] + half - bz, bz + 1 - (p[2] - half));
        const pen = Math.min(penX, penY, penZ);
        if (pen >= bestPen) continue;

        bestPen = pen;
        if (pen === penX) {
          bestAxis = 0;
          bestDir = p[0] + half - bx <= bx + 1 - (p[0] - half) ? -1 : 1;
        } else if (pen === penY) {
          bestAxis = 1;
          bestDir = p[1] + this.size.height - by <= by + 1 - p[1] ? -1 : 1;
        } else {
          bestAxis = 2;
          bestDir = p[2] + half - bz <= bz + 1 - (p[2] - half) ? -1 : 1;
        }
      }

      if (bestAxis < 0) break;
      p[bestAxis] += bestDir * (bestPen + SKIN);
    }

    this.unstickResult.x = p[0];
    this.unstickResult.y = p[1];
    this.unstickResult.z = p[2];
    this.unstickResult.passes = passes;
    return this.unstickResult;
  }

  /**
   * Moves one axis by `delta` and, when that lands inside a block, snaps the
   * box against the offending face. Returns true when the move was blocked.
   */
  private moveAxis(p: number[], axis: 0 | 1 | 2, delta: number): boolean {
    p[axis] += delta;
    if (this.scanAt(p[0], p[1], p[2]) === 0) return false;

    const count = this.scanAt(p[0], p[1], p[2]);
    let face = delta > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const block = this.found[i * 3 + axis];
      if (delta > 0) face = Math.min(face, block);
      else face = Math.max(face, block + 1);
    }
    if (!Number.isFinite(face)) return false;

    // x/z: the box is centered on the position. y: the position is the feet.
    const above = axis === 1 ? this.size.height : this.halfWidth;
    const below = axis === 1 ? 0 : this.halfWidth;
    p[axis] = delta > 0 ? face - above : face + below;

    // Safety net: a snap into a different block (corner cases) gets pushed out.
    if (this.scanAt(p[0], p[1], p[2]) !== 0) {
      const fixed = this.unstick(p[0], p[1], p[2]);
      p[0] = fixed.x;
      p[1] = fixed.y;
      p[2] = fixed.z;
    }
    return true;
  }
}
