/**
 * InteractionSession: wires the interaction pieces into one object a host page
 * calls once per frame.
 *
 *   dig / place  ->  InteractionController   (update(dt))
 *   hotbar       ->  Hotbar                  (9 slots, keys 1-9 + wheel)
 *   HUD          ->  Hud                     (crosshair, slots, F3 debug)
 *   save / load  ->  EditTracker + SaveStore (localStorage, autosave every 10 s)
 *
 * Ordering note: `update()` re-applies saved block edits to chunks that are in
 * memory, and hosts call it from the engine's `onFrame`, which runs *before*
 * chunk streaming and the draw. A chunk that just streamed in is therefore
 * patched before its mesh is built, so a loaded world never shows a first frame
 * of unmodified terrain.
 */
import type * as THREE from 'three';
import { Block } from '../engine/blocks';
import { InteractionController, type PlaceResult } from './controller';
import { EditTracker } from './diffs';
import { TargetHighlight } from './highlight';
import { Hotbar } from './inventory';
import { Hud, blockLabel, type HudOptions } from './hud';
import { createCameraPlayerAdapter } from './player';
import {
  DEFAULT_AUTOSAVE_MS,
  SaveStore,
  browserStorage,
  rebuildHotbar,
  type SaveData,
  type StorageLike,
} from './storage';
import type {
  ChunkAwareWorld,
  PlayerAdapter,
  PlayerSaveState,
  RaycastHit,
} from './types';

export interface InteractionSessionOptions {
  world: ChunkAwareWorld;
  /** Needed for the block highlight box. Omit to run without one. */
  scene?: THREE.Object3D | null;
  /** Used to build a default player adapter when `player` is omitted. */
  camera?: THREE.Camera | null;
  player?: PlayerAdapter;
  seed?: number;
  hotbar?: Hotbar;
  reach?: number;
  digSpeed?: number;
  /** Atlas canvas used to paint the hotbar icons (optional). */
  atlasCanvas?: HTMLCanvasElement | null;
  /** false runs headless (node tests); a Hud instance is accepted too. */
  hud?: Hud | false;
  hudOptions?: HudOptions;
  /** Defaults to localStorage in the browser, no storage in node. */
  storage?: StorageLike | null;
  storageKey?: string;
  autosaveMs?: number;
  /** Draw the target highlight box. Default true when a scene is given. */
  highlight?: boolean;
  /** Marshal saved edits into loaded chunks every frame. Default true. */
  applyEdits?: boolean;
  /** Restore the save file on construction. Default true. */
  restore?: boolean;
  /** Shown as a toast once, e.g. "loaded world from 3 minutes ago". */
  status?: string;
  onPlayerRestored?: (state: PlayerSaveState) => void;
}

export interface SessionDebugInfo {
  fps: number;
  frameMs: number;
  player: PlayerSaveState;
  aim: RaycastHit | null;
  digging: number;
  hand: { id: number; label: string; count: number } | null;
  slot: number;
  slots: number;
  edits: number;
  editChunks: number;
  savedAgoSeconds: number | null;
  autosaveMs: number;
  chunks: { loaded: number; meshed: number; pending: number } | null;
}

export class InteractionSession {
  readonly hotbar: Hotbar;
  readonly edits: EditTracker;
  readonly controller: InteractionController;
  readonly store: SaveStore;
  readonly hud: Hud | null;
  readonly highlight: TargetHighlight | null;

  /** What was restored from localStorage, if anything. */
  loaded: SaveData | null = null;
  playerRestored = false;
  autosaveElapsed = 0;
  autosaveMs: number;
  editsApplied = 0;

  private readonly world: ChunkAwareWorld;
  private readonly player: PlayerAdapter;
  private readonly spawn: PlayerSaveState;
  private readonly opts: InteractionSessionOptions;
  private readonly detachWindow: () => void;
  private fps = 0;
  private frameMs = 0;
  private fpsWindow = 0;
  private fpsFrames = 0;
  private hudTimer = 0;
  private debugTimer = 0;
  private lastDebugText = '';
  private disposed = false;

