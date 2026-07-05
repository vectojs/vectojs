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
export interface IRenderer {
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
   * Release any backend-owned GPU textures / GL contexts / caches.
   *
   * Called by {@link Scene.destroy()} so renderers that hold scarce resources
   * (e.g. a WebGL2 context — browsers cap concurrent contexts to ~16) clean up
   * before GC. Implementations MUST be idempotent: a second call after a
   * successful teardown must be a silent no-op, not throw.
   */
  dispose?(): void;
}
