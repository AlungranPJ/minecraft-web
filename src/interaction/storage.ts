/**
 * Persistence: one JSON document in localStorage holding the player state and
 * the block diff (see docs/save-format.md).
 *
 * Storage is injected so the module runs in node tests with a Map backed stub.
 */
import { BLOCKS } from '../engine/blocks';
import type { BlockEdit, PlayerSaveState } from './types';
import { Hotbar, sanitizeStack, type HotbarData } from './inventory';

export const SAVE_VERSION = 1;
export const DEFAULT_AUTOSAVE_MS = 10_000;
export const STORAGE_PREFIX = 'minecraft-web:world:';

export interface SaveData {
  version: number;
  seed: number;
  savedAt: number;
  player: PlayerSaveState | null;
  hotbar: HotbarData;
  edits: BlockEdit[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage when available (browser), else null (node, blocked storage). */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__voxel_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** In memory fallback used by tests and by browsers with storage disabled. */
export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

export function storageKeyFor(seed: number): string {
  return STORAGE_PREFIX + (seed >>> 0);
}

export interface SaveStoreOptions {
  seed: number;
  storage?: StorageLike | null;
  key?: string;
  autosaveMs?: number;
  now?: () => number;
  onSaved?: (data: SaveData) => void;
}

/**
 * Reads / writes the world save. Autosave itself is driven by
 * `InteractionSession.update(dt)` so it stays deterministic in tests.
 */
export class SaveStore {
  readonly seed: number;
  readonly key: string;
  autosaveMs: number;
  lastSavedAt = 0;
  lastError = '';
  saveCount = 0;
  loadCount = 0;

  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly onSaved: ((data: SaveData) => void) | null;

  constructor(opts: SaveStoreOptions) {
    this.seed = opts.seed >>> 0;
    this.storage = opts.storage === undefined ? browserStorage() : opts.storage;
    this.key = opts.key ?? storageKeyFor(this.seed);
    this.autosaveMs = Math.max(1000, Math.floor(opts.autosaveMs ?? DEFAULT_AUTOSAVE_MS));
    this.now = opts.now ?? (() => Date.now());
    this.onSaved = opts.onSaved ?? null;
  }

  get available(): boolean {
    return this.storage !== null;
  }

  /** Reads and validates the stored document. Null when absent / unusable. */
  load(): SaveData | null {
    if (!this.storage) return null;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.key);
    } catch (error) {
      this.lastError = 'read failed: ' + describe(error);
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      const data = normalizeSaveData(parsed);
      if (!data) {
        this.lastError = 'save file is not valid JSON for this version';
        return null;
      }
      this.loadCount++;
      return data;
    } catch (error) {
      this.lastError = 'parse failed: ' + describe(error);
      return null;
    }
  }

  save(data: SaveData): boolean {
    if (!this.storage) {
      this.lastError = 'no storage available';
      return false;
    }
    const payload: SaveData = { ...data, version: SAVE_VERSION, seed: this.seed, savedAt: this.now() };
    try {
      this.storage.setItem(this.key, JSON.stringify(payload));
    } catch (error) {
      this.lastError = 'write failed: ' + describe(error);
      return false;
    }
    this.lastSavedAt = payload.savedAt;
    this.saveCount++;
    this.lastError = '';
    this.onSaved?.(payload);
    return true;
  }

  clear(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.key);
    } catch (error) {
      this.lastError = 'remove failed: ' + describe(error);
    }
  }

  /** Raw stored string, for debugging (never null when a save exists). */
  peek(): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(this.key);
    } catch {
      return null;
    }
  }
}

/**
 * Turns unknown JSON into a usable SaveData. Returns null when the document is
 * for another version, another seed, or has no usable fields at all.
 */
export function normalizeSaveData(input: unknown): SaveData | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const version = Math.floor(Number(raw.version));
  const seed = Math.floor(Number(raw.seed));
  if (!Number.isFinite(version) || version !== SAVE_VERSION) return null;
  if (!Number.isFinite(seed)) return null;

  const player = normalizePlayer(raw.player);
  const hotbar = (raw.hotbar ?? {}) as Partial<HotbarData>;
  const slots = Array.isArray(hotbar.slots)
    ? hotbar.slots.map((slot) => sanitizeStack(slot))
    : [];
  const edits: BlockEdit[] = [];
  if (Array.isArray(raw.edits)) {
    for (const entry of raw.edits) {
      if (!entry || typeof entry !== 'object') continue;
      const edit = entry as Partial<BlockEdit>;
      const x = Math.floor(Number(edit.x));
      const y = Math.floor(Number(edit.y));
      const z = Math.floor(Number(edit.z));
      const id = Math.floor(Number(edit.id));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      // id 0 (AIR) is valid: that is a block the player dug out
      if (!Number.isFinite(id) || id < 0 || id >= BLOCKS.length) continue;
      edits.push({ x, y, z, id });
    }
  }

  return {
    version: SAVE_VERSION,
    seed: seed >>> 0,
    savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0,
    player,
    hotbar: {
      selected: typeof hotbar.selected === 'number' ? Math.floor(hotbar.selected) : 0,
      slots,
    },
    edits,
  };
}

function normalizePlayer(input: unknown): PlayerSaveState | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<PlayerSaveState>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const state: PlayerSaveState = { x, y, z };
  if (Number.isFinite(Number(raw.yaw))) state.yaw = Number(raw.yaw);
  if (Number.isFinite(Number(raw.pitch))) state.pitch = Number(raw.pitch);
  return state;
}

export function rebuildHotbar(data: HotbarData, size?: number): Hotbar {
  return Hotbar.fromJSON(data, size);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
