import {
  TweenDriver,
  SpringDriver,
  isTweenConfig,
  type PropertyDriver,
  type MotionConfig,
  type TweenConfig,
  type SpringConfig,
} from '../animation/drivers';

/** A numeric transform/visual property that participates in the animation system. */
export type AnimatableProp = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity';

const ANIMATABLE_PROPS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
]);

/**
 * A 2-D coordinate in canvas/world space.
 */
export interface Point {
  x: number;
  y: number;
}

/** Six-scalar 2D affine transform matching CanvasRenderingContext2D. */
export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
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
  tag?: 'div' | 'a' | 'button' | 'img' | 'input' | 'textarea';
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
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  haspopup?: string;
  selected?: boolean;
  activedescendant?: string;
  valuemin?: string;
  valuemax?: string;
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
  | 'wheel'
  | 'keydown'
  | 'keyup';

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
export class VectoJSEvent<N = unknown> {
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
  private readonly explicitScenePoint: Point | undefined;
  private stopped = false;
  private stoppedImmediate = false;

  constructor(
    type: VectoEvent,
    target: Entity,
    nativeEvent?: N,
    bubbles: boolean = true,
    scenePoint?: Point,
  ) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.nativeEvent = nativeEvent;
    this.bubbles = bubbles;
    this.explicitScenePoint = scenePoint;
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

  private get resolvedScenePoint(): Point | undefined {
    if (this.explicitScenePoint) return this.explicitScenePoint;
    const native = this.nativeEvent as
      | { clientX?: number; clientY?: number; vectoSceneX?: number; vectoSceneY?: number }
      | undefined;
    if (native?.vectoSceneX !== undefined && native.vectoSceneY !== undefined) {
      return { x: native.vectoSceneX, y: native.vectoSceneY };
    }
    if (native?.clientX === undefined || native.clientY === undefined) return undefined;
    const scene = this.target.scene as {
      clientToScene?: (clientX: number, clientY: number) => Point;
    } | null;
    return (
      scene?.clientToScene?.(native.clientX, native.clientY) ?? {
        x: native.clientX,
        y: native.clientY,
      }
    );
  }

  /** Pointer X in the Scene's logical coordinate space. */
  get sceneX(): number | undefined {
    return this.resolvedScenePoint?.x;
  }

  /** Pointer Y in the Scene's logical coordinate space. */
  get sceneY(): number | undefined {
    return this.resolvedScenePoint?.y;
  }

  /** Pointer X local to the entity whose listener is currently running. */
  get localX(): number | undefined {
    const point = this.resolvedScenePoint;
    if (!point) return undefined;
    return this.currentTarget.worldToLocal(point.x, point.y)?.x;
  }

  /** Pointer Y local to the entity whose listener is currently running. */
  get localY(): number | undefined {
    const point = this.resolvedScenePoint;
    if (!point) return undefined;
    return this.currentTarget.worldToLocal(point.x, point.y)?.y;
  }

  get shiftKey(): boolean {
    return !!(this.nativeEvent as { shiftKey?: boolean })?.shiftKey;
  }

  get ctrlKey(): boolean {
    return !!(this.nativeEvent as { ctrlKey?: boolean })?.ctrlKey;
  }

  get altKey(): boolean {
    return !!(this.nativeEvent as { altKey?: boolean })?.altKey;
  }

