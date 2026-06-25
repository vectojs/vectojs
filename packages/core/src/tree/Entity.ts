/**
 * A 2-D coordinate in canvas/world space.
 */
export interface Point {
  x: number;
  y: number;
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
  | 'pointerleave';

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

  protected listeners: Map<VectoEvent, Array<(e: any) => void>> = new Map();
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
   * @param event - The event name to listen for.
   * @param callback - Handler invoked when the event is emitted.
   * @returns `this` for method chaining.
   * @example entity.on('click', (e) => console.log('clicked', e));
   */
  public on(event: VectoEvent, callback: (e: any) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
    return this;
  }

  /**
   * Remove a previously registered event listener.
   *
   * @param event - The event name to stop listening to.
   * @param callback - The exact handler reference passed to {@link on}.
   * @returns `this` for method chaining.
   */
  public off(event: VectoEvent, callback: (e: any) => void): this {
    const handlers = this.listeners.get(event);
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
    if (this.parent) {
      this.parent.remove(this);
    }
  }

  /**
   * Dispatch a {@link VectoEvent} to all registered listeners on this entity.
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
   * Return `true` when the given world-space point lies within this entity's
   * interactive hit area.
   *
   * @param globalX - World-space X coordinate.
   * @param globalY - World-space Y coordinate.
   * @returns Whether the point is inside this entity.
   */
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
