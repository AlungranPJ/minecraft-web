/**
 * First person mouse look.
 *
 * Yaw is free, pitch is clamped to +/- `maxPitchDegrees` (default 89) so the
 * camera can never roll over. The camera rotation is rebuilt from yaw/pitch
 * every frame in YXZ order, which is the only place the quaternion is written.
 *
 * Pointer lock: a left click on `element` asks the browser for the lock, ESC
 * leaves it (the browser does that by itself, this class only reacts to the
 * `pointerlockchange` event). When the lock is not available (or not wanted)
 * dragging with the left button still rotates the view, which also keeps the
 * controller usable in headless browsers and on touch screens.
 *
 * The camera is optional: with no camera and no element the controller is just
 * yaw/pitch state that tests can drive directly with `look()`.
 */
import * as THREE from 'three';

export interface LookOptions {
  /** Radians of rotation per pixel of mouse movement. Default 0.0022. */
  sensitivity?: number;
  /** Pitch limit in degrees. Default 89. */
  maxPitchDegrees?: number;
  /** Flip the vertical axis. Default false. */
  invertY?: boolean;
  /** Ask for pointer lock on click. Default true. */
  pointerLock?: boolean;
  /** Rotate while dragging when pointer lock is not active. Default true. */
  dragLook?: boolean;
  /** Initial yaw in radians. */
  yaw?: number;
  /** Initial pitch in radians. */
  pitch?: number;
}

export class MouseLook {
  yaw = 0;
  pitch = 0;
  locked = false;
  enabled = true;
  sensitivity: number;
  maxPitch: number;
  invertY: boolean;
  pointerLockEnabled: boolean;
  dragLookEnabled: boolean;
  /** The element the lock is requested on (null in headless / physics only use). */
  readonly element: HTMLElement | null;
  /** Notified when the pointer lock state changes (the demo shows a hint overlay). */
  onLockChange: ((locked: boolean) => void) | null = null;

  private readonly doc: Document | null;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private dragging = false;
  private pointerId: number | null = null;

  constructor(element: HTMLElement | null = null, options: LookOptions = {}) {
    this.element = element;
    this.doc = element?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    this.sensitivity = options.sensitivity ?? 0.0022;
    this.maxPitch = THREE.MathUtils.degToRad(options.maxPitchDegrees ?? 89);
    this.invertY = options.invertY ?? false;
    this.pointerLockEnabled = options.pointerLock !== false;
    this.dragLookEnabled = options.dragLook !== false;
    this.yaw = options.yaw ?? 0;
    this.pitch = clamp(options.pitch ?? 0, -this.maxPitch, this.maxPitch);

    if (element) {
      element.addEventListener('click', this.onClick);
      element.addEventListener('pointerdown', this.onPointerDown);
      element.addEventListener('pointermove', this.onPointerMove);
      element.addEventListener('pointerup', this.onPointerUp);
      element.addEventListener('pointercancel', this.onPointerUp);
      element.addEventListener('contextmenu', this.onContextMenu);
      this.doc?.addEventListener('pointerlockchange', this.onPointerLockChange);
      this.doc?.addEventListener('pointerlockerror', this.onPointerLockChange);
      this.doc?.addEventListener('mousemove', this.onMouseMove);
    }
  }

  dispose(): void {
    const element = this.element;
    if (element) {
      element.removeEventListener('click', this.onClick);
      element.removeEventListener('pointerdown', this.onPointerDown);
      element.removeEventListener('pointermove', this.onPointerMove);
      element.removeEventListener('pointerup', this.onPointerUp);
      element.removeEventListener('pointercancel', this.onPointerUp);
      element.removeEventListener('contextmenu', this.onContextMenu);
    }
    this.doc?.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.doc?.removeEventListener('pointerlockerror', this.onPointerLockChange);
    this.doc?.removeEventListener('mousemove', this.onMouseMove);
  }

  /** Applies raw mouse deltas (pixels). Pointer lock and drag both funnel through here. */
  look(deltaX: number, deltaY: number): void {
    if (!this.enabled) return;
    this.yaw -= deltaX * this.sensitivity;
    const vertical = (this.invertY ? deltaY : -deltaY) * this.sensitivity;
    this.pitch = clamp(this.pitch + vertical, -this.maxPitch, this.maxPitch);
    // keep yaw bounded so long sessions cannot drift into float noise territory
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Sets both angles (pitch is clamped). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -this.maxPitch, this.maxPitch);
  }

  /** Writes yaw/pitch onto a camera. */
  applyTo(camera: THREE.Camera): void {
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
  }

  /** Asks the browser for the pointer lock. Safe to call when unsupported. */
  requestLock(): void {
    if (!this.pointerLockEnabled || !this.element) return;
    const result = this.element.requestPointerLock?.() as unknown;
    if (result && typeof (result as Promise<void>).catch === 'function') {
      // Chrome rejects the request when the user just pressed ESC: ignore it.
      (result as Promise<void>).catch(() => {});
    }
  }

  exitLock(): void {
    if (this.doc?.pointerLockElement) this.doc.exitPointerLock?.();
  }

  private readonly onClick = (): void => {
    if (this.locked || !this.enabled) return;
    this.requestLock();
  };

  private readonly onPointerLockChange = (): void => {
    const locked = !!this.doc && this.doc.pointerLockElement === this.element;
    if (locked === this.locked) return;
    this.locked = locked;
    this.dragging = false;
    this.onLockChange?.(locked);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked || !this.enabled) return;
    this.look(event.movementX, event.movementY);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.locked || !this.enabled || !this.dragLookEnabled || event.button !== 0) return;
    this.dragging = true;
    this.pointerId = event.pointerId;
    // can throw when the pointer is no longer active (synthetic events, lost capture)
    try {
      this.element?.setPointerCapture?.(event.pointerId);
    } catch {
      /* drag look works without the capture */
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || this.locked || !this.enabled) return;
    this.look(event.movementX, event.movementY);
  };

  private readonly onPointerUp = (): void => {
    if (this.pointerId !== null) {
      try {
        this.element?.releasePointerCapture?.(this.pointerId);
      } catch {
        /* capture was never taken */
      }
      this.pointerId = null;
    }
    this.dragging = false;
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
