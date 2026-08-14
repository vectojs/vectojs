import * as THREE from 'three';

/** Viewing mode for {@link GraphCamera}. */
export type GraphCameraMode = '2d' | '3d';

export interface GraphCameraOptions {
  /**
   * `'2d'` (default) — orthographic camera looking down −Z, pan + zoom only.
   * `'3d'` — perspective camera with orbit-style rotate + pan + zoom.
   */
  mode?: GraphCameraMode;
  /** Element that receives pointer/wheel events (usually the WebGL canvas). */
  domElement: HTMLElement;
  /** Initial canvas width in CSS px. Defaults to the element's client width. */
  width?: number;
  /** Initial canvas height in CSS px. Defaults to the element's client height. */
  height?: number;
  /**
   * Half-height of the orthographic frustum at zoom 1 (world units).
   * Default 200 — a typical force graph fits without an immediate fit pass.
   */
  orthoHalfHeight?: number;
  /** Perspective vertical FOV in degrees. Default 50. */
  fov?: number;
  /** Near/far clip. Defaults `[0.1, 10000]`. */
  near?: number;
  far?: number;
  /** Perspective camera distance from the look-at target. Default 400. */
  perspectiveDistance?: number;
  /**
   * Whether the left mouse button pans (2D) / orbits (3D). Default `true`.
   * Hosts that already use left-click for node selection typically keep this
   * on and let {@link GraphInteraction.setControlsEnabled} gate it during drags.
   */
  enableRotate?: boolean;
  /** Wheel zoom sensitivity. Default 0.001. */
  zoomSpeed?: number;
  /** Pointer pan sensitivity in world units per pixel at zoom 1. Default 1. */
  panSpeed?: number;
  /**
   * Min orthographic zoom (larger = closer). Default 0.01 — low enough that
   * `fitToPositions` can frame a force layout whose span is several thousand
   * world units (dense bipartite cuts easily reach that).
   */
  minZoom?: number;
  /** Max orthographic zoom. Default 20. */
  maxZoom?: number;
  /** Min perspective distance. Default 20. */
  minDistance?: number;
  /** Max perspective distance. Default 4000. */
  maxDistance?: number;
}

/**
 * Camera + pan/zoom (and 3D orbit) controls for a {@link Graph3D} scene.
 *
 * graph3d deliberately ships no camera of its own so hosts can drop a graph
 * into any Three.js app. Knowledge-graph apps — and any flat 2D force graph —
 * still need a battery-included option: this is that option.
 *
 * - **2D**: `THREE.OrthographicCamera` looking at the origin down −Z. Left-drag
 *   pans the view; wheel zooms about the cursor. Rotate is a no-op.
 * - **3D**: `THREE.PerspectiveCamera` with left-drag orbit, right/middle-drag
 *   pan, wheel dolly. Spherical angles stay clamped off the poles.
 *
 * The host owns the render loop; call {@link update} only if you change
 * `domElement` size via {@link setSize}. Pointer listeners are attached in the
 * constructor and removed by {@link dispose}.
 *
 * Pair with {@link GraphInteraction} by passing {@link camera} and wiring
 * `setControlsEnabled` so a node drag does not also pan the view.
 */
export class GraphCamera {
  private readonly ortho: THREE.OrthographicCamera;
  private readonly perspective: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private mode: GraphCameraMode;

  /** The Three.js camera currently driving the view (ortho or perspective). */
  get camera(): THREE.Camera {
    return this.mode === '2d' ? this.ortho : this.perspective;
  }

  private width: number;
  private height: number;
  private readonly orthoHalfHeight: number;
  private readonly zoomSpeed: number;
  private readonly panSpeed: number;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly enableRotate: boolean;

  /** Look-at / orbit target in world space. */
  private readonly target = new THREE.Vector3(0, 0, 0);
  /** Perspective spherical state (radians). */
  private spherical = { radius: 400, phi: Math.PI / 3, theta: 0 };

  private enabled = true;
  private pointerId: number | null = null;
  private dragging = false;
  private button = -1;
  private lastX = 0;
  private lastY = 0;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onContextMenu: (e: Event) => void;

  constructor(options: GraphCameraOptions) {
    this.domElement = options.domElement;
    this.mode = options.mode ?? '2d';
    this.width = options.width ?? Math.max(1, this.domElement.clientWidth || 800);
    this.height = options.height ?? Math.max(1, this.domElement.clientHeight || 600);
    this.orthoHalfHeight = options.orthoHalfHeight ?? 200;
    this.zoomSpeed = options.zoomSpeed ?? 0.001;
    this.panSpeed = options.panSpeed ?? 1;
    this.minZoom = options.minZoom ?? 0.01;
    this.maxZoom = options.maxZoom ?? 20;
    this.minDistance = options.minDistance ?? 20;
    this.maxDistance = options.maxDistance ?? 4000;
    this.enableRotate = options.enableRotate ?? true;
    this.spherical.radius = options.perspectiveDistance ?? 400;

    const near = options.near ?? 0.1;
    const far = options.far ?? 10000;
    const aspect = this.width / this.height;
    const halfH = this.orthoHalfHeight;
    const halfW = halfH * aspect;

    this.ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, near, far);
    this.ortho.position.set(0, 0, 500);
    this.ortho.up.set(0, 1, 0);
    this.ortho.lookAt(this.target);
    this.ortho.zoom = 1;
    this.ortho.updateProjectionMatrix();

