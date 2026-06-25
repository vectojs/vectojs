import { Entity } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { IRenderer } from '../renderer/IRenderer';

/**
 * Top-level orchestrator that owns the entity tree, drive the render loop,
 * and maintains the accessibility/automation shadow layer.
 *
 * Create one `Scene` per `<canvas>` element.  Add {@link Entity} objects via
 * {@link add}, then call {@link start} to begin the 60-FPS render loop.
 *
 * @example
 * const scene = new Scene(document.querySelector('canvas')!);
 * scene.add(new CircleEntity().setPosition(100, 100));
 * scene.start();
 */
export class Scene {
  private root: Entity;
  private renderer: CanvasRenderer;
  private isRunning: boolean = false;
  private lastTime: number = 0;
  public canvas: HTMLCanvasElement;

  /**
   * Redraw strategy:
   * - `'always'` (default): re-render every animation frame (legacy behavior).
   * - `'onDemand'`: only re-render when the scene is marked dirty (via
   *   {@link markDirty}) or while an animation is pending. Ideal for static /
   *   event-driven UIs where idle frames should cost ~0.
   */
  public renderMode: 'always' | 'onDemand' = 'always';
  private dirty: boolean = true;

  // A11y / Automation Layer
  private a11yRoot: HTMLDivElement;
  private a11yElements: Map<string, HTMLElement> = new Map();
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.root = new (class RootEntity extends Entity {
      isPointInside() {
        return false;
      }
      // Root renders nothing itself — renderNode() handles all child traversal.
      render(_r: any) {}
    })('root');

    this.renderer = new CanvasRenderer(canvas);

    // Setup Agent / Automation Semantic Layer
    this.a11yRoot = document.createElement('div');
    this.a11yRoot.style.position = 'absolute';
    this.a11yRoot.style.top = '0';
    this.a11yRoot.style.left = '0';
    this.a11yRoot.style.width = '100vw';
    this.a11yRoot.style.height = '100vh';
    this.a11yRoot.style.pointerEvents = 'none';
    this.a11yRoot.style.overflow = 'hidden';
    this.a11yRoot.style.zIndex = '10'; // Render above canvas
    if (canvas.parentElement) {
      canvas.parentElement.appendChild(this.a11yRoot);
    }

