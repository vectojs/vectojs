import * as THREE from 'three';
import {
  Scene as VectoScene,
  Entity,
  VectoUIEvent,
  SceneOptions,
  VectoEvent,
} from '@vecto-ui/core';

export interface ThreeAdapterOptions {
  /** Physical layout width of the 2D UI canvas. */
  width: number;
  /** Physical layout height of the 2D UI canvas. */
  height: number;
  /** Optional pre-existing canvas element. If omitted, a new canvas is created. */
  canvas?: HTMLCanvasElement;
  /** Options passed to the VectoScene constructor. */
  sceneOptions?: SceneOptions;
}

interface PointerState {
  isHovering: boolean;
  lastUv: THREE.Vector2;
  lastTargetId: string | null;
}

/**
 * Adapts a VectoUI Scene into a Three.js CanvasTexture, allowing VectoUI
 * components to be rendered in 3D space (e.g. on a plane, screen, or VR dashboard).
 */
export class ThreeAdapter {
  /** The Three.js CanvasTexture wrapping the offscreen Vecto canvas. */
  public texture: THREE.CanvasTexture;
  /** The active VectoUI Scene instance. */
  public vectoScene: VectoScene;
  /** The offscreen HTMLCanvasElement on which Vecto draws. */
  public canvas: HTMLCanvasElement;
  /** A pre-built THREE.Mesh with PlaneGeometry and this texture for immediate use. */
  public mesh: THREE.Mesh;

  /** Track hover states independently per pointerId for WebXR / Multi-Touch. */
  private activePointers: Map<number, PointerState> = new Map();

  constructor(options: ThreeAdapterOptions) {
    this.canvas =
      options.canvas ||
      (typeof document !== 'undefined'
        ? document.createElement('canvas')
        : ({ width: options.width, height: options.height } as HTMLCanvasElement));
    this.canvas.width = options.width;
    this.canvas.height = options.height;

    // Enforce custom resize handling
    const sceneOptions: SceneOptions = {
      ...options.sceneOptions,
      disableWindowResize: true,
    };

    // Initialize Vecto Scene
    this.vectoScene = new VectoScene(this.canvas, sceneOptions);
    this.vectoScene.resize(options.width, options.height);

    // Create CanvasTexture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    // Proxy intercept VectoScene.render to set texture.needsUpdate = true only when redrawing
    const originalRender = this.vectoScene.render;
    this.vectoScene.render = (renderer, dt, time) => {
      originalRender.call(this.vectoScene, renderer, dt, time);
      this.texture.needsUpdate = true;
    };

    // Construct default mesh (size: 1x1 plane)
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
  }

  /**
   * Processes 3D Raycasting intersections and forwards pointer/scroll events.
   * Call this from window/document event listeners passing the raycaster.
   *
   * @param raycaster Three.js Raycaster instance.
   * @param type Pointer event type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'click'.
   * @param originalEvent Optional original DOM Event to forward scroll deltas or button states.
   * @returns true if the ray intersected the VectoUI mesh; false otherwise.
   */
  public updateIntersection(
    raycaster: THREE.Raycaster,
    type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'click',
    originalEvent?: Event,
  ): boolean {
    const intersects = raycaster.intersectObject(this.mesh);
    const pointerId = originalEvent instanceof PointerEvent ? originalEvent.pointerId : 1;

    let state = this.activePointers.get(pointerId);
    if (!state) {
      state = { isHovering: false, lastUv: new THREE.Vector2(), lastTargetId: null };
      this.activePointers.set(pointerId, state);
    }

    if (intersects.length > 0) {
      const hit = intersects[0];
      if (hit.uv) {
        state.lastUv.copy(hit.uv);
        state.isHovering = true;
        this.dispatchAtUv(type, hit.uv, pointerId, originalEvent);
        return true;
      }
    }

    // Trigger pointerleave when the cursor exits the UI boundaries
    if (state.isHovering) {
      state.isHovering = false;
      this.dispatchAtUv('pointerleave', state.lastUv, pointerId, originalEvent);
    }
    return false;
  }

