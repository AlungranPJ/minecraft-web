/**
 * Headless smoke test for the performance work.
 *
 *  1. the adaptive quality ladder: pure policy, driven with synthetic fps
 *  2. the real cost of generating + meshing one chunk on this machine — the
 *     number that decides whether terrain generation has to move into a Web
 *     Worker or the per-frame chunk budget is enough
 *
 * No browser, no WebGL.
 *
 *   npm run test:perf
 */
import { CHUNK_HEIGHT, CHUNK_SIZE_X, CHUNK_SIZE_Z, Chunk } from '../src/engine/chunk';
import { buildChunkMeshData } from '../src/engine/mesher';
import { TerrainGenerator } from '../src/engine/terrain';
import { AdaptiveQuality, QUALITY_LEVELS } from '../src/perf/adaptive';

const SEED = 20260924;
const STEP = 1 / 60;

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

/** Feeds `seconds` of `fps` into the controller, returns how many times it moved. */
function feed(controller: AdaptiveQuality, fps: number, seconds: number): number {
  let moves = 0;
  const frames = Math.round(seconds / STEP);
  for (let i = 0; i < frames; i++) if (controller.update(STEP, fps)) moves++;
  return moves;
}

// ------------------------------------------------------------- the ladder ---
section('adaptive quality policy');
{
  const levels = new AdaptiveQuality();
  check('starts at the best level', levels.level === 0 && levels.current.name === 'high', levels.current.name);
  check(
    'the starting level is what createGame defaults to (render distance 6)',
    levels.current.renderDistance === 6,
    String(levels.current.renderDistance),
  );
  check(
    'the ladder is ordered best -> worst',
    QUALITY_LEVELS.every((lv, i) => i === 0 || lv.renderDistance <= QUALITY_LEVELS[i - 1].renderDistance),
    QUALITY_LEVELS.map((lv) => `${lv.name}:${lv.renderDistance}`).join(' '),
  );

  const steady = new AdaptiveQuality();
  feed(steady, 60, 30);
  check('60 fps for 30 s never drops quality', steady.level === 0 && steady.changes.length === 0, `${steady.level}`);

  const dead = new AdaptiveQuality();
  feed(dead, 50, 30);
  check('50 fps (dead band) never moves the level', dead.level === 0 && dead.changes.length === 0, `${dead.level}`);

  const slow = new AdaptiveQuality();
  feed(slow, 30, 2.4);
  check('a short dip below the floor does not move the level yet', slow.level === 0, String(slow.level));
  feed(slow, 30, 0.2);
  check('a sustained dip drops one level', slow.level === 1 && slow.current.name === 'medium', slow.current.name);
  check('the change is logged with the fps that caused it', slow.changes.length === 1 && slow.changes[0].fps === 30, JSON.stringify(slow.changes));

  const bottom = new AdaptiveQuality();
  feed(bottom, 12, 60);
  check('a very slow machine walks to the worst level', bottom.level === QUALITY_LEVELS.length - 1 && bottom.atWorst, String(bottom.level));
  check('the worst level still renders a world', bottom.current.renderDistance >= 3, String(bottom.current.renderDistance));
  check('it never runs past the end of the ladder', bottom.changes.length === QUALITY_LEVELS.length - 1, JSON.stringify(bottom.changes.map((c) => c.to)));

  const recover = new AdaptiveQuality();
  feed(recover, 12, 60);
  const before = recover.level;
  feed(recover, 60, 5.9);
  check('recovery needs the longer window (still down after 5.9 s)', recover.level === before, String(recover.level));
  feed(recover, 60, 0.2);
  check('sustained headroom raises the level back', recover.level === before - 1, `${before} -> ${recover.level}`);
  feed(recover, 60, 60);
  check('it recovers all the way to the starting level, never above', recover.level === 0 && recover.atBest, String(recover.level));

  const flappy = new AdaptiveQuality();
  feed(flappy, 20, 2);
  feed(flappy, 60, 2);
  feed(flappy, 20, 2);
  feed(flappy, 60, 2);
  check('alternating load does not accumulate into a drop', flappy.level === 0 && flappy.changes.length === 0, String(flappy.level));

  const blank = new AdaptiveQuality();
  const blankMoves = feed(blank, 0, 20) + feed(blank, Number.NaN, 5);
  check('an unmeasured fps (0 / NaN) is ignored', blankMoves === 0 && blank.samples === 0, `samples ${blank.samples}`);

  const frozen = new AdaptiveQuality();
  frozen.enabled = false;
  feed(frozen, 5, 60);
  check('disabled means the level is frozen', frozen.level === 0 && frozen.changes.length === 0, String(frozen.level));
  frozen.enabled = true;
  feed(frozen, 5, 3);
  check('re-enabling resumes the policy', frozen.level === 1, String(frozen.level));

  const forced = new AdaptiveQuality();
  check('forceLevel moves and logs', forced.forceLevel(2) && forced.level === 2 && forced.changes.length === 1, String(forced.level));
  check('forceLevel clamps out of range values', !forced.forceLevel(2) && forced.forceLevel(99) && forced.level === QUALITY_LEVELS.length - 1, String(forced.level));
  forced.reset();
  check('reset() goes back to the starting quality', forced.level === 0 && forced.changes.length === 0 && forced.elapsed === 0, String(forced.level));

  const custom = new AdaptiveQuality({
    levels: [
      { name: 'a', renderDistance: 8, pixelRatio: 2, chunkOpsPerFrame: 4 },
      { name: 'b', renderDistance: 2, pixelRatio: 1, chunkOpsPerFrame: 1 },
    ],
    degradeBelowFps: 60,
    recoverAboveFps: 59,
    degradeAfterSeconds: 1,
    recoverAfterSeconds: 1,
  });
  feed(custom, 55, 1.1);
  check('the thresholds are configurable', custom.level === 1 && custom.current.name === 'b', custom.current.name);
  feed(custom, 61, 1.1);
  check('and so is the recovery side', custom.level === 0, String(custom.level));

  let threw = false;
  try {
    new AdaptiveQuality({ levels: [] });
  } catch {
    threw = true;
  }
  check('an empty ladder is rejected', threw);
}

