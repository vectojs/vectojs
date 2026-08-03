/**
 * Renderer abstraction consumed by every {@link Entity}.
 *
 * Implementations wrap a concrete drawing backend (Canvas 2D, WebGL, …) and
 * expose a path-based drawing API.  Entities must only depend on `IRenderer`
 * so they remain backend-agnostic.
 *
 * @example
 * // Inside an Entity.render() implementation:
 * render(r: IRenderer) {
 *   r.beginPath();
 *   r.fill('#38bdf8');
 * }
 */
/**
 * Per-backend draw counters, for a DevTools GPU readout.
 *
 * Opt-in via {@link IRenderer.setDrawCounters}: when off, counting compiles to a
 * single boolean test per op, matching how `Scene` gates its phase timing and
 * dirty tracking. Totals are cumulative until cleared rather than per-frame,
 * because a per-frame log answers the question less directly at far more memory —
 * the same reasoning `Scene.renderPhases` documents.
 */
export interface DrawCounters {
  /** `fill()` calls, each committing one path. */
  fills: number;
  /** `stroke()` calls. */
  strokes: number;
  /** `fillText()` calls. */
  texts: number;
  /** `drawImage`/`drawImageRect` blits. */
  images: number;
  /** `fillCircle()` calls — batched, so this exceeds the fills they produce. */
  circles: number;
  /** Batch commits from {@link IRenderer.flush}. */
  flushes: number;
  /** `save()` calls. */
  saves: number;
  /** `restore()` calls. */
  restores: number;
  /** `clip()` calls. */
  clips: number;
  /**
   * Times a font or fill style actually changed, as opposed to being re-set to
   * the value it already had.
   *
   * The renderer already elides redundant sets; this counts the ones that got
   * through, which is the number that costs anything.
   */
  stateSwitches: number;
  /**
   * Sum of drawn primitive areas divided by canvas area.
   *
   * A PROXY for overdraw, not a measurement: Canvas2D exposes no pixel-coverage
   * readback, so this counts area submitted, ignoring clipping and off-screen
   * rejection. It overstates, sometimes badly. Useful as a trend between two
   * states of the same scene; meaningless as an absolute.
   */
  overdrawRatio: number;
}

export interface IRenderer {
  /**
   * Stable backend identifier.
   *
   * A discriminator rather than `constructor.name`, which minifies to something
   * unusable in a production bundle — and a debug tool that cannot name the
   * backend in the build where it matters is not much of a debug tool.
   */
  readonly kind?: 'canvas2d' | 'svg' | 'three' | string;

  /**
   * Device pixels per CSS pixel of this renderer's backing store, i.e. the scale
   * already applied to the drawing context.
   *
   * Read this rather than `window.devicePixelRatio` when rasterizing pixels that
   * will be blitted into the renderer: the two differ whenever a backend clamps
   * (`CanvasRenderer.maxDPR`, `SceneOptions.maxDPR`), and rasterizing at the
   * window's ratio while the context is scaled to a clamped one blits a texture
   * the destination then resamples. A cache keyed on this value also stays
   * correct across a zoom or a monitor move, which a value captured once at
   * module scope cannot — that is the defect this exists to make fixable
   * (`GlyphRasterAtlas` consumers; see `Markdown`'s code atlas pool).
   *
   * Optional and a *live* read, not a snapshot: a backend that has no backing
   * store of its own omits it, and a caller treats the absence as `1`.
   */
  readonly pixelRatio?: number;

  /**
   * Enable or disable draw counting. Optional; a backend that cannot count omits
   * it and a reader treats the absence as "not available".
   */
  setDrawCounters?(enabled: boolean): void;
  /** Current counter totals, or null when counting is off. */
  getDrawCounters?(): DrawCounters | null;
  /** Zero the totals without disabling counting. */
  clearDrawCounters?(): void;

