/**
 * A 2-D coordinate in canvas/world space.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * An axis-aligned bounding box in an entity's local coordinate space.
 *
 * Returned from {@link Entity.getBounds} to enable viewport culling.
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Describes an entity that renders as a single filled circle at its local
 * origin, returned from {@link Entity.getBatchCircle} to opt into the renderer's
 * draw-call batching fast-path.
 */
export interface BatchCircle {
  /** Circle radius in the entity's local space. */
  radius: number;
  /** CSS fill color. */
  color: string;
}

/**
 * Describes an entity that renders as a single filled rectangle from its local
 * origin, returned from {@link Entity.getBatchRect} to opt into the GPU
 * instanced-rectangle fast-path (WebGL `pointBackend` only).
 */
export interface BatchRect {
  /** Rectangle width in the entity's local space. */
  width: number;
  /** Rectangle height in the entity's local space. */
  height: number;
  /** CSS fill color. */
  color: string;
}

/**
 * Semantic attributes an {@link Entity} can project into the accessibility /
 * automation shadow layer maintained by {@link Scene}.
 *
 * Returned from {@link Entity.getA11yAttributes}; consumed by `Scene.syncA11y`
 * to create and label the shadow DOM node (e.g. a real `<button>` or `<a href>`)
 * so the canvas stays accessible and clickable by automation/agents.
 */
export interface A11yAttributes {
  /** Shadow element tag to create. Defaults to `'div'`. */
  tag?: 'div' | 'a' | 'button' | 'img' | 'input';
  /** ARIA role applied via the `role` attribute. */
  role?: string;
  /** Accessible name applied via `aria-label`. */
  label?: string;
  /** Destination URL; only meaningful for `tag: 'a'`. */
  href?: string;
  /** Image source; only meaningful for `tag: 'img'`. */
  src?: string;
  /** Alternative text; only meaningful for `tag: 'img'`. */
  alt?: string;
  /** Input type (e.g. `'text'`, `'checkbox'`); only meaningful for `tag: 'input'`. */
  inputType?: string;
  /** Placeholder text; only meaningful for `tag: 'input'`. */
  placeholder?: string;
  /** Current value; refreshed each frame for `tag: 'input'` (text fields). */
  value?: string;
  /**
   * Checked state — sets `input.checked` for checkbox inputs and `aria-checked`
   * for `role: 'switch'`/`'checkbox'`. Refreshed each frame.
   */
  checked?: boolean;
}

/**
 * Union of all pointer/interaction events that can be emitted by an {@link Entity}.
 */
export type VectoEvent =
  | 'click'
  | 'hover'
  | 'pointerdown'
  | 'pointerup'
  | 'pointermove'
  | 'pointerleave'
  // Emitted from a form-control shadow node (`<input>`) when its value/checked
  // changes; payload `{ value, checked, selectionStart, selectionEnd, composition }`
  // where `composition` is `{ start, length } | null` for the active IME pre-edit.
  | 'change'
  // Emitted when the shadow `<input>` gains/loses focus (caret blink, etc.).
  | 'focus'
  | 'blur'
  // Mouse-wheel / trackpad scroll over the entity's shadow node; payload is the
  // native `WheelEvent` (call `preventDefault()` to stop the page scrolling).
  | 'wheel';

/** Options for {@link Entity.on} / {@link Entity.off}. */
export interface ListenerOptions {
  /** Register the listener for the capture phase (root→target) instead of bubble. */
  capture?: boolean;
}

/**
 * A propagating event dispatched through the entity tree by
 * {@link Entity.dispatchEvent} (DOM-like capture + bubble).
 *
 * It wraps the originating browser event (`nativeEvent`) and adds tree-aware
 * fields: `target` (where it originated), `currentTarget` (the node currently
 * handling it), and `stopPropagation()`. Common native fields (`deltaY`,
 * `clientX`, `key`, …) and `preventDefault()` pass through to `nativeEvent`, so
 * handlers written against the raw DOM event keep working.
 */
