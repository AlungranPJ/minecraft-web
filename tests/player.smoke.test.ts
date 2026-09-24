/**
 * Headless smoke test for the first person player: physics, collision, input
 * and mouse look. No browser, no WebGL, no DOM (the look target is a test
 * double, so pointer lock stays untested here: tests/player.browser.test.mjs
 * covers that in a real Chrome).
 *
 *   npx tsx tests/player.smoke.test.ts
 */
import * as THREE from 'three';
import { Block } from '../src/engine/blocks';
import type { Game } from '../src/engine/game';
import { PlayerCollider } from '../src/player/collision';
import { DEFAULT_KEYMAP, KeyboardInput } from '../src/player/input';
import { MouseLook } from '../src/player/look';
import { PLAYER_DEFAULTS, PlayerPhysics, jumpSpeedFor, surfaceFeet, type MoveInput } from '../src/player/physics';
import { FirstPersonPlayer } from '../src/player/player';

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

function near(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance;
}

const DT = 1 / 60;

// ------------------------------------------------------------------ doubles --

/** A block map that answers getBlock like the engine World does. */
class StubWorld {
  readonly blocks = new Map<string, number>();
  /** Present only when the test wants the fast path. */
  heightAt?: (x: number, z: number) => number;

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y > 63) return Block.AIR;
    return this.blocks.get(`${x},${y},${z}`) ?? Block.AIR;
  }

  set(x: number, y: number, z: number, id: number): void {
    this.blocks.set(`${x},${y},${z}`, id);
  }

  fill(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, id = Block.STONE): void {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) this.set(x, y, z, id);
      }
    }
  }
}

/** Ground slab: everything below y=33 is solid, its top face is 33. */
function makeGround(world: StubWorld, radius = 24): StubWorld {
  world.fill(-radius, radius, 0, 32, -radius, radius, Block.STONE);
  world.heightAt = () => 32;
  return world;
}

class FakeTarget {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeElement extends FakeTarget {
  ownerDocument = new FakeTarget() as FakeTarget & { pointerLockElement: unknown; exitPointerLock?: () => void };
  requestPointerLock?: () => unknown;
  setPointerCapture?: () => void;
  releasePointerCapture?: () => void;
}

function keyEvent(code: string, extra: Record<string, unknown> = {}): any {
  return { code, repeat: false, target: null, preventDefault: () => {}, ...extra };
}

/** Deterministic pseudo random walk, used as a fuzz check for the collision code. */
class PhysicsRandomWalk {
  private readonly physics: PlayerPhysics;

  constructor(physics: PlayerPhysics) {
    this.physics = physics;
  }

  run(): { inside: number; minY: number; maxY: number; frames: number } {
    this.physics.spawnOnSurface(0.5, 0.5);
    let seed = 123456789;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let inside = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 600; i++) {
      const angle = rand() * Math.PI * 2;
      const input: MoveInput = {
        wishX: Math.cos(angle),
        wishZ: Math.sin(angle),
        sprint: rand() > 0.5,
        jump: rand() > 0.6,
      };
      this.physics.step(DT, input);
      if (this.physics.isStuck) inside++;
      minY = Math.min(minY, this.physics.y);
      maxY = Math.max(maxY, this.physics.y);
    }
    return { inside, minY, maxY, frames: 600 };
  }
}

const walk = (physics: PlayerPhysics, frames: number, input: MoveInput, onFrame?: (i: number) => void): void => {
  for (let i = 0; i < frames; i++) {
    physics.step(DT, input);
    onFrame?.(i);
  }
};

// ------------------------------------------------------------- constants ----

