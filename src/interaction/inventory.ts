/**
 * 9 slot hotbar / inventory.
 *
 * Pure data (no DOM, no engine import beyond block ids) so it runs in node
 * tests and serialises straight into the save file.
 */
import { Block, BLOCKS, type BlockId } from '../engine/blocks';

export const HOTBAR_SIZE = 9;
export const MAX_STACK = 64;

export interface ItemStack {
  id: BlockId;
  count: number;
}

export interface HotbarData {
  selected: number;
  slots: Array<ItemStack | null>;
}

/** Items a fresh world hands the player: grass, dirt, stone, sand, wood. */
export const STARTER_ITEMS: ItemStack[] = [
  { id: Block.GRASS, count: MAX_STACK },
  { id: Block.DIRT, count: MAX_STACK },
  { id: Block.STONE, count: MAX_STACK },
  { id: Block.SAND, count: MAX_STACK },
  { id: Block.WOOD, count: MAX_STACK },
];

function isBlockId(value: unknown): value is BlockId {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < BLOCKS.length;
}

/** Drops anything that is not a usable stack (corrupt / hand edited saves). */
export function sanitizeStack(value: unknown): ItemStack | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { id?: unknown; count?: unknown };
  if (!isBlockId(raw.id)) return null;
  const count = Math.floor(Number(raw.count));
  if (!Number.isFinite(count) || count <= 0) return null;
  return { id: raw.id, count: Math.min(count, MAX_STACK) };
}

export class Hotbar {
  readonly size: number;
  readonly slots: Array<ItemStack | null>;
  selected = 0;

  constructor(size = HOTBAR_SIZE, slots?: Array<ItemStack | null>, selected = 0) {
    this.size = Math.max(1, Math.floor(size));
    this.slots = new Array<ItemStack | null>(this.size).fill(null);
    if (slots) {
      for (let i = 0; i < this.size && i < slots.length; i++) {
        this.slots[i] = sanitizeStack(slots[i]);
      }
    }
    this.selected = this.size > 0 ? ((Math.floor(selected) % this.size) + this.size) % this.size : 0;
  }

  static starter(size = HOTBAR_SIZE): Hotbar {
    const slots = new Array<ItemStack | null>(size).fill(null);
    for (let i = 0; i < STARTER_ITEMS.length && i < size; i++) {
      slots[i] = { ...STARTER_ITEMS[i] };
    }
    return new Hotbar(size, slots);
  }

  get selectedStack(): ItemStack | null {
    return this.slots[this.selected] ?? null;
  }

  /** Selects a slot by index. Returns false when the index is out of range. */
  select(index: number): boolean {
    if (!Number.isFinite(index)) return false;
    const i = Math.floor(index);
    if (i < 0 || i >= this.size) return false;
    this.selected = i;
    return true;
  }

  /** Selects with a 1-based number, i.e. how the number row reads on screen. */
  selectByNumber(label: number): boolean {
    return this.select(label - 1);
  }

  /** Wheel handler: steps the selection and wraps around. */
  cycle(delta: number): number {
    if (!Number.isFinite(delta) || delta === 0) return this.selected;
    const step = delta > 0 ? 1 : -1;
    this.selected = ((this.selected + step) % this.size + this.size) % this.size;
    return this.selected;
  }

  /** Count of `id` in the hotbar. */
  countOf(id: BlockId): number {
    let total = 0;
    for (const slot of this.slots) if (slot && slot.id === id) total += slot.count;
    return total;
  }

  /**
   * Adds items, topping up existing stacks first (like Minecraft).
   * Returns how many items did not fit.
   */
  add(id: BlockId, count = 1): number {
    if (!isBlockId(id) || !Number.isFinite(count) || count <= 0) return Math.max(0, Math.floor(count) || 0);
    let left = Math.floor(count);

    for (const slot of this.slots) {
      if (left === 0) break;
      if (slot && slot.id === id && slot.count < MAX_STACK) {
        const room = MAX_STACK - slot.count;
        const moved = Math.min(room, left);
        slot.count += moved;
        left -= moved;
      }
    }
    for (let i = 0; i < this.size && left > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(MAX_STACK, left);
      this.slots[i] = { id, count: moved };
      left -= moved;
    }
    return left;
  }

  /** Removes from the selected stack. False when the hand is empty. */
  takeFromSelected(count = 1): boolean {
    const slot = this.slots[this.selected];
    if (!slot || slot.count < count || count <= 0) return false;
    slot.count -= count;
    if (slot.count <= 0) this.slots[this.selected] = null;
    return true;
  }

  /** Puts a stack into a specific slot, replacing whatever is there. */
  setSlot(index: number, stack: ItemStack | null): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) return false;
    this.slots[index] = sanitizeStack(stack);
    return true;
  }

  /** Restores the default starter inventory and selection. */
  resetToStarter(): void {
    for (let i = 0; i < this.size; i++) this.slots[i] = null;
    for (let i = 0; i < STARTER_ITEMS.length && i < this.size; i++) {
      this.slots[i] = { ...STARTER_ITEMS[i] };
    }
    this.selected = 0;
  }

  isEmpty(): boolean {
    return this.slots.every((slot) => !slot);
  }

  toJSON(): HotbarData {
    return {
      selected: this.selected,
      slots: this.slots.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)),
    };
  }

  static fromJSON(data: unknown, size = HOTBAR_SIZE): Hotbar {
    const raw = (data ?? {}) as { selected?: unknown; slots?: unknown };
    const slots = Array.isArray(raw.slots) ? (raw.slots as Array<ItemStack | null>) : [];
    return new Hotbar(size, slots, typeof raw.selected === 'number' ? raw.selected : 0);
  }
}
