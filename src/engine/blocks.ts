/**
 * Block ids are plain numbers so a whole chunk fits in a Uint8Array.
 * AIR is always 0 and is never rendered.
 */
export type BlockId = number;

/** Block ids. These numbers are part of the public API and must not change. */
export const Block = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  WOOD: 6,
  LEAVES: 7,
} as const;

/** Atlas tile indices (row-major inside a 4x4 grid, see atlas.ts). */
export const TILE = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  WOOD_SIDE: 6,
  WOOD_TOP: 7,
  LEAVES: 8,
} as const;

export interface BlockDef {
  id: BlockId;
  name: string;
  /** Player AABB collides with it. */
  solid: boolean;
  /** Hides the touching face of the neighbour block. */
  opaque: boolean;
  /** Player can move through it and it does not occlude neighbours. */
  liquid: boolean;
  /** Seconds to break by hand. Used by the dig/interaction layer. */
  hardness: number;
  /** Flat vertex alpha. Lets water be see-through with a single material. */
  alpha: number;
  tileTop: number;
  tileBottom: number;
  tileSide: number;
}

function define(
  id: BlockId,
  name: string,
  over: Partial<BlockDef> &
    Pick<BlockDef, 'tileTop' | 'tileBottom' | 'tileSide'>,
): BlockDef {
  return {
    id,
    name,
    solid: true,
    opaque: true,
    liquid: false,
    hardness: 1,
    alpha: 1,
    ...over,
  };
}

export const BLOCKS: BlockDef[] = [
  define(Block.AIR, 'air', {
    solid: false,
    opaque: false,
    hardness: 0,
    tileTop: TILE.DIRT,
    tileBottom: TILE.DIRT,
    tileSide: TILE.DIRT,
  }),
  define(Block.GRASS, 'grass', {
    hardness: 0.6,
    tileTop: TILE.GRASS_TOP,
    tileBottom: TILE.DIRT,
    tileSide: TILE.GRASS_SIDE,
  }),
  define(Block.DIRT, 'dirt', {
    hardness: 0.5,
    tileTop: TILE.DIRT,
    tileBottom: TILE.DIRT,
    tileSide: TILE.DIRT,
  }),
  define(Block.STONE, 'stone', {
    hardness: 1.5,
    tileTop: TILE.STONE,
    tileBottom: TILE.STONE,
    tileSide: TILE.STONE,
  }),
  define(Block.SAND, 'sand', {
    hardness: 0.4,
    tileTop: TILE.SAND,
    tileBottom: TILE.SAND,
    tileSide: TILE.SAND,
  }),
  define(Block.WATER, 'water', {
    solid: false,
    opaque: false,
    liquid: true,
    hardness: 1.0,
    alpha: 0.72,
    tileTop: TILE.WATER,
    tileBottom: TILE.WATER,
    tileSide: TILE.WATER,
  }),
  define(Block.WOOD, 'wood', {
    hardness: 1.2,
    tileTop: TILE.WOOD_TOP,
    tileBottom: TILE.WOOD_TOP,
    tileSide: TILE.WOOD_SIDE,
  }),
  define(Block.LEAVES, 'leaves', {
    hardness: 0.3,
    tileTop: TILE.LEAVES,
    tileBottom: TILE.LEAVES,
    tileSide: TILE.LEAVES,
  }),
];

export const AIR_DEF: BlockDef = BLOCKS[Block.AIR];

/** Never returns undefined: unknown ids fall back to air. */
export function getBlockDef(id: BlockId): BlockDef {
  return BLOCKS[id] ?? AIR_DEF;
}

export function isSolid(id: BlockId): boolean {
  return id !== Block.AIR && getBlockDef(id).solid;
}

export function isOpaque(id: BlockId): boolean {
  return id !== Block.AIR && getBlockDef(id).opaque;
}

export function isLiquid(id: BlockId): boolean {
  return id !== Block.AIR && getBlockDef(id).liquid;
}

/** True when the id should be meshed at all. */
export function isRenderable(id: BlockId): boolean {
  return id !== Block.AIR;
}