section('physics constants');
{
  const physics = new PlayerPhysics(makeGround(new StubWorld()));
  check('player box is 0.6 x 1.8', physics.size.width === 0.6 && physics.size.height === 1.8, `${physics.size.width}x${physics.size.height}`);
  check('walk speed is 4.3 blocks/s', physics.walkSpeed === 4.3, String(physics.walkSpeed));
  check('sprint speed is 5.6 blocks/s', physics.sprintSpeed === 5.6, String(physics.sprintSpeed));
  check('eye height is 1.62', PLAYER_DEFAULTS.eyeHeight === 1.62, String(PLAYER_DEFAULTS.eyeHeight));
  check('gravity is 28 blocks/s^2', physics.gravity === 28, String(physics.gravity));

  const expected = Math.sqrt(2 * 28 * 1.25);
  check('jump speed comes from the target jump height', near(physics.jumpSpeed, expected, 1e-9), `${physics.jumpSpeed} vs ${expected}`);
  check('jump height = jumpSpeed^2 / 2g', near(physics.jumpHeight, 1.25, 1e-9), String(physics.jumpHeight));
  check('jumpSpeedFor() helper matches', near(jumpSpeedFor(28, 1.25), physics.jumpSpeed, 1e-12));
  check('square of 2gh: apex clears one block with margin', physics.jumpHeight > 1 && physics.jumpHeight < 1.5, String(physics.jumpHeight));
}

// ---------------------------------------------------------------- spawning --

section('spawning');
{
  const world = makeGround(new StubWorld());
  world.set(0, 33, 0, Block.WOOD);
  world.set(0, 34, 0, Block.WOOD);
  world.set(0, 35, 0, Block.LEAVES);
  const physics = new PlayerPhysics(world);
  physics.spawnOnSurface(0.5, 0.5);
  check('spawn stands one block above the surface of the column', physics.y === 36, String(physics.y));
  check('spawn uses the requested column', physics.x === 0.5 && physics.z === 0.5, `${physics.x},${physics.z}`);
  check('spawn is not inside a block', !physics.isStuck);
  physics.settle();
  check('settle leaves the player standing', physics.onGround && physics.vy === 0, `${physics.onGround}/${physics.vy}`);

  const flat = new PlayerPhysics(makeGround(new StubWorld()));
  flat.spawnOnSurface(3.5, -2.5);
  check('flat ground spawn is at surface top + 1', flat.y === 33, String(flat.y));

  const scanWorld = new StubWorld();
  scanWorld.fill(-8, 8, 0, 19, -8, 8, Block.STONE); // no heightAt(): forces the scan path
  check('surfaceFeet scans when the world has no heightAt()', surfaceFeet(scanWorld, 0, 0) === 20, String(surfaceFeet(scanWorld, 0, 0)));

  const teleported = new PlayerPhysics(makeGround(new StubWorld()));
  teleported.teleport(0.5, 32.2, 0.5); // feet inside the ground block
  check('teleport into a block pushes the box out', !teleported.isStuck, JSON.stringify([teleported.x, teleported.y, teleported.z]));
  check('teleport clears momentum', teleported.vx === 0 && teleported.vy === 0 && teleported.vz === 0);
}

// ------------------------------------------------------- gravity & ground ---

section('gravity, standing, terminal velocity');
{
  const physics = new PlayerPhysics(makeGround(new StubWorld()));
  physics.teleport(0.5, 40, 0.5);
  let minY = Infinity;
  let landed = 0;
  for (let i = 0; i < 300; i++) {
    physics.step(DT);
    minY = Math.min(minY, physics.y);
    if (physics.onGround && landed === 0) landed = i;
  }
  check('falls until it lands on the surface', physics.y === 33 && physics.onGround, String(physics.y));
  check('never sinks below the surface', minY === 33, String(minY));
  check('landing stops the fall (vy = 0)', physics.vy === 0, String(physics.vy));

  // standing still for 2 s: the reported position must not move at all
  let jitter = 0;
  for (let i = 0; i < 120; i++) {
    physics.step(DT);
    if (physics.y !== 33) jitter++;
  }
  check('standing still does not jitter or sink (120 frames)', jitter === 0, `${jitter} frames off`);
  check('standing still keeps vy at 0', physics.vy === 0, String(physics.vy));

  // landing must snap onto the surface in the frame it touches it (no creep)
  const snapping = new PlayerPhysics(makeGround(new StubWorld()));
  snapping.teleport(0.5, 36, 0.5);
  let landedY = -1;
  for (let i = 0; i < 200 && landedY < 0; i++) {
    snapping.step(DT);
    if (snapping.onGround) landedY = snapping.y;
  }
  check('the first grounded frame is already exactly on the surface', landedY === 33, String(landedY));
  let creep = 0;
  for (let i = 0; i < 60; i++) {
    snapping.step(DT);
    if (snapping.y !== 33) creep++;
  }
  check('no downward creep after landing (60 frames)', creep === 0, String(creep));

  const falling = new PlayerPhysics(
    new StubWorld(), // no ground at all: free fall, so the terminal velocity clamp is reachable
    { voidY: -100000 },
  );
  falling.teleport(0.5, 63, 0.5);
  walk(falling, 300, { wishX: 0, wishZ: 0, sprint: false, jump: false });
  check('fall speed is capped at the terminal velocity (78)', near(falling.vy, -78, 1e-6), String(falling.vy));

  const capped = new PlayerPhysics(makeGround(new StubWorld()), { terminalVelocity: 5 });
  capped.teleport(0.5, 63, 0.5);
  let maxFall = 0;
  for (let i = 0; i < 30; i++) {
    capped.step(DT);
    maxFall = Math.min(maxFall, capped.vy);
  }
  check('terminal velocity is configurable', maxFall >= -5 - 1e-9, String(maxFall));
}

