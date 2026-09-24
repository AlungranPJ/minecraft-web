/**
 * First person player physics: gravity, horizontal acceleration, jumping and a
 * swept AABB against the voxel world. No THREE, no DOM, no camera: pure state
 * plus a `getBlock(x,y,z)` source, so it is unit testable in node.
 *
 * Units are blocks and seconds. All defaults are tuned to feel like vanilla
 * Minecraft (see `PLAYER_DEFAULTS` and `docs/player-controller.md`).
 */
import { isSolid } from '../engine/blocks';
import { PlayerCollider, createMoveResult, type BlockSource, type MoveResult, type PlayerSize } from './collision';

/** A world that can also report its terrain surface height (the engine's `World` does). */
export interface SurfaceSource extends BlockSource {
  heightAt?(x: number, z: number): number;
}

export interface PhysicsOptions {
  size?: Partial<PlayerSize>;
  /** Blocks per second while walking. Default 4.3. */
  walkSpeed?: number;
  /** Blocks per second while sprinting (Shift). Default 5.6. */
  sprintSpeed?: number;
  /** Downward acceleration in blocks/s^2. Default 28. */
  gravity?: number;
  /** Peak height of a jump in blocks. Ignored when `jumpSpeed` is given. Default 1.25. */
  jumpHeight?: number;
  /** Initial upward speed of a jump. Default `sqrt(2 * gravity * jumpHeight)` = 8.3666. */
  jumpSpeed?: number;
  /** Horizontal acceleration on the ground, blocks/s^2. Default 60. */
  groundAccel?: number;
  /** Horizontal acceleration in the air (air control). Default 12. */
  airAccel?: number;
  /** Exponential damping per second with no input on the ground. Default 18. */
  groundFriction?: number;
  /** Exponential damping per second with no input in the air. Default 0.4. */
  airDrag?: number;
  /** Downward speed cap in blocks/s. Default 78. */
  terminalVelocity?: number;
  /** How long a jump press is remembered before landing. Default 0.15 s. */
  jumpBufferTime?: number;
  /** Grace period to still jump after walking off an edge. Default 0.08 s. */
  coyoteTime?: number;
  /** Longest simulated step; longer frames are clamped to this. Default 0.1 s. */
  maxStepTime?: number;
  /** Distance used to probe for ground under the feet. Default 0.06 blocks. */
  groundProbe?: number;
  /** Falling below this y is treated as falling out of the world (respawn). Default -16. */
  voidY?: number;
  /** Longest collision substep. Default 0.1 blocks. */
  maxSubstep?: number;
}

export interface MoveInput {
  /** Horizontal wish direction in world space, already rotated by yaw. */
  wishX: number;
  wishZ: number;
  /** Sprint (Shift) held. */
  sprint: boolean;
  /** Jump (Space) held. */
  jump: boolean;
}

export interface PhysicsState {
  /** Feet position: the box bottom, the camera sits `eyeHeight` above it. */
  x: number;
  y: number;
  z: number;
  /** Velocity in blocks/s. */
  vx: number;
  vy: number;
  vz: number;
  /** Horizontal speed in blocks/s. */
  speed: number;
  onGround: boolean;
  sprinting: boolean;
  flying: boolean;
}

/**
 * Physics constants, all in blocks and seconds.
 *
 * | constant | value | why |
 * |---|---|---|
 * | width / height | 0.6 / 1.8 | vanilla player box |
 * | walkSpeed | 4.3 | vanilla walking speed |
 * | sprintSpeed | 5.6 | vanilla sprinting speed |
 * | jumpHeight | 1.25 | clears a one block step with room to spare |
 * | gravity | 28 | vanilla-ish (32 is vanilla, 28 keeps the jump arc snappy) |
 * | groundAccel | 60 | full walk speed in ~0.07 s |
 * | airAccel | 12 | air control, noticeably weaker than on the ground |
 * | groundFriction | 18 | stops within ~0.25 s after releasing the keys |
 * | airDrag | 0.4 | momentum is mostly kept through a jump |
 * | terminalVelocity | 78 | vanilla fall speed cap |
 */
export const PLAYER_DEFAULTS = {
  width: 0.6,
  height: 1.8,
  eyeHeight: 1.62,
  walkSpeed: 4.3,
  sprintSpeed: 5.6,
  jumpHeight: 1.25,
  gravity: 28,
  groundAccel: 60,
  airAccel: 12,
  groundFriction: 18,
  airDrag: 0.4,
  terminalVelocity: 78,
  jumpBufferTime: 0.15,
  coyoteTime: 0.08,
  maxStepTime: 0.1,
  groundProbe: 0.06,
  voidY: -16,
  maxSubstep: 0.1,
} as const;

/** Upward speed that reaches `jumpHeight` under `gravity`: v = sqrt(2 g h). */
export function jumpSpeedFor(gravity: number, jumpHeight: number): number {
  return Math.sqrt(2 * gravity * jumpHeight);
}

