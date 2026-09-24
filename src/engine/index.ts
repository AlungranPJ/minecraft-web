/**
 * Public engine API.
 *
 * Everything another module needs to build gameplay on top of the voxel world
 * lives here. The names below are frozen (see README "public API"):
 *
 *   world.getBlock(x, y, z): BlockId
 *   world.setBlock(x, y, z, id): void
 *   world.raycast(origin, direction, maxDist): RaycastHit | null
 *   createGame(canvas, opts): Game
 */
export { createGame } from './game';
export type { Game, GameOptions, GameStats } from './game';

export { World } from './world';
export type { RaycastHit, WorldOptions, WorldStats } from './world';

export {
  Block,
  BLOCKS,
  TILE,
  getBlockDef,
  isLiquid,
  isOpaque,
  isRenderable,
  isSolid,
} from './blocks';
export type { BlockDef, BlockId } from './blocks';

export { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_VOLUME, Chunk } from './chunk';

export { SEA_LEVEL, TREE_MARGIN, TerrainGenerator } from './terrain';

export { buildChunkMeshData } from './mesher';
export type { BlockGetter, MeshBuffers } from './mesher';

export { createBlockAtlas, createTerrainMaterial, tileUV } from './atlas';
export type { BlockAtlas, TileUV } from './atlas';

export { SpectatorController } from './cameraRig';
export type { SpectatorOptions } from './cameraRig';

export { fbm2, hash01, mulberry32, SimplexNoise } from './noise';
