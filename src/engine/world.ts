import * as THREE from 'three';
import { createBlockAtlas, createTerrainMaterial } from './atlas';
import { Block, type BlockId, isLiquid } from './blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z, Chunk } from './chunk';
import { buildChunkMeshData } from './mesher';
import { TerrainGenerator } from './terrain';

export interface WorldOptions {
  seed?: number;
  /** Chunks of radius kept around the focus point. Default 6. */
  renderDistance?: number;
  /** Chunk (re)builds allowed per frame. Default 2. */
  maxChunkOpsPerFrame?: number;
  /** Extra ring kept in memory before unloading. Default 1. */
  unloadMargin?: number;
  /** Shared terrain material. Created automatically (needs a DOM) when omitted. */
  material?: THREE.Material;
}

export interface RaycastHit {
  /** Voxel that was hit: integer world coordinates. */
  position: [number, number, number];
  /** Face normal the ray entered through. [0,0,0] when the origin is inside the block. */
  normal: [number, number, number];
  blockId: BlockId;
  /** Distance along the ray in blocks. */
  distance: number;
}

export interface WorldStats {
  seed: number;
  renderDistance: number;
  chunks: number;
  meshed: number;
  pending: number;
  builds: number;
  rebuilds: number;
  unloads: number;
  vertices: number;
  triangles: number;
  quads: number;
}

/**
 * Owns every loaded chunk, their meshes and the terrain generator.
 *
 * Chunk data is generated on demand (deterministic, so a world position always
 * yields the same blocks, whatever the load order) and meshed on a per-frame
 * budget, which is what keeps the frame time flat while the camera moves.
 */
export class World {
  readonly terrain: TerrainGenerator;
  readonly group: THREE.Group;
  renderDistance: number;
  maxChunkOpsPerFrame: number;
  unloadMargin: number;

  private readonly chunks = new Map<string, Chunk>();
  private readonly queue: Chunk[] = [];
  private readonly queuedKeys = new Set<string>();
  private material: THREE.Material | null;
  private ownedMaterial = false;

  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private wantedOffsets: Array<[number, number]> = [];
  private wantedRadius = -1;

  private counts = { builds: 0, rebuilds: 0, unloads: 0 };

  constructor(scene: THREE.Scene | null = null, opts: WorldOptions = {}) {
    this.terrain = new TerrainGenerator(opts.seed ?? 1337);
    this.renderDistance = Math.max(1, Math.floor(opts.renderDistance ?? 6));
    this.maxChunkOpsPerFrame = Math.max(1, Math.floor(opts.maxChunkOpsPerFrame ?? 2));
    this.unloadMargin = Math.max(0, Math.floor(opts.unloadMargin ?? 1));
    this.material = opts.material ?? null;

    this.group = new THREE.Group();
    this.group.name = 'voxel-chunks';
    if (scene) scene.add(this.group);
  }

  // ---------------------------------------------------------------- streaming

  /**
   * Streams chunks around `focus`: loads what entered the render distance and
   * unloads what left it. Call once per frame (createGame does it for you).
   */
  update(_dt: number, focus: THREE.Vector3): void {
    const pcx = Math.floor(focus.x / CHUNK_SIZE_X);
    const pcz = Math.floor(focus.z / CHUNK_SIZE_Z);
    // `renderDistance` is writable at runtime (adaptive quality). Reload when it
    // changed instead of waiting for the camera to cross into another chunk,
    // otherwise raising the distance back up would do nothing while standing.
    const radiusChanged = this.wantedRadius !== Math.max(1, Math.floor(this.renderDistance));
    if (pcx !== this.centerX || pcz !== this.centerZ || radiusChanged) {
      this.centerX = pcx;
      this.centerZ = pcz;
      this.loadAround(pcx, pcz);
    }
    this.buildPendingChunks(this.maxChunkOpsPerFrame);
    this.unloadFarChunks(pcx, pcz);
  }

  /** Meshes up to `maxOps` queued chunks. Returns how many were built. */
  buildPendingChunks(maxOps = Number.POSITIVE_INFINITY): number {
    let ops = 0;
    while (ops < maxOps && this.queue.length > 0) {
      const chunk = this.queue.shift() as Chunk;
      this.queuedKeys.delete(chunk.key);
      const current = this.chunks.get(chunk.key);
      if (!current || current !== chunk || !chunk.needsMesh) continue;
      chunk.needsMesh = false;
      const rebuilding = chunk.meshed;
      const buffers = buildChunkMeshData(chunk.originX, chunk.originZ, this.getBlockBound);
      this.applyMesh(chunk, buffers);
      if (rebuilding) this.counts.rebuilds++;
      ops++;
    }
    return ops;
  }