  /** Clear the entire drawing surface to transparent / background color. */
  clear(): void;
  /** Push the current transform + state onto the renderer's stack. */
  save(): void;
  /** Pop the last saved transform + state from the renderer's stack. */
  restore(): void;
  /**
   * Apply a translation to the current transform matrix.
   *
   * @param x - Horizontal offset in pixels.
   * @param y - Vertical offset in pixels.
   */
  translate(x: number, y: number): void;
  /**
   * Apply a scale to the current transform matrix.
   *
   * @param x - Horizontal scale factor.
   * @param y - Vertical scale factor.
   */
  scale(x: number, y: number): void;
  /**
   * Apply a clockwise rotation to the current transform matrix.
   *
   * @param angle - Rotation angle in radians.
   */
  rotate(angle: number): void;
  /**
   * Set the global opacity applied to all subsequent draw calls.
   *
   * @param alpha - Opacity in the range `[0, 1]`.
   */
  setGlobalAlpha(alpha: number): void;

  /**
   * Intersect the current clip region with a rectangle. Affects all subsequent
   * draws until the next {@link restore}; wrap in {@link save}/{@link restore}.
   *
   * @param x - Left edge.
   * @param y - Top edge.
   * @param width - Rectangle width.
   * @param height - Rectangle height.
   */
  clip(x: number, y: number, width: number, height: number): void;

  /** Begin a new sub-path, discarding the current path. */
  beginPath(): void;
  /**
   * Move the pen to the given point without drawing a line.
   *
   * @param x - Target X coordinate.
   * @param y - Target Y coordinate.
   */
  moveTo(x: number, y: number): void;
  /**
   * Add a straight line segment from the current pen position to the given point.
   *
   * @param x - Target X coordinate.
   * @param y - Target Y coordinate.
   */
  lineTo(x: number, y: number): void;
  /**
   * Add a cubic Bézier curve to the current path.
   *
   * @param cp1x - X of the first control point.
   * @param cp1y - Y of the first control point.
   * @param cp2x - X of the second control point.
   * @param cp2y - Y of the second control point.
   * @param x - X of the end point.
   * @param y - Y of the end point.
   */
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  /** Close the current sub-path by drawing a line back to its starting point. */
  closePath(): void;

  /**
   * Add a circular arc to the current path.
   *
   * @param x - X of the arc center.
   * @param y - Y of the arc center.
   * @param radius - Arc radius in pixels.
   * @param startAngle - Start angle in radians (0 = 3 o'clock).
   * @param endAngle - End angle in radians.
   * @param counterclockwise - If `true`, draws the arc counter-clockwise.
   */
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;

  /**
   * Add a rounded rectangle to the current path.
   *
   * @param x - Left edge.
   * @param y - Top edge.
   * @param width - Rectangle width.
   * @param height - Rectangle height.
   * @param radii - Corner radius (uniform) or per-corner array as accepted by `CanvasRenderingContext2D.roundRect()`.
   */
  roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void;

  /**
   * Draw an image or video frame into the canvas.
   *
   * @param source - The image source (HTMLImageElement, HTMLVideoElement, HTMLCanvasElement, etc.).
   * @param dx - Destination X.
   * @param dy - Destination Y.
   * @param dw - Destination width.
   * @param dh - Destination height.
   */
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;

