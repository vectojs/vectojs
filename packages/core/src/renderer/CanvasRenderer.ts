import { type DrawCounters, installRendererDevTraps, IRenderer } from './IRenderer';

/** A zeroed counter set. `overdrawRatio` is derived on read, so it starts at 0. */
function emptyDrawCounters(): DrawCounters {
  return {
    fills: 0,
    strokes: 0,
    texts: 0,
    images: 0,
    circles: 0,
    flushes: 0,
    saves: 0,
    restores: 0,
    clips: 0,
    stateSwitches: 0,
    overdrawRatio: 0,
  };
}

/**
 * Canvas 2D implementation of {@link IRenderer}.
 *
 * Wraps a `CanvasRenderingContext2D`, applies HiDPI (`devicePixelRatio`)
 * scaling on construction, and delegates every path/fill/stroke call to the
 * native 2D API.  Used internally by {@link Scene}; obtain a reference via
 * `scene.getRenderer()` when direct access is needed.
 *
 * @example
 * const renderer = new CanvasRenderer(document.querySelector('canvas')!);
 * renderer.clear();
 * renderer.beginPath();
 * renderer.fill('#38bdf8');
 */
const TWO_PI = Math.PI * 2;

/** Device pixel ratio, or `1` in non-DOM (SSR/Node) environments. */
function getDevicePixelRatio(): number {
  const raw =
    typeof window !== 'undefined'
      ? (window as unknown as { devicePixelRatio?: number }).devicePixelRatio
      : 1;
  return Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 1;
}