export class VectoUIEvent<N = unknown> {
  /** The event name. */
  readonly type: VectoEvent;
  /** The entity the event originated on. */
  readonly target: Entity;
  /** The entity whose listeners are currently running (updated per node). */
  currentTarget: Entity;
  /** The wrapped browser event, if any. */
  readonly nativeEvent: N | undefined;
  /** Whether the event bubbles past its target (capture always runs). */
  readonly bubbles: boolean;
  private stopped = false;
  private stoppedImmediate = false;

  constructor(type: VectoEvent, target: Entity, nativeEvent?: N, bubbles: boolean = true) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.nativeEvent = nativeEvent;
    this.bubbles = bubbles;
  }

  /** Stop the event from reaching the next node in the propagation path. */
  stopPropagation(): void {
    this.stopped = true;
  }

  /** Stop propagation AND skip any remaining listeners on the current node. */
  stopImmediatePropagation(): void {
    this.stopped = true;
    this.stoppedImmediate = true;
  }

  /** Forward to the native event's `preventDefault` (e.g. stop page scroll). */
  preventDefault(): void {
    (this.nativeEvent as { preventDefault?: () => void })?.preventDefault?.();
  }

  /** Whether {@link stopPropagation} has been called. */
  get propagationStopped(): boolean {
    return this.stopped;
  }

  /** Whether {@link stopImmediatePropagation} has been called. */
  get immediatePropagationStopped(): boolean {
    return this.stoppedImmediate;
  }

  /** Whether the native event's default action was prevented. */
  get defaultPrevented(): boolean {
    return !!(this.nativeEvent as { defaultPrevented?: boolean })?.defaultPrevented;
  }

  /** Native horizontal wheel delta, if this wraps a `WheelEvent`. */
  get deltaX(): number | undefined {
    return (this.nativeEvent as { deltaX?: number })?.deltaX;
  }

  /** Native vertical wheel delta, if this wraps a `WheelEvent`. */
  get deltaY(): number | undefined {
    return (this.nativeEvent as { deltaY?: number })?.deltaY;
  }

  /** Native pointer X, if this wraps a pointer/mouse event. */
  get clientX(): number | undefined {
    return (this.nativeEvent as { clientX?: number })?.clientX;
  }

  /** Native pointer Y, if this wraps a pointer/mouse event. */
  get clientY(): number | undefined {
    return (this.nativeEvent as { clientY?: number })?.clientY;
  }

  /** Native key, if this wraps a keyboard event. */
  get key(): string | undefined {
    return (this.nativeEvent as { key?: string })?.key;
  }
}

/**
 * Base class for every node in the Virtual Math Tree (VMT).
 *
 * Subclass `Entity` and implement {@link isPointInside} and {@link render} to
 * create custom drawable objects.  Entities form a scene-graph: each node may
 * own child entities, inheriting the parent's transform.
 *
 * @example
 * class CircleEntity extends Entity {
 *   isPointInside(x: number, y: number) {
 *     return Math.hypot(x - this.x, y - this.y) < 50;
 *   }
 *   render(r: IRenderer) {
 *     r.beginPath();
 *     r.fill('#38bdf8');
 *   }
 * }
 */
export abstract class Entity {
  public id: string;
  public children: Entity[] = [];
  public parent: Entity | null = null;

  /**
   * Walk up the parent chain to find the scene this entity is currently attached to.
   */
  public get scene(): any {
    if ((this as any)._scene) return (this as any)._scene;
    return this.parent ? this.parent.scene : null;
  }

  public x: number = 0;
  public y: number = 0;
  public scaleX: number = 1;
  public scaleY: number = 1;
  public rotation: number = 0;
  public opacity: number = 1;

