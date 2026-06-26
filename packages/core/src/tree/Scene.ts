import { Entity } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { IRenderer } from '../renderer/IRenderer';
import { createWebGLPointRenderer, type PointRenderer } from '../renderer/WebGLPointRenderer';

/**
 * Options for {@link Scene}.
 */
export interface SceneOptions {
  /**
   * Backend for `getBatchCircle()` point-cloud entities:
   * - `'canvas'` (default): the Canvas2D order-preserving same-color batch.
   * - `'webgl'`: a stacked WebGL2 layer drawing all such circles in one draw
   *   call (10–100× throughput for 100k+). Auto-falls back to `'canvas'` when
   *   WebGL2 is unavailable. The GL layer composites above the 2D content, so its
   *   points don't interleave per-entity with 2D draws.
   */
  pointBackend?: 'canvas' | 'webgl';
  /**
   * Render the accessibility/automation shadow nodes with a visible blue dashed
   * outline (development aid). Default `false`: shadow nodes are transparent
   * (`opacity:0`) — still operable by Playwright/assistive tech, but the canvas
   * is the only thing seen.
   */
  debugA11y?: boolean;
  /**
   * Cap the render loop to at most this many frames per second (power saving —
   * e.g. a quieter fan in a library). `0` (default) means uncapped (native
   * refresh rate). Continuous animations still run, just less often. Also
   * settable later via {@link Scene.maxFPS}.
   */
  maxFPS?: number;
  /**
   * When `true` (default), a system **prefers-reduced-motion** setting auto-caps
   * the loop to {@link REDUCED_MOTION_FPS} (or the lower of that and `maxFPS`).
   * Set `false` to ignore the OS setting.
   */
  respectReducedMotion?: boolean;
}