/** Highest y the feet can rest at, at this column. */
export function surfaceFeet(world: SurfaceSource, x: number, z: number): number {
  let top: number;
  if (typeof world.heightAt === 'function') {
    top = Math.floor(world.heightAt(x, z));
    let guard = 0;
    while (guard++ < 64 && isSolid(world.getBlock(x, top + 1, z))) top++;
  } else {
    top = 63;
    let guard = 0;
    while (top > 0 && guard++ < 128 && !isSolid(world.getBlock(x, top, z))) top--;
  }
  return Math.max(top + 1, 1);
}

const NO_INPUT: MoveInput = { wishX: 0, wishZ: 0, sprint: false, jump: false };

export class PlayerPhysics {
  readonly world: SurfaceSource;
  readonly collider: PlayerCollider;
  readonly size: PlayerSize;

  readonly walkSpeed: number;
  readonly sprintSpeed: number;
  readonly gravity: number;
  readonly jumpSpeed: number;
  readonly groundAccel: number;
  readonly airAccel: number;
  readonly groundFriction: number;
  readonly airDrag: number;
  readonly terminalVelocity: number;
  readonly jumpBufferTime: number;
  readonly coyoteTime: number;
  readonly maxStepTime: number;
  readonly groundProbe: number;
  readonly voidY: number;
  readonly eyeHeight: number;

  /** Feet position. */
  x = 0;
  y = 0;
  z = 0;
  /** Velocity in blocks/s. */
  vx = 0;
  vy = 0;
  vz = 0;
  onGround = false;
  sprinting = false;
  /** No gravity and no vertical motion (debug parking / creative flight). */
  flying = false;
  /** Where the void guard puts the player back. */
  spawnX = 0;
  spawnY = 64;
  spawnZ = 0;

  private jumpBuffer = 0;
  private coyote = 0;
  private jumpWasHeld = false;
  private readonly moveResult: MoveResult = createMoveResult();
  private readonly settleResult: MoveResult = createMoveResult();

  constructor(world: SurfaceSource, options: PhysicsOptions = {}) {
    this.world = world;
    this.size = {
      width: options.size?.width ?? PLAYER_DEFAULTS.width,
      height: options.size?.height ?? PLAYER_DEFAULTS.height,
    };
    this.eyeHeight = PLAYER_DEFAULTS.eyeHeight;
    this.walkSpeed = options.walkSpeed ?? PLAYER_DEFAULTS.walkSpeed;
    this.sprintSpeed = options.sprintSpeed ?? PLAYER_DEFAULTS.sprintSpeed;
    this.gravity = options.gravity ?? PLAYER_DEFAULTS.gravity;
    this.jumpSpeed =
      options.jumpSpeed ?? jumpSpeedFor(this.gravity, options.jumpHeight ?? PLAYER_DEFAULTS.jumpHeight);
    this.groundAccel = options.groundAccel ?? PLAYER_DEFAULTS.groundAccel;
    this.airAccel = options.airAccel ?? PLAYER_DEFAULTS.airAccel;
    this.groundFriction = options.groundFriction ?? PLAYER_DEFAULTS.groundFriction;
    this.airDrag = options.airDrag ?? PLAYER_DEFAULTS.airDrag;
    this.terminalVelocity = options.terminalVelocity ?? PLAYER_DEFAULTS.terminalVelocity;
    this.jumpBufferTime = options.jumpBufferTime ?? PLAYER_DEFAULTS.jumpBufferTime;
    this.coyoteTime = options.coyoteTime ?? PLAYER_DEFAULTS.coyoteTime;
    this.maxStepTime = options.maxStepTime ?? PLAYER_DEFAULTS.maxStepTime;
    this.groundProbe = options.groundProbe ?? PLAYER_DEFAULTS.groundProbe;
    this.voidY = options.voidY ?? PLAYER_DEFAULTS.voidY;
    this.collider = new PlayerCollider(world, this.size, options.maxSubstep ?? PLAYER_DEFAULTS.maxSubstep);
  }

  /** Peak height a jump reaches with the configured values. */
  get jumpHeight(): number {
    return (this.jumpSpeed * this.jumpSpeed) / (2 * this.gravity);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /** True when the player box is inside a solid block (should never stay that way). */
  get isStuck(): boolean {
    return this.collider.overlapsAt(this.x, this.y, this.z);
  }

  /** Places the feet and clears momentum. */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.jumpBuffer = 0;
    this.coyote = 0;
    const fixed = this.collider.unstick(x, y, z);
    this.x = fixed.x;
    this.y = fixed.y;
    this.z = fixed.z;
  }

  /**
   * Spawn on top of the surface at x,z: the feet land one block above the
   * topmost solid block of that column (trees included), pushed further up when
   * that spot is occupied.
   */
  spawnOnSurface(x = 0, z = 0): void {
    let y = surfaceFeet(this.world, Math.floor(x), Math.floor(z));
    let guard = 0;
    while (y < 63 && guard++ < 64 && this.collider.overlapsAt(x, y, z)) y++;
    this.spawnX = x;
    this.spawnY = y;
    this.spawnZ = z;
    this.teleport(x, y, z);
    this.onGround = this.collider.overlapsBelow(x, y, z, this.groundProbe);
  }