// -------------------------------------------------------------- walking ----

section('walking, sprinting, friction');
{
  const physics = new PlayerPhysics(makeGround(new StubWorld()));
  physics.teleport(0.5, 33, 0.5);
  const forward: MoveInput = { wishX: 1, wishZ: 0, sprint: false, jump: false };
  walk(physics, 60, forward);
  check('walk speed converges to 4.3 blocks/s', near(physics.speed, 4.3, 0.01), physics.speed.toFixed(4));
  check('x velocity matches the wish direction', near(physics.vx, 4.3, 0.01) && physics.vz === 0, `${physics.vx}/${physics.vz}`);

  const start = physics.x;
  walk(physics, 120, forward);
  const distance = physics.x - start;
  check('two seconds of walking covers ~8.6 blocks', distance > 8.4 && distance < 8.7, distance.toFixed(3));
  check('walking on flat ground keeps the feet at the surface', physics.y === 33, String(physics.y));

  const sprint = new PlayerPhysics(makeGround(new StubWorld()));
  sprint.teleport(0.5, 33, 0.5);
  walk(sprint, 60, { wishX: 0, wishZ: 1, sprint: true, jump: false });
  check('sprint speed converges to 5.6 blocks/s', near(sprint.speed, 5.6, 0.01), sprint.speed.toFixed(4));
  check('sprinting flag is reported', sprint.sprinting);

  const diagonal = new PlayerPhysics(makeGround(new StubWorld()));
  diagonal.teleport(0.5, 33, 0.5);
  walk(diagonal, 60, { wishX: Math.SQRT1_2, wishZ: Math.SQRT1_2, sprint: false, jump: false });
  check('diagonal walking is not faster (normalized wish)', near(diagonal.speed, 4.3, 0.01), diagonal.speed.toFixed(4));

  const stopped = new PlayerPhysics(makeGround(new StubWorld()));
  stopped.teleport(0.5, 33, 0.5);
  walk(stopped, 60, forward);
  walk(stopped, 30, { wishX: 0, wishZ: 0, sprint: false, jump: false });
  check('releasing the keys stops the player within 0.5 s', stopped.vx === 0 && stopped.vz === 0, `${stopped.vx}/${stopped.vz}`);
}

// -------------------------------------------------------------- jumping ----

