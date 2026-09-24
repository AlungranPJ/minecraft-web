/**
 * Dig / place interaction.
 *
 * Digging: hold the left button on a block in reach; progress runs for
 * `getBlockDef(id).hardness` seconds (0.3 s leaves .. 1.5 s stone) and the block
 * turns to air, dropping into the hotbar.
 *
 * Placing: hold the right button; the target voxel is `hit.position + hit.normal`
 * (always attached to the aimed face, never floating), it must be empty or a
 * liquid, and it must not intersect the player box.
 */
import * as THREE from 'three';
import { Block, getBlockDef, isLiquid, isRenderable, type BlockId } from '../engine/blocks';
import { CHUNK_HEIGHT } from '../engine/chunk';
import type { Hotbar } from './inventory';
import { createAABB, sameVoxel, voxelKey, boxOverlapsBlock, type AABB, type PlayerAdapter, type RaycastHit, type VoxelWorld } from './types';

export type PlaceRejectReason =
  | 'no-target'
  | 'inside-block'
  | 'out-of-world'
  | 'occupied'
  | 'player-box'
  | 'empty-hand'
  | 'unknown-item';

export interface PlaceSuccess {
  ok: true;
  position: [number, number, number];
  id: BlockId;
}

export interface PlaceFailure {
  ok: false;
  reason: PlaceRejectReason;
  position: [number, number, number] | null;
}

export type PlaceResult = PlaceSuccess | PlaceFailure;

export interface DigCompleteInfo {
  position: [number, number, number];
  id: BlockId;
  seconds: number;
}

export interface InteractionOptions {
  world: VoxelWorld;
  player: PlayerAdapter;
  hotbar: Hotbar;
  /** Max dig/place distance in blocks. Default 5. */
  reach?: number;
  /** 1 = break in `hardness` seconds. Default 1. */
  digSpeed?: number;
  /** Seconds between repeated placements while the button is held. Default 0.22. */
  placeDelay?: number;
  /** Start disabled (e.g. while the pointer is not locked). Default true. */
  enabled?: boolean;
  onTargetChange?: (hit: RaycastHit | null) => void;
  onDigProgress?: (hit: RaycastHit, progress: number, hardness: number) => void;
  onDigComplete?: (info: DigCompleteInfo) => void;
  onPlace?: (result: PlaceSuccess) => void;
  onReject?: (result: PlaceFailure) => void;
  onInventoryFull?: (id: BlockId, leftover: number) => void;
}

export const DEFAULT_REACH = 5;
export const DEFAULT_PLACE_DELAY = 0.22;

export class InteractionController {
  enabled: boolean;
  reach: number;
  digSpeed: number;
  placeDelay: number;

  /** What the crosshair is on right now. */
  target: RaycastHit | null = null;
  /** 0..1 break progress of the current dig target. */
  digProgress = 0;
  /** Hardness of the block being dug, in seconds. */
  digHardness = 0;
  digging = false;
  placing = false;

  digsCompleted = 0;
  placesDone = 0;
  lastReject: PlaceFailure | null = null;
  readonly rejects: Record<string, number> = {};

  private readonly world: VoxelWorld;
  private readonly player: PlayerAdapter;
  private readonly hotbar: Hotbar;
  private readonly hooks: InteractionOptions;

  private digVoxel: [number, number, number] | null = null;
  private digBlockId = 0;
  private placeCooldown = 0;
  private lastTargetKey = '';

  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly box: AABB = createAABB();

  constructor(opts: InteractionOptions) {
    this.world = opts.world;
    this.player = opts.player;
    this.hotbar = opts.hotbar;
    this.hooks = opts;
    this.reach = opts.reach ?? DEFAULT_REACH;
    this.digSpeed = opts.digSpeed ?? 1;
    this.placeDelay = opts.placeDelay ?? DEFAULT_PLACE_DELAY;
    this.enabled = opts.enabled !== false;
  }

  // ------------------------------------------------------------------ input

  beginDig(): void {
    this.digging = true;
    this.digVoxel = null;
    this.digProgress = 0;
  }

  endDig(): void {
    this.digging = false;
    this.digVoxel = null;
    this.digProgress = 0;
  }

  beginPlace(): void {
    this.placing = true;
    this.placeCooldown = 0;
  }

  endPlace(): void {
    this.placing = false;
  }

  /** Clears held buttons and progress (used on pointer lock loss / blur). */
  reset(): void {
    this.endDig();
    this.endPlace();
    this.digHardness = 0;
  }

  // ------------------------------------------------------------------ frame

