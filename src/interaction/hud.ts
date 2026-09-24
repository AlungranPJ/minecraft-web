/**
 * HUD: crosshair, break progress, hotbar (9 slots with counts + atlas icons),
 * debug overlay (F3) and toasts.
 *
 * The whole overlay is `pointer-events: none` except the reset button, so it
 * never steals a click from the game.
 */
import { BLOCKS, getBlockDef, type BlockId } from '../engine/blocks';
import { HOTBAR_SIZE, type Hotbar, type ItemStack } from './inventory';

const STYLE_ID = 'interaction-hud-style';
const ICON_PX = 32;
const ATLAS_TILE_PX = 16;
const ATLAS_COLS = 4;
const RESET_ARM_MS = 3000;

export interface HudOptions {
  parent?: HTMLElement;
  hotbarSize?: number;
  debug?: boolean;
  crosshair?: boolean;
  showReset?: boolean;
  status?: string;
}

interface SlotView {
  root: HTMLDivElement;
  icon: HTMLCanvasElement;
  count: HTMLSpanElement;
  key: HTMLSpanElement;
  id: BlockId | 0;
}

export class Hud {
  readonly root: HTMLDivElement;
  debugVisible: boolean;
  hotbarSize: number;

  private readonly slots: SlotView[] = [];
  private readonly icons = new Map<BlockId, HTMLCanvasElement>();
  private readonly progressWrap: HTMLDivElement;
  private readonly progressFill: HTMLElement;
  private readonly debugEl: HTMLPreElement;
  private readonly toastEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly resetButton: HTMLButtonElement | null;
  private readonly debugWrap: HTMLDivElement;
  private atlasCanvas: HTMLCanvasElement | null = null;
  private resetArmed = false;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private resetHandler: (() => void) | null = null;

  constructor(opts: HudOptions = {}) {
    this.hotbarSize = Math.max(1, Math.floor(opts.hotbarSize ?? HOTBAR_SIZE));
    this.debugVisible = opts.debug === true;
    ensureStyles();

    this.root = document.createElement('div');
    this.root.className = 'ix-root';

    if (opts.crosshair !== false) {
      const crosshair = document.createElement('div');
      crosshair.className = 'ix-crosshair';
      crosshair.appendChild(document.createElement('i'));
      this.root.appendChild(crosshair);
    }

    this.progressWrap = document.createElement('div');
    this.progressWrap.className = 'ix-progress';
    this.progressFill = document.createElement('i');
    this.progressWrap.appendChild(this.progressFill);
    this.progressWrap.style.opacity = '0';
    this.root.appendChild(this.progressWrap);

    this.debugWrap = document.createElement('div');
    this.debugWrap.className = 'ix-debug';
    this.debugEl = document.createElement('pre');
    this.debugWrap.appendChild(this.debugEl);
    this.debugWrap.style.display = this.debugVisible ? 'block' : 'none';
    this.root.appendChild(this.debugWrap);

    const hotbar = document.createElement('div');
    hotbar.className = 'ix-hotbar';
    for (let i = 0; i < this.hotbarSize; i++) {
      const slot = document.createElement('div');
      slot.className = 'ix-slot';
      const icon = document.createElement('canvas');
      icon.width = ICON_PX;
      icon.height = ICON_PX;
      const count = document.createElement('span');
      count.className = 'ix-count';
      const key = document.createElement('span');
      key.className = 'ix-key';
      key.textContent = String(i + 1);
      slot.appendChild(key);
      slot.appendChild(icon);
      slot.appendChild(count);
      hotbar.appendChild(slot);
      this.slots.push({ root: slot, icon, count, key, id: 0 });
    }
    this.root.appendChild(hotbar);

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'ix-toast';
    this.root.appendChild(this.toastEl);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ix-status';
    this.statusEl.textContent = opts.status ?? '';
    this.root.appendChild(this.statusEl);

    this.resetButton = opts.showReset === false ? null : document.createElement('button');
    if (this.resetButton) {
      this.resetButton.className = 'ix-reset';
      this.resetButton.type = 'button';
      this.resetButton.textContent = 'Reset world';
      this.resetButton.addEventListener('click', this.onResetClick);
      this.root.appendChild(this.resetButton);
    }

    this.mount(opts.parent);
  }