  get metaKey(): boolean {
    return !!(this.nativeEvent as { metaKey?: boolean })?.metaKey;
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

  private _x = 0;
  private _y = 0;
  private _scaleX = 1;
  private _scaleY = 1;
  private _rotation = 0;
  private _opacity = 1;

  // Fast-path flag: false for the overwhelming majority of entities (incl. the
  // Danmaku hot loop), so a bare `entity.x = v` is one boolean check + field write.
  private _hasTransitions = false;
  private _transitions: Map<AnimatableProp, MotionConfig> | null = null;
  private _drivers: Map<AnimatableProp, PropertyDriver> = new Map();
  private _mounted = false;

  public get x(): number {
    return this._x;
  }
  public set x(v: number) {
    if (this._hasTransitions) this._animateProp('x', v);
    else this._x = v;
  }
  public get y(): number {
    return this._y;
  }
  public set y(v: number) {
    if (this._hasTransitions) this._animateProp('y', v);
    else this._y = v;
  }
  public get scaleX(): number {
    return this._scaleX;
  }
  public set scaleX(v: number) {
    if (this._hasTransitions) this._animateProp('scaleX', v);
    else this._scaleX = v;
  }
  public get scaleY(): number {
    return this._scaleY;
  }
  public set scaleY(v: number) {
    if (this._hasTransitions) this._animateProp('scaleY', v);
    else this._scaleY = v;
  }
  public get rotation(): number {
    return this._rotation;
  }
  public set rotation(v: number) {
    if (this._hasTransitions) this._animateProp('rotation', v);
    else this._rotation = v;
  }
  public get opacity(): number {
    return this._opacity;
  }
  public set opacity(v: number) {
    if (this._hasTransitions) this._animateProp('opacity', v);
    else this._opacity = v;
  }
  public isDOMPortal: boolean = false;
  private _interactive: boolean = false;
  public get interactive(): boolean {
    return this._interactive;
  }
  public set interactive(val: boolean) {
    if (this._interactive !== val) {
      this._interactive = val;
      const s = this.scene;
      if (s) {
        s.a11yNeedsReorder = true;
        s.markDirty();
      }
    }
  }
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
    const s = this.scene;
    if (s) {
      s.a11yNeedsReorder = true;
      s.markDirty();
      child._notifyMounted(); // fire onMounted for the newly-live subtree
    }
    return this;
  }

  /** Called once when this entity becomes attached to a live Scene. Override to react. */
  protected onMounted(): void {}

  /** Fire onMounted for this node and its descendants, guarded against double-fire. */
  private _notifyMounted(): void {
    if (this._mounted) return;
    this._mounted = true;
    this.onMounted();
    for (const c of this.children) c._notifyMounted();
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
      const s = this.scene;
      if (s) {
        s.a11yNeedsReorder = true;
        s.markDirty();
      }
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

  /** Write a driver-computed value to a backing field without re-triggering the setter. */
  private _applyAnimated(prop: AnimatableProp, v: number): void {
    switch (prop) {
      case 'x':
        this._x = v;
        break;
      case 'y':
        this._y = v;
        break;
      case 'scaleX':
        this._scaleX = v;
        break;
      case 'scaleY':
        this._scaleY = v;
        break;
      case 'rotation':
        this._rotation = v;
        break;
      case 'opacity':
        this._opacity = v;
        break;
    }
  }

  private _currentOf(prop: AnimatableProp): number {
    switch (prop) {
      case 'x':
        return this._x;
      case 'y':
        return this._y;
      case 'scaleX':
        return this._scaleX;
      case 'scaleY':
        return this._scaleY;
      case 'rotation':
        return this._rotation;
      case 'opacity':
        return this._opacity;
    }
  }

  /**
   * Write a value immediately, bypassing any configured transition. For subclasses
   * that need to seed a starting state (e.g. the presence helper's enter `from`).
   */
  protected setImmediate(prop: AnimatableProp, v: number): void {
    const existing = this._drivers.get(prop);
    if (existing) this._settleDriver(existing);
    this._drivers.delete(prop);
    this._applyAnimated(prop, v);
  }

  private _settleDriver(driver: PropertyDriver): void {
    const active = driver as PropertyDriver & { onDone?: () => void };
    const onDone = active.onDone;
    active.onDone = undefined;
    onDone?.();
  }

  private _spawnDriver(prop: AnimatableProp, to: number, cfg: MotionConfig): void {
    // Reduced motion: suppress movement (transforms), keep opacity fades. Snap instantly.
    if (prop !== 'opacity' && this.scene?.prefersReducedMotion) {
      const existing = this._drivers.get(prop);
      if (existing) this._settleDriver(existing);
      this._drivers.delete(prop);
      this._applyAnimated(prop, to);
      return;
    }
    const existing = this._drivers.get(prop);
    if (existing) {
      // Retargeting an in-flight driver: resolve the previous Promise so callers
      // awaiting the original `animateTo`/`springTo` don't leak. The new drive
      // will get a fresh `onDone` assigned by `_driveTo`.
      this._settleDriver(existing);
      existing.retarget(to);
      return;
    }
    const from = this._currentOf(prop);
    const driver: PropertyDriver = isTweenConfig(cfg)
      ? new TweenDriver(from, to, cfg)
      : new SpringDriver(from, to, cfg === 'spring' ? {} : (cfg as SpringConfig));
    this._drivers.set(prop, driver);
    this.scene?.markDirty();
  }

  /** Assignment path when a declarative transition is configured for `prop`. */
  private _animateProp(prop: AnimatableProp, to: number): void {
    const cfg = this._transitions?.get(prop);
    if (!cfg) {
      this._applyAnimated(prop, to);
      return;
    }
    this._spawnDriver(prop, to, cfg);
  }

  /** Declare which properties animate, and how. Subsequent assignment animates them. */
  public setTransition(config: Partial<Record<AnimatableProp, MotionConfig>>): this {
    this._transitions ??= new Map();
    for (const [k, v] of Object.entries(config))
      this._transitions.set(k as AnimatableProp, v as MotionConfig);
    this._hasTransitions = this._transitions.size > 0;
    return this;
  }

  /** Imperative tween toward targets; resolves when all reach their end. */
  public animateTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: TweenConfig,
  ): Promise<void> {
    return this._driveTo(props, cfg);
  }