  /** One frame of aim + dig + place. `dt` in seconds. */
  update(dt: number): void {
    this.refreshTarget();

    if (!this.enabled) {
      this.digging = false;
      this.placing = false;
      this.digProgress = 0;
      this.digVoxel = null;
      return;
    }

    // A frame longer than 100 ms means a stalled tab: never hand that much
    // digging progress (or repeat placement) to one update.
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.updateDig(step);
    this.updatePlace(step);
  }

  /** Ray origin / direction / player box, refreshed from the player adapter. */
  refreshTarget(): RaycastHit | null {
    this.player.getEye(this.eye);
    this.player.getLook(this.look);
    const hit = this.world.raycast(this.eye, this.look, this.reach);
    this.target = hit;
    const key = hit ? voxelKey(hit.position[0], hit.position[1], hit.position[2]) + ':' + hit.blockId : '';
    if (key !== this.lastTargetKey) {
      this.lastTargetKey = key;
      this.hooks.onTargetChange?.(hit);
    }
    return hit;
  }

  private updateDig(dt: number): void {
    const hit = this.target;
    if (!this.digging || !hit) {
      this.digProgress = 0;
      this.digVoxel = null;
      this.digBlockId = 0;
      return;
    }

    // Aim moved to another voxel (or the block changed): start over.
    if (!this.digVoxel || !sameVoxel(this.digVoxel, hit.position) || this.digBlockId !== hit.blockId) {
      this.digVoxel = [hit.position[0], hit.position[1], hit.position[2]];
      this.digBlockId = hit.blockId;
      this.digProgress = 0;
    }

    this.digHardness = Math.max(0.05, getBlockDef(hit.blockId).hardness);
    this.digProgress += (Math.max(0, dt) * this.digSpeed) / this.digHardness;
    this.hooks.onDigProgress?.(hit, Math.min(this.digProgress, 1), this.digHardness);

    if (this.digProgress >= 1) this.completeDig(hit);
  }

  private completeDig(hit: RaycastHit): void {
    const position: [number, number, number] = [hit.position[0], hit.position[1], hit.position[2]];
    const id = hit.blockId;
    this.world.setBlock(position[0], position[1], position[2], Block.AIR);
    const leftover = this.hotbar.add(id, 1);
    if (leftover > 0) this.hooks.onInventoryFull?.(id, leftover);

    this.digsCompleted++;
    this.digProgress = 0;
    this.digVoxel = null;
    this.digBlockId = 0;
    this.hooks.onDigComplete?.({ position, id, seconds: this.digHardness });
  }

  private updatePlace(dt: number): void {
    if (!this.placing) return;
    this.placeCooldown -= dt;
    if (this.placeCooldown > 0) return;
    const result = this.tryPlace();
    if (result.ok) {
      this.placeCooldown = this.placeDelay;
    } else {
      // one toast per press instead of one per frame
      this.placing = false;
    }
  }

  /**
   * Single placement attempt against the current target. Consumes one item from
   * the selected slot only when the block actually lands.
   */
  tryPlace(): PlaceResult {
    const hit = this.target ?? this.refreshTarget();
    if (!hit) return this.reject('no-target', null);

    const [nx, ny, nz] = hit.normal;
    if (nx === 0 && ny === 0 && nz === 0) {
      // the ray started inside a block: there is no face to build on
      return this.reject('inside-block', null);
    }
    const position: [number, number, number] = [
      hit.position[0] + nx,
      hit.position[1] + ny,
      hit.position[2] + nz,
    ];
    if (position[1] < 0 || position[1] >= CHUNK_HEIGHT) return this.reject('out-of-world', position);

    const existing = this.world.getBlock(position[0], position[1], position[2]);
    if (existing !== Block.AIR && !isLiquid(existing)) return this.reject('occupied', position);

    const stack = this.hotbar.selectedStack;
    if (!stack || stack.count <= 0) return this.reject('empty-hand', position);
    if (!isRenderable(stack.id)) return this.reject('unknown-item', position);

    this.player.getBox(this.box);
    if (boxOverlapsBlock(this.box, position[0], position[1], position[2])) {
      return this.reject('player-box', position);
    }

    this.world.setBlock(position[0], position[1], position[2], stack.id);
    this.hotbar.takeFromSelected(1);
    this.placesDone++;
    const placed: PlaceSuccess = { ok: true, position, id: stack.id };
    // fired here (not in updatePlace) so direct calls are recorded too
    this.hooks.onPlace?.(placed);
    return placed;
  }

  private reject(reason: PlaceRejectReason, position: [number, number, number] | null): PlaceFailure {
    const failure: PlaceFailure = { ok: false, reason, position };
    this.lastReject = failure;
    this.rejects[reason] = (this.rejects[reason] ?? 0) + 1;
    this.hooks.onReject?.(failure);
    return failure;
  }
}
