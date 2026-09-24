/**
 * Headless smoke test for the engine core. No browser, no WebGL:
 * terrain, blocks, raycast, greedy mesher and chunk streaming.
 *
 *   npm run test:smoke
 */
import * as THREE from 'three';
import { Block, isSolid } from '../src/engine/blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../src/engine/chunk';
import { buildChunkMeshData } from '../src/engine/mesher';
import { SEA_LEVEL, TerrainGenerator } from '../src/engine/terrain';
import { World } from '../src/engine/world';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' -- ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

function section(title: string): void {
  console.log('\n' + title);
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A column with no tree within the 3 block tree margin, so nothing hangs above it. */
function clearColumn(world: World): [number, number] {
  for (let x = 0; x < 64; x++) {
    for (let z = 0; z < 64; z++) {
      let clear = true;
      for (let dx = -3; dx <= 3 && clear; dx++) {
        for (let dz = -3; dz <= 3 && clear; dz++) {
          if (world.terrain.isTreeAt(x + dx, z + dz)) clear = false;
        }
      }
      if (clear) return [x, z];
    }
  }
  throw new Error('no tree free column found');
}

// ---------------------------------------------------------------- terrain ---
section('terrain generation');
{
  const a = new TerrainGenerator(4242).generate(0, 0);
  const b = new TerrainGenerator(4242).generate(0, 0);
  const c = new TerrainGenerator(777).generate(0, 0);
  check('same seed -> identical chunk', sameArray(a, b));
  check('different seed -> different chunk', !sameArray(a, c));

  const gen = new TerrainGenerator(4242);
  const counts = new Map<number, number>();
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const data = gen.generate(cx, cz);
      for (let i = 0; i < data.length; i++) counts.set(data[i], (counts.get(data[i]) ?? 0) + 1);
    }
  }
  const present = (id: number): boolean => (counts.get(id) ?? 0) > 0;
  check('grass generated', present(Block.GRASS), String(counts.get(Block.GRASS)));
  check('dirt generated', present(Block.DIRT), String(counts.get(Block.DIRT)));
  check('stone generated', present(Block.STONE), String(counts.get(Block.STONE)));
  check('sand generated', present(Block.SAND), String(counts.get(Block.SAND)));
  check('water generated', present(Block.WATER), String(counts.get(Block.WATER)));
  check('trees generated (wood)', present(Block.WOOD), String(counts.get(Block.WOOD)));
  check('trees generated (leaves)', present(Block.LEAVES), String(counts.get(Block.LEAVES)));
  check(
    'at least 4 solid block types',
    new Set([Block.GRASS, Block.DIRT, Block.STONE, Block.SAND].filter(present)).size >= 4,
  );

  // vertical structure of a land column
  const h = gen.heightAt(5, 5);
  const data = gen.generate(0, 0);
  const at = (x: number, y: number, z: number): number => data[(y * 16 + z) * 16 + x];
  check('y=0 is bedrock stone', at(5, 0, 5) === Block.STONE);
  check('surface block is grass or sand', at(5, h, 5) === Block.GRASS || at(5, h, 5) === Block.SAND);
  check('below surface is dirt or sand', ([Block.DIRT, Block.SAND] as number[]).includes(at(5, h - 2, 5)));
  check('deep block is stone', at(5, Math.max(1, h - 8), 5) === Block.STONE);

  // water only fills up to sea level
  let waterAboveSea = 0;
  let waterOverGround = 0;
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const d = gen.generate(cx, cz);
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if (d[(y * 16 + z) * 16 + x] !== Block.WATER) continue;
            if (y > SEA_LEVEL) waterAboveSea++;
            const hh = gen.heightAt(cx * 16 + x, cz * 16 + z);
            if (y <= hh) waterOverGround++;
          }
        }
      }
    }
  }
  check('no water above sea level', waterAboveSea === 0, String(waterAboveSea));
  check('no water inside ground', waterOverGround === 0, String(waterOverGround));
}

