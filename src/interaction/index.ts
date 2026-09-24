/**
 * Interaction layer public surface: dig / place, 9 slot hotbar, HUD and the
 * localStorage save (player position + block diff).
 *
 * A host page only needs this:
 *
 *   const session = new InteractionSession({
 *     world: game.world, scene: game.scene, player: myPlayer, seed,
 *     atlasCanvas: atlas.canvas,
 *   });
 *   game.onFrame((dt) => session.update(dt));
 *
 * The engine's `world.getBlock/setBlock/raycast` API is not modified by this
 * layer; it only consumes it.
 */
export * from './types';
export * from './inventory';
export * from './diffs';
export * from './storage';
export * from './player';
export * from './controller';
export * from './highlight';
export * from './hud';
export * from './session';