section('jumping');
{
  const physics = new PlayerPhysics(makeGround(new StubWorld()));
  physics.teleport(0.5, 33, 0.5);
  const startY = physics.y;
  let apex = startY;
  let airborneFrames = 0;
  for (let i = 0; i < 120; i++) {
    physics.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: i < 2 });
    apex = Math.max(apex, physics.y);
    if (!physics.onGround) airborneFrames++;
  }
  // Semi implicit Euler overshoots the analytic apex by about v*dt/2, so at
  // 60 Hz the measured apex sits a hair above the 1.25 blocks the constant asks
  // for, and it converges to 1.25 as the step shrinks.
  check('jump apex is 1.25 blocks (one integrator step of slack at 60 Hz)', apex - startY >= 1.25 && apex - startY <= 1.33, (apex - startY).toFixed(4));
  check('jump becomes airborne', airborneFrames > 20, String(airborneFrames));
  check('lands back on the surface', physics.y === startY && physics.onGround, String(physics.y));

  const fine = new PlayerPhysics(makeGround(new StubWorld()));
  fine.teleport(0.5, 33, 0.5);
  let fineApex = fine.y;
  for (let i = 0; i < 480; i++) {
    fine.step(1 / 240, { wishX: 0, wishZ: 0, sprint: false, jump: i < 4 });
    fineApex = Math.max(fineApex, fine.y);
  }
  check('at 240 Hz the apex converges to the analytic jump height', near(fineApex - 33, 1.25, 0.03), (fineApex - 33).toFixed(4));

  // holding jump must not repeat the jump (edge triggered)
  const held = new PlayerPhysics(makeGround(new StubWorld()));
  held.teleport(0.5, 33, 0.5);
  let jumps = 0;
  let wasGround = true;
  for (let i = 0; i < 300; i++) {
    held.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: true });
    if (wasGround && !held.onGround) jumps++;
    wasGround = held.onGround;
  }
  check('holding jump does not bunny hop', jumps === 1, String(jumps));

  // no double jump: pressing again in the air must do nothing
  const doubleJump = new PlayerPhysics(makeGround(new StubWorld()));
  doubleJump.teleport(0.5, 33, 0.5);
  doubleJump.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: true });
  let apex2 = doubleJump.y;
  for (let i = 0; i < 60; i++) {
    doubleJump.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: i % 4 === 0 });
    apex2 = Math.max(apex2, doubleJump.y);
  }
  check('spamming jump in the air cannot double jump', apex2 - 33 <= 1.33 && apex2 - 33 >= 1.25, (apex2 - 33).toFixed(4));

  // ceiling: head stops at the block above
  const ceilingWorld = makeGround(new StubWorld());
  ceilingWorld.fill(-4, 4, 35, 35, -4, 4, Block.STONE);
  const ceiling = new PlayerPhysics(ceilingWorld);
  ceiling.teleport(0.5, 33, 0.5);
  let top = 0;
  for (let i = 0; i < 60; i++) {
    ceiling.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: true });
    top = Math.max(top, ceiling.y + ceiling.size.height);
  }
  check('a block above stops the jump', top <= 35 + 1e-9, String(top));
  check('head bump does not push through the ceiling', ceiling.y + ceiling.size.height <= 35 + 1e-9, `${ceiling.y}`);
  check('head bump zeroes the vertical speed', ceiling.onGround || ceiling.vy <= 0, String(ceiling.vy));

  // jump onto a one block step while walking
  const stepWorld = makeGround(new StubWorld());
  stepWorld.fill(2, 2, 33, 33, -1, 1, Block.STONE);
  const step = new PlayerPhysics(stepWorld);
  step.teleport(0.5, 33, 0.5);
  let onStep = false;
  for (let i = 0; i < 240 && !onStep; i++) {
    step.step(DT, { wishX: 1, wishZ: 0, sprint: false, jump: i < 2 });
    if (step.onGround && step.y === 34) onStep = true;
  }
  check('walking + jumping climbs a 1 block step', onStep, `y=${step.y} x=${step.x.toFixed(2)}`);
  check('standing on the step is not stuck inside it', !step.isStuck);

  // jump buffer: pressing shortly before landing jumps on landing
  const buffered = new PlayerPhysics(makeGround(new StubWorld()));
  buffered.teleport(0.5, 36, 0.5);
  let bumped = false;
  for (let i = 0; i < 90; i++) {
    const jump = i === 24; // ~0.4 s in, still falling, lands ~0.46 s
    buffered.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump });
    if (i > 24 && buffered.vy > 1) bumped = true;
  }
  check('jump pressed before landing fires on landing (buffer)', bumped, String(buffered.vy));

  // coyote time: jumping just after walking off an edge
  const ledge = new StubWorld();
  ledge.fill(-8, 2, 0, 32, -4, 4, Block.STONE);
  ledge.heightAt = () => 32;
  const coyote = new PlayerPhysics(ledge);
  coyote.teleport(0.5, 33, 0.5);
  let leftGround = -1;
  for (let i = 0; i < 240 && leftGround < 0; i++) {
    coyote.step(DT, { wishX: 1, wishZ: 0, sprint: false, jump: false });
    if (!coyote.onGround) leftGround = i;
  }
  coyote.step(DT, { wishX: 1, wishZ: 0, sprint: false, jump: true });
  let jumped = false;
  for (let i = 0; i < 5; i++) {
    coyote.step(DT, { wishX: 1, wishZ: 0, sprint: false, jump: false });
    if (coyote.vy > 1) jumped = true;
  }
  check('walked off the edge before the jump', leftGround >= 0, String(leftGround));
  check('coyote time allows a jump just after leaving the ground', jumped, String(coyote.vy));

  const late = new PlayerPhysics(ledge);
  late.teleport(0.5, 33, 0.5);
  let lateLeft = -1;
  for (let i = 0; i < 240 && lateLeft < 0; i++) {
    late.step(DT, { wishX: 1, wishZ: 0, sprint: false, jump: false });
    if (!late.onGround) lateLeft = i;
  }
  walk(late, 10, { wishX: 0, wishZ: 0, sprint: false, jump: false }); // 0.17 s of falling: coyote has expired
  late.step(DT, { wishX: 0, wishZ: 0, sprint: false, jump: true });
  check('coyote time expires (no jump long after the edge)', late.vy <= 0 && !late.onGround, `${late.vy}/${late.onGround}`);
}