// ------------------------------------------------------------- block access --
section('world block access');
const testMaterial = new THREE.MeshBasicMaterial();
{
  const world = new World(null, { seed: 4242, renderDistance: 2, material: testMaterial });
  const h = world.heightAt(3, 3);
  check('getBlock reads terrain', world.getBlock(3, h, 3) !== Block.AIR);
  check('getBlock below world is air', world.getBlock(3, -1, 3) === Block.AIR);
  check('getBlock above height is air', world.getBlock(3, CHUNK_HEIGHT, 3) === Block.AIR);

  const [ax, az] = clearColumn(world);
  const ah = world.heightAt(ax, az);
  check('getBlock above the surface is air', world.getBlock(ax, ah + 2, az) === Block.AIR);

  world.setBlock(3, h + 1, 3, Block.STONE);
  check('setBlock then getBlock', world.getBlock(3, h + 1, 3) === Block.STONE);
  world.setBlock(3, h + 1, 3, Block.AIR);
  check('setBlock back to air', world.getBlock(3, h + 1, 3) === Block.AIR);

  // chunk border write must not throw and must be visible from both sides
  world.setBlock(15, h + 1, 4, Block.WOOD);
  world.setBlock(16, h + 1, 4, Block.WOOD);
  check('border write visible (left chunk)', world.getBlock(15, h + 1, 4) === Block.WOOD);
  check('border write visible (right chunk)', world.getBlock(16, h + 1, 4) === Block.WOOD);

  // negative coordinates must not break the chunk maths
  world.setBlock(-1, h + 1, -17, Block.STONE);
  check('negative coords write/read', world.getBlock(-1, h + 1, -17) === Block.STONE);

  check(
    'terrain deterministic across worlds',
    new World(null, { seed: 4242, material: testMaterial }).getBlock(3, h, 3) === world.getBlock(3, h, 3),
  );
  world.dispose();
}

// ----------------------------------------------------------------- raycast --
section('raycast');
{
  const world = new World(null, { seed: 4242, renderDistance: 2, material: testMaterial });
  const [sx, sz] = clearColumn(world);
  const h = world.heightAt(sx, sz);
  const surface = world.getBlock(sx, h, sz);

  const down = world.raycast(new THREE.Vector3(sx + 0.5, h + 4.5, sz + 0.5), new THREE.Vector3(0, -1, 0), 10);
  check('downward ray hits the surface', down !== null);
  check('hit position is the surface voxel', down?.position[0] === sx && down?.position[1] === h && down?.position[2] === sz, JSON.stringify(down?.position));
  check('hit block matches getBlock', down?.blockId === surface);
  check('hit normal is +y', down?.normal[1] === 1 && down?.normal[0] === 0 && down?.normal[2] === 0, JSON.stringify(down?.normal));
  check('hit distance is 3.5 (from y = h+4.5 to the top face at y = h+1)', Math.abs((down?.distance ?? 0) - 3.5) < 1e-9, String(down?.distance));

  const short = world.raycast(new THREE.Vector3(sx + 0.5, h + 4.5, sz + 0.5), new THREE.Vector3(0, -1, 0), 2);
  check('maxDist is respected', short === null);

  const sky = world.raycast(new THREE.Vector3(sx + 0.5, h + 4, sz + 0.5), new THREE.Vector3(0, 1, 0), 10);
  check('ray into the sky misses', sky === null);

  world.setBlock(sx + 4, h + 1, sz, Block.STONE);
  const wall = world.raycast(new THREE.Vector3(sx + 0.5, h + 1.5, sz + 0.5), new THREE.Vector3(1, 0, 0), 5);
  check('ray hits a placed wall', wall?.blockId === Block.STONE && wall?.position[0] === sx + 4, JSON.stringify(wall));
  check('wall normal faces -x', wall?.normal[0] === -1 && wall?.normal[1] === 0 && wall?.normal[2] === 0, JSON.stringify(wall?.normal));

  const diagonal = world.raycast(new THREE.Vector3(sx + 0.5, h + 1.5, sz + 0.5), new THREE.Vector3(1, 0, 0.4), 6);
  check('diagonal ray still lands somewhere sane', diagonal === null || isSolid(diagonal.blockId));

  // water must not stop the ray: pick a column under sea level
  let wx = 0;
  let wz = 0;
  outer: for (let x = -40; x < 40; x++) {
    for (let z = -40; z < 40; z++) {
      if (world.heightAt(x, z) < SEA_LEVEL - 2) {
        wx = x;
        wz = z;
        break outer;
      }
    }
  }
  const groundY = world.heightAt(wx, wz);
  const throughWater = world.raycast(
    new THREE.Vector3(wx + 0.5, SEA_LEVEL + 3, wz + 0.5),
    new THREE.Vector3(0, -1, 0),
    SEA_LEVEL + 6,
  );
  check(
    'ray passes through water and hits the floor',
    throughWater !== null && throughWater.position[1] === groundY,
    JSON.stringify(throughWater),
  );
  world.dispose();
}

