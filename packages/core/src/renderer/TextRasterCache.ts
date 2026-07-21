/**
 * A cache of pre-rasterized text runs, so a scene that draws the *same short
 * strings* thousands of times per frame pays the Canvas2D text cost once per
 * unique run instead of once per draw.
 *
 * ## Why
 *
 * `ctx.fillText()` is deceptively expensive at scale: each call re-shapes the
 * string, re-parses the CSS `fillStyle` color, and rasterizes glyphs on the CPU
 * main thread. When a view draws thousands of independently-positioned text
 * runs per frame (danmaku/barrage, chat/log tails, data-grid cells, particle
 * labels), that per-call shaping dominates the frame — a CPU profile shows the
 * main thread pegged in native (`(program)`) code while the GPU sits idle,
 * because the GPU can't be fed fast enough.
 *
 * This cache rasterizes each distinct `(font, color, text)` run to a small
 * offscreen canvas exactly once. Every subsequent frame the caller blits it
 * with a single {@link IRenderer.drawImage}, turning CPU text shaping into a
 * GPU-friendly bitmap copy. When the set of distinct runs is bounded (a fixed
 * phrase library, a small palette, a handful of font sizes) the steady-state
 * hit rate approaches 100%; an insertion-order eviction cap bounds memory
 * against unbounded (e.g. user-typed) content.
 *
 * It does **not** replace `fillText` for large or highly-varied text — the win
 * comes from *reuse*. Emoji and color glyphs rasterize fine (they're baked into
 * the bitmap), but a run that's only ever drawn once is pure overhead.
 *
 * ## Use
 *
 * ```ts
 * const cache = new TextRasterCache();
 * // in the frame loop, per text run:
 * const r = cache.get('600 24px system-ui', '#38bdf8', label);
 * if (r) renderer.drawImage(r.canvas, x - r.offsetX, baselineY - r.offsetY, r.width, r.height);
 * else renderer.fillText(label, x, baselineY, '600 24px system-ui', '#38bdf8'); // headless fallback
 * ```
 *
 * The blit position mirrors the `fillText` baseline: pass the glyph origin `x`
 * and the text baseline `y`, then subtract the raster's `offsetX`/`offsetY`.
 */

/** A rasterized text run plus the offsets needed to blit it at a baseline. */
export interface TextRaster {
  /** The offscreen canvas holding the rasterized run. */
  canvas: HTMLCanvasElement;
  /** Blit destination width in CSS pixels. */
  width: number;
  /** Blit destination height in CSS pixels. */
  height: number;
  /** Left inset (CSS px) of the glyph origin inside the canvas. */
  offsetX: number;
  /** Distance (CSS px) from the canvas top down to the text baseline. */
  offsetY: number;
}

/** Instrumentation counters for the cache (e.g. to surface a HUD hit rate). */
export interface TextRasterStats {
  /** Requests served from an existing raster. */
  hits: number;
  /** Requests that had to rasterize a new run. */
  misses: number;
  /** Current number of cached rasters. */
  size: number;
}

/** Options for {@link TextRasterCache}. */
export interface TextRasterCacheOptions {
  /**
   * Hard cap on cached rasters. On overflow the oldest ~10% (insertion order,
   * which `Map` preserves) are evicted; evicted runs are re-rasterized cheaply
   * on their next miss. Default `4096`.
   */
  maxEntries?: number;
  /**
   * Device-pixel-ratio the rasters are rendered at. `> 1` keeps text crisp on
   * HiDPI displays at the cost of larger bitmaps; the returned `width`/`height`
   * stay in CSS pixels so the blit is unchanged. Default `1`.
   */
  dpr?: number;
}

/**
 * An isolated text-raster cache. Create one per renderer/scene (instances don't
 * share state, so multiple scenes or an SSR pass never collide).
 */
export class TextRasterCache {
  private readonly cache = new Map<string, TextRaster>();
  private readonly maxEntries: number;
  private readonly dpr: number;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  private _hits = 0;
  private _misses = 0;

  constructor(options: TextRasterCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 4096);
    this.dpr = Math.max(1, options.dpr ?? 1);
  }

  /** Live instrumentation snapshot. */
  get stats(): TextRasterStats {
    return { hits: this._hits, misses: this._misses, size: this.cache.size };
  }

  private measureCtx(): CanvasRenderingContext2D | null {
    if (!this.scratchCtx) {
      if (typeof document === 'undefined') return null;
      this.scratchCtx = document.createElement('canvas').getContext('2d');
    }
    return this.scratchCtx;
  }

  /**
   * Return the cached raster for a text run, rasterizing it on first request.
   *
   * @param font - Full CSS `font` shorthand, used for both measuring and painting.
   * @param color - CSS color baked into the raster.
   * @param text - The run to rasterize (may contain CJK / emoji).
   * @returns The raster, or `null` in a non-DOM/headless context (caller should
   *   fall back to {@link IRenderer.fillText}).
   */
  get(font: string, color: string, text: string): TextRaster | null {
    const key = font + '\u0000' + color + '\u0000' + text;
    const hit = this.cache.get(key);
    if (hit) {
      this._hits++;
      return hit;
    }
    this._misses++;

    const m = this.measureCtx();
    if (!m) return null;
    m.font = font;
    const metrics = m.measureText(text);

    // Prefer true glyph metrics (they cover emoji / ascender / descender
    // overshoot); fall back to font-relative estimates on engines that omit
    // them. `fontBoundingBox*` is the most reliable fallback; then a fraction
    // of the measured width as a last resort.
    const approx = metrics.width || text.length * 8;
    const ascent = metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || approx * 0.8;
    const descent =
      metrics.actualBoundingBoxDescent || metrics.fontBoundingBoxDescent || approx * 0.2;
    const left = metrics.actualBoundingBoxLeft || 0;
    const right = metrics.actualBoundingBoxRight || metrics.width;
    const pad = 2; // antialias bleed guard

    const offsetX = Math.ceil(left) + pad;
    const offsetY = Math.ceil(ascent) + pad;
    const width = offsetX + Math.ceil(right) + pad;
    const height = offsetY + Math.ceil(descent) + pad;

    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const dpr = this.dpr;
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (dpr !== 1) ctx.scale(dpr, dpr);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(text, offsetX, offsetY);

    const raster: TextRaster = { canvas, width, height, offsetX, offsetY };

    if (this.cache.size >= this.maxEntries) {
      let toDrop = Math.ceil(this.maxEntries * 0.1);
      for (const k of this.cache.keys()) {
        this.cache.delete(k);
        if (--toDrop <= 0) break;
      }
    }
    this.cache.set(key, raster);
    return raster;
  }

  /** Drop all cached rasters and reset instrumentation. */
  clear(): void {
    this.cache.clear();
    this._hits = 0;
    this._misses = 0;
  }
}