// ------------------------------------------------------------ collision ----

section('collision');
{
  const world = makeGround(new StubWorld());
  world.fill(5, 5, 33, 36, -4, 4, Block.STONE); // wall face at x = 5
  const physics = new PlayerPhysics(world);
  physics.teleport(0.5, 33, 0.5);
  let overlapFrames = 0;
  let maxX = -Infinity;
  for (let i = 0; i < 180; i++) {
    physics.step(DT, { wishX: 1, wishZ: 0, sprint: true, jump: false });
    if (physics.isStuck) overlapFrames++;
    maxX = Math.max(maxX, physics.x);
  }
  check('walking into a wall never enters the wall', overlapFrames === 0, `${overlapFrames} frames inside`);
  check('the box stops at the wall face', near(physics.x + 0.3, 5, 1e-6), String(physics.x + 0.3));
  check('no jitter against the wall (x does not drift back)', maxX <= 5 - 0.3 + 1e-9, String(maxX));
  check('the wall blocks the horizontal speed', physics.vx === 0, String(physics.vx));

  // high speed: a rocket must not tunnel through the wall either
  for (const dt of [1 / 60, 1 / 30, 0.1]) {
    const rocket = new PlayerPhysics(world);
    rocket.teleport(0.5, 33, 0.5);
    rocket.vx = 50;
    let inside = false;
    let tunneled = false;
    for (let i = 0; i < 60; i++) {
      rocket.step(dt, { wishX: 1, wishZ: 0, sprint: true, jump: false });
      if (rocket.isStuck) inside = true;
      if (rocket.x > 5.3) tunneled = true;
    }
    check(`no tunnelling at 50 blocks/s (dt ${dt.toFixed(3)})`, !inside && !tunneled, `x=${rocket.x.toFixed(3)}`);
  }

  // falling fast onto a thin floor must not tunnel either
  const thin = new StubWorld();
  thin.fill(-8, 8, 0, 32, -8, 8, Block.STONE);
  const drop = new PlayerPhysics(thin);
  drop.teleport(0.5, 62, 0.5);
  let belowFloor = false;
  for (let i = 0; i < 200; i++) {
    drop.step(0.1, { wishX: 0, wishZ: 0, sprint: false, jump: false });
    if (drop.y < 33) belowFloor = true;
  }
  check('a 7.8 block per frame fall lands on the floor', !belowFloor && drop.y === 33, String(drop.y));

  // water is not solid
  const water = makeGround(new StubWorld());
  water.set(0, 33, 0, Block.WATER);
  water.set(0, 34, 0, Block.WATER);
  const swimmer = new PlayerPhysics(water);
  swimmer.teleport(0.5, 36, 0.5);
  walk(swimmer, 120, { wishX: 0, wishZ: 0, sprint: false, jump: false });
  check('water does not block the player', swimmer.y === 33 && swimmer.onGround, String(swimmer.y));

  // outside the world there is nothing to collide with
  const empty = new PlayerPhysics(new StubWorld());
  empty.teleport(0.5, 40, 0.5);
  walk(empty, 30, { wishX: 0, wishZ: 0, sprint: false, jump: false });
  check('air has no collision (the player keeps falling)', empty.y < 40 && !empty.onGround, String(empty.y));

  // a block placed where the player stands must not trap them
  const trapWorld = makeGround(new StubWorld());
  const trapped = new PlayerPhysics(trapWorld);
  trapped.teleport(0.5, 33, 0.5);
  trapWorld.set(0, 33, 0, Block.STONE); // the block the player box occupies
  trapped.step(DT);
  check('a block placed inside the player pushes them out', !trapped.isStuck, JSON.stringify([trapped.x.toFixed(2), trapped.y, trapped.z.toFixed(2)]));
  check('getting unstuck keeps the player on the ground', trapped.y >= 33, String(trapped.y));

  // unstick() itself: deeper penetration pops out the nearest face
  const collider = new PlayerCollider(makeGround(new StubWorld()), { width: 0.6, height: 1.8 });
  const fixed = collider.unstick(0.5, 32.5, 0.5);
  check('unstick() resolves a 0.5 block penetration', !collider.overlapsAt(fixed.x, fixed.y, fixed.z) && fixed.passes > 0, JSON.stringify(fixed));

  // a long random walk never ends up inside the world
  const random = new PhysicsRandomWalk(new PlayerPhysics(makeGround(new StubWorld(), 40)));
  const report = random.run();
  check('10 s of random input never leaves the player inside a block', report.inside === 0, String(report.inside));
  check('10 s of random input never falls through the floor', report.minY >= 33 - 1e-9, String(report.minY));
}