  /**
   * Dispatches pointer events mapped from UV coordinates [0, 1] to VectoUI entities.
   */
  private dispatchAtUv(
    type: VectoEvent,
    uv: THREE.Vector2,
    pointerId: number,
    originalEvent?: Event,
  ): void {
    const px = uv.x * this.canvas.width;
    // Map Three.js Y (0 is bottom) to Canvas Y (0 is top)
    const py = (1.0 - uv.y) * this.canvas.height;

    // Trigger markDirty so the scene repaints immediately in onDemand mode
    this.vectoScene.markDirty();

    // Perform Vecto hierarchy hit testing
    const hitEntity = this.vectoScene.findEntityAt(px, py);
    const state = this.activePointers.get(pointerId);

    // Handle element hover transition events
    if (state && type === 'pointermove') {
      const currentTargetId = hitEntity ? hitEntity.id : null;
      if (currentTargetId !== state.lastTargetId) {
        if (state.lastTargetId) {
          const oldEntity = this.findEntityById(this.vectoScene.getRoot(), state.lastTargetId);
          if (oldEntity) {
            this.dispatchEventToTarget(oldEntity, 'pointerleave', px, py, pointerId, originalEvent);
          }
        }
        if (hitEntity) {
          this.dispatchEventToTarget(hitEntity, 'hover', px, py, pointerId, originalEvent);
        }
        state.lastTargetId = currentTargetId;
      }
    } else if (state && type === 'pointerleave') {
      if (state.lastTargetId) {
        const oldEntity = this.findEntityById(this.vectoScene.getRoot(), state.lastTargetId);
        if (oldEntity) {
          this.dispatchEventToTarget(oldEntity, 'pointerleave', px, py, pointerId, originalEvent);
        }
      }
      state.lastTargetId = null;
    }

    if (hitEntity) {
      this.dispatchEventToTarget(hitEntity, type, px, py, pointerId, originalEvent);
    } else {
      // Fallback: dispatch to canvas itself
      const fallbackEvent = this.createDOMEvent(type, px, py, pointerId, originalEvent);
      this.canvas.dispatchEvent(fallbackEvent);
    }
  }

  /**
   * Routes events to the associated A11y DOM element, or Vecto's own event dispatch system.
   */
  private dispatchEventToTarget(
    entity: Entity,
    type: VectoEvent,
    x: number,
    y: number,
    pointerId: number,
    originalEvent?: Event,
  ): void {
    const a11yEl = this.vectoScene.getA11yElement(entity.id);

    // If an associated transparent DOM element exists, dispatch to it to drive natively-bound widgets
    if (a11yEl) {
      const domEvent = this.createDOMEvent(type, x, y, pointerId, originalEvent);
      a11yEl.dispatchEvent(domEvent);

      // Handle focus activation for inputs/textareas
      if (
        type === 'pointerdown' &&
        (a11yEl instanceof HTMLInputElement ||
          a11yEl instanceof HTMLTextAreaElement ||
          a11yEl.getAttribute('tabindex') !== null)
      ) {
        a11yEl.focus();
      }
    } else {
      // Fallback: bubble the VectoUIEvent up the virtual tree directly
      const e = originalEvent instanceof MouseEvent ? originalEvent : undefined;
      const vectoEvent = new VectoUIEvent(type, entity, e, type !== 'pointerleave');
      entity.dispatchEvent(vectoEvent);
    }
  }

  private createDOMEvent(
    type: VectoEvent,
    x: number,
    y: number,
    pointerId: number,
    originalEvent?: Event,
  ): Event {
    if (type === 'wheel') {
      const wheelE = originalEvent instanceof WheelEvent ? originalEvent : undefined;
      return new WheelEvent('wheel', {
        clientX: x,
        clientY: y,
        deltaX: wheelE ? wheelE.deltaX : 0,
        deltaY: wheelE ? wheelE.deltaY : 0,
        deltaZ: wheelE ? wheelE.deltaZ : 0,
        deltaMode: wheelE ? wheelE.deltaMode : 0,
        bubbles: true,
        cancelable: true,
      });
    }

    return new PointerEvent(type as string, {
      clientX: x,
      clientY: y,
      button: originalEvent instanceof MouseEvent ? originalEvent.button : 0,
      buttons: originalEvent instanceof MouseEvent ? originalEvent.buttons : 0,
      pointerId,
      bubbles: true,
      cancelable: true,
    });
  }

  private findEntityById(root: Entity, id: string): Entity | null {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = this.findEntityById(child, id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Resizes the offscreen canvas and VectoScene dimensions.
   */
  public resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.vectoScene.resize(width, height);
    this.texture.needsUpdate = true;
  }

  /**
   * Disposes of Three.js textures, geometries, and VectoUI scenes to prevent memory leaks.
   */
  public dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      for (const mat of this.mesh.material) mat.dispose();
    } else {
      this.mesh.material.dispose();
    }
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.vectoScene.destroy();
    this.activePointers.clear();
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