// ------------------------------------------------ what one chunk really costs
section('chunk generate + mesh cost (this machine, node)');
{
  const gen = new TerrainGenerator(SEED);
  const cache = new Map<string, Uint8Array>();
  const getBlock = (x: number, y: number, z: number): number => {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const key = cx + ',' + cz;
    let data = cache.get(key);
    if (!data) {
      data = gen.generate(cx, cz);
      cache.set(key, data);
    }
    return data[Chunk.index(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z)];
  };

  const COLS = 4;
  const ROUNDS = 3;
  const cells: Array<[number, number]> = [];
  for (let cx = 0; cx < COLS; cx++) for (let cz = 0; cz < COLS; cz++) cells.push([cx, cz]);

  let genMs = 0;
  let meshMs = 0;
  let quads = 0;
  let vertices = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const [cx, cz] of cells) {
      const key = cx + ',' + cz;
      const t0 = performance.now();
      cache.set(key, gen.generate(cx, cz));
      const t1 = performance.now();
      const buffers = buildChunkMeshData(cx * CHUNK_SIZE_X, cz * CHUNK_SIZE_Z, getBlock);
      const t2 = performance.now();
      genMs += t1 - t0;
      meshMs += t2 - t1;
      if (buffers) {
        quads += buffers.quadCount;
        vertices += buffers.positions.length / 3;
      }
    }
  }
  const samples = cells.length * ROUNDS;
  const genAvg = genMs / samples;
  const meshAvg = meshMs / samples;
  const totalAvg = genAvg + meshAvg;
  console.log(
    `  ..   ${samples} chunks: generate ${genAvg.toFixed(2)} ms, mesh ${meshAvg.toFixed(2)} ms, ` +
      `total ${totalAvg.toFixed(2)} ms/chunk (avg ${(quads / samples).toFixed(0)} quads, ${(vertices / samples).toFixed(0)} vertices)`,
  );

  check('a chunk generates in a fraction of a frame', genAvg < 8, `${genAvg.toFixed(2)} ms`);
  check('a chunk meshes in a fraction of a frame', meshAvg < 12, `${meshAvg.toFixed(2)} ms`);
  check('one chunk stays well inside a 60 fps budget (16.7 ms)', totalAvg < 16.7, `${totalAvg.toFixed(2)} ms`);

  const ops = QUALITY_LEVELS[0].chunkOpsPerFrame;
  console.log(
    `  ..   worst frame at ${ops} chunk builds/frame: ~${(totalAvg * ops).toFixed(1)} ms of the 16.7 ms budget ` +
      `(${((totalAvg * ops / 16.7) * 100).toFixed(0)}%)`,
  );
  check(
    'the default per-frame chunk budget is not a frame breaker',
    totalAvg * ops < 16.7,
    `${(totalAvg * ops).toFixed(1)} ms for ${ops} builds`,
  );
  console.log(
    '  ..   terrain generation is synchronous and stays on the main thread: ' +
      `at ${totalAvg.toFixed(2)} ms/chunk a Web Worker would only add latency`,
  );
}

// ------------------------------------------------------------------ report --
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const f of failures) console.log('  - ' + f);
  throw new Error(`${failures.length} perf smoke test failure(s)`);
}