  constructor(opts: InteractionSessionOptions) {
    this.opts = opts;
    this.world = opts.world;
    this.autosaveMs = Math.max(1000, Math.floor(opts.autosaveMs ?? DEFAULT_AUTOSAVE_MS));

    if (opts.player) {
      this.player = opts.player;
    } else if (opts.camera) {
      this.player = createCameraPlayerAdapter(opts.camera);
    } else {
      throw new Error('InteractionSession: pass either `player` or `camera`');
    }

    const seed = opts.seed ?? 20260924;
    this.hotbar = opts.hotbar ?? Hotbar.starter();
    this.edits = new EditTracker(seed);
    this.spawn = this.player.saveState();

    this.store = new SaveStore({
      seed,
      storage: opts.storage === undefined ? browserStorage() : opts.storage,
      key: opts.storageKey,
      autosaveMs: this.autosaveMs,
      onSaved: () => undefined,
    });

    this.hud = opts.hud === false ? null : (opts.hud ?? new Hud(opts.hudOptions));
    this.hud?.setAtlasSource(opts.atlasCanvas ?? null);
    this.hud?.onReset(() => this.resetWorld());

    this.highlight = opts.scene && opts.highlight !== false ? new TargetHighlight(opts.scene) : null;

    this.controller = new InteractionController({
      world: this.world,
      player: this.player,
      hotbar: this.hotbar,
      reach: opts.reach,
      digSpeed: opts.digSpeed,
      onDigProgress: (hit, progress) => this.onDigProgress(hit, progress),
      onDigComplete: (info) => {
        // every world write the controller makes is recorded as a save diff
        this.edits.record(info.position[0], info.position[1], info.position[2], Block.AIR);
        this.hud?.toast(`+1 ${blockLabel(info.id)}`);
        this.hud?.setHotbar(this.hotbar);
      },
      onPlace: (result) => {
        this.edits.record(result.position[0], result.position[1], result.position[2], result.id);
        this.hud?.setHotbar(this.hotbar);
        this.hud?.toast(`${blockLabel(result.id)} placed`);
      },
      onReject: (failure) => this.hud?.toast(rejectText(failure.reason)),
      onInventoryFull: (id) => this.hud?.toast(`inventory full, ${blockLabel(id)} dropped`),
    });

    if (opts.restore !== false) this.restore();

    this.detachWindow = bindLifecycleSave(() => this.saveNow(false));
  }

  // ------------------------------------------------------------------ loading

  /** Reads localStorage and restores player, hotbar and block edits. */
  restore(): boolean {
    const data = this.store.load();
    if (!data || data.seed !== (this.store.seed >>> 0)) return false;
    this.loaded = data;

    const restoredHotbar = rebuildHotbar(data.hotbar, this.hotbar.size);
    for (let i = 0; i < this.hotbar.size; i++) this.hotbar.setSlot(i, restoredHotbar.slots[i]);
    this.hotbar.selected = restoredHotbar.selected;
    this.hud?.setHotbar(this.hotbar);

    for (const edit of data.edits) this.edits.record(edit.x, edit.y, edit.z, edit.id);

    if (data.player) {
      this.player.loadState(data.player);
      this.playerRestored = true;
      this.opts.onPlayerRestored?.(data.player);
    }
    if (this.opts.status) this.hud?.setStatus(this.opts.status);
    return true;
  }

  /** Writes the saved edits into the chunks that are in memory right now. */
  applyEditsToLoadedChunks(): number {
    const written = this.edits.applyToLoadedChunks(this.world);
    this.editsApplied += written;
    return written;
  }

  // -------------------------------------------------------------------- loop

  /** Once per frame, from the engine's `onFrame` callback. */
  update(dt: number): void {
    if (this.disposed) return;
    this.trackFps(dt);
    if (this.opts.applyEdits !== false) this.applyEditsToLoadedChunks();

    this.controller.update(dt);
    this.updateHighlight();

    if (this.hud) {
      this.hudTimer += dt;
      if (this.hudTimer >= 0.08) {
        this.hudTimer = 0;
        this.hud.setHotbar(this.hotbar);
      }
      this.debugTimer += dt;
      if (this.debugTimer >= 0.25) {
        this.debugTimer = 0;
        const text = this.formatDebug();
        if (text !== this.lastDebugText) {
          this.lastDebugText = text;
          this.hud.setDebug(text);
        }
      }
    }

    this.autosaveElapsed += dt;
    // autosaveMs is milliseconds (10 s default), dt is seconds
    if (this.autosaveElapsed * 1000 >= this.autosaveMs) this.saveNow(true);
  }

  private trackFps(dt: number): void {
    this.fpsWindow += dt;
    this.fpsFrames++;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
    if (this.fpsWindow >= 0.5) {
      this.fps = this.fpsFrames / this.fpsWindow;
      this.fpsWindow = 0;
      this.fpsFrames = 0;
    }
  }

  private updateHighlight(): void {
    if (!this.highlight) return;
    const hit = this.controller.target;
    if (!hit) {
      this.highlight.hide();
      this.hud?.setProgress(0, false);
      return;
    }
    this.highlight.show(hit.position, this.controller.digProgress);
    if (this.controller.digProgress > 0.001) {
      this.hud?.setProgress(this.controller.digProgress, true);
    } else {
      this.hud?.setProgress(0, false);
    }
  }

  private onDigProgress(hit: RaycastHit, progress: number): void {
    if (progress > 0 && progress < 1) this.hud?.setProgress(progress, true);
  }

  // ------------------------------------------------------------------ saving

  snapshot(): SaveData {
    return {
      version: 1,
      seed: this.store.seed,
      savedAt: this.store.lastSavedAt,
      player: this.player.saveState(),
      hotbar: this.hotbar.toJSON(),
      edits: this.edits.toJSON(),
    };
  }

  /** Saves now and resets the autosave timer. */
  saveNow(notify = true): boolean {
    const ok = this.store.save(this.snapshot());
    this.autosaveElapsed = 0;
    if (notify && this.hud) {
      this.hud.toast(ok ? `world saved (${this.edits.size} edits)` : 'save failed: ' + this.store.lastError);
    }
    return ok;
  }