// ------------------------------------------------------------ input map ----

section('keyboard input');
{
  const target = new FakeTarget();
  const input = new KeyboardInput(target);
  check('default keymap maps WASD', DEFAULT_KEYMAP.forward[0] === 'KeyW' && DEFAULT_KEYMAP.left[0] === 'KeyA');
  check('arrows are mapped too', DEFAULT_KEYMAP.forward.includes('ArrowUp'));

  target.dispatch('keydown', keyEvent('KeyW'));
  check('keydown sets the action', input.isDown('forward'));
  check('axes() reports forward = 1', input.axes().forward === 1, JSON.stringify(input.axes()));
  target.dispatch('keyup', keyEvent('KeyW'));
  check('keyup clears the action', !input.isDown('forward'));

  target.dispatch('keydown', keyEvent('KeyW'));
  target.dispatch('keydown', keyEvent('KeyD'));
  check('W + D gives a forward/strafe diagonal', JSON.stringify(input.axes()) === JSON.stringify({ forward: 1, strafe: 1 }));
  target.dispatch('keydown', keyEvent('ShiftLeft'));
  check('shift maps to sprint', input.isDown('sprint'));

  target.dispatch('blur');
  check('window blur releases every key', !input.isDown('forward') && !input.isDown('sprint'));

  let swallowed = false;
  target.dispatch('keydown', keyEvent('Space', { preventDefault: () => (swallowed = true) }));
  check('space is swallowed so the page does not scroll', swallowed && input.isDown('jump'));

  target.dispatch('keydown', keyEvent('KeyW', { target: { tagName: 'INPUT' } }));
  check('keys typed into a text field are ignored', !input.isDown('forward'));

  input.setKeymap({ forward: ['KeyI'], jump: ['KeyK'] });
  target.dispatch('keydown', keyEvent('KeyW'));
  check('remapping drops the old key', !input.isDown('forward'));
  target.dispatch('keydown', keyEvent('KeyI'));
  check('remapping binds the new key', input.isDown('forward'));
  check('getKeymap() returns the current mapping', input.getKeymap().forward[0] === 'KeyI');

  let threw = false;
  try {
    input.setKeymap({ nope: ['KeyZ'] } as never);
  } catch {
    threw = true;
  }
  check('an unknown action throws', threw);

  threw = false;
  try {
    input.setKeymap({ forward: [] });
  } catch {
    threw = true;
  }
  check('an empty key list throws', threw);

  input.dispose();
  target.dispatch('keydown', keyEvent('KeyI'));
  check('dispose() stops listening', !input.isDown('forward'));
}