  /** Runs physics with no input until the player is standing (or the time runs out). */
  settle(seconds = 2, step = 1 / 60): void {
    for (let t = 0; t < seconds; t += step) {
      this.step(step, NO_INPUT);
      if (this.onGround && this.vy === 0) break;
    }
  }

  /**
   * One physics step: horizontal steering, jumping, gravity, then a swept
   * collision move, then the ground/stuck bookkeeping.
   */
  step(dt: number, input: MoveInput = NO_INPUT): void {
    const h = Math.min(Math.max(dt, 0), this.maxStepTime);
    if (h <= 0) return;

    // ---------------------------------------------------------------- jump
    this.jumpBuffer = Math.max(0, this.jumpBuffer - h);
    if (input.jump && !this.jumpWasHeld) this.jumpBuffer = this.jumpBufferTime;
    this.jumpWasHeld = input.jump;
    this.coyote = this.onGround ? this.coyoteTime : Math.max(0, this.coyote - h);

    // ------------------------------------------------------------ horizontal
    const wishLength = Math.hypot(input.wishX, input.wishZ);
    const moving = wishLength > 1e-6;
    const scale = wishLength > 1 ? 1 / wishLength : 1;
    const wishX = input.wishX * scale;
    const wishZ = input.wishZ * scale;
    const grounded = this.onGround || this.flying;

    this.sprinting = input.sprint && moving;
    const speed = this.sprinting ? this.sprintSpeed : this.walkSpeed;

    if (moving) {
      const accel = (grounded ? this.groundAccel : this.airAccel) * h;
      this.vx = approach(this.vx, wishX * speed, accel);
      this.vz = approach(this.vz, wishZ * speed, accel);
    } else {
      const damping = Math.exp(-(grounded ? this.groundFriction : this.airDrag) * h);
      this.vx *= damping;
      this.vz *= damping;
      if (Math.abs(this.vx) < 1e-3) this.vx = 0;
      if (Math.abs(this.vz) < 1e-3) this.vz = 0;
    }

    // -------------------------------------------------------------- vertical
    if (this.flying) {
      this.vy = 0;
    } else {
      this.vy -= this.gravity * h;
      if (this.vy < -this.terminalVelocity) this.vy = -this.terminalVelocity;
      if (this.jumpBuffer > 0 && (this.onGround || this.coyote > 0)) {
        this.vy = this.jumpSpeed;
        this.jumpBuffer = 0;
        this.coyote = 0;
        this.onGround = false;
      }
    }

    // ------------------------------------------------------ move + collide
    const result = this.collider.move(this.x, this.y, this.z, this.vx * h, this.vy * h, this.vz * h, this.moveResult);
    this.x = result.x;
    this.y = result.y;
    this.z = result.z;
    if (result.hitX) this.vx = 0;
    if (result.hitZ) this.vz = 0;
    if (result.hitY) this.vy = 0;

    this.onGround =
      result.landed ||
      (this.vy <= 0 && this.collider.overlapsBelow(this.x, this.y, this.z, this.groundProbe));
    if (this.onGround) {
      this.coyote = this.coyoteTime;
      if (this.vy < 0) this.vy = 0;
      // Hug the surface. The collision scan shrinks the box by a hair, so a
      // landing can stop a few hundredths above the ground and then creep down
      // at g*dt^2 per frame; this snaps it onto the surface in one step.
      const settle = this.collider.move(
        this.x,
        this.y,
        this.z,
        0,
        -Math.max(this.groundProbe, 1e-3),
        0,
        this.settleResult,
      );
      this.x = settle.x;
      this.y = settle.y;
      this.z = settle.z;
    }

    // Never stay inside a block (someone may have placed one where we stand).
    if (this.collider.overlapsAt(this.x, this.y, this.z)) {
      const fixed = this.collider.unstick(this.x, this.y, this.z);
      this.x = fixed.x;
      this.y = fixed.y;
      this.z = fixed.z;
      this.vx = 0;
      this.vz = 0;
      if (this.vy < 0) this.vy = 0;
    }

    // Void guard: falling out of the world puts the player back at spawn.
    if (!this.flying && this.y < this.voidY) {
      this.y = this.spawnY;
      this.x = this.spawnX;
      this.z = this.spawnZ;
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
    }
  }

  /** Copies the current state into `out` (no allocation). */
  readState(out: PhysicsState): PhysicsState {
    out.x = this.x;
    out.y = this.y;
    out.z = this.z;
    out.vx = this.vx;
    out.vy = this.vy;
    out.vz = this.vz;
    out.speed = Math.hypot(this.vx, this.vz);
    out.onGround = this.onGround;
    out.sprinting = this.sprinting;
    out.flying = this.flying;
    return out;
  }
}

/** Moves `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}