  /** Back to a pristine world: terrain restored, hotbar and player reset. */
  resetWorld(): void {
    const restored = this.edits.restoreLoadedChunks(this.world);
    this.hotbar.resetToStarter();
    this.player.loadState(this.spawn);
    this.store.clear();
    this.loaded = null;
    this.playerRestored = false;
    this.autosaveElapsed = 0;
    this.hud?.setHotbar(this.hotbar);
    this.hud?.setProgress(0, false);
    this.hud?.toast(`world reset (${restored} blocks restored)`);
    this.opts.onPlayerRestored?.(this.spawn);
  }

  // ------------------------------------------------------------------- input

  /** Keys the session owns: 1-9 hotbar, F3 debug. Returns true when handled. */
  handleKeyDown(event: { code: string; key?: string; preventDefault?: () => void }): boolean {
    const code = event.code;
    if (code.startsWith('Digit')) {
      const label = Number(code.slice(5));
      if (Number.isFinite(label) && this.hotbar.selectByNumber(label)) {
        this.hud?.setSelected(this.hotbar.selected);
        return true;
      }
      return false;
    }
    if (code === 'F3') {
      this.hud?.toggleDebug();
      event.preventDefault?.();
      return true;
    }
    return false;
  }

  /** Wheel: scroll up moves the selection left, like Minecraft. */
  handleWheel(deltaY: number): boolean {
    if (!Number.isFinite(deltaY) || deltaY === 0) return false;
    this.hotbar.cycle(deltaY > 0 ? 1 : -1);
    this.hud?.setSelected(this.hotbar.selected);
    return true;
  }

  debugInfo(): SessionDebugInfo {
    const stack = this.hotbar.selectedStack;
    const stats = this.world.stats?.() ?? null;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      player: this.player.saveState(),
      aim: this.controller.target,
      digging: this.controller.digProgress,
      hand: stack ? { id: stack.id, label: blockLabel(stack.id), count: stack.count } : null,
      slot: this.hotbar.selected + 1,
      slots: this.hotbar.size,
      edits: this.edits.size,
      editChunks: this.edits.chunkCount,
      savedAgoSeconds: this.store.lastSavedAt > 0 ? (Date.now() - this.store.lastSavedAt) / 1000 : null,
      autosaveMs: this.autosaveMs,
      chunks: stats ? { loaded: stats.chunks, meshed: stats.meshed, pending: stats.pending } : null,
    };
  }

  /** The F3 overlay text: fps, position, loaded chunks, aim, save state. */
  formatDebug(): string {
    const info = this.debugInfo();
    const p = info.player;
    const yaw = typeof p.yaw === 'number' ? ((p.yaw * 180) / Math.PI).toFixed(0) : '-';
    const pitch = typeof p.pitch === 'number' ? ((p.pitch * 180) / Math.PI).toFixed(0) : '-';
    const aim = info.aim
      ? `${blockLabel(info.aim.blockId)} (${info.aim.position.join(', ')}) ${info.aim.distance.toFixed(2)} m`
      : 'none';
    const chunks = info.chunks
      ? `${info.chunks.loaded} loaded (meshed ${info.chunks.meshed}, pending ${info.chunks.pending})`
      : 'n/a';
    const saved = info.savedAgoSeconds === null ? 'never' : `${info.savedAgoSeconds.toFixed(1)} s ago`;
    const dig = info.digging > 0.001 ? `  digging ${(info.digging * 100).toFixed(0)}%` : '';
    return [
      `fps ${info.fps.toFixed(1)}  (${info.frameMs.toFixed(2)} ms/frame)`,
      `pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}   yaw ${yaw}  pitch ${pitch}`,
      `chunks ${chunks}`,
      `aim ${aim}${dig}`,
      `hand ${info.hand ? `${info.hand.label} x${info.hand.count}` : 'empty'}   slot ${info.slot}/${info.slots}`,
      `edits ${info.edits} in ${info.editChunks} chunk(s)   saved ${saved}   autosave ${(info.autosaveMs / 1000).toFixed(0)} s`,
    ].join('\n');
  }

  /** Convenience for tests / console: one placement attempt. */
  tryPlace(): PlaceResult {
    return this.controller.tryPlace();
  }

  dispose(): void {
    this.disposed = true;
    this.detachWindow();
    this.highlight?.dispose();
    this.hud?.dispose();
  }
}

function rejectText(reason: string): string {
  switch (reason) {
    case 'no-target':
      return 'nothing in reach';
    case 'inside-block':
      return 'cannot build: you are inside a block';
    case 'out-of-world':
      return 'cannot build there';
    case 'occupied':
      return 'block already there';
    case 'player-box':
      return 'block would hit you';
    case 'empty-hand':
      return 'slot is empty';
    default:
      return 'cannot place here';
  }
}

/** Saves on tab hide / unload so a crash never costs more than one autosave. */
function bindLifecycleSave(save: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') save();
  };
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    window.removeEventListener('pagehide', save);
    window.removeEventListener('beforeunload', save);
    document.removeEventListener('visibilitychange', onHide);
  };
}