  mount(parent?: HTMLElement): void {
    (parent ?? document.body).appendChild(this.root);
  }

  /** Atlas source used to paint the slot icons (optional). */
  setAtlasSource(canvas: HTMLCanvasElement | null): void {
    this.atlasCanvas = canvas;
    this.icons.clear();
  }

  /** Refreshes every slot from the inventory model. */
  setHotbar(hotbar: Hotbar): void {
    for (let i = 0; i < this.slots.length; i++) this.setSlot(i, hotbar.slots[i] ?? null);
    this.setSelected(hotbar.selected);
  }

  setSelected(index: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].root.classList.toggle('ix-slot-active', i === index);
    }
  }

  setSlot(index: number, stack: ItemStack | null): void {
    const slot = this.slots[index];
    if (!slot) return;
    const id = stack ? stack.id : 0;
    if (slot.id !== id) {
      slot.id = id;
      this.paintIcon(slot.icon, id);
    }
    slot.count.textContent = stack && stack.count > 0 ? String(stack.count) : '';
    slot.root.classList.toggle('ix-slot-empty', !stack);
  }

  setProgress(progress: number, visible = true): void {
    if (!visible) {
      this.progressWrap.style.opacity = '0';
      this.progressFill.style.width = '0%';
      return;
    }
    const pct = Math.max(0, Math.min(1, progress)) * 100;
    this.progressWrap.style.opacity = '1';
    this.progressFill.style.width = pct.toFixed(1) + '%';
  }

  setDebug(text: string): void {
    this.debugEl.textContent = text;
  }

  setDebugVisible(visible: boolean): boolean {
    this.debugVisible = visible;
    this.debugWrap.style.display = visible ? 'block' : 'none';
    return this.debugVisible;
  }

  toggleDebug(): boolean {
    return this.setDebugVisible(!this.debugVisible);
  }

  toast(message: string, ms = 1800): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('ix-toast-visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('ix-toast-visible'), ms);
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Registers the reset action; the button asks for a second click first. */
  onReset(handler: () => void): void {
    this.resetHandler = handler;
  }

  /** True while the reset button waits for its confirmation click. */
  get resetIsArmed(): boolean {
    return this.resetArmed;
  }

  clickReset(): void {
    this.onResetClick();
  }

  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetButton?.removeEventListener('click', this.onResetClick);
    this.root.remove();
  }

  private onResetClick = (): void => {
    if (!this.resetButton) return;
    if (!this.resetArmed) {
      this.resetArmed = true;
      this.resetButton.classList.add('ix-reset-armed');
      this.resetButton.textContent = 'Confirm reset';
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.disarmReset(), RESET_ARM_MS);
      return;
    }
    this.disarmReset();
    this.resetHandler?.();
  };

  private disarmReset(): void {
    this.resetArmed = false;
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.resetButton) {
      this.resetButton.classList.remove('ix-reset-armed');
      this.resetButton.textContent = 'Reset world';
    }
  }

  private paintIcon(canvas: HTMLCanvasElement, id: BlockId): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    if (id <= 0) return;

    let source = this.icons.get(id);
    if (!source) {
      source = document.createElement('canvas');
      source.width = ICON_PX;
      source.height = ICON_PX;
      const sourceCtx = source.getContext('2d');
      if (sourceCtx && this.atlasCanvas) {
        sourceCtx.imageSmoothingEnabled = false;
        const tile = getBlockDef(id).tileSide;
        const sx = (tile % ATLAS_COLS) * ATLAS_TILE_PX;
        const sy = Math.floor(tile / ATLAS_COLS) * ATLAS_TILE_PX;
        sourceCtx.drawImage(this.atlasCanvas, sx, sy, ATLAS_TILE_PX, ATLAS_TILE_PX, 0, 0, ICON_PX, ICON_PX);
      } else if (sourceCtx) {
        sourceCtx.fillStyle = fallbackColor(id);
        sourceCtx.fillRect(0, 0, ICON_PX, ICON_PX);
      }
      this.icons.set(id, source);
    }
    ctx.drawImage(source, 0, 0);
  }
}