  /**
   * Draw a sub-rectangle of an image source — the 9-argument `drawImage`.
   *
   * **Optional.** Callers must feature-detect and keep a fallback path:
   *
   * ```ts
   * if (r.drawImageRect) r.drawImageRect(atlas, sx, sy, sw, sh, dx, dy, dw, dh);
   * else r.fillText(glyph, x, baselineY, font, color);
   * ```
   *
   * This exists for texture atlases (see `GlyphRasterAtlas`), where selecting one slot
   * out of a shared canvas is what makes the blit cheap: a per-source-canvas
   * cache re-binds a different texture almost every call and measured *slower*
   * than the `fillText` it replaced on Chrome at scale, while atlas blits stay
   * flat and run ~2x faster on both engines.
   *
   * `SVGRenderer` deliberately omits it: an SVG image embeds its source as a data
   * URL, so a per-cell sub-rect would inline the entire atlas once per cell —
   * and vector text is the correct output for a vector export regardless.
   *
   * @param source - The image source.
   * @param sx - Source X, in source-image pixels.
   * @param sy - Source Y, in source-image pixels.
   * @param sw - Source width, in source-image pixels.
   * @param sh - Source height, in source-image pixels.
   * @param dx - Destination X.
   * @param dy - Destination Y.
   * @param dw - Destination width.
   * @param dh - Destination height.
   */
  drawImageRect?(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;

  /**
   * Fill the current path with the given color or gradient.
   *
   * @param colorOrGradient - CSS color string or a gradient object.
   */
  fill(colorOrGradient: string | any): void;
  /**
   * Stroke the current path with the given color or gradient.
   *
   * @param colorOrGradient - CSS color string or a gradient object.
   * @param lineWidth - Stroke width in pixels (default: `1`).
   */
  stroke(colorOrGradient: string | any, lineWidth?: number): void;
  /**
   * Render a text string at the given position.
   *
   * @param text - The string to draw.
   * @param x - Left edge of the text baseline.
   * @param y - Baseline Y coordinate.
   * @param font - CSS font shorthand, e.g. `'16px monospace'`.
   * @param color - CSS color string or gradient.
   */
  fillText(text: string, x: number, y: number, font: string, color: string | any): void;

  /**
   * Draw a filled circle through the order-preserving batch.
   *
   * Consecutive calls sharing the same `color` and `alpha` are coalesced into a
   * single path and committed with one `fill()` on {@link flush} (or when the
   * style changes / another draw call intervenes). Coordinates are in the
   * current transform space. This collapses the per-entity
   * `beginPath`/`arc`/`fill` of large point clouds into a handful of draw calls
   * while preserving painter's-order semantics.
   *
   * @param cx - Center X in the current transform space.
   * @param cy - Center Y in the current transform space.
   * @param radius - Circle radius.
   * @param color - CSS color string.
   * @param alpha - Opacity in `[0, 1]` (default `1`).
   */
  fillCircle(cx: number, cy: number, radius: number, color: string, alpha?: number): void;

  /**
   * Commit any pending batched draws (see {@link fillCircle}). Safe to call when
   * no batch is active (no-op). The {@link Scene} flushes at the end of each
   * sibling group and frame.
   */
  flush(): void;

  /**
   * Create a linear gradient between two points with the given color stops.
   *
   * @param x0 - X of the gradient start point.
   * @param y0 - Y of the gradient start point.
   * @param x1 - X of the gradient end point.
   * @param y1 - Y of the gradient end point.
   * @param colorStops - Array of `{ stop, color }` pairs where `stop` is in `[0, 1]`.
   * @returns An opaque gradient object suitable for {@link fill} or {@link stroke}.
   */
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): any;

  /**
   * Present the completed frame, called by {@link Scene} exactly once at the
   * end of each render pass (after the final {@link flush}). Retained-scene
   * backends (e.g. `@vectojs/three`) do their single real GL render here;
   * immediate-mode backends (Canvas2D, SVG) don't need it. Optional.
   */
  present?(): void;

  /**
   * Release any backend-owned GPU textures / GL contexts / caches.
   *
   * Called by {@link Scene.destroy()} so renderers that hold scarce resources
   * (e.g. a WebGL2 context — browsers cap concurrent contexts to ~16) clean up
   * before GC. Implementations MUST be idempotent: a second call after a
   * successful teardown must be a silent no-op, not throw.
   */
  dispose?(): void;

  /**
   * Whether the renderer's drawing context is currently lost (e.g. a Canvas2D
   * `contextlost` before its `contextrestored`, or a WebGL context loss). While
   * true the renderer's draw calls are no-ops and the owner should skip its
   * render pass. Optional — a renderer that can't lose its context omits it.
   */
  isContextLost?(): boolean;

  /**
   * Register a callback invoked after a lost context is restored and
   * re-initialized, so the owner can repaint (a restored canvas comes back
   * cleared). Optional, paired with {@link isContextLost}.
   */
  onContextRestored?(cb: () => void): void;
}