// ------------------------------------------------------------------ mesher --
section('greedy mesher');
{
  // a single 16x16x1 stone slab at y=0: 6 greedy quads, 576 individual faces
  const slab = (x: number, y: number, z: number): number =>
    y === 0 && x >= 0 && x < 16 && z >= 0 && z < 16 ? Block.STONE : Block.AIR;
  const buffers = buildChunkMeshData(0, 0, slab);
  check('slab produces a mesh', buffers !== null);
  check('flat 16x16 slab merges to 6 quads', buffers?.quadCount === 6, String(buffers?.quadCount));
  check('face count before merging is 576+...', buffers?.faceCount === 576, String(buffers?.faceCount));

  // every vertex must sit inside one chunk box: catches stale/looped coordinates
  let outOfRange = 0;
  let yMax = -Infinity;
  if (buffers) {
    for (let i = 0; i < buffers.positions.length; i += 3) {
      const [px, py, pz] = [buffers.positions[i], buffers.positions[i + 1], buffers.positions[i + 2]];
      yMax = Math.max(yMax, py);
      if (px < 0 || px > CHUNK_SIZE_X || py < 0 || py > CHUNK_HEIGHT || pz < 0 || pz > CHUNK_SIZE_Z) {
        outOfRange++;
      }
    }
  }
  check('slab vertices stay inside the chunk box', outOfRange === 0, `${outOfRange} outside, yMax ${yMax}`);
  check('slab top face is at y = 1', yMax === 1, String(yMax));
  check('quad -> 4 vertices', (buffers?.positions.length ?? 0) === 6 * 4 * 3);
  check('quad -> 2 triangles', (buffers?.indices.length ?? 0) === 6 * 2 * 3);
  check('uv count matches vertices', (buffers?.uvs.length ?? 0) === (buffers?.positions.length ?? 0) / 3 * 2);
  check('rgba vertex colors', (buffers?.colors.length ?? 0) === (buffers?.positions.length ?? 0) / 3 * 4);

  let axisAligned = true;
  if (buffers) {
    for (let i = 0; i < buffers.normals.length; i += 3) {
      const n = [buffers.normals[i], buffers.normals[i + 1], buffers.normals[i + 2]];
      const sum = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
      if (sum !== 1) axisAligned = false;
    }
  }
  check('normals are unit axis vectors', axisAligned);

  // interior faces between two identical opaque blocks are culled
  const pair = (x: number, y: number, z: number): number =>
    y === 0 && x >= 0 && x < 2 && z >= 0 && z < 2 ? Block.STONE : Block.AIR;
  const pairMesh = buildChunkMeshData(0, 0, pair);
  check('interior faces culled (2x2x1 slab = 6 quads)', pairMesh?.quadCount === 6, String(pairMesh?.quadCount));

  // water keeps its own faces but is see-through
  const water = (x: number, y: number, z: number): number =>
    y === 0 && x >= 0 && x < 16 && z >= 0 && z < 16 ? Block.WATER : Block.AIR;
  const waterMesh = buildChunkMeshData(0, 0, water);
  let alphas = new Set<number>();
  if (waterMesh) {
    for (let i = 3; i < waterMesh.colors.length; i += 4) alphas.add(waterMesh.colors[i]);
  }
  check('water vertex alpha is translucent', alphas.size === 1 && [...alphas][0] < 1, [...alphas].join(','));

  // stone next to water: both faces survive (stone is opaque, water is not)
  const shore = (x: number, y: number, z: number): number => {
    if (y === 0) return x >= 0 && x < 16 && z >= 0 && z < 16 ? (x < 8 ? Block.STONE : Block.WATER) : Block.AIR;
    return Block.AIR;
  };
  const shoreMesh = buildChunkMeshData(0, 0, shore);
  check('stone/water boundary keeps both faces', (shoreMesh?.quadCount ?? 0) >= 8, String(shoreMesh?.quadCount));
}