/** Flat colour per block, used when no atlas is available (headless tests). */
export function fallbackColor(id: BlockId): string {
  const name = getBlockDef(id).name;
  const table: Record<string, string> = {
    grass: '#5d9b3a',
    dirt: '#8a6440',
    stone: '#8d8d92',
    sand: '#e3d8a4',
    water: '#3a72c4',
    wood: '#6f5232',
    leaves: '#2f6b2a',
  };
  return table[name] ?? '#cccccc';
}

/** Human readable block name for HUD / toast text. */
export function blockLabel(id: BlockId): string {
  if (id <= 0) return 'air';
  return BLOCKS[id]?.name ?? 'unknown';
}

function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.ix-root { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #f2f7ff; }
.ix-crosshair { position: absolute; left: 50%; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  mix-blend-mode: difference; }
.ix-crosshair::before, .ix-crosshair::after { content: ''; position: absolute; background: #fff; }
.ix-crosshair::before { left: 8px; top: 0; width: 2px; height: 18px; }
.ix-crosshair::after { top: 8px; left: 0; height: 2px; width: 18px; }
.ix-progress { position: absolute; left: 50%; top: 50%; width: 140px; height: 8px; margin: 18px 0 0 -70px;
  background: rgba(8, 12, 20, 0.6); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 4px;
  transition: opacity 120ms linear; overflow: hidden; }
.ix-progress > i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #ffe08a, #ff9d3c); }
.ix-debug { position: absolute; top: 8px; left: 8px; padding: 6px 9px; background: rgba(10, 14, 22, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 6px; max-width: 46vw; }
.ix-debug pre { margin: 0; white-space: pre-wrap; }
.ix-hotbar { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; gap: 4px;
  padding: 4px; background: rgba(10, 14, 22, 0.45); border-radius: 8px; }
.ix-slot { position: relative; box-sizing: border-box; width: 40px; height: 40px; border: 2px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px; background: rgba(24, 30, 40, 0.55); display: flex; align-items: center; justify-content: center; }
.ix-slot canvas { width: 32px; height: 32px; image-rendering: pixelated; opacity: 1; }
.ix-slot.ix-slot-empty canvas { opacity: 0.12; }
.ix-slot.ix-slot-active { border-color: #ffd166;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.55), 0 0 14px 2px rgba(255, 209, 102, 0.8);
  transform: translateY(-3px) scale(1.08); }
.ix-count { position: absolute; right: 2px; bottom: 0; font-size: 13px; font-weight: 700;
  text-shadow: 0 1px 2px #000, 0 0 3px #000; }
.ix-key { position: absolute; left: 3px; top: 1px; font-size: 11px; opacity: 0.8; text-shadow: 0 1px 0 #000; }
.ix-toast { position: absolute; left: 50%; top: 12%; transform: translateX(-50%); padding: 6px 12px;
  background: rgba(10, 14, 22, 0.7); border-radius: 6px; opacity: 0; transition: opacity 150ms linear; }
.ix-toast-visible { opacity: 1; }
.ix-status { position: absolute; left: 50%; bottom: 64px; transform: translateX(-50%); padding: 4px 10px;
  background: rgba(10, 14, 22, 0.4); border-radius: 6px; }
.ix-reset { position: absolute; right: 10px; top: 10px; pointer-events: auto; cursor: pointer;
  font: inherit; color: #f2f7ff; background: rgba(10, 14, 22, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 6px; padding: 5px 10px; }
.ix-reset:hover { background: rgba(30, 40, 56, 0.75); }
.ix-reset-armed { background: #8a2b2b; border-color: #ffb3b3; }
`;
  document.head.appendChild(style);
}
