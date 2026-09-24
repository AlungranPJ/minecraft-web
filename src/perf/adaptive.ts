/**
 * Adaptive quality: keeps the frame rate above a floor on weaker machines.
 *
 * Pure logic (no DOM, no timers of its own): the host feeds it the frame time
 * and the measured fps once per frame, then applies whatever level comes out.
 * That makes the whole policy testable in node — see tests/perf.smoke.test.ts.
 *
 * Policy: a level is dropped only after the fps stayed below `degradeBelowFps`
 * for `degradeAfterSeconds`; it is raised again only after the fps stayed above
 * `recoverAboveFps` for the longer `recoverAfterSeconds`. The asymmetry is
 * deliberate: dropping quality is cheap and visible, raising it again while a
 * chunk build spike is still settling would make the level flap.
 *
 * Level 0 is the best quality and also the ceiling: the controller never goes
 * above where it started, so a fast machine keeps the quality the page asked
 * for (and the engine's chunk budget stays predictable).
 */

export interface QualityLevel {
  /** Label shown in the HUD / debug overlay. */
  name: string;
  /** Chunk radius streamed around the player. */
  renderDistance: number;
  /** Upper bound for the device pixel ratio (fill rate). */
  pixelRatio: number;
  /** Chunk (re)builds allowed per frame (CPU spike size). */
  chunkOpsPerFrame: number;
}

/** Best -> worst. Tuned for integrated GPUs on a 1280x720 .. 1920x1080 screen. */
export const QUALITY_LEVELS: QualityLevel[] = [
  { name: 'high', renderDistance: 6, pixelRatio: 1.5, chunkOpsPerFrame: 2 },
  { name: 'medium', renderDistance: 5, pixelRatio: 1.25, chunkOpsPerFrame: 1 },
  { name: 'low', renderDistance: 4, pixelRatio: 1, chunkOpsPerFrame: 1 },
  { name: 'minimal', renderDistance: 3, pixelRatio: 0.85, chunkOpsPerFrame: 1 },
];

export interface AdaptiveQualityOptions {
  levels?: QualityLevel[];
  /** fps below this counts as "too slow". Default 45. */
  degradeBelowFps?: number;
  /** fps above this counts as "there is headroom". Default 57. */
  recoverAboveFps?: number;
  /** Seconds below the floor before the level drops. Default 2.5. */
  degradeAfterSeconds?: number;
  /** Seconds above the ceiling before the level rises. Default 6. */
  recoverAfterSeconds?: number;
  /** Level to start on. Default 0 (the best one). */
  startLevel?: number;
}

export interface QualityChange {
  /** Seconds of runtime when the change happened. */
  at: number;
  from: string;
  to: string;
  /** fps measurement that triggered it. */
  fps: number;
}

export class AdaptiveQuality {
  readonly levels: QualityLevel[];
  readonly degradeBelowFps: number;
  readonly recoverAboveFps: number;
  readonly degradeAfterSeconds: number;
  readonly recoverAfterSeconds: number;
  /** Live log of the level changes, newest last (kept for the HUD / tests). */
  readonly changes: QualityChange[] = [];
  /** Set false to freeze the level (perf runs that must not move). */
  enabled = true;
  /** How many fps samples have been fed in. */
  samples = 0;
  /** Seconds fed in so far. */
  elapsed = 0;

  private index: number;
  private lowTimer = 0;
  private highTimer = 0;

  constructor(options: AdaptiveQualityOptions = {}) {
    this.levels = options.levels ?? QUALITY_LEVELS;
    if (this.levels.length === 0) throw new Error('AdaptiveQuality: needs at least one level');
    this.degradeBelowFps = options.degradeBelowFps ?? 45;
    this.recoverAboveFps = options.recoverAboveFps ?? 57;
    this.degradeAfterSeconds = options.degradeAfterSeconds ?? 2.5;
    this.recoverAfterSeconds = options.recoverAfterSeconds ?? 6;
    this.index = clampIndex(options.startLevel ?? 0, this.levels.length);
  }

  /** Current level index (0 = best). */
  get level(): number {
    return this.index;
  }

  get current(): QualityLevel {
    return this.levels[this.index];
  }

  get atWorst(): boolean {
    return this.index >= this.levels.length - 1;
  }

  get atBest(): boolean {
    return this.index <= 0;
  }

  /**
   * Feeds one frame. `fps <= 0` means "no measurement yet" (the engine only
   * publishes a rate every 0.5 s) and is ignored. Returns true when the level
   * changed, so the host can re-apply it.
   */
  update(dt: number, fps: number): boolean {
    const step = Math.max(0, dt);
    this.elapsed += step;
    if (!this.enabled || !Number.isFinite(fps) || fps <= 0) return false;
    this.samples++;

    if (fps < this.degradeBelowFps) {
      this.lowTimer += step;
      this.highTimer = 0;
      if (this.lowTimer >= this.degradeAfterSeconds) return this.step(+1, fps);
      return false;
    }

    if (fps > this.recoverAboveFps) {
      this.highTimer += step;
      this.lowTimer = 0;
      if (this.highTimer >= this.recoverAfterSeconds) return this.step(-1, fps);
      return false;
    }

    // dead band: back off both timers so a single dip does not accumulate
    this.lowTimer = Math.max(0, this.lowTimer - step * 2);
    this.highTimer = Math.max(0, this.highTimer - step * 2);
    return false;
  }

  /** Jumps straight to a level (debug / perf runs). Returns true when it moved. */
  forceLevel(index: number, fps = 0): boolean {
    const next = clampIndex(index, this.levels.length);
    if (next === this.index) return false;
    this.stepTo(next, fps);
    return true;
  }

  /** Forgets the timers without touching the level (used when boot finishes). */
  resetTimers(): void {
    this.lowTimer = 0;
    this.highTimer = 0;
  }

  /** Back to the starting quality, timers cleared. */
  reset(): void {
    this.index = 0;
    this.resetTimers();
    this.samples = 0;
    this.elapsed = 0;
    this.changes.length = 0;
  }

  private step(direction: 1 | -1, fps: number): boolean {
    const next = clampIndex(this.index + direction, this.levels.length);
    if (next === this.index) {
      // already at the end of the ladder: hold the timers so it does not spin
      this.lowTimer = this.highTimer = 0;
      return false;
    }
    this.stepTo(next, fps);
    return true;
  }

  private stepTo(next: number, fps: number): void {
    const from = this.current.name;
    this.index = next;
    this.resetTimers();
    this.changes.push({ at: Number(this.elapsed.toFixed(2)), from, to: this.current.name, fps: Number(fps.toFixed(1)) });
    if (this.changes.length > 32) this.changes.shift();
  }
}

function clampIndex(value: number, size: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(size - 1, n));
}