/** Frame-rate the loop is capped to when the OS requests reduced motion. */
export const REDUCED_MOTION_FPS = 30;

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

  /**
   * Frame-rate cap (power saving). `0` = uncapped (native refresh). When set,
   * the loop renders at most `maxFPS` times per second; animations still run,
   * just less often. See {@link SceneOptions.maxFPS}.
   */
  public maxFPS: number = 0;
  /** Whether the OS prefers-reduced-motion setting auto-caps the loop. */
  public respectReducedMotion: boolean = true;
  /** Cached media-query list; `.matches` is read live each frame. */
  private reducedMotionQuery: MediaQueryList | null = null;

  // A11y / Automation Layer
  private a11yRoot: HTMLDivElement;
  private a11yElements: Map<string, HTMLElement> = new Map();
  private resizeHandler: () => void;

  // Optional WebGL point-cloud layer (see SceneOptions.pointBackend).
  private pointRenderer: PointRenderer | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private debugA11y: boolean;

  constructor(canvas: HTMLCanvasElement, options: SceneOptions = {}) {
    this.canvas = canvas;
    this.debugA11y = options.debugA11y ?? false;
    this.maxFPS = options.maxFPS ?? 0;
    this.respectReducedMotion = options.respectReducedMotion ?? true;
    this.reducedMotionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
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

    // Optional WebGL2 point-cloud layer, stacked above the 2D canvas (below a11y).
    if (options.pointBackend === 'webgl') {
      const gl = document.createElement('canvas');
      gl.style.position = 'absolute';
      gl.style.top = '0';
      gl.style.left = '0';
      gl.style.pointerEvents = 'none';
      gl.style.zIndex = '5';
      if (canvas.parentElement) canvas.parentElement.appendChild(gl);
      const pr = createWebGLPointRenderer(gl);
      if (pr) {
        pr.resize(window.innerWidth, window.innerHeight);
        this.glCanvas = gl;
        this.pointRenderer = pr;
      } else {
        gl.remove(); // WebGL2 unavailable → fall back to the Canvas2D batch
      }
    }

    this.resizeHandler = () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
      this.pointRenderer?.resize(window.innerWidth, window.innerHeight);
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
    this.pointRenderer?.destroy();
    this.glCanvas?.remove();
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
    if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
      let el = this.a11yElements.get(node.id);
      const attrs = node.getA11yAttributes();
      if (!el) {
        el = document.createElement(attrs.tag || 'div');
        el.setAttribute('data-vecto-id', node.id);
        if (attrs.role) el.setAttribute('role', attrs.role);
        if (attrs.href && el instanceof HTMLAnchorElement) el.href = attrs.href;
        if (el instanceof HTMLImageElement) {
          if (attrs.src) el.src = attrs.src;
          if (attrs.alt) el.alt = attrs.alt;
        }
        if (el instanceof HTMLInputElement) {
          el.type = attrs.inputType || 'text';
          if (attrs.placeholder) el.placeholder = attrs.placeholder;
        }
        el.style.position = 'absolute';
        el.style.pointerEvents = 'auto'; // allow Playwright/Agent to click!
        // A full-viewport background surface uses the default cursor (it's not a
        // button); discrete controls show the pointer cursor.
        el.style.cursor = node.a11yFullViewport ? 'default' : 'pointer';
        el.style.margin = '0';
        el.style.padding = '0';
        if (this.debugA11y) {
          // Debug visibility: semi-transparent blue dashed border.
          el.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          el.style.border = '1px dashed rgba(56, 189, 248, 0.4)';
        } else {
          // Production: the canvas IS the visual; the shadow node is the
          // semantic/automation layer only. opacity:0 keeps it operable by
          // Playwright/AT (not display:none) without rendering native chrome
          // (input text, checkbox, broken-img) over the canvas.
          el.style.opacity = '0';
          el.style.border = 'none';
          el.style.background = 'transparent';
        }

        // Keyboard accessibility for non-natively-focusable interactive controls
        // (e.g. a div with role="switch"): make them Tab-focusable and a
        // Enter/Space. Native <button>/<a href>/<input> already handle this; landmark
        // roles like "group" must stay non-focusable.
        const INTERACTIVE_ROLES = new Set([
          'button',
          'switch',
          'checkbox',
          'radio',
          'link',
          'tab',
          'menuitem',
          'slider',
        ]);
        const nativelyFocusable =
          el instanceof HTMLButtonElement ||
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLAnchorElement && !!attrs.href);
        if (!nativelyFocusable && attrs.role && INTERACTIVE_ROLES.has(attrs.role)) {
          el.setAttribute('tabindex', '0');
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); // stop Space from scrolling the page
              node.emit('click', e);
            }
          });
        }

        // Map DOM events to Canvas ECS Engine
        el.addEventListener('click', (e) => node.emit('click', e));
        el.addEventListener('mouseenter', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          node.emit('hover', e);
        });
        el.addEventListener('mouseleave', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          node.emit('pointerleave', e);
        });
        el.addEventListener('pointerdown', (e) => node.emit('pointerdown', e));
        el.addEventListener('pointerup', (e) => node.emit('pointerup', e));
        el.addEventListener('pointermove', (e) => node.emit('pointermove', e));
        el.addEventListener('wheel', (e) => node.emit('wheel', e));

        // Form-control changes (text input / checkbox) flow back to the entity.
        if (el instanceof HTMLInputElement) {
          const input = el;
          // Active IME pre-edit range, tracked across composition events so the
          // canvas can underline the composing segment.
          let composition: { start: number; length: number } | null = null;
          const forward = () =>
            node.emit('change', {
              value: input.value,
              checked: input.checked,
              selectionStart: input.selectionStart ?? input.value.length,
              selectionEnd: input.selectionEnd ?? input.value.length,
              composition,
            });
          el.addEventListener('input', forward);
          el.addEventListener('change', forward);
          // Caret/selection moves that don't change the value (arrows, click, drag).
          el.addEventListener('keyup', forward);
          el.addEventListener('click', forward);
          el.addEventListener('select', forward);
          // IME composition: the real input holds the pre-edit text; we just track
          // its [start, length) so the canvas can render it underlined.
          el.addEventListener('compositionstart', () => {
            composition = { start: input.selectionStart ?? input.value.length, length: 0 };
            forward();
          });
          el.addEventListener('compositionupdate', (e) => {
            const data = (e as CompositionEvent).data ?? '';
            composition = { start: composition?.start ?? 0, length: data.length };
            forward();
          });
          el.addEventListener('compositionend', () => {
            composition = null;
            forward();
          });
          // Focus state drives the canvas caret blink.
          el.addEventListener('focus', () => node.emit('focus', {}));
          el.addEventListener('blur', () => node.emit('blur', {}));
        }

        // Full-viewport surfaces mount behind other shadow nodes so on-top
        // components stay clickable; discrete controls append on top.
        if (node.a11yFullViewport) {
          this.a11yRoot.insertBefore(el, this.a11yRoot.firstChild);
        } else {
          this.a11yRoot.appendChild(el);
        }
        this.a11yElements.set(node.id, el);
      }

      // Dynamic attributes refreshed every frame (content can change at runtime).
      if (attrs.label !== undefined) el.setAttribute('aria-label', attrs.label);
      if (attrs.checked !== undefined) {
        if (el instanceof HTMLInputElement) el.checked = attrs.checked;
        else el.setAttribute('aria-checked', String(attrs.checked));
      }
      // Don't clobber the field the user is actively typing in.
      if (
        attrs.value !== undefined &&
        el instanceof HTMLInputElement &&
        document.activeElement !== el
      ) {
        el.value = attrs.value;
      }

      if (node.a11yFullViewport) {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = `${vw}px`;
        el.style.height = `${vh}px`;
        el.style.transform = '';
      } else {
        const pos = node.getGlobalPosition();
        el.style.left = `${pos.x + node.a11yOffsetX}px`;
        el.style.top = `${pos.y + node.a11yOffsetY}px`;
        el.style.width = `${node.width * node.scaleX}px`;
        el.style.height = `${node.height * node.scaleY}px`;
        el.style.transform = `rotate(${node.rotation}rad)`;
      }
    }

    for (const child of node.children) this.syncA11y(child);
  }

  /**
   * The frame-rate cap actually in effect: the explicit {@link maxFPS}, further
   * lowered to {@link REDUCED_MOTION_FPS} when the OS requests reduced motion
   * (and {@link respectReducedMotion} is on). `0` means uncapped.
   */
  private effectiveMaxFPS(): number {
    const reduced = this.respectReducedMotion && !!this.reducedMotionQuery?.matches;
    if (reduced)
      return this.maxFPS > 0 ? Math.min(this.maxFPS, REDUCED_MOTION_FPS) : REDUCED_MOTION_FPS;
    return this.maxFPS;
  }

  private loop(time: number): void {
    if (!this.isRunning) return;

    // Frame-rate cap (power saving / prefers-reduced-motion): if this frame
    // arrived sooner than the target interval, skip rendering this tick.
    // `lastTime` only advances on rendered frames, so `dt` stays accurate.
    const cap = this.effectiveMaxFPS();
    if (cap > 0 && time - this.lastTime < 1000 / cap - 1) {
      requestAnimationFrame((t) => this.loop(t));
      return;
    }

    const dt = time - this.lastTime;
    this.lastTime = time;

    // onDemand: only redraw when dirty or an animation is in flight.
    if (this.renderMode === 'onDemand' && !this.dirty && !this.hasAnyPendingAnimation(this.root)) {
      requestAnimationFrame((t) => this.loop(t));
      return;
    }

    this.renderer.clear();
    this.pointRenderer?.begin();

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

      // Batch fast-path: a uniform-scaled leaf circle draws through the renderer
      // batch in the parent's transform space (center = local pos, radius scaled),
      // skipping its own save/translate/scale/rotate/render/restore. Runs of
      // same-color siblings coalesce into one fill(). Rotation is irrelevant for
      // a circle; non-uniform scale would shear it, so fall back in that case.
      if (node.children.length === 0 && node.scaleX === node.scaleY) {
        const bc = node.getBatchCircle();
        if (bc) {
          if (visible) {
            if (this.pointRenderer) {
              // GPU layer: emit in world coords (center = (te,tf), radius scaled
              // by the accumulated uniform scale = hypot(a,b)).
              this.pointRenderer.addCircle(
                te,
                tf,
                bc.radius * Math.hypot(a, b),
                bc.color,
                node.opacity,
              );
            } else {
              this.renderer.fillCircle(
                node.x,
                node.y,
                bc.radius * node.scaleX,
                bc.color,
                node.opacity,
              );
            }
          }
          return;
        }
        // GPU instanced rectangle (WebGL backend only; otherwise falls through
        // to the normal render path below). Origin (te,tf), world scale hypot(a,b),
        // rotation atan2(b,a).
        if (this.pointRenderer) {
          const br = node.getBatchRect();
          if (br) {
            if (visible) {
              const ws = Math.hypot(a, b);
              this.pointRenderer.addRect(
                te,
                tf,
                br.width * ws,
                br.height * ws,
                br.color,
                node.opacity,
                Math.atan2(b, a),
              );
            }
            return;
          }
        }
      }

      // Any normal (non-batched) draw must commit the pending batch first so
      // painter's order is preserved across the sibling group.
      this.renderer.flush();
      this.renderer.save();
      this.renderer.translate(node.x, node.y);
      this.renderer.scale(node.scaleX, node.scaleY);
      this.renderer.rotate(node.rotation);
      this.renderer.setGlobalAlpha(node.opacity);

      if (visible) node.render(this.renderer);

      if (node.clipChildren) {
        this.renderer.clip(0, 0, node.width, node.height);
      }

      for (const child of node.children) {
        renderNode(child, a, b, c, d, te, tf);
      }
      // Commit any batched leaf children before popping this node's transform.
      this.renderer.flush();
      this.renderer.restore();
    };

    renderNode(this.root, 1, 0, 0, 1, 0, 0);
    this.renderer.flush();
    this.pointRenderer?.flush();

    // Sync Automation Shadow DOM (skip the whole walk when nothing is interactive).
    if (this.hasAnyInteractive(this.root)) {
      this.syncA11y(this.root);
    }

    this.dirty = false;

    requestAnimationFrame((t) => this.loop(t));
  }
}