// ------------------------------------------------------------- mouse look ---

section('mouse look');
{
  const look = new MouseLook(null);
  look.look(100, 0);
  check('yaw follows the horizontal delta', near(look.yaw, -0.22, 1e-9), String(look.yaw));
  look.look(0, -100);
  check('moving the mouse up looks up', look.pitch > 0, String(look.pitch));

  look.look(0, 1e6);
  const limit = THREE.MathUtils.degToRad(89);
  check('pitch is clamped to -89 degrees', near(look.pitch, -limit, 1e-12), String(look.pitch));
  look.look(0, -1e7);
  check('pitch is clamped to +89 degrees', near(look.pitch, limit, 1e-12), String(look.pitch));

  const camera = new THREE.PerspectiveCamera();
  look.setLook(0.7, 2.0); // past the limit, must clamp
  look.applyTo(camera);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  check('setLook() clamps as well', near(look.pitch, limit, 1e-12), String(look.pitch));
  check('the camera is never rolled over (up.y > 0)', up.y > 0, String(up.y));
  check('the view is never exactly vertical (no gimbal flip)', Math.abs(forward.y) < 0.9999999, String(forward.y));
  check('the forward vector stays unit length', near(forward.length(), 1, 1e-9), String(forward.length()));

  const sensitivity = new MouseLook(null, { sensitivity: 0.01, invertY: true });
  sensitivity.look(10, 10);
  check('sensitivity is configurable', near(sensitivity.yaw, -0.1, 1e-9), String(sensitivity.yaw));
  check('invertY flips the vertical axis', sensitivity.pitch > 0, String(sensitivity.pitch));

  // pointer lock lifecycle through a test double
  const element = new FakeElement();
  element.ownerDocument.pointerLockElement = null;
  let lockRequests = 0;
  element.requestPointerLock = () => {
    lockRequests++;
    element.ownerDocument.pointerLockElement = element;
    element.ownerDocument.dispatch('pointerlockchange');
    return Promise.resolve();
  };
  element.ownerDocument.exitPointerLock = () => {
    element.ownerDocument.pointerLockElement = null;
    element.ownerDocument.dispatch('pointerlockchange');
  };
  const locking = new MouseLook(element as unknown as HTMLElement, { yaw: 0 });
  const lockStates: boolean[] = [];
  locking.onLockChange = (locked) => lockStates.push(locked);
  check('starts unlocked', !locking.locked);

  element.dispatch('click');
  check('a click asks for the pointer lock', lockRequests === 1 && locking.locked, `${lockRequests}/${locking.locked}`);
  check('onLockChange fired', lockStates.length === 1 && lockStates[0] === true, JSON.stringify(lockStates));

  element.ownerDocument.dispatch('mousemove', { movementX: 50, movementY: 0 });
  check('movement deltas rotate the camera while locked', near(locking.yaw, -0.11, 1e-9), String(locking.yaw));

  locking.exitLock();
  check('exiting the lock is reported (ESC)', !locking.locked && lockStates[1] === false, JSON.stringify(lockStates));

  element.dispatch('pointerdown', { button: 0, pointerId: 1 });
  element.dispatch('pointermove', { movementX: -50, movementY: 0 });
  check('drag look works while unlocked', near(locking.yaw, 0, 1e-9), String(locking.yaw));
  element.dispatch('pointerup', {});
  element.dispatch('pointermove', { movementX: -50, movementY: 0 });
  check('releasing the button stops drag look', near(locking.yaw, 0, 1e-9), String(locking.yaw));

  // a camera-less look controller is legal, and no document means no listeners
  const bare = new MouseLook(null);
  check('a look controller without an element still works', bare.element === null && bare.look(10, 0) === undefined);
  locking.dispose();
  element.dispatch('pointerdown', { button: 0, pointerId: 2 });
  element.dispatch('pointermove', { movementX: 50, movementY: 0 });
  check('dispose() removes the listeners', near(locking.yaw, 0, 1e-9), String(locking.yaw));
}

