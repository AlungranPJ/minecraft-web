/**
 * Public API of the first person player module.
 *
 *   import { FirstPersonPlayer, PLAYER_DEFAULTS } from './player';
 *
 * The module is layered so each piece can be used (and tested) on its own:
 *
 *   input.ts      keymap + held keys (remappable)
 *   look.ts       yaw/pitch mouse look with pointer lock and a drag fallback
 *   collision.ts  swept axis separated AABB against blocks
 *   physics.ts    gravity, walk/sprint, jump, ground handling (no DOM)
 *   player.ts     the three above wired to a camera and the engine's onFrame
 */
export { FirstPersonPlayer } from './player';
export type { PlayerOptions, PlayerState, PlayerUpdateListener } from './player';

export { DEFAULT_KEYMAP, KeyboardInput, PLAYER_ACTIONS } from './input';
export type { KeyEventTarget, Keymap, PlayerAction } from './input';

export { MouseLook } from './look';
export type { LookOptions } from './look';

export { PlayerCollider, createMoveResult } from './collision';
export type { BlockSource, MoveResult, PlayerSize } from './collision';

export { PLAYER_DEFAULTS, PlayerPhysics, jumpSpeedFor, surfaceFeet } from './physics';
export type { MoveInput, PhysicsOptions, PhysicsState, SurfaceSource } from './physics';
