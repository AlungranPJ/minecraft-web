/**
 * Keyboard input for the first person player.
 *
 * Keys are mapped to abstract actions, so the keymap is remappable at runtime
 * (`setKeymap`) and gameplay code never looks at raw `event.code` values.
 */

export type PlayerAction = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint';

export type Keymap = Record<PlayerAction, string[]>;

/** KeyboardEvent.code values. */
export const DEFAULT_KEYMAP: Keymap = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
};

export const PLAYER_ACTIONS: PlayerAction[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

/** Anything that can carry keydown/keyup listeners: `window`, an element, or a test double. */
export interface KeyEventTarget {
  addEventListener(type: 'keydown' | 'keyup' | 'blur', listener: (event: any) => void): void;
  removeEventListener(type: 'keydown' | 'keyup' | 'blur', listener: (event: any) => void): void;
}

/** The bits of a KeyboardEvent this module reads (keeps node tests DOM free). */
interface KeyLikeEvent {
  code?: string;
  repeat?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

/** Keys the page should not scroll with while the game has focus. */
const SWALLOWED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class KeyboardInput {
  /** Actions whose keys are held right now. */
  private readonly down = new Set<PlayerAction>();
  private keymap: Keymap;
  private readonly codes = new Map<string, PlayerAction[]>();
  private readonly target: KeyEventTarget;

  constructor(target: KeyEventTarget, keymap: Partial<Keymap> = {}) {
    this.target = target;
    this.keymap = { ...DEFAULT_KEYMAP };
    this.reindex();
    this.setKeymap(keymap);
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.clear();
  }

  /** Current keymap (a copy: mutating it does nothing, call `setKeymap`). */
  getKeymap(): Keymap {
    return {
      forward: [...this.keymap.forward],
      back: [...this.keymap.back],
      left: [...this.keymap.left],
      right: [...this.keymap.right],
      jump: [...this.keymap.jump],
      sprint: [...this.keymap.sprint],
    };
  }

  /**
   * Remaps one or more actions. Unknown action names and empty key lists throw,
   * so a typo fails loudly instead of silently disabling movement.
   */
  setKeymap(patch: Partial<Keymap>): void {
    for (const [action, keys] of Object.entries(patch) as Array<[PlayerAction, string[]]>) {
      if (!PLAYER_ACTIONS.includes(action)) {
        throw new Error(`KeyboardInput: unknown action "${action}" (expected one of ${PLAYER_ACTIONS.join(', ')})`);
      }
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' || key === '')) {
        throw new Error(`KeyboardInput: action "${action}" needs a non empty array of KeyboardEvent.code strings`);
      }
      this.keymap[action] = [...keys];
    }
    this.reindex();
  }

  isDown(action: PlayerAction): boolean {
    return this.down.has(action);
  }

  /** Movement axes in the -1..1 range: `forward` is W/S, `strafe` is D/A. */
  axes(): { forward: number; strafe: number } {
    return {
      forward: (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0),
      strafe: (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0),
    };
  }

  /** Drives an action without a keyboard (automation, replays, tests). */
  setAction(action: PlayerAction, down: boolean): void {
    if (down) this.down.add(action);
    else this.down.delete(action);
  }

  /** Releases everything (also called on window blur). */
  clear(): void {
    this.down.clear();
  }

  private reindex(): void {
    this.codes.clear();
    for (const action of PLAYER_ACTIONS) {
      for (const code of this.keymap[action]) {
        const actions = this.codes.get(code);
        if (actions) actions.push(action);
        else this.codes.set(code, [action]);
      }
    }
  }

  private onKeyDown = (event: KeyLikeEvent): void => {
    const code = event.code ?? '';
    const actions = this.codes.get(code);
    if (!actions) return;
    if (isTypingTarget(event.target)) return;
    if (SWALLOWED.has(code)) event.preventDefault?.();
    for (const action of actions) this.down.add(action);
  };

  private onKeyUp = (event: KeyLikeEvent): void => {
    const actions = this.codes.get(event.code ?? '');
    if (!actions) return;
    for (const action of actions) this.down.delete(action);
  };

  private onBlur = (): void => {
    this.clear();
  };
}

/** Don't steal keys from text fields (the HUD / debug console may add some later). */
function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}
