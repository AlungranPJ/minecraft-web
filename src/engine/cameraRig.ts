import * as THREE from 'three';

export interface SpectatorOptions {
  /** Movement speed in blocks per second. Default 12. */
  speed?: number;
  /** Radians of rotation per pixel of mouse drag. Default 0.0025. */
  lookSpeed?: number;
  /** Set false to keep camera movements to gameplay code only. */
  mouseLook?: boolean;
}

const PITCH_LIMIT = THREE.MathUtils.degToRad(89);

/**
 * Minimal free-fly camera: drag with the mouse to look, WASD to move,
 * Space/Shift for up/down, wheel to change speed.
 *
 * This is only the temporary demo camera the engine ship with. Gameplay code
 * (first person player, physics) should either disable it (createGame option
 * `controls: 'none'`) or drive the camera itself from onFrame().
 */
export class SpectatorController {
  enabled = true;
  speed: number;
  yaw = 0;
  pitch = 0;

  private readonly element: HTMLElement;
  private readonly lookSpeed: number;
  private readonly mouseLook: boolean;
  private readonly keys = new Set<string>();
  private dragging = false;
  private pointerId: number | null = null;

  constructor(camera: THREE.Camera, element: HTMLElement, opts: SpectatorOptions = {}) {
    this.element = element;
    this.speed = opts.speed ?? 12;
    this.lookSpeed = opts.lookSpeed ?? 0.0025;
    this.mouseLook = opts.mouseLook !== false;

    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = euler.y;
    this.pitch = euler.x;

    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
  }

  /** True while a movement key is held. */
  isMoving(): boolean {
    return this.keys.has('KeyW') || this.keys.has('KeyA') || this.keys.has('KeyS') || this.keys.has('KeyD');
  }

  update(dt: number, camera: THREE.Camera): void {
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    if (!this.enabled) return;

    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const lift = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0);
    if (forward === 0 && strafe === 0 && lift === 0) return;

    const boost = this.keys.has('ControlLeft') ? 4 : 1;
    const step = this.speed * boost * dt;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // horizontal move along the yaw only, so looking down does not slow you down
    camera.position.x += (-sin * forward + cos * strafe) * step;
    camera.position.z += (-cos * forward - sin * strafe) * step;
    camera.position.y += lift * step;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.mouseLook || !this.enabled || event.button !== 0) return;
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.element.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || !this.enabled) return;
    this.yaw -= event.movementX * this.lookSpeed;
    this.pitch -= event.movementY * this.lookSpeed;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== null) {
      this.element.releasePointerCapture?.(this.pointerId);
      this.pointerId = null;
    }
    this.dragging = false;
    void event;
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    const next = this.speed * Math.exp(-event.deltaY * 0.0015);
    this.speed = Math.max(2, Math.min(200, next));
  };

  private onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.dragging = false;
  };
}