/**
 * Canvas2D style properties that have no equivalent on {@link IRenderer}, mapped
 * to the method to call instead.
 *
 * `IRenderer` is deliberately method-based: style travels *with* the draw call
 * (`stroke(color, width)`), which lets a batching backend coalesce runs and
 * gives a GPU backend a defined boundary. A mutable style *property* is
 * Canvas2D-specific statefulness that WebGL/WebGPU cannot honour cheaply, so
 * these are not going to be added.
 *
 * The failure mode is what makes this worth trapping: assigning one is not a
 * type error against a structural interface when the code is untranspiled JS,
 * it just attaches an expando, and the draw silently uses the context default.
 * Two `@vectojs` demos shipped that way — a bloom-intensity slider that moved
 * its halo metric by 1.07 instead of 17.0, and a panel rim that drew as a black
 * hairline instead of `rgba(255,255,255,0.25)` at 1.5px.
 */
const RENDERER_STYLE_PROPERTY_HINTS: Record<string, string> = {
  globalAlpha: 'setGlobalAlpha(alpha)',
  strokeStyle: 'stroke(color, lineWidth)',
  lineWidth: 'stroke(color, lineWidth)',
  fillStyle: 'fill(color) — or fillText(text, x, y, font, color)',
  font: 'fillText(text, x, y, font, color)',
  lineCap: 'stroke(color, lineWidth) (cap is backend-chosen)',
  lineJoin: 'stroke(color, lineWidth) (join is backend-chosen)',
  globalCompositeOperation: 'no equivalent — composite via a separate canvas',
  shadowBlur: 'no equivalent — draw the shadow explicitly',
  shadowColor: 'no equivalent — draw the shadow explicitly',
  textAlign: 'no equivalent — measure and offset x yourself',
  textBaseline: 'no equivalent — measure and offset y yourself',
};

/**
 * Whether dev-mode renderer diagnostics are active.
 *
 * This lives here rather than being read from `Scene` because the dependency
 * runs `Scene → renderer`: a renderer importing `Scene` would close a cycle.
 * `Scene` publishes its own dev state here via {@link setRendererDevMode} as
 * part of construction, so `Scene.devMode`, `globalThis.__DEV__`, and
 * `NODE_ENV=development` all reach the renderer without an import.
 */
let rendererDevMode = false;

/**
 * Publish dev-mode state to the renderer layer. Called by `Scene`; also usable
 * directly when a renderer is constructed without one.
 */
export function setRendererDevMode(active: boolean): void {
  rendererDevMode = active;
}

/** Whether renderer dev diagnostics are currently enabled. */
export function isRendererDevMode(): boolean {
  if (rendererDevMode) return true;
  const g = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
  if (g?.__DEV__) return true;
  return g?.process?.env?.NODE_ENV === 'development';
}

/**
 * Install dev-mode-only accessors that warn when Canvas2D style *properties* are
 * assigned on a renderer instead of calling the corresponding method.
 *
 * Call once per renderer instance, from its constructor. No-ops outside dev
 * mode, so the accessors never exist in production.
 * Each trapped property warns on its **first** write only — a per-frame
 * assignment would otherwise flood the console at 240fps — and then stores and
 * returns the value like a plain field, so a warned write is never a hard break
 * for code that assigns and reads back.
 *
 * Skips any property the instance genuinely defines, so a backend that really
 * does expose one keeps its own behavior.
 */
export function installRendererDevTraps(renderer: object, label: string): void {
  if (!isRendererDevMode()) return;
  for (const [prop, hint] of Object.entries(RENDERER_STYLE_PROPERTY_HINTS)) {
    if (prop in renderer) continue;
    let stored: unknown;
    let warned = false;
    Object.defineProperty(renderer, prop, {
      configurable: true,
      enumerable: false,
      get: () => stored,
      set: (value: unknown) => {
        stored = value;
        if (warned) return;
        warned = true;
        console.warn(
          `[vectojs/dev] \`${prop}\` is not a renderer property — assigning it on ` +
            `${label} has no effect on what is drawn. Call \`${hint}\` instead.`,
        );
      },
    });
  }
}
