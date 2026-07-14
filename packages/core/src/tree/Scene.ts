export interface IWebGLPointRenderer {
  resize(width: number, height: number): void;
}
export type WebGLPointRendererCreator = (canvas: HTMLCanvasElement) => any;

export interface IWebGPUParticleSystemManager {
  new (device: GPUDevice): any;
  initPipelines(format: GPUTextureFormat): Promise<void> | void;
  setupEntityResources(entity: any): void;
  recordComputePass(
    pass: GPUComputePassEncoder,
    entity: any,
    dt: number,
    mouseX: number,
    mouseY: number,
    width: number,
    height: number,
  ): void;
  recordRenderPass(renderPassEncoder: GPURenderPassEncoder, entity: any): void;
  destroy(): void;
}

import { Entity, VectoJSEvent } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { SVGRenderer } from '../renderer/SVGRenderer';
import { IRenderer } from '../renderer/IRenderer';
import type { PointRenderer } from '../renderer/WebGLPointRenderer';
import { DOMPortalEntity } from './DOMPortalEntity';
import type { WebGPUParticleSystemManager } from '../renderer/WebGPUParticleSystemManager';
import { ComputeParticleEntity } from './ComputeParticleEntity';
import { sanitizeUrl } from '../renderer/url';
import { clearCssLineBoxMetrics, cssLineBoxBaseline } from '../text/Typography';

const INTERACTIVE_A11Y_ROLES = new Set([
  'button',
  'switch',
  'checkbox',
  'radio',
  'link',
  'tab',
  'menuitem',
  'slider',
  'combobox',
]);

function isNativelyFocusable(element: HTMLElement): boolean {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLAnchorElement && element.hasAttribute('href'))
  );
}

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
   * Backend for particle simulation and rendering:
   * - `'auto'` (default): tries WebGPU first, falls back to CPU if WebGPU is unavailable or fails.
   * - `'webgpu'`: explicitly requests WebGPU; the current runtime still falls back to CPU if initialization fails.
   * - `'cpu'`: forces CPU simulation and rendering (disabling WebGPU completely).
   */
  particleBackend?: 'auto' | 'webgpu' | 'cpu';
  /**
   * Render the accessibility/automation shadow nodes with a visible blue dashed
   * outline (development aid). Default `false`: shadow nodes are transparent
   * (`opacity:0`) — still operable by Playwright/assistive tech, but the canvas
   * is the only thing seen.
   */
  debugA11y?: boolean;
  /**
   * Cap the render loop to at most this many frames per second (power saving —
   * e.g. a quieter fan in a library). `0` means uncapped (native refresh
   * rate). Defaults to `60` (`0` under test runners). Continuous animations
   * still run, just less often. Also settable later via {@link Scene.maxFPS}.
   */
  maxFPS?: number;
  /**
   * When `true` (default), a system **prefers-reduced-motion** setting auto-caps
   * the loop to {@link REDUCED_MOTION_FPS} (or the lower of that and `maxFPS`).
   * Set `false` to ignore the OS setting.
   */
  respectReducedMotion?: boolean;
  /**
   * Throttle the accessibility/automation shadow-DOM sync to at most once per this
   * many milliseconds. `0` (default) syncs every rendered frame. During heavy
   * animation, a small value (e.g. `100`) keeps the a11y layer eventually
   * consistent while sparing the per-frame DOM writes that can drag Canvas FPS.
   * Also settable later via {@link Scene.a11ySyncInterval}.
   */
  a11ySyncInterval?: number;
  /**
   * Custom renderer implementation (e.g., ThreeRenderer from @vectojs/three).
   * If provided, this renderer will be used for drawing rather than the default CanvasRenderer.
   */
  renderer?: IRenderer;
  /**
   * Disable the automatic registration of window resize listener.
   * Useful when Vecto is running inside a custom layout container or offscreen canvas.
   */
  disableWindowResize?: boolean;
  /**
   * Enable automatic throttling to 2 FPS when the scene is static (no active transitions
   * and not marked dirty) to save power/CPU. Default is `true`.
   */
  autoThrottle?: boolean;
  /**
   * Mirror static text from entities implementing
   * {@link Entity.getContentProjection} as transparent, position-synced DOM
   * nodes, so find-in-page, screen readers, crawlers, and translation work on
   * canvas-rendered text. Default is `true`; disable for purely decorative
   * scenes to skip the sync walk.
   */
  contentProjection?: boolean;
}

/** Frame-rate the loop is capped to when the OS requests reduced motion. */
export const REDUCED_MOTION_FPS = 30;

export interface A11yTreeNode {
  id: string;
  tag: string;
  role?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  valuemin?: string;
  valuemax?: string;
  children: A11yTreeNode[];
}

/**
 * Parse an inline `"<n>px"` style value into a positive number, or `null` for
 * anything else (empty, percentages, calc(), zero).
 */