export class CanvasRenderer implements IRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private canvas: HTMLCanvasElement;
  /** True between a `contextlost` and its `contextrestored` — the 2D context is
   *  unusable, so draw calls are skipped until it comes back. Canvas2D context
   *  loss is rare (GPU reset / memory pressure) but a real browser event. */
  private contextLost = false;
  /** Invoked after the context is restored + re-initialized, so the owner
   *  (`Scene`) can repaint the now-blank canvas. Set via {@link onContextRestored}. */
  private contextRestoredCb: (() => void) | null = null;

  /**
   * Cap on the effective device pixel ratio applied by the constructor and
   * {@link resize}. `undefined` (default) uses the real, uncapped
   * `devicePixelRatio` — unchanged from prior versions. Set directly, or via
   * the constructor's third argument; `Scene` (see `SceneOptions.maxDPR`)
   * keeps this in sync on every {@link resize} call, since the real DPR can
   * change at runtime (e.g. a window dragged between displays).
   */
  public maxDPR?: number;

  /**
   * The ratio the context is actually scaled by, i.e. the last value the
   * constructor or {@link resize} applied. Backs {@link pixelRatio}; see there
   * for why this is recorded rather than recomputed on read.
   */
  private appliedDPR = 1;

  /**
   * Max circles per batched `fill()`. A single Canvas 2D `fill()` over a path is
   * superlinear in sub-path count, so an unbounded batch is *slower* than many
   * small fills at high entity counts. Capping bounds each fill's path
   * complexity while still amortizing per-draw overhead. Tuned via the benchmark.
   */
  static readonly MAX_BATCH = 64;

  // Order-preserving batch state for fillCircle(): a run of same-style circles
  // accumulates into one path and is committed by a single fill() on flush().
  private batchActive: boolean = false;
  private batchColor: string = '';
  private batchAlpha: number = 1;
  private batchCount: number = 0;

  private _cachedFont: string = '';
  private _cachedFill: string = '';
  // Stroke-side counterparts of the fill/font caches, read by stroke()'s
  // style-elision branch. Reset wherever the context state can change behind
  // our back: restore(), resize(), contextrestored, dispose().
  private _cachedStroke: string = '';
  private _cachedLineWidth: number = -1;
  private _cachedLineCap: string = '';
  private _cachedLineJoin: string = '';
  // Context-loss listeners, held for removal in dispose() so a canvas that
  // outlives the renderer cannot retain it through these closures.
  private _onContextLost?: (e: Event) => void;
  private _onContextRestored?: () => void;

  /** Backend discriminator; see {@link IRenderer.kind}. */
  public readonly kind = 'canvas2d';

  /**
   * Draw counters, allocated only once counting is enabled.
   *
   * Null when off, so the guard on every op is a single null test and an inactive
   * renderer carries no counter object at all.
   */
  private counters: DrawCounters | null = null;
  /** Accumulated primitive area, kept separately so the ratio is derived on read. */
  private drawnArea = 0;

  /**
   * @param canvas - The target canvas. Its backing store is resized to the
   *   logical size × devicePixelRatio.
   * @param size - Explicit logical size. Without it the renderer assumes a
   *   fullscreen canvas and sizes to the window — pass this for embedded /
   *   custom-container canvases (the Scene does when `disableWindowResize` is
   *   set) so the canvas's own dimensions aren't clobbered by the window's.
   * @param maxDPR - See {@link maxDPR}.
   */
  constructor(
    canvas: HTMLCanvasElement,
    size?: { width: number; height: number },
    maxDPR?: number,
  ) {
    this.maxDPR = maxDPR;
    const dpr = this.effectiveDPR();
    this.appliedDPR = dpr;
    // Fall back to the canvas's own size in SSR/Node where there is no window.
    this.width =
      size?.width ?? (typeof window !== 'undefined' ? window.innerWidth : canvas.width || 0);
    this.height =
      size?.height ?? (typeof window !== 'undefined' ? window.innerHeight : canvas.height || 0);

    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    // Record the logical size as CSS size (same as resize() does): on HiDPI
    // the canvas would otherwise *display* at the backing-store size, and a
    // remounted Scene needs the logical size to survive somewhere readable —
    // canvas.width now holds the DPR-scaled value.
    if (canvas.style) {
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
    }

    // getContext may be absent/return null in a headless canvas; stay constructible.
    const ctx = canvas.getContext('2d');
    this.ctx = ctx as CanvasRenderingContext2D;
    if (ctx) ctx.scale(dpr, dpr);
    this.canvas = canvas;
    this.setupContextLossRecovery();
    installRendererDevTraps(this, 'CanvasRenderer');
  }

  /** Register a callback fired after a lost 2D context is restored + re-scaled,
   *  so the owner can repaint (the restored canvas comes back cleared). */
  public onContextRestored(cb: () => void): void {
    this.contextRestoredCb = cb;
  }

  /**
   * Handle Canvas2D context loss/restore (GPU reset, memory pressure). The
   * `contextlost` handler MUST call `preventDefault()` or the browser never
   * fires `contextrestored`; while lost, draw calls are skipped. On restore we
   * re-acquire the 2D context, re-apply the DPR scale, drop cached style, and
   * notify the owner to repaint.
   */
  private setupContextLossRecovery(): void {
    if (typeof this.canvas.addEventListener !== 'function') return;
    // Kept as fields so dispose() can remove them: a canvas outliving the
    // renderer would otherwise retain it via these closures, and a post-dispose
    // `contextrestored` would re-acquire a context and fire callbacks on a
    // disposed object.
    this._onContextLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
    };
    this._onContextRestored = () => {
      const ctx = this.canvas.getContext('2d');
      if (!ctx) return;
      this.ctx = ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Recorded, not just applied: this is a third site that sets the context
      // scale, and leaving `appliedDPR` behind here would make `pixelRatio` lie
      // after a GPU reset that happened across a zoom.
      const restoredDPR = this.effectiveDPR();
      this.appliedDPR = restoredDPR;
      ctx.scale(restoredDPR, restoredDPR);
      this._cachedFont = '';
      this._cachedFill = '';
      this._cachedStroke = '';
      this._cachedLineWidth = -1;
      this._cachedLineCap = '';
      this._cachedLineJoin = '';
      this.batchActive = false;
      this.batchCount = 0;
      this.contextLost = false;
      this.contextRestoredCb?.();
    };
    this.canvas.addEventListener('contextlost', this._onContextLost);
    this.canvas.addEventListener('contextrestored', this._onContextRestored);
  }

  /**
   * Expose the underlying `CanvasRenderingContext2D` for operations not
   * covered by the {@link IRenderer} interface.
   *
   * @returns The raw 2D rendering context.
   */
  public getContext() {
    return this.ctx;
  }

  /** Real `devicePixelRatio`, clamped to {@link maxDPR} when set. */
  private effectiveDPR(): number {
    const real = getDevicePixelRatio();
    if (this.maxDPR === undefined) return real;
    // Guard NaN/Infinity maxDPR (externally assignable) — treat as uncapped
    if (!Number.isFinite(this.maxDPR) || this.maxDPR <= 0) return real;
    return Math.min(real, this.maxDPR);
  }

  /**
   * @inheritdoc
   *
   * The ratio the context is **currently scaled by**, recorded by the constructor
   * and {@link resize} — deliberately not a live `effectiveDPR()` call.
   *
   * The distinction is load-bearing rather than pedantic. `devicePixelRatio`
   * changes the instant a zoom lands, but the backing store is only reallocated
   * when something calls {@link resize} (in a `Scene`, the `(resolution: Ndppx)`
   * media query). A live getter therefore reports the *future* ratio during that
   * window, and a caller rasterizing pixels from it produces a texture that the
   * still-old context scale resamples — the same defect this property exists to
   * let callers avoid, merely inverted. Reporting the applied ratio means a
   * cache keyed on it is always consistent with the pixels it is blitted into,
   * and it simply re-keys on the next `resize`.
   */
  public get pixelRatio(): number {
    return this.appliedDPR;
  }

  /**
   * Resize the backing canvas buffer and re-apply DPR scaling.
   *
   * Called automatically by {@link Scene} on `window.resize` events.
   *
   * @param width - New logical width in CSS pixels.
   * @param height - New logical height in CSS pixels.
   */
  public resize(width: number, height: number): void {
    const dpr = this.effectiveDPR();
    // Guard against non-finite dimensions (caller should have validated, but
    // DPR-scaled product can still overflow to Infinity).
    const safeWidth = Number.isFinite(width) && width >= 0 ? width : this.width;
    const safeHeight = Number.isFinite(height) && height >= 0 ? height : this.height;
    const backingW = Number.isFinite(safeWidth * dpr)
      ? Math.max(1, Math.round(safeWidth * dpr))
      : 1;
    const backingH = Number.isFinite(safeHeight * dpr)
      ? Math.max(1, Math.round(safeHeight * dpr))
      : 1;
    this.appliedDPR = dpr;
    this.width = safeWidth;
    this.height = safeHeight;
    this.ctx.canvas.width = backingW;
    this.ctx.canvas.height = backingH;
    // Sync CSS size so the logical and physical sizes match on HiDPI screens.
    // Guarded like the constructor for SSR/stubbed canvases where a 2D context
    // exists but `style` does not.
    if (this.ctx.canvas.style) {
      this.ctx.canvas.style.width = `${safeWidth}px`;
      this.ctx.canvas.style.height = `${safeHeight}px`;
    }
    this.ctx.scale(dpr, dpr);
    // Setting `canvas.width`/`canvas.height` resets the whole 2D context state
    // per spec (font → 10px sans-serif, fillStyle → #000000). Drop the caches so
    // the next draw re-applies them; otherwise a draw using the same font/color
    // string as the cache skips the assignment and paints with the reset
    // defaults — the same reset `contextrestored` performs for a lost context.
    this._cachedFont = '';
    this._cachedFill = '';
    this._cachedStroke = '';
    this._cachedLineWidth = -1;
    this._cachedLineCap = '';
    this._cachedLineJoin = '';
    this.batchActive = false;
    this.batchCount = 0;
  }

  /** Whether the 2D context is currently lost (drawing is a no-op until it is
   *  restored). The owner skips its render pass while this is true. */
  public isContextLost(): boolean {
    return this.contextLost;
  }

  /** @inheritdoc */
  /** @inheritdoc */
  setDrawCounters(enabled: boolean): void {
    if (!enabled) {
      this.counters = null;
      this.drawnArea = 0;
      return;
    }
    if (!this.counters) this.counters = emptyDrawCounters();
  }

  /** @inheritdoc */
  getDrawCounters(): DrawCounters | null {
    if (!this.counters) return null;
    const area = this.width * this.height;
    return {
      ...this.counters,
      // Derived on read rather than maintained: the ratio is only meaningful
      // against the current surface size, which can change under resize.
      overdrawRatio: area > 0 ? Math.round((this.drawnArea / area) * 100) / 100 : 0,
    };
  }

  /** @inheritdoc */
  clearDrawCounters(): void {
    if (this.counters) this.counters = emptyDrawCounters();
    this.drawnArea = 0;
  }

  clear(): void {
    if (this.contextLost) return; // context gone → nothing to clear/draw
    this.flush();
    if (this.counters) this.drawnArea = 0;
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
  /** @inheritdoc */
  save(): void {
    this.flush();
    if (this.counters) this.counters.saves++;
    this.ctx.save();
  }
  /** @inheritdoc */
  restore(): void {
    this.flush();
    if (this.counters) this.counters.restores++;
    this.ctx.restore();
    this._cachedFont = '';
    this._cachedFill = '';
    this._cachedStroke = '';
    this._cachedLineWidth = -1;
    this._cachedLineCap = '';
    this._cachedLineJoin = '';
  }
  /** @inheritdoc */
  translate(x: number, y: number): void {
    this.ctx.translate(x, y);
  }
  /** @inheritdoc */
  scale(x: number, y: number): void {
    this.ctx.scale(x, y);
  }
  /** @inheritdoc */
  rotate(angle: number): void {
    this.ctx.rotate(angle);
  }
  /** @inheritdoc */
  setGlobalAlpha(alpha: number): void {
    this.ctx.globalAlpha = alpha;
  }

  /** @inheritdoc */
  clip(x: number, y: number, width: number, height: number, radii?: number | number[]): void {
    this.flush();
    if (this.counters) this.counters.clips++;
    this.ctx.beginPath();
    if (radii !== undefined) {
      this.ctx.roundRect(x, y, width, height, radii as any);
    } else {
      this.ctx.rect(x, y, width, height);
    }
    this.ctx.clip();
  }

  /** @inheritdoc */
  beginPath(): void {
    this.flush();
    this.ctx.beginPath();
  }
  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
  /** @inheritdoc */
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  /** @inheritdoc */
  closePath(): void {
    this.ctx.closePath();
  }

  /** @inheritdoc */
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  /** @inheritdoc */
  roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void {
    this.ctx.roundRect(x, y, width, height, radii as any);
  }

  /** @inheritdoc */
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.flush();
    if (this.counters) {
      this.counters.images++;
      this.drawnArea += Math.abs(dw * dh);
    }
    this.ctx.drawImage(source, dx, dy, dw, dh);
  }

  /** @inheritdoc */
  drawImageRect(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    // Flush for the same reason `drawImage` does: a pending batch must not paint
    // over a blit that was issued before it.
    this.flush();
    if (this.counters) {
      this.counters.images++;
      this.drawnArea += Math.abs(dw * dh);
    }
    this.ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  /** @inheritdoc */
  fillCircle(cx: number, cy: number, radius: number, color: string, alpha: number = 1): void {
    if (this.batchActive && (color !== this.batchColor || alpha !== this.batchAlpha)) {
      this.flush();
    }
    if (!this.batchActive) {
      this.ctx.beginPath();
      this.batchActive = true;
      this.batchColor = color;
      this.batchAlpha = alpha;
    }
    if (this.counters) {
      this.counters.circles++;
      this.drawnArea += Math.PI * radius * radius;
    }
    // moveTo before arc starts a fresh sub-path so circles don't connect.
    this.ctx.moveTo(cx + radius, cy);
    this.ctx.arc(cx, cy, radius, 0, TWO_PI);
    this.batchCount++;
    if (this.batchCount >= CanvasRenderer.MAX_BATCH) this.flush();
  }

  /** @inheritdoc */
  flush(): void {
    if (!this.batchActive) return;
    if (this.counters) this.counters.flushes++;
    // The caller's alpha (the render walk's `setGlobalAlpha(worldOpacity)`)
    // must survive the batch: capture it rather than forcing 1 afterwards.
    const prevAlpha = this.ctx.globalAlpha;
    this.ctx.globalAlpha = this.batchAlpha;
    this.ctx.fillStyle = this.batchColor;
    this.ctx.fill();
    this.ctx.globalAlpha = prevAlpha;
    // The context now holds the batch color; without updating the cache a
    // following draw of the previously cached color would skip its assignment
    // and paint with the batch color instead.
    this._cachedFill = this.batchColor;
    this.batchActive = false;
    this.batchCount = 0;
  }

  /** @inheritdoc */
  fill(color: string | any): void {
    this.flush();
    if (this.counters) this.counters.fills++;
    if (this._cachedFill !== color) {
      // Counted here rather than at every assignment: this branch is exactly the
      // set that was not elided, which is the one that costs something.
      if (this.counters) this.counters.stateSwitches++;
      this.ctx.fillStyle = color;
      this._cachedFill = color;
    }
    this.ctx.fill();
  }

  /** @inheritdoc */
  stroke(color: string | any, lineWidth: number = 1): void {
    this.flush();
    if (this.counters) this.counters.strokes++;
    // Style-elision pattern, same as fill()/fillText(): assign only on a real
    // switch and count the switches that were not elided. lineCap/lineJoin are
    // constants today but cached anyway so a future change to them cannot
    // silently regress into per-call assignment.
    if (
      this._cachedStroke !== color ||
      this._cachedLineWidth !== lineWidth ||
      this._cachedLineCap !== 'round' ||
      this._cachedLineJoin !== 'round'
    ) {
      if (this.counters) this.counters.stateSwitches++;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = lineWidth;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this._cachedStroke = color;
      this._cachedLineWidth = lineWidth;
      this._cachedLineCap = 'round';
      this._cachedLineJoin = 'round';
    }
    this.ctx.stroke();
  }

  /** @inheritdoc */
  fillText(text: string, x: number, y: number, font: string, color: string | any): void {
    this.flush();
    if (this.counters) this.counters.texts++;
    if (this._cachedFont !== font) {
      if (this.counters) this.counters.stateSwitches++;
      this.ctx.font = font;
      this._cachedFont = font;
    }
    if (this._cachedFill !== color) {
      if (this.counters) this.counters.stateSwitches++;
      this.ctx.fillStyle = color;
      this._cachedFill = color;
    }
    this.ctx.fillText(text, x, y);
  }

  /** @inheritdoc */
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): any {
    const grad = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const cs of colorStops) {
      grad.addColorStop(cs.stop, cs.color);
    }
    return grad;
  }

  /**
   * Canvas2D drawing contexts are automatically released when their
   * `<canvas>` element is GC'd, so there's no explicit GPU handle to free.
   * This method clears our internal batch state and is idempotent.
   */
  public dispose(): void {
    this.batchCount = 0;
    this.batchColor = '';
    this.batchAlpha = 1;
    this.batchActive = false;
    this._cachedFont = '';
    this._cachedFill = '';
    this._cachedStroke = '';
    this._cachedLineWidth = -1;
    this._cachedLineCap = '';
    this._cachedLineJoin = '';
    // Drop the context-loss listeners: a canvas outliving the renderer would
    // otherwise retain it, and a post-dispose `contextrestored` would
    // re-acquire a context and fire callbacks on a disposed object.
    if (typeof this.canvas.removeEventListener === 'function') {
      if (this._onContextLost) this.canvas.removeEventListener('contextlost', this._onContextLost);
      if (this._onContextRestored)
        this.canvas.removeEventListener('contextrestored', this._onContextRestored);
    }
    this._onContextLost = undefined;
    this._onContextRestored = undefined;
  }
}
