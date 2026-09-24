import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z } from './chunk';
import { Block, type BlockId, getBlockDef, isOpaque } from './blocks';
import { tileUV } from './atlas';

export type BlockGetter = (x: number, y: number, z: number) => BlockId;

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** RGBA per vertex: rgb = face shading, a = block alpha (water < 1). */
  colors: Float32Array;
  indices: Uint32Array;
  /** Merged quads actually pushed (one quad = 2 triangles). */
  quadCount: number;
  /** Individual block faces removed by merging. */
  faceCount: number;
}

const DIMS = [CHUNK_SIZE_X, CHUNK_HEIGHT, CHUNK_SIZE_Z];

/**
 * A face is drawn when the block on the other side does not hide it.
 * Water (non opaque, non solid) still hides its own faces but not the stone behind it.
 */
function faceVisible(self: BlockId, other: BlockId): boolean {
  if (self === Block.AIR) return false;
  if (isOpaque(other)) return false;
  if (other === self && !getBlockDef(self).opaque) return false;
  return true;
}

/**
 * Greedy meshing of one 16x16x64 chunk.
 *
 * Faces are merged into the largest possible coplanar rectangle of the same
 * block id and facing, so a flat 16x16 ground area becomes a single quad
 * instead of 256. UVs are the atlas rect of the tile: because a quad may span
 * many blocks, the texture is stretched over it, so tiles are painted with
 * nearest filtering (every texel lands on roughly one block).
 *
 * `getBlock` is world space and is allowed to read outside the chunk (the
 * caller supplies neighbour data) so the border faces get culled too.
 *
 * Returns null when the chunk has no visible face at all.
 */
export function buildChunkMeshData(
  baseX: number,
  baseZ: number,
  getBlock: BlockGetter,
): MeshBuffers | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const mask = new Int32Array(DIMS[0] * DIMS[1]);
  const xx = [0, 0, 0];
  const qq = [0, 0, 0];
  const duVec = [0, 0, 0];
  const dvVec = [0, 0, 0];

  let quadCount = 0;
  let faceCount = 0;

  const blockAt = (a: number, b: number, c: number): BlockId => getBlock(baseX + a, b, baseZ + c);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    qq[0] = 0;
    qq[1] = 0;
    qq[2] = 0;
    qq[d] = 1;

    const maskSize = DIMS[u] * DIMS[v];
    mask.fill(0, 0, maskSize);
    xx[0] = 0;
    xx[1] = 0;
    xx[2] = 0;

    for (xx[d] = -1; xx[d] < DIMS[d]; xx[d]++) {
      // ---- 1. build the face mask of the slice between x[d] and x[d]+1
      let n = 0;
      for (xx[v] = 0; xx[v] < DIMS[v]; xx[v]++) {
        for (xx[u] = 0; xx[u] < DIMS[u]; xx[u]++, n++) {
          const a = xx[d] >= 0 && xx[1] >= 0 ? blockAt(xx[0], xx[1], xx[2]) : Block.AIR;
          const b =
            xx[d] < DIMS[d] - 1 && xx[1] < CHUNK_HEIGHT
              ? blockAt(xx[0] + qq[0], xx[1] + qq[1], xx[2] + qq[2])
              : Block.AIR;
          if (faceVisible(a, b)) {
            mask[n] = a * 2 + 1; // face of `a` pointing towards +d
          } else if (faceVisible(b, a)) {
            mask[n] = b * 2; // face of `b` pointing towards -d
          } else {
            mask[n] = 0;
          }
        }
      }

      // ---- 2. merge the mask into rectangles
      n = 0;
      for (let j = 0; j < DIMS[v]; j++) {
        for (let i = 0; i < DIMS[u]; ) {
          const m = mask[n];
          if (m === 0) {
            i++;
            n++;
            continue;
          }

          let w = 1;
          while (i + w < DIMS[u] && mask[n + w] === m) w++;

          let h = 1;
          grow: while (j + h < DIMS[v]) {
            for (let k = 0; k < w; k++) {
              if (mask[n + k + h * DIMS[u]] !== m) break grow;
            }
            h++;
          }

          const blockId = m >> 1;
          const dir = (m & 1) === 1 ? 1 : -1;
          const def = getBlockDef(blockId);

          // quad base corner: the plane between the two slices
          const px = [xx[0], xx[1], xx[2]];
          px[d] += 1;
          px[u] = i;
          px[v] = j;

          duVec[0] = 0;
          duVec[1] = 0;
          duVec[2] = 0;
          duVec[u] = w;
          dvVec[0] = 0;
          dvVec[1] = 0;
          dvVec[2] = 0;
          dvVec[v] = h;

          const p = [
            [px[0], px[1], px[2]],
            [px[0] + duVec[0], px[1] + duVec[1], px[2] + duVec[2]],
            [px[0] + duVec[0] + dvVec[0], px[1] + duVec[1] + dvVec[1], px[2] + duVec[2] + dvVec[2]],
            [px[0] + dvVec[0], px[1] + dvVec[1], px[2] + dvVec[2]],
          ];

          const tile =
            d === 1 && dir === 1 ? def.tileTop : d === 1 ? def.tileBottom : def.tileSide;
          const rect = tileUV(tile);
          const uv4 =
            d === 0
              ? [
                  [rect.u0, rect.v0],
                  [rect.u0, rect.v1],
                  [rect.u1, rect.v1],
                  [rect.u1, rect.v0],
                ]
              : [
                  [rect.u0, rect.v0],
                  [rect.u1, rect.v0],
                  [rect.u1, rect.v1],
                  [rect.u0, rect.v1],
                ];

          let shade = 0.82;
          if (d === 1) shade = dir === 1 ? 1.0 : 0.5;
          else if (d === 0) shade = 0.78;
          else shade = 0.68;
          const alpha = def.alpha;

          const base = positions.length / 3;
          const order = dir === 1 ? [0, 1, 2, 3] : [0, 3, 2, 1];
          for (const c of order) {
            // local chunk space: the mesh object sits at (originX, 0, originZ)
            positions.push(p[c][0], p[c][1], p[c][2]);
            normals.push(d === 0 ? dir : 0, d === 1 ? dir : 0, d === 2 ? dir : 0);
            uvs.push(uv4[c][0], uv4[c][1]);
            colors.push(shade, shade, shade, alpha);
          }
          // triangle winding follows the pushed vertex order:
          // dir=+1 -> p0,p1,p2,p3 (front face towards +d), dir=-1 -> reversed
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);

          quadCount++;
          faceCount += w * h;

          for (let l = 0; l < h; l++) {
            for (let k = 0; k < w; k++) mask[n + k + l * DIMS[u]] = 0;
          }
          i += w;
          n += w;
        }
      }
    }
  }

  if (quadCount === 0) return null;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    quadCount,
    faceCount,
  };
}