function parseInlinePx(value: string | undefined): number | null {
  if (!value || !value.endsWith('px')) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A concrete text caret position, usable as a Selection anchor or focus. */
interface TextCaretPosition {
  node: Text;
  offset: number;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Bounding rect of a text node's full contents (null when it has no boxes). */
function textNodeRect(node: Text): DOMRect | null {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/** Character offset in `node` whose caret is nearest to viewport `x`. */
function offsetForX(node: Text, x: number): number {
  const range = document.createRange();
  let lo = 0;
  let hi = node.data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(node, mid);
    range.setEnd(node, Math.min(mid + 1, node.data.length));
    const rect = range.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Nearest text position inside one projected visual line for viewport `x`:
 * before the first character, at the caret under `x`, or at the end of the
 * visible text (excluding the trailing hard-break separator so a horizontal
 * drag through padding doesn't silently select a newline).
 */
function nearestTextPositionInLine(line: HTMLElement, x: number): TextCaretPosition | null {
  const texts = collectTextNodes(line);
  if (texts.length === 0) return null;
  const firstRect = textNodeRect(texts[0]);
  if (firstRect && x <= firstRect.left) return { node: texts[0], offset: 0 };
  for (const node of texts) {
    const rect = textNodeRect(node);
    if (rect && x >= rect.left && x <= rect.right) {
      return { node, offset: offsetForX(node, x) };
    }
  }
  const last = texts[texts.length - 1];
  let end = last.data.length;
  while (end > 0 && last.data[end - 1] === '\n') end--;
  return { node: last, offset: end };
}

/**
 * Resolve the text position nearest to viewport `(x, y)` inside a content
 * projection whose line boxes are absolutely positioned (out of flow — the
 * browser itself cannot anchor a selection in the container's blank space).
 * Picks the vertically nearest line, then the caret nearest to `x` within it.
 */
function nearestTextPositionInProjection(
  contentEl: HTMLElement,
  x: number,
  y: number,
): TextCaretPosition | null {
  let bestLine: HTMLElement | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < contentEl.children.length; i++) {
    const child = contentEl.children[i] as HTMLElement;
    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    // The vertically nearest line wins; x only breaks ties within a band.
    const dist = dy * 4096 + dx;
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = child;
    }
  }
  if (bestLine) return nearestTextPositionInLine(bestLine, x);
  // Projection with a single flowed text node (no per-line children).
  const texts = collectTextNodes(contentEl);
  if (texts.length === 0) return null;
  const rect = contentEl.getBoundingClientRect();
  const node = texts[texts.length - 1];
  return x <= rect.left ? { node: texts[0], offset: 0 } : { node, offset: node.data.length };
}

/**
 * Caret text position under the pointer, for driving a manual selection drag:
 * the browser's caret-from-point when it lands in text, otherwise snapped to
 * the nearest text of the content projection under the pointer.
 */
function caretTextPositionAt(x: number, y: number): TextCaretPosition | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      return { node: pos.offsetNode as Text, offset: pos.offset };
    }
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
      return { node: range.startContainer as Text, offset: range.startOffset };
    }
  }
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const contentEl = el?.closest('[data-vecto-content]') as HTMLElement | null;
  return contentEl ? nearestTextPositionInProjection(contentEl, x, y) : null;
}

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
  private static webglCreator: WebGLPointRendererCreator | null = null;
  private static webgpuManagerClass: any = null;

  public static registerWebGLPointRendererCreator(creator: WebGLPointRendererCreator) {
    Scene.webglCreator = creator;
  }

  public static registerWebGPUParticleSystemManager(managerClass: any) {
    Scene.webgpuManagerClass = managerClass;
  }

  private root: Entity;
  public overlayRoot: Entity;
  private renderer: IRenderer;
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
  /** Whether to throttle rendering to 2 FPS when the scene is static to save power. */
  public autoThrottle: boolean = true;

  /**
   * Frame-rate cap (power saving). `0` = uncapped (native refresh). When set,
   * the loop renders at most `maxFPS` times per second; animations still run,
   * just less often. See {@link SceneOptions.maxFPS}.
   */
  public maxFPS: number = 60;
  /** Whether the OS prefers-reduced-motion setting auto-caps the loop. */
  public respectReducedMotion: boolean = true;
  /** Cached media-query list; `.matches` is read live each frame. */
  private reducedMotionQuery: MediaQueryList | null = null;

  /** True when the OS asks for reduced motion and we respect it. Read by the animation drivers. */
  public get prefersReducedMotion(): boolean {
    return this.respectReducedMotion && !!this.reducedMotionQuery?.matches;
  }

  /**
   * Throttle interval (ms) for the a11y/automation shadow sync. `0` = every
   * frame. See {@link SceneOptions.a11ySyncInterval}.
   */
  public a11ySyncInterval: number = 0;
  /** Timestamp of the last a11y sync, for throttling. */
  private lastA11ySync: number = -Infinity;
  /** True if we skipped an a11y sync during animation and need to sync when at rest. */
  private a11yPendingSyncAfterAnimation: boolean = false;

  // A11y / Automation Layer. `null` in non-DOM (SSR/Node) environments — the
  // whole projection degrades to a no-op so the engine's logic stays usable
  // server-side (e.g. headless layout / vector export) without jsdom.
  private a11yRoot: HTMLDivElement | null;
  private a11yElements: Map<string, HTMLElement> = new Map();
  /** DOM nodes mirroring static text content, keyed by entity id. */
  private contentElements: Map<string, HTMLElement> = new Map();
  private contentProjectionEnabled: boolean = true;
  /**
   * True while a text-selection drag that started on a projection's blank
   * region (no text node under the press) is being driven manually — the
   * browser has no native anchor for it, so mousemove extends the Selection
   * from the position we resolved ourselves.
   */
  private blankRegionSelectionDrag = false;
  // Animation/interactive flags collected during the render walk (tree-walk
  // fusion): the loop reads last frame's answers instead of re-walking the
  // tree up to 4× per tick. Start true so the first tick stays conservative.
  private frameHadAnimation = true;
  private frameHadInteractive = true;
  private resizeHandler: () => void;
  private focusedA11yElement: HTMLElement | null = null;
  private caretBlinkTimer: any = null;
  public a11yNeedsReorder: boolean = true;
  private portalRoot: HTMLDivElement | null = null;
  private fullViewportElements: HTMLElement[] = [];
  private normalElements: HTMLElement[] = [];
  private activeIds: Set<string> = new Set<string>();

  private activePortalsThisFrame: Set<string> = new Set();
  private activePortalsPrevFrame: Set<string> = new Set();
  private portalEntities: Map<string, DOMPortalEntity> = new Map();
  private renderOrderCounter: number = 0;

  // Optional WebGL point-cloud layer (see SceneOptions.pointBackend).
  private pointRenderer: PointRenderer | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private debugA11y: boolean;
  public width: number;
  public height: number;
  private disableWindowResize: boolean = false;

  // WebGPU properties
  private destroyed: boolean = false;
  private device: GPUDevice | null = null;
  private deviceLost: boolean = false;
  public particleBackend: 'auto' | 'webgpu' | 'cpu' = 'auto';
  private _webgpuDisabled: boolean = false;
  public get webgpuDisabled(): boolean {
    return this._webgpuDisabled || this.particleBackend === 'cpu';
  }
  public set webgpuDisabled(value: boolean) {
    this._webgpuDisabled = value;
  }
  private recoveryTimerId: any = null;
  private manager: WebGPUParticleSystemManager | null = null;
  private initializingWebGPU: boolean = false;
  private gpuCanvas: HTMLCanvasElement | null = null;
  private gpuContext: any = null;
  /** True while the GPU canvas holds a presented particle frame (needs clearing when they leave). */
  private gpuHasContent: boolean = false;
  private mouseX: number = -9999;
  private mouseY: number = -9999;
  private pointerMoveListener: ((e: PointerEvent) => void) | null = null;
  private pointerLeaveListener: (() => void) | null = null;
  private hasWarnedZeroSize: boolean = false;
  private fontLoadHandler: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: SceneOptions = {}) {
    this.canvas = canvas;
    this.debugA11y = options.debugA11y ?? false;
    this.disableWindowResize = options.disableWindowResize ?? false;
    if (this.disableWindowResize) {
      // Prefer the inline px style: it's where the renderer records the
      // *logical* size. On a remount, canvas.width holds the previous
      // renderer's DPR-scaled backing store — reading it as logical would
      // compound the scale on every mount (400 → 800 → 1600 at DPR 2).
      const styleWidth = parseInlinePx(canvas.style?.width);
      const styleHeight = parseInlinePx(canvas.style?.height);
      this.width = styleWidth ?? (canvas.width || canvas.clientWidth || 0);
      this.height = styleHeight ?? (canvas.height || canvas.clientHeight || 0);
    } else {
      this.width =
        typeof window !== 'undefined'
          ? window.innerWidth
          : canvas.clientWidth || canvas.width || 800;
      this.height =
        typeof window !== 'undefined'
          ? window.innerHeight
          : canvas.clientHeight || canvas.height || 600;
    }
    const globalProcess =
      typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined;
    const isTest =
      globalProcess &&
      (globalProcess.env?.NODE_ENV === 'test' || globalProcess.env?.VITEST === 'true');
    this.maxFPS = options.maxFPS ?? (isTest ? 0 : 60);
    this.respectReducedMotion = options.respectReducedMotion ?? true;
    this.autoThrottle = options.autoThrottle ?? true;
    this.particleBackend = options.particleBackend ?? 'auto';
    this.a11ySyncInterval = options.a11ySyncInterval ?? 0;
    this.contentProjectionEnabled = options.contentProjection ?? true;
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
    (this.root as any)._scene = this;

    this.overlayRoot = new (class OverlayRoot extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    })('overlayRoot');
    (this.overlayRoot as any)._scene = this;

    if (options.renderer) {
      this.renderer = options.renderer;
    } else {
      // Embedded scenes (disableWindowResize) keep the canvas's own size; the
      // default fullscreen path lets CanvasRenderer size to the window.
      this.renderer = new CanvasRenderer(
        canvas,
        this.disableWindowResize ? { width: this.width, height: this.height } : undefined,
      );
    }

    // Setup Agent / Automation Semantic Layer (only where there's a DOM).
    if (typeof document !== 'undefined') {
      this.a11yRoot = document.createElement('div');
      this.a11yRoot.style.position = 'absolute';
      this.a11yRoot.style.top = '0';
      this.a11yRoot.style.left = '0';
      this.a11yRoot.style.width = '100vw';
      this.a11yRoot.style.height = '100vh';
      this.a11yRoot.style.pointerEvents = 'none';
      this.a11yRoot.style.overflow = 'hidden';
      this.a11yRoot.style.zIndex = '10'; // Render above canvas
      // Let text selection span across multiple content projection divs.
      // Individual divs opt in via pointer-events:auto; during an active drag
      // the root temporarily gains pointer-events so the browser can extend
      // the Selection Range beyond any single entity's bounds.
      this.a11yRoot.style.userSelect = 'text';
      this.a11yRoot.addEventListener('mousedown', (e) => {
        // Only promote when the mousedown lands on a selectable content div.
        const target = e.target as HTMLElement;
        const contentEl = target.closest('[data-vecto-content]') as HTMLElement | null;
        if (target === this.a11yRoot || !contentEl) return;
        if (getComputedStyle(contentEl).pointerEvents !== 'auto') return;
        this.a11yRoot!.style.pointerEvents = 'auto';
        // A press on the container's blank region (padding, space past a
        // line's end, the gap between lines) has no text node under the
        // cursor — every line box is absolutely positioned (out of flow), so
        // the browser cannot resolve a native selection anchor there and the
        // drag would select nothing. Anchor at the nearest text position and
        // drive the extension manually until mouseup.
        if (target === contentEl) {
          const anchor = nearestTextPositionInProjection(contentEl, e.clientX, e.clientY);
          const selection = window.getSelection();
          if (anchor && selection) {
            selection.collapse(anchor.node, anchor.offset);
            this.blankRegionSelectionDrag = true;
            // Without this the browser's own (failed) anchor attempt runs
            // after the listener and clears the collapsed range.
            e.preventDefault();
          }
        }
      });
      this.a11yRoot.addEventListener('mousemove', (e) => {
        if (!this.blankRegionSelectionDrag) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const focus = caretTextPositionAt(e.clientX, e.clientY);
        if (focus) selection.extend(focus.node, focus.offset);
      });
      const endDrag = () => {
        this.blankRegionSelectionDrag = false;
        if (this.a11yRoot) this.a11yRoot.style.pointerEvents = 'none';
      };
      this.a11yRoot.addEventListener('mouseup', endDrag);
      // Pointer may leave the overlay entirely (e.g. moving above the viewport).
      this.a11yRoot.addEventListener('mouseleave', endDrag);
      if (canvas.parentElement) {
        canvas.parentElement.appendChild(this.a11yRoot);
      }

      this.portalRoot = document.createElement('div');
      this.portalRoot.style.position = 'absolute';
      this.portalRoot.style.top = '0';
      this.portalRoot.style.left = '0';
      this.portalRoot.style.width = '100vw';
      this.portalRoot.style.height = '100vh';
      this.portalRoot.style.pointerEvents = 'none';
      this.portalRoot.style.overflow = 'hidden';
      this.portalRoot.style.zIndex = '9'; // Placed below a11yRoot
      if (canvas.parentElement) {
        canvas.parentElement.appendChild(this.portalRoot);
      }
    } else {
      this.a11yRoot = null;
      this.portalRoot = null;
    }

    // Optional WebGL2 point-cloud layer, stacked above the 2D canvas (below a11y).
    if (options.pointBackend === 'webgl' && typeof document !== 'undefined') {
      const gl = document.createElement('canvas');
      gl.style.position = 'absolute';
      gl.style.top = '0';
      gl.style.left = '0';
      gl.style.pointerEvents = 'none';
      gl.style.zIndex = '5';
      if (canvas.parentElement) canvas.parentElement.appendChild(gl);
      const pr = Scene.webglCreator ? Scene.webglCreator(gl) : null;
      if (pr) {
        pr.resize(this.width, this.height);
        this.glCanvas = gl;
        this.pointRenderer = pr;
      } else {
        gl.remove(); // WebGL2 unavailable → fall back to the Canvas2D batch
      }
    }

    this.resizeHandler = () => {
      this.resize(window.innerWidth, window.innerHeight);
    };

    if (typeof document !== 'undefined' && document.fonts) {
      this.fontLoadHandler = () => {
        clearCssLineBoxMetrics();
        this.markDirty();
      };
      document.fonts.ready.then(this.fontLoadHandler);
      document.fonts.addEventListener('loadingdone', this.fontLoadHandler);
    }

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

  /** Convert browser viewport coordinates into this Scene's logical coordinates. */
  public clientToScene(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect?.();
    if (!rect) return { x: clientX, y: clientY };
    const cssWidth = rect.width || this.canvas.clientWidth || this.width;
    const cssHeight = rect.height || this.canvas.clientHeight || this.height;
    return {
      x: (clientX - rect.left) * (cssWidth > 0 ? this.width / cssWidth : 1),
      y: (clientY - rect.top) * (cssHeight > 0 ? this.height / cssHeight : 1),
    };
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
    if (node.isDOMPortal) {
      (node as any).domElement.remove();
      this.portalEntities.delete(node.id);
      this.activePortalsThisFrame.delete(node.id);
      this.activePortalsPrevFrame.delete(node.id);
    }
    // Content projections must go with their entity: a surviving node is
    // still selectable (pointer-events: auto), still find-in-page-able at its
    // stale position, and leaks — the same orphan class as a11y elements.
    const contentEl = this.contentElements.get(node.id);
    if (contentEl) {
      contentEl.remove();
      this.contentElements.delete(node.id);
      this.a11yNeedsReorder = true;
    }
    const el = this.a11yElements.get(node.id);
    if (el) {
      if (el === this.focusedA11yElement) {
        this.focusedA11yElement = null;
        if (this.caretBlinkTimer) {
          clearInterval(this.caretBlinkTimer);
          this.caretBlinkTimer = null;
        }
      }
      el.remove();
      this.a11yElements.delete(node.id);
      this.a11yNeedsReorder = true;
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
   * Tear down the a11y/automation shadow nodes for `entity` and its descendants
   * without removing it from the scene graph. Components that manage dynamic
   * interactive *child* entities (e.g. a {@link Entity}'s per-link hotspots) call
   * this before discarding those children so their shadow `<a>`/controls don't
   * leak (the per-frame `syncA11y` only creates/updates, it never prunes).
   *
   * @param entity - The subtree whose shadow nodes should be removed.
   */
  public detachA11y(entity: Entity): void {
    // removeA11yRecursively prunes a11y elements, DOM portals, AND content
    // projections for the whole subtree.
    this.removeA11yRecursively(entity);
  }

  /**
   * Add an overlay entity to the overlay root, bypassing main tree clipping bounds.
   */
  public showOverlay(overlay: Entity): void {
    this.overlayRoot.add(overlay);
    this.markDirty();
  }

  /**
   * Remove an overlay entity from the overlay root.
   */
  public hideOverlay(overlay: Entity): void {
    this.overlayRoot.remove(overlay);
    this.removeA11yRecursively(overlay);
    this.markDirty();
  }

  private destroyEntitySubtree(entity: Entity): void {
    while (entity.children.length > 0) this.destroyEntitySubtree(entity.children.at(-1)!);
    entity.destroy();
  }

  /**
   * Tear down the Scene, halt the loop, and clean up event listeners and DOM elements.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    if (typeof document !== 'undefined' && document.fonts && this.fontLoadHandler) {
      document.fonts.removeEventListener('loadingdone', this.fontLoadHandler);
    }
    while (this.root.children.length > 0) this.destroyEntitySubtree(this.root.children.at(-1)!);
    while (this.overlayRoot.children.length > 0) {
      this.destroyEntitySubtree(this.overlayRoot.children.at(-1)!);
    }
    if (typeof window !== 'undefined' && !this.disableWindowResize) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (
      typeof window !== 'undefined' &&
      this.canvas &&
      typeof this.canvas.removeEventListener === 'function'
    ) {
      if (this.pointerMoveListener) {
        this.canvas.removeEventListener('pointermove', this.pointerMoveListener);
      }
      if (this.pointerLeaveListener) {
        this.canvas.removeEventListener('pointerleave', this.pointerLeaveListener);
      }
    }
    this.a11yRoot?.remove();
    this.portalRoot?.remove();
    this.a11yElements.clear();
    for (const el of this.contentElements.values()) el.remove();
    this.contentElements.clear();
    this.pointRenderer?.destroy();
    // Release the main renderer's backend (e.g. WebGLRenderer + GL context)
    // before GC — prevents context leakage across SPA/XR recreate cycles.
    this.renderer.dispose?.();
    this.glCanvas?.remove();
    this.gpuCanvas?.remove();
    this.gpuCanvas = null;
    this.gpuContext = null;
    if (this.recoveryTimerId) {
      clearTimeout(this.recoveryTimerId);
      this.recoveryTimerId = null;
    }
    if (this.manager) {
      this.manager.destroy();
      this.manager = null;
    }
    // Release the GPUDevice itself — without this, repeated Scene
    // create/destroy cycles (SPA routes, XR sessions) leak WebGPU devices.
    if (this.device) {
      this.device.destroy?.();
      this.device = null;
    }
  }

  private setupEvents(): void {
    if (typeof window !== 'undefined' && !this.disableWindowResize) {
      window.addEventListener('resize', this.resizeHandler);
    }
    if (
      typeof window !== 'undefined' &&
      this.canvas &&
      typeof this.canvas.addEventListener === 'function'
    ) {
      this.pointerMoveListener = (e: PointerEvent) => {
        const point = this.clientToScene(e.clientX, e.clientY);
        this.mouseX = point.x;
        this.mouseY = point.y;
      };
      this.pointerLeaveListener = () => {
        this.mouseX = -9999;
        this.mouseY = -9999;
      };
      this.canvas.addEventListener('pointermove', this.pointerMoveListener);
      this.canvas.addEventListener('pointerleave', this.pointerLeaveListener);
    }
  }

  /**
   * Begin the `requestAnimationFrame` render loop.
   *
   * Idempotent — calling `start()` on an already-running scene is a no-op.
   */
  public start(): void {
    if (this.isRunning) return;

    if ((this.width === 0 || this.height === 0) && !this.hasWarnedZeroSize) {
      console.warn(
        `[VectoJS] Scene started with width or height set to 0 (width: ${this.width}, height: ${this.height}). ` +
          'Entities may not render or simulate correctly. Please call scene.resize(width, height) to set valid dimensions.',
      );
      this.hasWarnedZeroSize = true;
    }

    this.isRunning = true;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : 0;
    this.scheduleFrame();

    const isTextFocused =
      this.focusedA11yElement instanceof HTMLInputElement ||
      this.focusedA11yElement instanceof HTMLTextAreaElement;
    if (isTextFocused && this.renderMode === 'onDemand' && !this.caretBlinkTimer) {
      this.caretBlinkTimer = setInterval(() => {
        this.markDirty();
      }, 500);
    }
  }

  /** Schedule the next frame, or no-op where `requestAnimationFrame` is absent (SSR). */
  private scheduleFrame(): void {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  /**
   * Halt the render loop after the current frame completes.
   *
   * Call {@link start} again to resume rendering.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.caretBlinkTimer) {
      clearInterval(this.caretBlinkTimer);
      this.caretBlinkTimer = null;
    }
  }

  /**
   * Manually advance the scene clock by `dt` milliseconds and render synchronously.
   * Essential for deterministic rendering (e.g. video export).
   * Note: You should call `scene.stop()` before using this to avoid conflict with the rAF loop.
   */
  /**
   * The scene-graph root entity. Exposed read-only for tooling — the devtools
   * inspector walks it to build the Virtual Math Tree view. Mutate the graph
   * through {@link add}/{@link remove}, not by editing this node directly.
   */
  public get rootEntity(): Entity {
    return this.root;
  }

  /** The overlay layer root (see {@link showOverlay}), read-only for tooling. */
  public get overlayRootEntity(): Entity {
    return this.overlayRoot;
  }

  public step(dt: number): void {
    const time = this.lastTime + dt;
    this.lastTime = time;
    this.render(this.renderer, dt, time);
    this.dirty = false;
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
  /** True when any node in the subtree is interactive (drives a11y sync). */
  private syncA11y(node: Entity) {
    if (!this.a11yRoot) return; // no DOM (SSR) → a11y projection is a no-op
    if (node.isDOMPortal) {
      return;
    }
    if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
      let el = this.a11yElements.get(node.id);
      const attrs = node.getA11yAttributes();
      const expectedTag = attrs.tag || 'div';

      // If tag name changes at runtime, recreate the element
      if (el && el.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
        if (el === this.focusedA11yElement) {
          this.focusedA11yElement = null;
          if (this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
        }
        if (el.parentNode === this.a11yRoot) {
          this.a11yRoot.removeChild(el);
        }
        this.a11yElements.delete(node.id);
        el = undefined;
        this.a11yNeedsReorder = true; // Mark reorder as DOM structure has mutated
      }

      if (!el) {
        el = document.createElement(expectedTag);
        el.id = node.id;
        el.setAttribute('data-vecto-id', node.id);

        // Default shadow DOM styling (with outline disabled to let Vecto handle visual focus outlines)
        el.style.position = 'absolute';
        el.style.transformOrigin = '0 0';
        el.style.pointerEvents = 'auto'; // allow Playwright/Agent to click!
        el.style.touchAction = 'pinch-zoom';
        el.style.margin = '0';
        el.style.padding = '0';
        el.style.outline = 'none';
        el.style.cursor = node.a11yFullViewport ? 'default' : 'pointer';

        if (this.debugA11y) {
          el.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          el.style.border = '1px dashed rgba(56, 189, 248, 0.4)';
        } else {
          el.style.opacity = '0';
          el.style.border = 'none';
          el.style.background = 'transparent';
        }

        // Bind pointer click
        el.addEventListener('click', (e) => {
          node.dispatchEvent(new VectoJSEvent('click', node, e));
        });

        // Developer debugger mode hover feedback
        el.addEventListener('mouseenter', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          node.dispatchEvent(new VectoJSEvent('hover', node, e, false));
        });
        el.addEventListener('mouseleave', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          node.dispatchEvent(new VectoJSEvent('pointerleave', node, e, false));
        });

        const capEl = el;
        const releasePointer = (event: PointerEvent): void => {
          if (typeof capEl.releasePointerCapture !== 'function') return;
          if (
            typeof capEl.hasPointerCapture === 'function' &&
            !capEl.hasPointerCapture(event.pointerId)
          ) {
            return;
          }
          try {
            capEl.releasePointerCapture(event.pointerId);
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
          }
        };
        el.addEventListener('pointerdown', (e) => {
          if (typeof capEl.setPointerCapture === 'function') capEl.setPointerCapture(e.pointerId);
          node.dispatchEvent(new VectoJSEvent('pointerdown', node, e));
        });
        el.addEventListener('pointerup', (e) => {
          releasePointer(e);
          node.dispatchEvent(new VectoJSEvent('pointerup', node, e));
        });
        el.addEventListener('pointercancel', (e) => {
          releasePointer(e);
          node.dispatchEvent(new VectoJSEvent('pointercancel', node, e));
        });
        el.addEventListener('pointermove', (e) =>
          node.dispatchEvent(new VectoJSEvent('pointermove', node, e)),
        );
        el.addEventListener(
          'wheel',
          (e) => {
            node.dispatchEvent(new VectoJSEvent('wheel', node, e));
          },
          { passive: false },
        );
        el.addEventListener('keydown', (e) => {
          node.dispatchEvent(new VectoJSEvent('keydown', node, e));
        });
        el.addEventListener('keyup', (e) => {
          node.dispatchEvent(new VectoJSEvent('keyup', node, e));
        });

        // Form integration listeners
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const input = el;
          let composition: { start: number; length: number } | null = null;
          const forward = () => {
            (input as any)._lastSyncedValue = input.value;
            node.emit('change', {
              value: input.value,
              checked: input instanceof HTMLInputElement ? input.checked : undefined,
              selectionStart: input.selectionStart ?? input.value.length,
              selectionEnd: input.selectionEnd ?? input.value.length,
              composition,
            });
            this.markDirty();
          };
          el.addEventListener('input', forward);
          el.addEventListener('change', forward);
          el.addEventListener('keyup', forward);
          el.addEventListener('click', forward);
          el.addEventListener('select', forward);

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
        }

        // Focus / blur handlers (guard blink timer only on text inputs)
        const isTextInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        el.addEventListener('focus', () => {
          this.focusedA11yElement = el!;
          node.emit('focus', {});
          if (
            isTextInput &&
            this.renderMode === 'onDemand' &&
            this.isRunning &&
            !this.caretBlinkTimer
          ) {
            this.caretBlinkTimer = setInterval(() => {
              this.markDirty();
            }, 500);
          }
        });
        el.addEventListener('blur', () => {
          if (this.focusedA11yElement === el) {
            this.focusedA11yElement = null;
          }
          const isTextFocused =
            this.focusedA11yElement instanceof HTMLInputElement ||
            this.focusedA11yElement instanceof HTMLTextAreaElement;
          if (!isTextFocused && this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
          node.emit('blur', {});
        });

        // Keyboard accessibility for non-natively-focusable interactive controls
        if (!isNativelyFocusable(el) && attrs.role && INTERACTIVE_A11Y_ROLES.has(attrs.role)) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              node.dispatchEvent(new VectoJSEvent('click', node, e));
            }
          });
        }

        // Initial insertion order placement
        if (node.a11yFullViewport) {
          this.a11yRoot.insertBefore(el, this.a11yRoot.firstChild);
        } else {
          this.a11yRoot.appendChild(el);
        }
        this.a11yElements.set(node.id, el);
        this.a11yNeedsReorder = true;
      }

      // Refresh dynamic attributes (with Dirty Checking to minimize DOM API calls)
      if (attrs.role !== undefined && el.getAttribute('role') !== attrs.role) {
        el.setAttribute('role', attrs.role);
      }
      if (attrs.label !== undefined && el.getAttribute('aria-label') !== attrs.label) {
        el.setAttribute('aria-label', attrs.label);
      }
      const implicitTabIndex =
        !isNativelyFocusable(el) && attrs.role && INTERACTIVE_A11Y_ROLES.has(attrs.role) ? 0 : null;
      const desiredTabIndex = attrs.tabIndex ?? implicitTabIndex;
      if (desiredTabIndex === null) {
        if (el.hasAttribute('tabindex')) el.removeAttribute('tabindex');
      } else if (el.getAttribute('tabindex') !== String(desiredTabIndex)) {
        el.setAttribute('tabindex', String(desiredTabIndex));
      }
      if (attrs.inputType !== undefined && el.getAttribute('type') !== attrs.inputType) {
        el.setAttribute('type', attrs.inputType);
      }
      if (
        attrs.placeholder !== undefined &&
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      ) {
        if (el.placeholder !== attrs.placeholder) el.placeholder = attrs.placeholder;
      }
      if (attrs.href !== undefined && el instanceof HTMLAnchorElement) {
        const safeHref = sanitizeUrl(attrs.href);
        if (el.getAttribute('href') !== safeHref) el.setAttribute('href', safeHref);
        if (attrs.target !== undefined && el.getAttribute('target') !== attrs.target) {
          el.setAttribute('target', attrs.target);
        }
      }
      if (el instanceof HTMLImageElement) {
        if (attrs.src !== undefined && el.src !== attrs.src) el.src = attrs.src;
        if (attrs.alt !== undefined && el.alt !== attrs.alt) el.alt = attrs.alt;
      }

      if (attrs.checked !== undefined) {
        if (el instanceof HTMLInputElement) {
          if (el.checked !== attrs.checked) el.checked = attrs.checked;
        } else if (el.getAttribute('aria-checked') !== String(attrs.checked)) {
          el.setAttribute('aria-checked', String(attrs.checked));
        }
      }
      if (attrs.disabled !== undefined) {
        if ('disabled' in el) {
          if ((el as any).disabled !== attrs.disabled) (el as any).disabled = attrs.disabled;
        } else if (el.getAttribute('aria-disabled') !== String(attrs.disabled)) {
          el.setAttribute('aria-disabled', String(attrs.disabled));
        }
      }
      if (
        attrs.expanded !== undefined &&
        el.getAttribute('aria-expanded') !== String(attrs.expanded)
      ) {
        el.setAttribute('aria-expanded', String(attrs.expanded));
      }
      if (attrs.controls !== undefined && el.getAttribute('aria-controls') !== attrs.controls) {
        el.setAttribute('aria-controls', attrs.controls);
      }
      if (attrs.haspopup !== undefined && el.getAttribute('aria-haspopup') !== attrs.haspopup) {
        el.setAttribute('aria-haspopup', attrs.haspopup);
      }
      if (
        attrs.selected !== undefined &&
        el.getAttribute('aria-selected') !== String(attrs.selected)
      ) {
        el.setAttribute('aria-selected', String(attrs.selected));
      }
      if (
        attrs.activedescendant !== undefined &&
        el.getAttribute('aria-activedescendant') !== attrs.activedescendant
      ) {
        el.setAttribute('aria-activedescendant', attrs.activedescendant);
      }
      if (attrs.valuemin !== undefined && el.getAttribute('aria-valuemin') !== attrs.valuemin) {
        el.setAttribute('aria-valuemin', attrs.valuemin);
      }
      if (attrs.valuemax !== undefined && el.getAttribute('aria-valuemax') !== attrs.valuemax) {
        el.setAttribute('aria-valuemax', attrs.valuemax);
      }

      if (attrs.value !== undefined) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.value !== attrs.value) {
            const userTyped = (el as any)._lastSyncedValue;
            if (attrs.value !== userTyped || document.activeElement !== el) {
              el.value = attrs.value;
              (el as any)._lastSyncedValue = attrs.value;
            }
          }
        } else if (el.getAttribute('aria-valuenow') !== attrs.value) {
          el.setAttribute('aria-valuenow', attrs.value);
        }
      }

      if (
        attrs.textInputStyle !== undefined &&
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      ) {
        const textStyle = attrs.textInputStyle;
        if (el.style.font !== textStyle.font) el.style.font = textStyle.font;
        const lineHeight = `${textStyle.lineHeight}px`;
        if (el.style.lineHeight !== lineHeight) el.style.lineHeight = lineHeight;
        const padding = `${textStyle.padding}px`;
        if (el.style.padding !== padding) el.style.padding = padding;
        if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
        if (el instanceof HTMLTextAreaElement) el.style.resize = 'none';
      }

      // Sync position mappings
      if (node.a11yFullViewport) {
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = `${this.width}px`;
        el.style.height = `${this.height}px`;
        el.style.transform = '';
      } else {
        const { a, b, c, d, e, f } = node.getWorldTransform();
        el.style.left = `${e + node.a11yOffsetX}px`;
        el.style.top = `${f + node.a11yOffsetY}px`;
        el.style.width = `${node.width}px`;
        el.style.height = `${node.height}px`;
        el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;
      }
    }

    this.syncContentProjection(node);

    for (const child of node.children) this.syncA11y(child);
    if (node === this.root) {
      for (const overlay of this.overlayRoot.children) this.syncA11y(overlay);
    }
  }

  /**
   * Mirror one entity's static text ({@link Entity.getContentProjection}) as a
   * transparent DOM node positioned over the drawn glyphs. Runs on the a11y
   * sync cadence; all writes are dirty-checked. Off-viewport projections are
   * hidden (`display: none`) so text-heavy scenes only materialize what is
   * visible to the browser's text machinery anyway.
   */
  private syncContentProjection(node: Entity): void {
    if (!this.contentProjectionEnabled || !this.a11yRoot) return;
    const projection = node.getContentProjection();
    let el = this.contentElements.get(node.id);

    if (!projection || !projection.text) {
      if (el) {
        el.remove();
        this.contentElements.delete(node.id);
        this.a11yNeedsReorder = true;
      }
      return;
    }

    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-vecto-content', node.id);
      const s = el.style;
      s.position = 'absolute';
      s.transformOrigin = '0 0';
      s.margin = '0';
      s.padding = '0';
      // The canvas owns the pixels; the DOM node only carries the text.
      s.color = 'transparent';
      s.forcedColorAdjust = 'none';
      s.setProperty('-webkit-text-fill-color', 'transparent');
      s.whiteSpace = 'pre-wrap';
      // No overflow:hidden — the a11yRoot clips at the viewport boundary.
      // Removing it lets the browser start text selection from padding/blank
      // regions inside the entity and extend selection beyond entity bounds.
      s.zIndex = '0'; // beneath the interactive a11y elements
      // Keep scroll containers working when the pointer is over selectable text.
      el.addEventListener(
        'wheel',
        (e) => {
          node.dispatchEvent(new VectoJSEvent('wheel', node, e));
        },
        { passive: false },
      );
      this.a11yRoot.appendChild(el);
      this.contentElements.set(node.id, el);
      this.a11yNeedsReorder = true;
    }

    const lines = projection.lines;
    if (lines && lines.length > 0) {
      const signature = JSON.stringify({
        lines,
        fallbackFont: projection.font ?? '',
        fallbackLineHeight: projection.lineHeight ?? 16,
      });
      if (el.dataset.vectoProjectionLines !== signature) {
        el.replaceChildren();
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const lineElement = document.createElement('span');
          const lineFont = line.font ?? projection.font ?? '';
          const lineHeight = line.lineHeight ?? projection.lineHeight ?? 16;
          lineElement.style.position = 'absolute';
          lineElement.dir = 'auto';
          lineElement.style.left = `${line.x}px`;
          lineElement.style.top = `${line.y + line.baseline - cssLineBoxBaseline(lineFont, lineHeight)}px`;
          lineElement.style.whiteSpace = 'pre';
          if (lineFont) lineElement.style.font = lineFont;
          // Assigning the CSS `font` shorthand resets line-height to `normal`.
          // Set the explicit line box afterwards, or selection geometry drifts
          // differently in each browser for mixed-size text.
          lineElement.style.lineHeight = `${lineHeight}px`;
          const separator = line.separatorAfter ?? (index < lines.length - 1 ? '\n' : '');
          if (line.runs && line.runs.length > 0) {
            for (let runIndex = 0; runIndex < line.runs.length; runIndex++) {
              const run = line.runs[runIndex];
              const runElement = document.createElement('span');
              // Keep the separator in the final logical Text node. Firefox
              // emits a duplicate Range rectangle when the same positioned
              // line contains a second, separator-only Text node.
              runElement.textContent =
                run.text + (runIndex === line.runs.length - 1 ? separator : '');
              if (run.font) runElement.style.font = run.font;
              // A run-level font shorthand also resets line-height. Preserve
              // the visual line's shared baseline for every mixed-size run.
              runElement.style.lineHeight = `${lineHeight}px`;
              lineElement.appendChild(runElement);
            }
          } else {
            lineElement.textContent = line.text + separator;
          }
          el.appendChild(lineElement);
        }
        el.dataset.vectoProjectionLines = signature;
      }
    } else {
      if (el.textContent !== projection.text) el.textContent = projection.text;
      delete el.dataset.vectoProjectionLines;
    }

    const font = projection.font ?? '';
    if (el.style.font !== font) el.style.font = font;
    const lineHeight = projection.lineHeight !== undefined ? `${projection.lineHeight}px` : '';
    if (el.style.lineHeight !== lineHeight) el.style.lineHeight = lineHeight;

    // Grid-drawn text (ligatures: 'none') needs the DOM copy laid out with
    // the same per-cell advances as the canvas; inherited by the line spans.
    const ligatures = projection.ligatures === 'none' ? 'none' : '';
    if (el.style.getPropertyValue('font-variant-ligatures') !== ligatures) {
      el.style.setProperty('font-variant-ligatures', ligatures);
      el.style.setProperty('font-kerning', ligatures ? 'none' : '');
    }

    // Interactive entities already project an a11y node — hide the text copy
    // from screen readers so nothing is announced twice. Static text has no
    // other semantic presence, so it stays exposed.
    const hidden = node.interactive ? 'true' : null;
    if (el.getAttribute('aria-hidden') !== hidden) {
      if (hidden) el.setAttribute('aria-hidden', hidden);
      else el.removeAttribute('aria-hidden');
    }

    // Selection is opt-in: pointer-events on the text would otherwise
    // intercept canvas input over every text block.
    const selectable = projection.selectable === true;
    const pointerEvents = selectable ? 'auto' : 'none';
    if (el.style.pointerEvents !== pointerEvents) {
      el.style.pointerEvents = pointerEvents;
      el.style.userSelect = selectable ? 'text' : 'none';
      el.style.cursor = selectable ? 'text' : '';
    }

    // Geometry: same threading as the interactive branch.
    const { a, b, c, d, e, f } = node.getWorldTransform();
    const contentX = projection.contentX ?? 0;
    const contentY = projection.contentY ?? 0;
    const baselineOffset =
      lines && lines.length > 0
        ? 0
        : projection.baseline === undefined
          ? 0
          : projection.baseline - cssLineBoxBaseline(font, projection.lineHeight ?? 16);
    // `contentX/Y` are local coordinates, like the arguments to Canvas
    // fillText. Map them through the world matrix before moving the DOM root;
    // otherwise a scaled or rotated entity selects text in a different place.
    const localY = contentY + baselineOffset;
    el.style.left = `${e + a * contentX + c * localY}px`;
    el.style.top = `${f + b * contentX + d * localY}px`;
    if (node.width > 0) el.style.width = `${node.width}px`;
    if (node.height > 0) el.style.height = `${node.height}px`;
    el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;

    // Viewport/clip lazy: a flat DOM mirror must not keep intercepting input
    // after its VMT box has scrolled outside a clipChildren ancestor.
    let visible = true;
    if (node.width > 0 && node.height > 0) {
      const worldCorners: Array<{ x: number; y: number }> = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const lx = i & 1 ? node.width : 0;
        const ly = i & 2 ? node.height : 0;
        const wx = a * lx + c * ly + e;
        const wy = b * lx + d * ly + f;
        worldCorners.push({ x: wx, y: wy });
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      visible = maxX >= 0 && minX <= this.width && maxY >= 0 && minY <= this.height;

      for (let ancestor = node.parent; visible && ancestor; ancestor = ancestor.parent) {
        if (!ancestor.clipChildren || ancestor.width <= 0 || ancestor.height <= 0) continue;
        let localMinX = Infinity;
        let localMinY = Infinity;
        let localMaxX = -Infinity;
        let localMaxY = -Infinity;
        for (const corner of worldCorners) {
          const local = ancestor.worldToLocal(corner.x, corner.y);
          if (!local) continue;
          localMinX = Math.min(localMinX, local.x);
          localMinY = Math.min(localMinY, local.y);
          localMaxX = Math.max(localMaxX, local.x);
          localMaxY = Math.max(localMaxY, local.y);
        }
        visible =
          localMaxX >= 0 &&
          localMinX <= ancestor.width &&
          localMaxY >= 0 &&
          localMinY <= ancestor.height;
      }
    }
    const display = visible ? '' : 'none';
    if (el.style.display !== display) el.style.display = display;
  }

  private enforceA11yDomOrder(): void {
    if (!this.a11yRoot) return;

    // Zero-GC cleanups
    this.fullViewportElements.length = 0;
    this.normalElements.length = 0;
    this.activeIds.clear();

    const collect = (node: Entity) => {
      if (node.isDOMPortal) return;

      const contentEl = this.contentElements.get(node.id);
      if (contentEl) {
        if (node.a11yFullViewport) this.fullViewportElements.push(contentEl);
        else this.normalElements.push(contentEl);
      }

      if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
        const el = this.a11yElements.get(node.id);
        if (el) {
          this.activeIds.add(node.id);
          if (node.a11yFullViewport) this.fullViewportElements.push(el);
          else this.normalElements.push(el);
        }
      }
      for (const child of node.children) collect(child);
      if (node === this.root) {
        for (const overlay of this.overlayRoot.children) collect(overlay);
      }
    };

    collect(this.root);

    // Prune removed/inactive elements and guard focus leaks
    let elementsPruned = false;
    for (const [id, el] of this.a11yElements.entries()) {
      if (!this.activeIds.has(id)) {
        elementsPruned = true;
        if (el === this.focusedA11yElement) {
          this.focusedA11yElement = null;
          if (this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
        }
        if (el.parentNode === this.a11yRoot) {
          this.a11yRoot.removeChild(el);
        }
        this.a11yElements.delete(id);
      }
    }

    if (elementsPruned) {
      this.a11yNeedsReorder = true;
    }

    // Only reorder if the hierarchy flag is set
    if (!this.a11yNeedsReorder) return;

    const fullLen = this.fullViewportElements.length;
    const normalLen = this.normalElements.length;
    const totalLen = fullLen + normalLen;

    // Reorder nodes with zero allocations (no expectedOrder array or concats)
    for (let i = 0; i < totalLen; i++) {
      const expected =
        i < fullLen ? this.fullViewportElements[i] : this.normalElements[i - fullLen];
      const current = this.a11yRoot.childNodes[i];
      if (current !== expected) {
        this.a11yRoot.insertBefore(expected, current || null);
      }
    }

    this.a11yNeedsReorder = false;
  }

  /** Keep DOM/WebGL overlay layers aligned with the canvas's CSS box. */
  private syncOverlayGeometry(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const canvasRect = this.canvas.getBoundingClientRect?.();
    const parentRect = parent.getBoundingClientRect?.();
    const cssWidth = canvasRect?.width || this.canvas.clientWidth || this.width;
    const cssHeight = canvasRect?.height || this.canvas.clientHeight || this.height;
    const left =
      (canvasRect?.left ?? 0) -
      (parentRect?.left ?? 0) -
      (parent.clientLeft || 0) +
      parent.scrollLeft;
    const top =
      (canvasRect?.top ?? 0) - (parentRect?.top ?? 0) - (parent.clientTop || 0) + parent.scrollTop;
    const scaleX = this.width > 0 ? cssWidth / this.width : 1;
    const scaleY = this.height > 0 ? cssHeight / this.height : 1;

    for (const root of [this.a11yRoot, this.portalRoot]) {
      if (!root) continue;
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.width = `${this.width}px`;
      root.style.height = `${this.height}px`;
      root.style.transformOrigin = '0 0';
      root.style.transform = `scale(${scaleX}, ${scaleY})`;
    }

    for (const canvas of [this.glCanvas, this.gpuCanvas]) {
      if (!canvas) continue;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
  }

  public getA11yTree(): A11yTreeNode[] {
    const map = new Map<string, A11yTreeNode>();
    const roots: A11yTreeNode[] = [];

    const traverse = (node: Entity, parentNode: Entity | null) => {
      if (node.isDOMPortal) return;

      let currentA11yNode: A11yTreeNode | null = null;

      if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
        const el = this.a11yElements.get(node.id);
        if (el) {
          const attrs = node.getA11yAttributes();
          currentA11yNode = {
            id: node.id,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            label: el.getAttribute('aria-label') || undefined,
            value: attrs.value,
            checked: attrs.checked,
            expanded: attrs.expanded,
            valuemin: attrs.valuemin,
            valuemax: attrs.valuemax,
            children: [],
          };
          map.set(node.id, currentA11yNode);

          // Find parent interactive container directly using the cached map
          const parentA11y = parentNode ? map.get(parentNode.id) : null;
          if (parentA11y) {
            parentA11y.children.push(currentA11yNode);
          } else {
            roots.push(currentA11yNode);
          }
        }
      }

      for (const child of node.children) {
        traverse(child, currentA11yNode ? node : parentNode);
      }

      if (node === this.root) {
        for (const overlay of this.overlayRoot.children) {
          traverse(overlay, currentA11yNode ? node : parentNode);
        }
      }
    };

    traverse(this.root, null);
    return roots;
  }

  private renderPortalDOM(
    portal: DOMPortalEntity,
    te: number,
    tf: number,
    a: number,
    b: number,
    c: number,
    d: number,
    opacity: number,
  ): void {
    if (!this.portalRoot) return;

    this.activePortalsThisFrame.add(portal.id);
    this.portalEntities.set(portal.id, portal);

    if (portal.domElement.parentElement !== this.portalRoot) {
      this.portalRoot.appendChild(portal.domElement);
    }

    if (!portal.domElement.hasAttribute('data-vecto-id')) {
      portal.domElement.setAttribute('data-vecto-id', portal.id);
    }

    const transformStr = `matrix(${a}, ${b}, ${c}, ${d}, ${te}, ${tf})`;
    let widthStr = '';
    let heightStr = '';
    if (portal.width > 0) widthStr = `${portal.width}px`;
    if (portal.height > 0) heightStr = `${portal.height}px`;

    const zIndexStr = String(this.renderOrderCounter++);

    if (portal.lastWidth !== widthStr) {
      portal.domElement.style.width = widthStr;
      portal.lastWidth = widthStr;
    }
    if (portal.lastHeight !== heightStr) {
      portal.domElement.style.height = heightStr;
      portal.lastHeight = heightStr;
    }
    if (portal.lastTransform !== transformStr) {
      portal.domElement.style.left = '0px';
      portal.domElement.style.top = '0px';
      portal.domElement.style.transform = transformStr;
      portal.lastTransform = transformStr;
    }
    if (portal.lastZIndex !== zIndexStr) {
      portal.domElement.style.zIndex = zIndexStr;
      portal.lastZIndex = zIndexStr;
    }
    const opacityStr = String(opacity);
    if (portal.lastOpacity !== opacityStr) {
      portal.domElement.style.opacity = opacityStr;
      portal.lastOpacity = opacityStr;
    }
  }

  private reconcilePortals(): void {
    if (!this.portalRoot) return;

    for (const oldId of this.activePortalsPrevFrame) {
      if (!this.activePortalsThisFrame.has(oldId)) {
        const portal = this.portalEntities.get(oldId);
        if (portal) {
          if (
            portal.domElement.parentElement === this.portalRoot &&
            (!portal.scene || portal.scene === this)
          ) {
            portal.domElement.remove();
          }
          this.portalEntities.delete(oldId);
        }
      }
    }

    this.activePortalsPrevFrame = new Set(this.activePortalsThisFrame);
    this.activePortalsThisFrame.clear();
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

    let cap = this.effectiveMaxFPS();

    // Idle = nothing marked dirty and no animation in flight. This drives two
    // independent behaviors: the onDemand frame skip (always active in that
    // mode) and the `always`-mode 2 FPS auto-throttle (opt-out via
    // `autoThrottle` — it must NOT gate the onDemand skip, or disabling the
    // throttle would silently turn onDemand into per-frame rendering).
    // Flags come from the last rendered frame (collected during the render
    // walk). Skipped frames change no state, so they stay valid while idle;
    // anything that starts motion marks the scene dirty, which wakes the loop
    // and refreshes them on the next rendered frame.
    const isIdle = !this.dirty && !this.frameHadAnimation;

    if (isIdle && this.autoThrottle && this.renderMode === 'always' && this.maxFPS > 0) {
      cap = Math.min(cap, 2);
    }

    // Frame-rate cap (power saving / prefers-reduced-motion): if this frame
    // arrived sooner than the target interval, skip rendering this tick.
    // `lastTime` only advances on rendered frames, so `dt` stays accurate.
    if (cap > 0 && time - this.lastTime < 1000 / cap - 1) {
      this.scheduleFrame();
      return;
    }

    const dt = time - this.lastTime;
    this.lastTime = time;

    // onDemand: only redraw when dirty or an animation is in flight.
    if (this.renderMode === 'onDemand' && isIdle) {
      this.scheduleFrame();
      return;
    }

    // Consume the dirty flag BEFORE the update/render pass: any markDirty()
    // call made inside an entity's update() must survive into the next frame
    // (self-animating entities re-arm themselves this way). Clearing after
    // render would silently wipe those marks and freeze the entity.
    this.dirty = false;

    this.render(this.renderer, dt, time);

    // Sync Automation Shadow DOM (skip the whole walk when nothing is interactive).
    // Performance Throttling: If an animation is currently flying, we freeze A11y writes
    // to prevent DOM reflow from thrashing Canvas render loop. We sync once it's at rest.
    const hasActiveAnimation = this.frameHadAnimation;

    const hasInteractive = this.frameHadInteractive;
    // Content projection rides the same walk. It must run even with zero
    // existing mirrors (new text entities need discovery), so enabling the
    // option opts into the walk; per-node writes are all dirty-checked, so an
    // unchanged frame costs only the traversal.
    const wantsContentSync = this.contentProjectionEnabled;
    const shouldSyncInterval =
      this.a11ySyncInterval <= 0 || time - this.lastA11ySync >= this.a11ySyncInterval;

    if (
      (hasInteractive || this.a11yElements.size > 0 || wantsContentSync) &&
      (shouldSyncInterval || this.a11yPendingSyncAfterAnimation)
    ) {
      this.lastA11ySync = time;
      if (hasInteractive || wantsContentSync) {
        this.syncA11y(this.root);
      }
      this.enforceA11yDomOrder();
      this.a11yPendingSyncAfterAnimation = hasActiveAnimation;
    } else if (hasActiveAnimation) {
      this.a11yPendingSyncAfterAnimation = true;
    }

    this.scheduleFrame();
  }

  /**
   * Render the entire scene graph onto the specified renderer.
   *
   * @param renderer - The renderer instance to draw to.
   * @param dt - Delta time in milliseconds (default 0).
   * @param time - Current absolute time in milliseconds (default 0).
   */
  public render(renderer: IRenderer, dt = 0, time = 0): void {
    const isMainRenderer = renderer === this.renderer;
    if (isMainRenderer && this.a11yRoot && this.canvas.parentElement) {
      const parentStyle = this.canvas.parentElement.style;
      if (!parentStyle.position || parentStyle.position === 'static') {
        parentStyle.position = 'relative';
      }
      this.syncOverlayGeometry();
    }

    if (isMainRenderer) {
      this.renderOrderCounter = 0;
      this.activePortalsThisFrame.clear();
    }

    // Collect all ComputeParticleEntity instances in the tree
    const computeEntities: ComputeParticleEntity[] = [];
    const collectComputeEntities = (node: Entity) => {
      if (node instanceof ComputeParticleEntity) {
        computeEntities.push(node);
      }
      for (const child of node.children) {
        collectComputeEntities(child);
      }
    };
    collectComputeEntities(this.root);
    for (const overlay of this.overlayRoot.children) {
      collectComputeEntities(overlay);
    }

    if (computeEntities.length > 0) {
      // Particle simulation (WebGPU compute pass / CPU fallback) mutates
      // `entity.particleData` even when `dt === 0`. Secondary renderers such as
      // SVG export are read-only snapshots; deterministic `step()` still uses
      // the Scene's main renderer and therefore advances simulation.
      const isMainRenderPath = renderer === this.renderer;
      // Async initialize WebGPU context on the first frame we encounter a ComputeParticleEntity
      if (
        isMainRenderPath &&
        !this.device &&
        !this.webgpuDisabled &&
        !this.initializingWebGPU &&
        !this.deviceLost
      ) {
        this.initializingWebGPU = true;
        this.initWebGPUContext(computeEntities)
          .then((newDevice) => {
            this.device = newDevice;
            this.initializingWebGPU = false;
            const format = navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm';
            if (Scene.webgpuManagerClass) {
              this.manager = new Scene.webgpuManagerClass(newDevice);
            } else if (this.particleBackend === 'webgpu') {
              throw new Error(
                'WebGPU particle manager is not registered. Please call Scene.registerWebGPUParticleSystemManager(WebGPUParticleSystemManager) first.',
              );
            }
            if (this.manager) {
              this.manager.initPipelines(format);
              for (const entity of computeEntities) {
                this.manager.setupEntityResources(entity);
                if (entity.gpuStorageBuffer) {
                  newDevice.queue.writeBuffer(entity.gpuStorageBuffer, 0, entity.particleData);
                }
              }
            }
          })
          .catch((err) => {
            if (this.particleBackend === 'webgpu') {
              console.error('Failed to initialize WebGPU:', err);
            } else {
              console.warn('WebGPU unavailable; using CPU particle fallback.', err);
            }
            this.webgpuDisabled = true;
            this.initializingWebGPU = false;
          });
      }

      // Dispatch WebGPU Compute + Render passes OR run CPU physics updates fallback
      if (
        isMainRenderPath &&
        this.device &&
        this.manager &&
        !this.deviceLost &&
        !this.webgpuDisabled
      ) {
        try {
          const commandEncoder = this.device.createCommandEncoder();

          // Compute Pass
          const computePass = commandEncoder.beginComputePass();
          for (const entity of computeEntities) {
            if (!entity.gpuStorageBuffer || entity.needsInit) {
              if (!entity.gpuStorageBuffer) {
                this.manager.setupEntityResources(entity);
              }
              this.device.queue.writeBuffer(entity.gpuStorageBuffer!, 0, entity.particleData);
              entity.needsInit = false;
            }
            this.manager.recordComputePass(
              computePass,
              entity,
              dt / 1000,
              this.mouseX,
              this.mouseY,
              this.width,
              this.height,
            );
          }
          computePass.end();

          // Render Pass
          if (this.gpuContext) {
            const view = this.gpuContext.getCurrentTexture().createView();
            const renderPassDescriptor: GPURenderPassDescriptor = {
              colorAttachments: [
                {
                  view,
                  clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);
            for (const entity of computeEntities) {
              this.manager.recordRenderPass(renderPass, entity);
            }
            renderPass.end();
          }

          this.device.queue.submit([commandEncoder.finish()]);
          if (this.gpuContext) this.gpuHasContent = true;
        } catch (e) {
          console.error('WebGPU frame execution failed. Falling back.', e);
          this.deviceLost = true;
          this.device = null;
          this.recreateWebGPUDeviceWithRetry(computeEntities);
        }
      } else if (isMainRenderPath) {
        // Fallback updates. The simulation runs in entity-local space, so the
        // scene-space mouse must be converted per entity (repulsion would
        // otherwise only work for untransformed entities at the origin).
        for (const entity of computeEntities) {
          let mx = this.mouseX;
          let my = this.mouseY;
          if (mx > -9000 && my > -9000) {
            const local = entity.worldToLocal(mx, my);
            if (local) {
              mx = local.x;
              my = local.y;
            } else {
              mx = -9999;
              my = -9999;
            }
          }
          entity.updateCPU(dt / 1000, mx, my, this.width, this.height);
        }
      }
    } else if (isMainRenderer) {
      // The GPU canvas presents its last frame until told otherwise: once the
      // final ComputeParticleEntity leaves the tree, clear it or the particles
      // stay frozen on screen.
      this.clearGPUCanvasIfStale();
    }

    renderer.clear();
    if (isMainRenderer) {
      this.pointRenderer?.begin();
    }

    const vw = this.width;
    const vh = this.height;

    // Tree-walk fusion: animation/interactive state is collected during this
    // walk (before any cull/portal early-return) so the loop doesn't re-walk.
    let walkHadAnimation = false;
    let walkHadInteractive = false;

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
      parentOpacity: number,
    ) => {
      if (isMainRenderer) {
        node.update(dt, time);
        if (!walkHadAnimation && node.hasPendingAnimations()) walkHadAnimation = true;
        if (!walkHadInteractive && node.interactive) walkHadInteractive = true;
      }

      // Compose parent * translate(x,y) * scale(sx,sy) * rotate(rot).
      const cos = Math.cos(node.rotation);
      const sin = Math.sin(node.rotation);
      const te = pa * node.x + pc * node.y + pe;
      const tf = pb * node.x + pd * node.y + pf;
      const sxCos = node.scaleX * cos;
      const sxSin = node.scaleX * sin;
      const syCos = node.scaleY * cos;
      const sySin = node.scaleY * sin;
      // Canvas calls translate → scale → rotate, so the local matrix is
      // T * S * R = [sx*cos, -sx*sin; sy*sin, sy*cos]. Keep culling,
      // portals, and GPU fast paths in the exact same coordinate system.
      const a = pa * sxCos + pc * sySin;
      const b = pb * sxCos + pd * sySin;
      const c = pa * -sxSin + pc * syCos;
      const d = pb * -sxSin + pd * syCos;
      const worldScaleX = Math.hypot(a, b);
      const worldScaleY = Math.hypot(c, d);
      const worldOpacity = parentOpacity * node.opacity;
      const scaleTolerance = Math.max(1, worldScaleX, worldScaleY) * 1e-6;
      const orthogonalTolerance = Math.max(1, worldScaleX * worldScaleY) * 1e-6;
      const isSimilarityTransform =
        Number.isFinite(worldScaleX) &&
        Number.isFinite(worldScaleY) &&
        Math.abs(worldScaleX - worldScaleY) <= scaleTolerance &&
        Math.abs(a * c + b * d) <= orthogonalTolerance;

      const a11yEl = isMainRenderer ? this.a11yElements.get(node.id) : undefined;
      if (a11yEl) {
        a11yEl.style.zIndex = String(this.renderOrderCounter++);
      }

      if ((node as any).isDOMPortal) {
        if (isMainRenderer) {
          this.renderPortalDOM(node as DOMPortalEntity, te, tf, a, b, c, d, worldOpacity);
        }
        return;
      }

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
          if (!visible) return;
          if (isMainRenderer && this.pointRenderer) {
            if (isSimilarityTransform) {
              // GPU layer: emit in world coords (center = (te,tf), radius scaled
              // by the accumulated uniform scale = hypot(a,b)).
              this.pointRenderer.addCircle(te, tf, bc.radius * worldScaleX, bc.color, worldOpacity);
              return;
            }
            // A non-uniform or sheared ancestor turns the circle into an
            // ellipse. The point backend only accepts one radius, so retain the
            // exact Canvas transform by falling through to node.render().
          } else {
            renderer.fillCircle(node.x, node.y, bc.radius * node.scaleX, bc.color, worldOpacity);
            return;
          }
        } else if (isMainRenderer && this.pointRenderer) {
          // GPU instanced rectangle (WebGL backend only; otherwise falls through
          // to the normal render path below). Origin (te,tf), world scale hypot(a,b),
          // rotation atan2(b,a).
          const br = node.getBatchRect();
          // A single size + rotation cannot represent non-uniform scale, shear,
          // or a reflection, so those cases use the normal Canvas path.
          if (br && isSimilarityTransform && a * d - b * c >= 0) {
            if (visible) {
              this.pointRenderer.addRect(
                te,
                tf,
                br.width * worldScaleX,
                br.height * worldScaleX,
                br.color,
                worldOpacity,
                Math.atan2(b, a),
              );
            }
            return;
          }
        }
      }

      // Any normal (non-batched) draw must commit the pending batch first so
      // painter's order is preserved across the sibling group.
      renderer.flush();
      renderer.save();
      renderer.translate(node.x, node.y);
      renderer.scale(node.scaleX, node.scaleY);
      renderer.rotate(node.rotation);
      renderer.setGlobalAlpha(worldOpacity);

      if (visible) {
        if (node instanceof ComputeParticleEntity) {
          if (this.deviceLost || this.webgpuDisabled || !this.device || !this.manager) {
            this.renderCPUParticles(
              renderer,
              node,
              worldOpacity,
              a,
              b,
              c,
              d,
              te,
              tf,
              worldScaleX,
              isSimilarityTransform,
            );
          }
        } else {
          node.render(renderer);
        }
      }

      if (node.clipChildren) {
        renderer.clip(0, 0, node.width, node.height);
      }

      for (const child of node.children) {
        renderNode(child, a, b, c, d, te, tf, worldOpacity);
      }
      // Commit any batched leaf children before popping this node's transform.
      renderer.flush();
      renderer.restore();
    };

    renderNode(this.root, 1, 0, 0, 1, 0, 0, 1);
    for (const overlay of this.overlayRoot.children) {
      renderNode(overlay, 1, 0, 0, 1, 0, 0, 1);
    }
    if (isMainRenderer) {
      this.frameHadAnimation = walkHadAnimation;
      this.frameHadInteractive = walkHadInteractive;
      this.reconcilePortals();
    }
    renderer.flush();
    if (isMainRenderer) {
      this.pointRenderer?.flush();
    }
    // Retained-scene backends (ThreeRenderer) render exactly once per frame here.
    renderer.present?.();
  }

  /**
   * Export the current scene state to a lightweight, flat SVG XML string.
   */
  public toSVG(): string {
    const renderer = new SVGRenderer(this.width, this.height);
    this.render(renderer, 0, 0);
    return renderer.toXMLString();
  }

  /**
   * Manually resize the Scene's viewport.
   */
  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (typeof (this.renderer as any).resize === 'function') {
      (this.renderer as any).resize(width, height);
    }
    this.pointRenderer?.resize(width, height);
    // Keep the WebGPU particle layer's backing store in step — otherwise it
    // rasterizes at the creation-time resolution and gets CSS-stretched.
    if (this.gpuCanvas) {
      this.gpuCanvas.width = width;
      this.gpuCanvas.height = height;
    }
    this.markDirty();
  }

  /**
   * Gets the accessibility DOM element projected for the given entity ID.
   */
  public getA11yElement(entityId: string): HTMLElement | undefined {
    return this.a11yElements.get(entityId);
  }

  /** Gets the static-content DOM projection for an entity ID, when materialized. */
  public getContentElement(entityId: string): HTMLElement | undefined {
    return this.contentElements.get(entityId);
  }

  /**
   * Gets the root entity of the scene.
   */
  public getRoot(): Entity {
    return this.root;
  }

  /**
   * Finds the topmost interactive entity at the given coordinates.
   */
  public findEntityAt(x: number, y: number): Entity | null {
    // 1. Search overlay root first (drawn on top)
    const overlayHit = this.findHitRecursively(this.overlayRoot, x, y);
    if (overlayHit) return overlayHit;

    // 2. Search main scene tree
    return this.findHitRecursively(this.root, x, y);
  }

  /** Submit one transparent clear pass when particle content lingers on the GPU canvas. */
  private clearGPUCanvasIfStale(): void {
    if (!this.gpuHasContent || !this.device || !this.gpuContext || this.deviceLost) return;
    try {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.gpuContext.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch {
      // Device may be mid-loss; the recovery machinery owns that state.
    }
    this.gpuHasContent = false;
  }

  private async initWebGPUContext(entities: ComputeParticleEntity[]): Promise<GPUDevice> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported on this platform.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No GPUAdapter found.');
    }
    const device = await adapter.requestDevice();

    if (typeof document !== 'undefined' && !this.gpuCanvas) {
      const gpuCanvas = document.createElement('canvas');
      gpuCanvas.width = this.width;
      gpuCanvas.height = this.height;
      gpuCanvas.style.position = 'absolute';
      gpuCanvas.style.top = '0';
      gpuCanvas.style.left = '0';
      gpuCanvas.style.pointerEvents = 'none';
      gpuCanvas.style.zIndex = '6';
      if (this.canvas.parentElement) {
        this.canvas.parentElement.appendChild(gpuCanvas);
      }
      this.gpuCanvas = gpuCanvas;
      this.gpuContext = gpuCanvas.getContext('webgpu');
    }

    if (this.gpuContext) {
      this.gpuContext.configure({
        device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
      });
    }

    // Register context lost handler re-binding
    this.setupDeviceLostHandler(device, entities);
    return device;
  }

  private setupDeviceLostHandler(device: GPUDevice, entities: ComputeParticleEntity[]): void {
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      console.warn(`WebGPU device lost: ${info.message}`);

      this.deviceLost = true;
      this.device = null;

      this.recreateWebGPUDeviceWithRetry(entities);
    });
  }

  private recreateWebGPUDeviceWithRetry(
    entities: ComputeParticleEntity[],
    attempt: number = 0,
  ): void {
    if (this.destroyed) return;

    if (attempt >= 3) {
      console.error(
        'Failed to recover WebGPU device after 3 retries. Remaining on fallback renderer.',
      );
      this.webgpuDisabled = true;
      this.deviceLost = true;
      return;
    }

    // Destroy old entities and manager references
    for (const entity of entities) {
      entity.destroyGPUResources();
    }
    if (this.manager) {
      this.manager.destroy();
      this.manager = null;
    }

    const backoff = Math.pow(2, attempt) * 1000;
    if (this.recoveryTimerId) clearTimeout(this.recoveryTimerId);

    this.recoveryTimerId = setTimeout(() => {
      if (this.destroyed) return;

      this.initWebGPUContext(entities)
        .then((newDevice) => {
          if (this.destroyed) {
            newDevice.destroy();
            return;
          }
          console.log('Successfully recovered WebGPU device.');
          this.device = newDevice;
          this.deviceLost = false;

          const format = navigator.gpu.getPreferredCanvasFormat();
          if (Scene.webgpuManagerClass) {
            this.manager = new Scene.webgpuManagerClass(newDevice);
          } else if (this.particleBackend === 'webgpu') {
            throw new Error(
              'WebGPU particle manager is not registered. Please call Scene.registerWebGPUParticleSystemManager(WebGPUParticleSystemManager) first.',
            );
          }
          if (this.manager) {
            this.manager.initPipelines(format);

            for (const entity of entities) {
              this.manager.setupEntityResources(entity);
              // Re-upload particle fallback states
              if (entity.gpuStorageBuffer) {
                newDevice.queue.writeBuffer(entity.gpuStorageBuffer, 0, entity.particleData);
              }
            }
          }
        })
        .catch(() => this.recreateWebGPUDeviceWithRetry(entities, attempt + 1));
    }, backoff);
  }

  private renderCPUParticles(
    renderer: IRenderer,
    entity: ComputeParticleEntity,
    worldOpacity: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    worldScale: number,
    isSimilarityTransform: boolean,
  ): void {
    const data = entity.particleData;
    const size = entity.maxParticles;
    // The GL point layer takes world coordinates and a single radius, so it
    // can only represent the entity's transform when it is a similarity
    // (uniform scale, no shear). Anything else draws through the canvas
    // branch, which runs under the entity's own transform in local space.
    const useGL = renderer === this.renderer && !!this.pointRenderer && isSimilarityTransform;

    for (let i = 0; i < size; i++) {
      const idx = i * 8;
      const x = data[idx];
      const y = data[idx + 1];
      const pSize = data[idx + 6];
      const life = data[idx + 7];
      if (life === 0.0) continue; // dead

      const opacity = life < 0.0 ? worldOpacity : worldOpacity * Math.min(1.0, life);
      const scale = life >= 0.0 ? Math.min(1.0, life) : 1.0;
      if (useGL) {
        this.pointRenderer!.addCircle(
          a * x + c * y + e,
          b * x + d * y + f,
          pSize * scale * worldScale,
          entity.baseColor,
          opacity,
        );
      } else {
        renderer.fillCircle(x, y, pSize * scale, entity.baseColor, opacity);
      }
    }
  }

  private findHitRecursively(node: Entity, x: number, y: number): Entity | null {
    // Walk children in reverse order (drawn last/top-most first)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const hit = this.findHitRecursively(node.children[i], x, y);
      if (hit) return hit;
    }

    // If the node itself has isPointInside and is hit
    if (node.isPointInside && node.isPointInside(x, y)) {
      return node;
    }

    return null;
  }
}