  /** Meshes everything queued right now (tests / tooling; blocks the frame). */
  buildAllPending(): void {
    let guard = 0;
    while (this.queue.length > 0 && guard++ < 100000) this.buildPendingChunks(1);
  }

  private loadAround(pcx: number, pcz: number): void {
    for (const [dx, dz] of this.getWantedOffsets()) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      let chunk = this.chunks.get(Chunk.key(cx, cz));
      if (!chunk) {
        chunk = new Chunk(cx, cz, this.terrain.generate(cx, cz));
        this.chunks.set(chunk.key, chunk);
        this.counts.builds++;
      }
      if (!chunk.meshed && !chunk.needsMesh) this.queueMesh(chunk);
    }
  }

  private getWantedOffsets(): Array<[number, number]> {
    const r = Math.max(1, Math.floor(this.renderDistance));
    if (this.wantedRadius === r) return this.wantedOffsets;
    const out: Array<[number, number, number]> = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r + r) continue; // round-ish disc instead of a square
        out.push([dx, dz, d2]);
      }
    }
    out.sort((a, b) => a[2] - b[2]);
    this.wantedOffsets = out.map((entry) => [entry[0], entry[1]] as [number, number]);
    this.wantedRadius = r;
    return this.wantedOffsets;
  }

  private queueMesh(chunk: Chunk): void {
    if (chunk.needsMesh) return;
    chunk.needsMesh = true;
    this.queue.push(chunk);
    this.queuedKeys.add(chunk.key);
  }

  private unloadFarChunks(pcx: number, pcz: number): void {
    const limit = this.renderDistance + this.unloadMargin;
    for (const [key, chunk] of this.chunks) {
      if (Math.abs(chunk.cx - pcx) <= limit && Math.abs(chunk.cz - pcz) <= limit) continue;
      this.disposeChunkMesh(chunk);
      this.chunks.delete(key);
      this.queuedKeys.delete(key);
      this.counts.unloads++;
    }
  }

  // ------------------------------------------------------------------ blocks

  /** Loaded chunk, or undefined. Never generates anything. */
  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(Chunk.key(cx, cz));
  }

  private getOrLoadChunk(cx: number, cz: number): Chunk {
    const key = Chunk.key(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz, this.terrain.generate(cx, cz));
      this.chunks.set(key, chunk);
      this.counts.builds++;
    }
    return chunk;
  }

  /**
   * Block at world coordinates. Outside the vertical range returns AIR.
   * A chunk outside the loaded area gets generated on demand (data only, no
   * mesh) so neighbour lookups at chunk borders are always correct.
   */
  getBlock(x: number, y: number, z: number): BlockId {
    if (y < 0 || y >= CHUNK_HEIGHT) return Block.AIR;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const chunk = this.getOrLoadChunk(cx, cz);
    return chunk.get(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z);
  }

  /** Read that never generates: only sees chunks already in memory. */
  peekBlock(x: number, y: number, z: number): BlockId {
    if (y < 0 || y >= CHUNK_HEIGHT) return Block.AIR;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const chunk = this.chunks.get(Chunk.key(cx, cz));
    if (!chunk) return Block.AIR;
    return chunk.get(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z);
  }

  /**
   * Writes a block and re-queues the chunk mesh, plus the neighbour mesh when
   * the write lands on a border, so seams stay closed.
   */
  setBlock(x: number, y: number, z: number, id: BlockId): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const chunk = this.getOrLoadChunk(cx, cz);
    const lx = x - cx * CHUNK_SIZE_X;
    const lz = z - cz * CHUNK_SIZE_Z;
    if (chunk.get(lx, y, lz) === id) return;
    chunk.set(lx, y, lz, id);
    this.queueMesh(chunk);

    if (lx === 0) this.markDirty(cx - 1, cz);
    else if (lx === CHUNK_SIZE_X - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    else if (lz === CHUNK_SIZE_Z - 1) this.markDirty(cx, cz + 1);
  }

  private markDirty(cx: number, cz: number): void {
    const chunk = this.chunks.get(Chunk.key(cx, cz));
    if (chunk && chunk.meshed) this.queueMesh(chunk);
  }

  // ----------------------------------------------------------------- raycast

  /**
   * Voxel DDA (Amanatides & Woo). Liquids are ignored, so the ray passes
   * through water and hits whatever is behind it.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist = 5): RaycastHit | null {
    let dx = direction.x;
    let dy = direction.y;
    let dz = direction.z;
    const len = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(len) || len === 0) return null;
    dx /= len;
    dy /= len;
    dz /= len;

    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
    const tDeltaZ = stepZ === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dz);

    let tMaxX = Number.isFinite(tDeltaX) ? boundaryDistance(origin.x, stepX) * tDeltaX : Number.POSITIVE_INFINITY;
    let tMaxY = Number.isFinite(tDeltaY) ? boundaryDistance(origin.y, stepY) * tDeltaY : Number.POSITIVE_INFINITY;
    let tMaxZ = Number.isFinite(tDeltaZ) ? boundaryDistance(origin.z, stepZ) * tDeltaZ : Number.POSITIVE_INFINITY;

    const normal: [number, number, number] = [0, 0, 0];
    let t = 0;

    for (let guard = 0; guard < 4096; guard++) {
      const id = this.getBlock(x, y, z);
      if (id !== Block.AIR && !isLiquid(id)) {
        return { position: [x, y, z], normal, blockId: id, distance: t };
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
        normal[0] = -stepX;
        normal[1] = 0;
        normal[2] = 0;
      } else if (tMaxY <= tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
        normal[0] = 0;
        normal[1] = -stepY;
        normal[2] = 0;
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        normal[0] = 0;
        normal[1] = 0;
        normal[2] = -stepZ;
      }
      if (t > maxDist) return null;
    }
    return null;
  }

  // ------------------------------------------------------------------- misc

  /** Terrain surface height (topmost generated solid block) at world x,z. */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Standing position at x,z: one block above the surface. */
  spawnPoint(x = 0, z = 0): THREE.Vector3 {
    const y = Math.max(this.terrain.heightAt(x, z) + 1, 1);
    return new THREE.Vector3(x + 0.5, y, z + 0.5);
  }

  stats(): WorldStats {
    let meshed = 0;
    let vertices = 0;
    let triangles = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.mesh) continue;
      meshed++;
      const geometry = chunk.mesh.geometry;
      const position = geometry.getAttribute('position');
      if (position) vertices += position.count;
      const index = geometry.getIndex();
      if (index) triangles += index.count / 3;
    }
    return {
      seed: this.terrain.seed,
      renderDistance: this.renderDistance,
      chunks: this.chunks.size,
      meshed,
      pending: this.queue.length,
      builds: this.counts.builds,
      rebuilds: this.counts.rebuilds,
      unloads: this.counts.unloads,
      vertices,
      triangles,
      quads: triangles / 2,
    };
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) this.disposeChunkMesh(chunk);
    this.chunks.clear();
    this.queue.length = 0;
    this.queuedKeys.clear();
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.ownedMaterial && this.material) {
      const material = this.material as THREE.MeshLambertMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.material = null;
  }

  // --------------------------------------------------------------- internals

  private getBlockBound = (x: number, y: number, z: number): BlockId => this.getBlock(x, y, z);

  private getMaterial(): THREE.Material {
    if (this.material) return this.material;
    if (typeof document === 'undefined') {
      throw new Error('World: no material supplied and no DOM available to build the atlas');
    }
    this.material = createTerrainMaterial(createBlockAtlas(this.terrain.seed));
    this.ownedMaterial = true;
    return this.material;
  }

  private applyMesh(chunk: Chunk, buffers: ReturnType<typeof buildChunkMeshData>): void {
    if (!buffers) {
      if (chunk.mesh) chunk.mesh.visible = false;
      chunk.meshed = true;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffers.colors, 4));
    geometry.setIndex(new THREE.Uint32BufferAttribute(buffers.indices, 1));
    geometry.computeBoundingSphere();

    if (chunk.mesh) {
      const previous = chunk.mesh.geometry;
      chunk.mesh.geometry = geometry;
      chunk.mesh.visible = true;
      previous.dispose();
    } else {
      const mesh = new THREE.Mesh(geometry, this.getMaterial());
      mesh.name = 'chunk:' + chunk.cx + ',' + chunk.cz;
      mesh.position.set(chunk.originX, 0, chunk.originZ);
      // chunk meshes never move: compute the matrix once instead of every frame
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      chunk.mesh = mesh;
      this.group.add(mesh);
    }
    chunk.meshed = true;
  }

  private disposeChunkMesh(chunk: Chunk): void {
    if (!chunk.mesh) return;
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh = null;
    chunk.meshed = false;
    chunk.needsMesh = false;
  }
}

function boundaryDistance(start: number, step: number): number {
  if (step > 0) return Math.ceil(start) - start;
  if (step < 0) return start - Math.floor(start);
  return Number.POSITIVE_INFINITY;
}