    this.perspective = new THREE.PerspectiveCamera(options.fov ?? 50, aspect, near, far);
    this.applySpherical();

    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onWheel = (e) => this.handleWheel(e);
    this.onContextMenu = (e) => e.preventDefault();

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerUp);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.domElement.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Active mode. */
  getMode(): GraphCameraMode {
    return this.mode;
  }

  /**
   * Switch between 2D ortho and 3D perspective. The look-at target is preserved;
   * the perspective spherical radius is left as-is so a round-trip feels stable.
   */
  setMode(mode: GraphCameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === '2d') {
      this.ortho.position.set(this.target.x, this.target.y, this.target.z + 500);
      this.ortho.lookAt(this.target);
      this.ortho.updateProjectionMatrix();
    } else {
      this.applySpherical();
    }
  }
  /**
   * Enable or disable pointer/wheel handling. Used by hosts (and
   * {@link GraphInteraction}) so a node drag does not also pan the camera.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.endDrag();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Resize the camera frustum to a new canvas size (CSS px). */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const aspect = this.width / this.height;
    const halfH = this.orthoHalfHeight / this.ortho.zoom;
    const halfW = halfH * aspect;
    this.ortho.left = -halfW;
    this.ortho.right = halfW;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
  }

  /**
   * Frame the given xyz-triplet positions (same layout as {@link Graph3D.applyPositions})
   * with a small padding. No-op on empty input.
   */
  fitToPositions(positions: Float32Array, padding = 1.2): void {
    if (positions.length < 3) return;
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!,
        y = positions[i + 1]!,
        z = positions[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    this.target.set(cx, cy, this.mode === '2d' ? 0 : cz);

    const spanX = Math.max(maxX - minX, 1) * padding;
    const spanY = Math.max(maxY - minY, 1) * padding;
    const spanZ = Math.max(maxZ - minZ, 1) * padding;

    if (this.mode === '2d') {
      const halfHNeeded = Math.max(spanY / 2, spanX / 2 / (this.width / this.height));
      const zoom = Math.min(
        this.maxZoom,
        Math.max(this.minZoom, this.orthoHalfHeight / halfHNeeded),
      );
      this.ortho.zoom = zoom;
      this.ortho.position.set(cx, cy, 500);
      this.ortho.lookAt(this.target);
      this.setSize(this.width, this.height);
    } else {
      const radius = Math.max(spanX, spanY, spanZ) * 1.2;
      this.spherical.radius = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, radius / Math.tan(((this.perspective.fov / 2) * Math.PI) / 180)),
      );
      this.applySpherical();
    }
  }

  /** Release listeners. Does not dispose Three.js cameras (GC is fine). */
  dispose(): void {
    this.endDrag();
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private applySpherical(): void {
    const { radius, phi, theta } = this.spherical;
    const sinPhi = Math.sin(phi);
    const x = radius * sinPhi * Math.sin(theta);
    const y = radius * Math.cos(phi);
    const z = radius * sinPhi * Math.cos(theta);
    this.perspective.position.set(this.target.x + x, this.target.y + y, this.target.z + z);
    this.perspective.up.set(0, 1, 0);
    this.perspective.lookAt(this.target);
    this.perspective.updateProjectionMatrix();
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    // Primary (0) pans in 2D / orbits in 3D; middle (1) and right (2) always pan.
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    this.dragging = true;
    this.button = e.button;
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    try {
      this.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / lost capture */
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.enabled || !this.dragging) return;
    if (this.pointerId != null && e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    const isPan =
      this.button === 1 ||
      this.button === 2 ||
      this.mode === '2d' ||
      (this.button === 0 && !this.enableRotate);

    if (isPan) this.pan(dx, dy);
    else this.orbit(dx, dy);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (this.pointerId != null && e.pointerId !== this.pointerId) return;
    this.endDrag();
  }

  private endDrag(): void {
    if (this.pointerId != null) {
      try {
        this.domElement.releasePointerCapture(this.pointerId);
      } catch {
        /* already released */
      }
    }
    this.dragging = false;
    this.pointerId = null;
    this.button = -1;
  }

  private handleWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    if (this.mode === '2d') {
      const factor = Math.exp(-e.deltaY * this.zoomSpeed);
      const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.ortho.zoom * factor));
      this.ortho.zoom = next;
      this.setSize(this.width, this.height);
    } else {
      const factor = Math.exp(e.deltaY * this.zoomSpeed);
      this.spherical.radius = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, this.spherical.radius * factor),
      );
      this.applySpherical();
    }
  }

  private pan(dx: number, dy: number): void {
    if (this.mode === '2d') {
      // Screen +x → world +x, screen +y → world −y; scale by current frustum.
      const halfH = this.orthoHalfHeight / this.ortho.zoom;
      const halfW = halfH * (this.width / this.height);
      const worldDx = (-dx / this.width) * halfW * 2 * this.panSpeed;
      const worldDy = (dy / this.height) * halfH * 2 * this.panSpeed;
      this.target.x += worldDx;
      this.target.y += worldDy;
      this.ortho.position.x += worldDx;
      this.ortho.position.y += worldDy;
      this.ortho.lookAt(this.target);
    } else {
      // Pan in the camera's local right/up plane, scaled by distance.
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      right.setFromMatrixColumn(this.perspective.matrixWorld, 0).normalize();
      up.setFromMatrixColumn(this.perspective.matrixWorld, 1).normalize();
      const dist = this.spherical.radius;
      const scale = (dist * this.panSpeed) / Math.max(this.height, 1);
      const move = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
      this.target.add(move);
      this.applySpherical();
    }
  }

  private orbit(dx: number, dy: number): void {
    const rotSpeed = 0.005;
    this.spherical.theta -= dx * rotSpeed;
    this.spherical.phi = Math.min(
      Math.PI - 0.05,
      Math.max(0.05, this.spherical.phi - dy * rotSpeed),
    );
    this.applySpherical();
  }
}