  // A11y & Automation Agent Layer
  public interactive: boolean = false;
  public width: number = 0;
  public height: number = 0;
  public a11yOffsetX: number = 0;
  public a11yOffsetY: number = 0;
  /**
   * Opt in to a viewport-filling accessibility/automation shadow node even when
   * this entity has no intrinsic box (`width`/`height` of `0`). Use for
   * full-screen, boundless interaction surfaces (e.g. an infinite-canvas graph)
   * that need global pointer events. The node is mounted behind all other shadow
   * nodes, so on-top components stay clickable.
   */
  public a11yFullViewport: boolean = false;
  /**
   * Clip this node's children to its local box (`[0,0]–[width,height]`) while
   * rendering. Combined with translating a content child, this is how
   * scroll/overflow containers (e.g. `ScrollView`) keep their content inside a
   * fixed viewport. Off by default (children render unclipped). Canvas2D only.
   */
  public clipChildren: boolean = false;

  protected listeners: Map<VectoEvent, Array<(e: any) => void>> = new Map();
  /** Capture-phase listeners (fired root→target before bubble). */
  protected captureListeners: Map<VectoEvent, Array<(e: any) => void>> = new Map();
  private animations: Array<any> = [];

  constructor(id?: string) {
    this.id = id || `entity_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Append a child entity to this node's children array.
   *
   * @param child - The entity to add as a child.
   * @returns `this` for method chaining.
   */
  public add(child: Entity): this {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  /**
   * Remove a child entity from this node.
   *
   * @param child - The entity to remove.
   * @returns `this` for method chaining.
   */
  public remove(child: Entity): this {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return this;
  }

  /**
   * Set the local position of this entity.
   *
   * @param x - Horizontal position in local space.
   * @param y - Vertical position in local space.
   * @returns `this` for method chaining.
   * @example entity.setPosition(100, 200);
   */
  public setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  /**
   * Queue a tween animation toward the specified target property values.
   *
   * Multiple calls chain animations sequentially.  Only numeric properties
   * are interpolated; non-numeric values are ignored.
   *
   * @param targetProps - Partial set of numeric properties to tween to.
   * @param durationMs - Duration of the tween in milliseconds.
   * @returns `this` for method chaining.
   * @example entity.animate({ x: 400, opacity: 0 }, 500);
   */
  public animate(targetProps: Partial<this>, durationMs: number): this {
    this.animations.push({
      target: targetProps,
      duration: durationMs,
      startTime: -1,
      startProps: {},
    });
    return this;
  }

  /**
   * Advance the entity's internal state for one frame.
   *
   * Called automatically by the {@link Scene} render loop — override in
   * subclasses to implement custom per-frame logic.
   *
   * @param dt - Elapsed time since the last frame in milliseconds.
   * @param time - Absolute timestamp from `performance.now()`.
   */
  public update(_dt: number, time: number): void {
    if (this.animations.length > 0) {
      const anim = this.animations[0];
      if (anim.startTime === -1) {
        anim.startTime = time;
        for (const key in anim.target) {
          anim.startProps[key] = (this as any)[key];
        }
      }

      const progress = Math.min((time - anim.startTime) / anim.duration, 1);

      for (const key in anim.target) {
        const start = anim.startProps[key];
        const end = anim.target[key];
        if (typeof start === 'number' && typeof end === 'number') {
          const easeOut = progress * (2 - progress);
          (this as any)[key] = start + (end - start) * easeOut;
        }
      }

      if (progress >= 1) {
        this.animations.shift();
      }
    }
  }

  /**
   * Register a listener for a {@link VectoEvent}.
   *
   * Listeners run in the bubble phase by default; pass `{ capture: true }` for the
   * capture phase (root→target). Bubble listeners also fire for the legacy
   * {@link emit} (direct, self-only) path.
   *
   * @param event - The event name to listen for.
   * @param callback - Handler invoked when the event fires.
   * @param options - `{ capture }` to register for the capture phase.
   * @returns `this` for method chaining.
   * @example entity.on('click', (e) => console.log('clicked', e));
   */
  public on(event: VectoEvent, callback: (e: any) => void, options?: ListenerOptions): this {
    const map = options?.capture ? this.captureListeners : this.listeners;
    if (!map.has(event)) {
      map.set(event, []);
    }
    map.get(event)!.push(callback);
    return this;
  }

  /**
   * Remove a previously registered event listener.
   *
   * @param event - The event name to stop listening to.
   * @param callback - The exact handler reference passed to {@link on}.
   * @param options - Must match the phase the listener was registered with.
   * @returns `this` for method chaining.
   */
  public off(event: VectoEvent, callback: (e: any) => void, options?: ListenerOptions): this {
    const handlers = (options?.capture ? this.captureListeners : this.listeners).get(event);
    if (handlers) {
      const idx = handlers.indexOf(callback);
      if (idx !== -1) handlers.splice(idx, 1);
    }
    return this;
  }

  /**
   * Tear down this entity: clear all animations, event listeners, and detach
   * from parent. Call before discarding an entity to prevent memory leaks.
   */
  public destroy(): void {
    this.animations = [];
    this.listeners.clear();
    this.captureListeners.clear();
    if (this.parent) {
      this.parent.remove(this);
    }
  }

  /**
   * Dispatch a {@link VectoEvent} directly to this entity's bubble-phase listeners
   * only — no tree propagation. Kept for component-internal/self events (e.g. a
   * form control emitting its own `change`); use {@link dispatchEvent} for the
   * capture/bubble path.
   *
   * @param event - The event name to dispatch.
   * @param payload - Arbitrary data forwarded to each listener.
   */
  public emit(event: VectoEvent, payload: any): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(payload));
    }
  }

  /** Run one node's listeners for the event, honoring stopImmediatePropagation. */
  private fireListeners(
    node: Entity,
    map: Map<VectoEvent, Array<(e: any) => void>>,
    event: VectoUIEvent,
  ): void {
    const handlers = map.get(event.type);
    if (!handlers) return;
    event.currentTarget = node;
    // Snapshot so a handler that adds/removes listeners doesn't disturb this pass.
    for (const h of handlers.slice()) {
      h(event);
      if (event.immediatePropagationStopped) return;
    }
  }

  /**
   * Dispatch a {@link VectoUIEvent} through the entity tree, DOM-style: a capture
   * phase from the root down to `event.target`, then a bubble phase back up to the
   * root. `event.stopPropagation()` halts the walk; `stopImmediatePropagation()`
   * also skips the remaining listeners on the current node. A non-bubbling event
   * only fires its target in the bubble phase (capture still runs).
   *
   * @param event - The event to propagate (its `target` defines the path).
   */
  public dispatchEvent(event: VectoUIEvent): void {
    // Build the path target → root.
    const path: Entity[] = [];
    for (let n: Entity | null = event.target; n; n = n.parent) path.push(n);

    // Capture: root → target.
    for (let i = path.length - 1; i >= 0; i--) {
      if (event.propagationStopped) return;
      this.fireListeners(path[i], path[i].captureListeners, event);
    }
    // Bubble: target → root.
    for (let i = 0; i < path.length; i++) {
      if (event.propagationStopped) return;
      this.fireListeners(path[i], path[i].listeners, event);
      if (!event.bubbles) return; // non-bubbling: only the target gets the bubble phase
    }
  }

  /**
   * Compute the entity's position in world/canvas space by accumulating
   * local offsets up the scene-graph hierarchy using affine transformations (scale and rotation).
   *
   * @returns World-space {@link Point} for this entity.
   */
  public getGlobalPosition(): Point {
    let px = this.x;
    let py = this.y;
    let curr = this.parent;
    while (curr && curr.id !== 'root') {
      // Match Scene.loop's Canvas transform order (translate -> scale -> rotate):
      // world = parent.pos + S(R(local)). Scale applies per-axis to the rotated
      // vector. The previous code mixed scaleX/scaleY into the rotation terms,
      // which was wrong whenever scaleX !== scaleY and rotation !== 0.
      const cos = Math.cos(curr.rotation);
      const sin = Math.sin(curr.rotation);
      const rotatedX = px * cos - py * sin;
      const rotatedY = px * sin + py * cos;
      px = curr.x + curr.scaleX * rotatedX;
      py = curr.y + curr.scaleY * rotatedY;
      curr = curr.parent;
    }
    return { x: px, y: py };
  }

  /**
   * Accumulated world scale factors: this entity's own `scaleX`/`scaleY` times
   * those of every ancestor (excluding the scene root). Useful for mapping a
   * world-space point back into local space for hit-testing.
   *
   * @returns The world scale `{ x, y }`.
   */
  public getWorldScale(): { x: number; y: number } {
    let sx = this.scaleX;
    let sy = this.scaleY;
    let curr = this.parent;
    while (curr && curr.id !== 'root') {
      sx *= curr.scaleX;
      sy *= curr.scaleY;
      curr = curr.parent;
    }
    return { x: sx, y: sy };
  }

  /**
   * Return `true` when the given world-space point lies within this entity's
   * interactive hit area.
   *
   * @param globalX - World-space X coordinate.
   * @param globalY - World-space Y coordinate.
   * @returns Whether the point is inside this entity.
   */
  /**
   * Describe this entity's semantics for the accessibility / automation shadow
   * layer. Override in components to project a real `<button>`, `<a href>`, etc.
   *
   * The default returns `{}`, which `Scene.syncA11y` maps to a plain `div`
   * (preserving the historical behavior of interactive entities).
   *
   * @returns The {@link A11yAttributes} for this entity's shadow node.
   */
  public getA11yAttributes(): A11yAttributes {
    return {};
  }

  /**
   * Local-space axis-aligned bounding box of what this entity's {@link render}
   * draws, used by {@link Scene} for viewport culling.
   *
   * Returns `null` by default, meaning "unknown bounds" — the entity is then
   * never culled (always rendered). Override to return a {@link Bounds} so the
   * scene can skip rendering it when it lies outside the viewport.
   *
   * @returns The local bounds, or `null` to opt out of culling.
   */
  public getBounds(): Bounds | null {
    return null;
  }

  /**
   * Opt into the renderer's draw-call batching fast-path for point-cloud /
   * particle entities that draw as a single filled circle at their local origin.
   *
   * When a leaf entity returns a {@link BatchCircle} and has uniform scale, the
   * {@link Scene} skips its per-entity `save`/`translate`/`scale`/`rotate`/
   * `restore` and {@link render}, emitting the circle through
   * {@link IRenderer.fillCircle} so runs of same-color siblings coalesce into a
   * single `fill()`. Returns `null` by default (normal render path). Read each
   * frame, so an animated color/radius is honored.
   *
   * @returns The circle to batch, or `null` to use the normal {@link render} path.
   */
  public getBatchCircle(): BatchCircle | null {
    return null;
  }

  /**
   * Opt into the GPU instanced-rectangle fast-path for a leaf entity that draws
   * as a single filled rectangle from its local origin. Only used when the
   * {@link Scene} runs a WebGL `pointBackend`; otherwise the entity renders
   * normally via {@link render}. Returns `null` by default. Read each frame.
   *
   * @returns The rectangle to batch, or `null` for the normal render path.
   */
  public getBatchRect(): BatchRect | null {
    return null;
  }

  /**
   * Whether this entity still has a queued/running tween animation.
   *
   * Used by {@link Scene}'s `onDemand` render mode to keep redrawing while an
   * animation is in flight.
   *
   * @returns `true` if at least one animation remains.
   */
  public hasPendingAnimations(): boolean {
    return this.animations.length > 0;
  }

  public abstract isPointInside(globalX: number, globalY: number): boolean;

  /**
   * Draw this entity using the provided renderer.
   *
   * Called each frame after the entity's transform has been pushed onto the
   * renderer's matrix stack.
   *
   * @param renderer - The active renderer instance.
   */
  public abstract render(renderer: any): void;
}