// --------------------------------------------------------- chunk streaming --
section('chunk manager');
{
  const world = new World(null, { seed: 4242, renderDistance: 2, maxChunkOpsPerFrame: 2, material: testMaterial });
  const focus = new THREE.Vector3(8, 40, 8);

  world.update(0.016, focus);
  const first = world.stats();
  check('first frame builds at most maxChunkOpsPerFrame chunks', first.meshed <= 2, String(first.meshed));
  check('rest stays queued (frame not blocked)', first.pending > 0, String(first.pending));

  for (let i = 0; i < 200; i++) world.update(0.016, focus);
  const settled = world.stats();
  check('all wanted chunks get meshed eventually', settled.pending === 0 && settled.meshed === settled.chunks, JSON.stringify(settled));
  check('chunk count matches render distance disc (21)', settled.chunks === 21, String(settled.chunks));
  check('triangles are generated', settled.triangles > 0, String(settled.triangles));

  // walk away and make sure nothing accumulates
  let maxChunks = settled.chunks;
  let maxGeometries = settled.meshed;
  for (let step = 1; step <= 20; step++) {
    focus.set(8 + step * 16, 40, 8 + step * 16);
    for (let i = 0; i < 20; i++) world.update(0.016, focus);
    const s = world.stats();
    maxChunks = Math.max(maxChunks, s.chunks);
    maxGeometries = Math.max(maxGeometries, s.meshed);
  }
  const far = world.stats();
  check('memory stays bounded while walking', maxChunks <= 49, String(maxChunks));
  check('mesh count stays bounded while walking', maxGeometries <= 49, String(maxGeometries));
  check('chunks were unloaded', far.unloads > 0, String(far.unloads));
  check('scene holds one mesh per meshed chunk', world.group.children.length === far.meshed, `${world.group.children.length} vs ${far.meshed}`);

  // real terrain chunks: every vertex must sit inside its own 16x64x16 box
  let stray = 0;
  let worstY = 0;
  for (const mesh of world.group.children) {
    const attr = (mesh as THREE.Mesh).geometry.attributes.position;
    for (let i = 0; i < attr.count; i++) {
      const vx = attr.getX(i);
      const vy = attr.getY(i);
      const vz = attr.getZ(i);
      if (vy > worstY) worstY = vy;
      if (vx < 0 || vx > CHUNK_SIZE_X || vy < 0 || vy > CHUNK_HEIGHT || vz < 0 || vz > CHUNK_SIZE_Z) stray++;
    }
  }
  check('terrain chunk vertices stay inside their chunk box', stray === 0, `${stray} stray, max y ${worstY}`);

  // the world is the same wherever it is loaded from
  const reference = new TerrainGenerator(4242).generate(20, 20);
  const reloaded = world.getBlock(20 * 16 + 4, world.heightAt(20 * 16 + 4, 20 * 16 + 4), 20 * 16 + 4);
  const referenceValue = reference[(world.heightAt(20 * 16 + 4, 20 * 16 + 4) * 16 + 4) * 16 + 4];
  check('world content independent of load order', reloaded === referenceValue, `${reloaded} vs ${referenceValue}`);

  const before = world.stats().meshed;
  world.dispose();
  check('dispose clears meshes', world.group.children.length === 0, `${before} -> ${world.group.children.length}`);
}

// ------------------------------------------------------------------ report --
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const f of failures) console.log('  - ' + f);
  throw new Error(`${failures.length} engine smoke test failure(s)`);
}
