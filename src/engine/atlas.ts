import * as THREE from 'three';
import { TILE } from './blocks';
import { mulberry32 } from './noise';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const TILE_PX = 16;
export const ATLAS_PX = ATLAS_COLS * TILE_PX;

export interface TileUV {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * UV rect of an atlas tile in three.js space (origin bottom-left).
 * Half-texel inset keeps the nearest-filter sampler away from the neighbours.
 */
export function tileUV(tile: number): TileUV {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS) % ATLAS_ROWS;
  const inset = 0.5 / ATLAS_PX;
  return {
    u0: col / ATLAS_COLS + inset,
    u1: (col + 1) / ATLAS_COLS - inset,
    v0: 1 - (row + 1) / ATLAS_ROWS + inset,
    v1: 1 - row / ATLAS_ROWS - inset,
  };
}

export interface BlockAtlas {
  texture: THREE.Texture;
  canvas: HTMLCanvasElement;
}

type Painter = (rng: () => number, px: (x: number, y: number, w: number, h: number, color: string) => void) => void;

const PAINTERS: Record<number, Painter> = {
  [TILE.GRASS_TOP]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#5d9b3a');
    for (let i = 0; i < 130; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#6cb043' : '#4e8a31');
    }
  },
  [TILE.GRASS_SIDE]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#8a6440');
    for (let i = 0; i < 110; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = 4 + Math.floor(rng() * (TILE_PX - 4));
      px(x, y, 1, 1, rng() > 0.5 ? '#9a7350' : '#77563a');
    }
    // grass fringe on the top edge
    px(0, 0, TILE_PX, 3, '#5d9b3a');
    for (let x = 0; x < TILE_PX; x++) {
      const drop = 3 + Math.floor(rng() * 3);
      px(x, 3, 1, drop - 3, '#4e8a31');
    }
  },
  [TILE.DIRT]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#8a6440');
    for (let i = 0; i < 150; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#9a7350' : '#77563a');
    }
  },
  [TILE.STONE]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#8d8d92');
    for (let i = 0; i < 170; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#9c9ca1' : '#7c7c81');
    }
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rng() * (TILE_PX - 4));
      const y = Math.floor(rng() * (TILE_PX - 3));
      px(x, y, 3 + Math.floor(rng() * 3), 1 + Math.floor(rng() * 2), '#737378');
    }
  },
  [TILE.SAND]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#e3d8a4');
    for (let i = 0; i < 140; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#efe6b8' : '#d3c68d');
    }
  },
  [TILE.WATER]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#3a72c4');
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#4b83d4' : '#2f62ad');
    }
  },
  [TILE.WOOD_SIDE]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#6f5232');
    for (let x = 0; x < TILE_PX; x++) {
      if (rng() > 0.55) px(x, 0, 1, TILE_PX, rng() > 0.5 ? '#7d5d3a' : '#5f4629');
    }
    for (let i = 0; i < 20; i++) {
      px(Math.floor(rng() * TILE_PX), Math.floor(rng() * TILE_PX), 1, 1, '#513a22');
    }
  },
  [TILE.WOOD_TOP]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#a8845a');
    for (let x = 0; x < TILE_PX; x++) {
      for (let y = 0; y < TILE_PX; y++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (Math.floor(d) % 3 === 0 && rng() > 0.25) px(x, y, 1, 1, '#8f6d45');
      }
    }
  },
  [TILE.LEAVES]: (rng, px) => {
    px(0, 0, TILE_PX, TILE_PX, '#2f6b2a');
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(rng() * TILE_PX);
      const y = Math.floor(rng() * TILE_PX);
      px(x, y, 1, 1, rng() > 0.5 ? '#3d8034' : '#25561f');
    }
  },
};

/**
 * Paints every block texture into one canvas atlas so the whole terrain renders
 * with a single material (one draw call per chunk mesh).
 * Requires a DOM (browser / jsdom-with-canvas only).
 */
export function createBlockAtlas(seed = 1337): BlockAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('createBlockAtlas: 2d context unavailable');
  ctx.imageSmoothingEnabled = false;

  const px = (x: number, y: number, w: number, h: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };

  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(0, 0, ATLAS_PX, ATLAS_PX);

  const rng = mulberry32(seed);
  for (const key of Object.keys(PAINTERS)) {
    const tile = Number(key);
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    const ox = col * TILE_PX;
    const oy = row * TILE_PX;
    const tilePx = (x: number, y: number, w: number, h: number, color: string): void =>
      px(ox + x, oy + y, w, h, color);
    PAINTERS[tile](rng, tilePx);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, canvas };
}

/** The one material every chunk mesh shares: atlas + per-vertex shading/alpha. */
export function createTerrainMaterial(atlas: BlockAtlas): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    vertexColors: true,
    transparent: true,
    alphaTest: 0,
    side: THREE.FrontSide,
  });
  material.name = 'terrain';
  return material;
}