    this.resizeHandler = () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };

    this.setupEvents();
  }

  /**
   * Expose the underlying {@link IRenderer} for advanced direct-draw operations.
   *
   * @returns The active renderer instance.
   */
  public getRenderer(): IRenderer {
    return this.renderer;
  }

  /**
   * Add a top-level entity to the scene graph.
   *
   * @param entity - The entity to attach to the scene root.
   * @returns `this` for method chaining.
   * @example scene.add(new CircleEntity());
   */
  public add(entity: Entity): this {
    this.root.add(entity);
    return this;
  }

  private removeA11yRecursively(node: Entity) {
    const el = this.a11yElements.get(node.id);
    if (el) {
      el.remove();
      this.a11yElements.delete(node.id);
    }
    for (const child of node.children) {
      this.removeA11yRecursively(child);
    }
  }

  /**
   * Remove a top-level entity from the scene graph and clean up its
   * accessibility shadow elements recursively.
   *
   * @param entity - The entity to detach from the scene root.
   * @returns `this` for method chaining.
   */
  public remove(entity: Entity): this {
    this.root.remove(entity);
    this.removeA11yRecursively(entity);
    return this;
  }

  /**
   * Tear down the Scene, halt the loop, and clean up event listeners and DOM elements.
   */
  public destroy(): void {
    this.stop();
    window.removeEventListener('resize', this.resizeHandler);
    this.a11yRoot.remove();
    this.a11yElements.clear();
  }

  private setupEvents(): void {
    window.addEventListener('resize', this.resizeHandler);
  }

  /**
   * Begin the `requestAnimationFrame` render loop.
   *
   * Idempotent — calling `start()` on an already-running scene is a no-op.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Halt the render loop after the current frame completes.
   *
   * Call {@link start} again to resume rendering.
   */
  public stop(): void {
    this.isRunning = false;
  }

  /**
   * Mark the scene as needing a redraw on the next frame.
   *
   * Only meaningful in `onDemand` {@link renderMode}: call it after mutating
   * entity state outside of {@link Entity.animate} so the change is rendered.
   */
  public markDirty(): void {
    this.dirty = true;
  }

  /** True when any node in the subtree has a pending animation. */
  private hasAnyPendingAnimation(node: Entity): boolean {
    if (node.hasPendingAnimations()) return true;
    for (const child of node.children) {
      if (this.hasAnyPendingAnimation(child)) return true;
    }
    return false;
  }

  /** True when any node in the subtree is interactive (drives a11y sync). */
  private hasAnyInteractive(node: Entity): boolean {
    if (node.interactive) return true;
    for (const child of node.children) {
      if (this.hasAnyInteractive(child)) return true;
    }
    return false;
  }

  private syncA11y(node: Entity) {
    if (node.interactive && node.width > 0) {
      let el = this.a11yElements.get(node.id);
      if (!el) {
        const attrs = node.getA11yAttributes();
        el = document.createElement(attrs.tag || 'div');
        el.setAttribute('data-vecto-id', node.id);
        if (attrs.role) el.setAttribute('role', attrs.role);
        if (attrs.label) el.setAttribute('aria-label', attrs.label);
        if (attrs.href && el instanceof HTMLAnchorElement) el.href = attrs.href;
        el.style.position = 'absolute';
        el.style.pointerEvents = 'auto'; // allow Playwright/Agent to click!
        el.style.cursor = 'pointer';
        // Debug visibility: semi-transparent blue dashed border
        el.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
        el.style.border = '1px dashed rgba(56, 189, 248, 0.4)';

        // Map DOM events to Canvas ECS Engine
        el.addEventListener('click', (e) => node.emit('click', e));
        el.addEventListener('mouseenter', (e) => {
          el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          node.emit('hover', e);
        });
        el.addEventListener('mouseleave', (e) => {
          el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          node.emit('pointerleave', e);
        });
        el.addEventListener('pointerdown', (e) => node.emit('pointerdown', e));
        el.addEventListener('pointerup', (e) => node.emit('pointerup', e));
        el.addEventListener('pointermove', (e) => node.emit('pointermove', e));

        this.a11yRoot.appendChild(el);
        this.a11yElements.set(node.id, el);
      }

      const pos = node.getGlobalPosition();
      el.style.left = `${pos.x + node.a11yOffsetX}px`;
      el.style.top = `${pos.y + node.a11yOffsetY}px`;
      el.style.width = `${node.width * node.scaleX}px`;
      el.style.height = `${node.height * node.scaleY}px`;
      el.style.transform = `rotate(${node.rotation}rad)`;
    }

    for (const child of node.children) this.syncA11y(child);
  }

  private loop(time: number): void {
    if (!this.isRunning) return;

    const dt = time - this.lastTime;
    this.lastTime = time;

    // onDemand: only redraw when dirty or an animation is in flight.
    if (this.renderMode === 'onDemand' && !this.dirty && !this.hasAnyPendingAnimation(this.root)) {
      requestAnimationFrame((t) => this.loop(t));
      return;
    }

    this.renderer.clear();

    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;

    // renderNode carries the parent's accumulated world matrix as six scalar
    // params (canvas T*S*R order) to avoid per-node array allocation — important
    // for large scenes. Off-viewport entities with a known getBounds() are culled.
    const renderNode = (
      node: Entity,
      pa: number,
      pb: number,
      pc: number,
      pd: number,
      pe: number,
      pf: number,
    ) => {
      node.update(dt, time);

      // Compose parent * translate(x,y) * scale(sx,sy) * rotate(rot).
      const cos = Math.cos(node.rotation);
      const sin = Math.sin(node.rotation);
      const te = pa * node.x + pc * node.y + pe;
      const tf = pb * node.x + pd * node.y + pf;
      const sxCos = node.scaleX * cos;
      const sxSin = node.scaleX * sin;
      const syCos = node.scaleY * cos;
      const sySin = node.scaleY * sin;
      const a = pa * sxCos + pc * sxSin;
      const b = pb * sxCos + pd * sxSin;
      const c = pa * -sySin + pc * syCos;
      const d = pb * -sySin + pd * syCos;

      // Cull test: transform the local bounds box and check viewport overlap.
      let visible = true;
      const bounds = node.getBounds();
      if (bounds) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < 4; i++) {
          const lx = i & 1 ? bounds.x + bounds.width : bounds.x;
          const ly = i & 2 ? bounds.y + bounds.height : bounds.y;
          const wx = a * lx + c * ly + te;
          const wy = b * lx + d * ly + tf;
          if (wx < minX) minX = wx;
          if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy;
          if (wy > maxY) maxY = wy;
        }
        visible = maxX >= 0 && minX <= vw && maxY >= 0 && minY <= vh;
      }

      // Fully skip invisible leaf nodes (no transform, no render, no recursion).
      if (!visible && node.children.length === 0) return;

      this.renderer.save();
      this.renderer.translate(node.x, node.y);
      this.renderer.scale(node.scaleX, node.scaleY);
      this.renderer.rotate(node.rotation);
      this.renderer.setGlobalAlpha(node.opacity);

      if (visible) node.render(this.renderer);

      for (const child of node.children) {
        renderNode(child, a, b, c, d, te, tf);
      }
      this.renderer.restore();
    };

    renderNode(this.root, 1, 0, 0, 1, 0, 0);

    // Sync Automation Shadow DOM (skip the whole walk when nothing is interactive).
    if (this.hasAnyInteractive(this.root)) {
      this.syncA11y(this.root);
    }

    this.dirty = false;

    requestAnimationFrame((t) => this.loop(t));
  }
}