// ------------------------------------------------------ player (headless) ---

section('first person player (headless)');
{
  const world = makeGround(new StubWorld());
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  const element = new FakeElement();
  const player = new FirstPersonPlayer({
    world,
    camera,
    element: element as unknown as HTMLElement,
    keyTarget: element,
    position: [0.5, 33, 0.5],
    yaw: 0,
  });
  check('camera starts at eye height above the feet', near(camera.position.y, 33 + 1.62, 1e-9), String(camera.position.y));
  check('position starts at the feet', player.position.y === 33 && player.position.x === 0.5);

  let frames = 0;
  const off = player.onUpdate(() => frames++);
  player.input.setAction('forward', true);
  for (let i = 0; i < 60; i++) player.update(DT);
  check('W walks toward -z at yaw 0', player.position.z < -3.5 && near(player.position.x, 0.5, 1e-9), `${player.position.x.toFixed(2)},${player.position.z.toFixed(2)}`);
  check('the camera follows the player every frame', near(camera.position.z, player.position.z, 1e-9) && near(camera.position.y, 33 + 1.62, 1e-9));
  check('onUpdate fires once per frame', frames === 60, String(frames));
  check('the reported state carries speed and ground contact', player.state.speed > 4.2 && player.state.onGround, `${player.state.speed.toFixed(2)}/${player.state.onGround}`);
  off();
  player.update(DT);
  check('unsubscribing stops the listener', frames === 60, String(frames));

  player.input.setAction('forward', false);
  player.setLook(Math.PI / 2, -0.2);
  player.input.setAction('forward', true);
  for (let i = 0; i < 60; i++) player.update(DT);
  check('yaw rotates the walk direction', near(player.position.x, 0.5 - 4.3, 0.2), player.position.x.toFixed(2));
  check('pitch does not slow the walk down', near(player.state.speed, 4.3, 0.05), player.state.speed.toFixed(3));

  const spawned = new FirstPersonPlayer({ world, camera, keyTarget: element });
  check('a player without an explicit position spawns on the surface at 0,0', spawned.position.y === 33, String(spawned.position.y));
  check('spawn is reported every frame as grounded', spawned.state.onGround || spawned.onGround);

  // mount() must hand the update to the engine loop and be undoable
  let registered = 0;
  let removed = 0;
  const game = {
    onFrame: (cb: (dt: number) => void) => {
      registered++;
      return () => {
        removed++;
        void cb;
      };
    },
  };
  const mounted = new FirstPersonPlayer({ world, camera, keyTarget: element, position: [0.5, 33, 0.5] });
  const unmount = mounted.mount(game as unknown as Game);
  check('mount() registers the step on game.onFrame', registered === 1, String(registered));
  unmount();
  check('unmount() releases the frame callback', removed === 1, String(removed));

  const frozen = mounted.position.clone();
  mounted.dispose();
  mounted.update(DT);
  check('dispose() stops the player from updating', mounted.position.equals(frozen));

  // no key target and no window must fail loudly instead of silently ignoring input
  let threw = false;
  try {
    new FirstPersonPlayer({ world, camera });
  } catch {
    threw = true;
  }
  check('a player with no key target throws', threw);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log('  - ' + failure);
  throw new Error(`${failures.length} player smoke test failure(s)`);
}