  /** Imperative spring toward targets; resolves when all reach rest. */
  public springTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: SpringConfig = {},
  ): Promise<void> {
    return this._driveTo(props, cfg);
  }

  private _driveTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: MotionConfig,
  ): Promise<void> {
    const entries = Object.entries(props) as [AnimatableProp, number][];
    return Promise.all(
      entries.map(
        (e) =>
          new Promise<void>((resolve) => {
            this._spawnDriver(e[0], e[1], cfg);
            const d = this._drivers.get(e[0]) as
              | (PropertyDriver & { onDone?: () => void })
              | undefined;
            if (!d)
              resolve(); // spawn resolved instantly (e.g. reduced motion) -> no driver
            else d.onDone = resolve;
          }),
      ),
    ).then(() => undefined);
  }

  /** Advance active property drivers one frame. Call from update(). */
  protected tickDrivers(dt: number): void {
    if (this._drivers.size === 0) return;
    for (const [prop, driver] of this._drivers) {
      driver.tick(dt);
      if (driver.isDone()) {
        this._applyAnimated(prop, driver.target); // snap exactly to target on completion
        this._settleDriver(driver);
        this._drivers.delete(prop);
      } else {
        this._applyAnimated(prop, driver.value);
      }
    }
    this.scene?.markDirty();
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
  public update(dt: number, time: number): void {
    this.tickDrivers(dt);
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
          const value = start + (end - start) * easeOut;
          // Write transform props past the public setter: with a declarative
          // transition configured, the setter would spawn/retarget a driver
          // every frame and the two animation systems would fight.
          if (ANIMATABLE_PROPS.has(key as AnimatableProp)) {
            this._applyAnimated(key as AnimatableProp, value);
          } else {
            (this as any)[key] = value;
          }
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
    // Settle in-flight property drivers so promises returned by
    // animateTo/springTo resolve instead of hanging forever.
    for (const driver of this._drivers.values()) {
      this._settleDriver(driver);
    }
    this._drivers.clear();
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
    event: VectoJSEvent,
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
   * Dispatch a {@link VectoJSEvent} through the entity tree, DOM-style: a capture
   * phase from the root down to `event.target`, then a bubble phase back up to the
   * root. `event.stopPropagation()` halts the walk; `stopImmediatePropagation()`
   * also skips the remaining listeners on the current node. A non-bubbling event
   * only fires its target in the bubble phase (capture still runs).
   *
   * @param event - The event to propagate (its `target` defines the path).
   */
  public dispatchEvent(event: VectoJSEvent): void {
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
    return this.localToWorld(0, 0);
  }

  /**
   * Return the exact accumulated Canvas `T * S * R` transform for this entity.
   */
  public getWorldTransform(): AffineTransform {
    const path: Entity[] = this.id === 'root' ? [] : [this];
    let ancestor = this.parent;
    while (ancestor && ancestor.id !== 'root') {
      path.push(ancestor);
      ancestor = ancestor.parent;
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    let e = 0;
    let f = 0;

    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      const cos = Math.cos(node.rotation);
      const sin = Math.sin(node.rotation);
      const la = node.scaleX * cos;
      const lb = node.scaleY * sin;
      const lc = -node.scaleX * sin;
      const ld = node.scaleY * cos;
      const le = node.x;
      const lf = node.y;

      const nextA = a * la + c * lb;
      const nextB = b * la + d * lb;
      const nextC = a * lc + c * ld;
      const nextD = b * lc + d * ld;
      const nextE = a * le + c * lf + e;
      const nextF = b * le + d * lf + f;
      a = nextA;
      b = nextB;
      c = nextC;
      d = nextD;
      e = nextE;
      f = nextF;
    }

    return { a, b, c, d, e, f };
  }

  /** Convert a point from this entity's local space to Scene/world space. */
  public localToWorld(localX: number, localY: number): Point {
    const { a, b, c, d, e, f } = this.getWorldTransform();
    return {
      x: a * localX + c * localY + e,
      y: b * localX + d * localY + f,
    };
  }

  /**
   * Convert a Scene/world point into this entity's local space.
   * Returns `null` when the accumulated transform is singular.
   */
  public worldToLocal(worldX: number, worldY: number): Point | null {
    const { a, b, c, d, e, f } = this.getWorldTransform();
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    const x = worldX - e;
    const y = worldY - f;
    return {
      x: (d * x - c * y) / determinant,
      y: (-b * x + a * y) / determinant,
    };
  }

  /**
   * Return the entity's local bounds transformed into a world-space AABB.
   * Falls back to the entity's `[0, 0, width, height]` box when `getBounds()`
   * does not provide a render-specific box.
   */
  public getWorldBounds(): Bounds {
    const bounds = this.getBounds() ?? { x: 0, y: 0, width: this.width, height: this.height };
    const { a, b, c, d, e, f } = this.getWorldTransform();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < 4; i++) {
      const localX = i & 1 ? bounds.x + bounds.width : bounds.x;
      const localY = i & 2 ? bounds.y + bounds.height : bounds.y;
      const worldX = a * localX + c * localY + e;
      const worldY = b * localX + d * localY + f;
      minX = Math.min(minX, worldX);
      minY = Math.min(minY, worldY);
      maxX = Math.max(maxX, worldX);
      maxY = Math.max(maxY, worldY);
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
   * Accumulated world rotation: this entity's own `rotation` plus
   * that of every ancestor (excluding the scene root).
   *
   * @returns The accumulated world rotation in radians.
   */
  public getWorldRotation(): number {
    let rot = this.rotation;
    let curr = this.parent;
    while (curr && curr.id !== 'root') {
      rot += curr.rotation;
      curr = curr.parent;
    }
    return rot;
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
   * When a leaf entity returns a {@link BatchCircle} and its accumulated
   * transform is representable by the selected batch backend, the {@link Scene}
   * skips its per-entity `save`/`translate`/`scale`/`rotate`/`restore` and
   * {@link render}. Canvas mode or an unsupported affine transform uses the
   * normal render path, so implementations must keep {@link render} correct.
   * Returns `null` by default. Read each frame, so animated color/radius works.
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
   * Whether this entity still has a queued/running tween animation, or an
   * active {@link setTransition}/{@link animateTo}/{@link springTo} property
   * driver.
   *
   * Used by {@link Scene} to keep rendering continuously while an animation
   * is in flight — both in `onDemand` render mode, and to hold off the
   * `always`-mode idle auto-throttle. Without checking `_drivers` here, a
   * property driver becomes invisible to that throttle: `markDirty()` called
   * from inside `update()`/`tickDrivers()` is wiped by the loop's own
   * `dirty = false` at the end of that same tick, so once the throttle
   * engages an in-flight spring/tween only advances one animation-frame per
   * external `markDirty()` trigger instead of every render frame.
   *
   * @returns `true` if at least one animation or property driver remains.
   */
  public hasPendingAnimations(): boolean {
    return this.animations.length > 0 || this._drivers.size > 0;
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
