/**
 * Visual feedback for digging: a wireframe box around the targeted block plus an
 * inner box that shrinks as the break progresses (a cheap crack animation).
 */
import * as THREE from 'three';

export interface HighlightOptions {
  /** Outline colour. Default black, like Minecraft's selection box. */
  outline?: number;
  /** Progress box colour. Default white. */
  progress?: number;
}

export class TargetHighlight {
  readonly group: THREE.Group;
  visible = false;

  private readonly outlineGeometry: THREE.EdgesGeometry;
  private readonly outlineMaterial: THREE.LineBasicMaterial;
  private readonly progressMaterial: THREE.LineBasicMaterial;
  private readonly progressMesh: THREE.LineSegments;

  constructor(scene: THREE.Object3D, opts: HighlightOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'interaction-highlight';
    this.group.visible = false;
    this.group.renderOrder = 10;

    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.outlineGeometry = new THREE.EdgesGeometry(box);
    box.dispose();
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: opts.outline ?? 0x000000,
      transparent: true,
      opacity: 0.55,
      fog: false,
    });
    const outline = new THREE.LineSegments(this.outlineGeometry, this.outlineMaterial);
    this.group.add(outline);

    const inner = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const innerEdges = new THREE.EdgesGeometry(inner);
    inner.dispose();
    this.progressMaterial = new THREE.LineBasicMaterial({
      color: opts.progress ?? 0xffffff,
      transparent: true,
      opacity: 0.85,
      fog: false,
    });
    this.progressMesh = new THREE.LineSegments(innerEdges, this.progressMaterial);
    this.progressMesh.visible = false;
    this.group.add(this.progressMesh);

    scene.add(this.group);
  }

  /** Puts the box on a voxel. `progress` 0..1 shrinks the inner box. */
  show(position: [number, number, number], progress = 0): void {
    this.group.position.set(position[0] + 0.5, position[1] + 0.5, position[2] + 0.5);
    this.group.visible = true;
    this.visible = true;

    const active = progress > 0.001;
    this.progressMesh.visible = active;
    if (active) {
      const scale = Math.max(0.08, 1 - Math.min(progress, 1) * 0.92);
      this.progressMesh.scale.set(scale, scale, scale);
      this.progressMaterial.opacity = 0.35 + 0.55 * Math.min(progress, 1);
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.group.visible = false;
    this.visible = false;
    this.progressMesh.visible = false;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.outlineGeometry.dispose();
    this.outlineMaterial.dispose();
    this.progressMaterial.dispose();
    this.progressMesh.geometry.dispose();
  }
}
