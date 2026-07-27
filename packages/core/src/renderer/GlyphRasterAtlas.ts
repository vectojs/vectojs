/**
 * A texture atlas of rasterized glyphs, for grids that draw the *same small set
 * of glyphs* thousands of times per frame.
 *
 * Named `GlyphRasterAtlas` rather than `GlyphAtlas` because `@vectojs/layout`
 * already exports a `GlyphAtlas` interface — a map of grapheme to *vector* path
 * metrics — and the core barrel re-exports that package, so the shorter name is a
 * hard collision. The distinction is also worth keeping: that one holds path data
 * for measuring, this one holds pixels for blitting.
 *
 * ## Why this exists alongside {@link TextRasterCache}
 *
 * Both replace per-cell `fillText` with a bitmap blit. The difference is where
 * the pixels live, and measurement says that difference decides whether the idea
 * works at all.
 *
 * `TextRasterCache` allocates **one canvas per cached run**. A warm cache for a
 * syntax-highlighted code grid holds a few hundred of them (glyphs x theme
 * colours), so a frame blits from a few hundred distinct source textures and the
 * GPU re-binds on nearly every call. Measured on real hardware, that per-source
 * cost is invisible at 2k cells and dominant at 40k: Chrome went 1.82x at 2k to
 * **0.87x at 40k** — slower than the `fillText` it replaced. Its per-call cost
 * grows with cell count (1.22 -> 2.89 us) rather than staying flat.
 *
 * This atlas keeps every glyph in **one** canvas and selects with a source rect,
 * so the source texture never changes. Same call count, same pixels, same
 * geometry — and per-call cost is flat as the grid grows (Chrome 1.10 -> 1.11
 * us), giving **1.90-2.27x over `fillText` on both engines at every size**.
 * Full data: `vectojs-docs/forge/baselines/raster-cache-findings.md`.
 *
 * The win comes from *reuse*, so this is for bounded glyph sets: a monospace code
 * grid, a terminal, a data grid, a numeric HUD. Prose is the wrong customer —
 * every run is distinct, so an atlas is pure overhead (use `RichText`'s coalesced
 * runs there instead).
 *
 * ## Requires a source-rect blit
 *
 * Selecting one slot needs {@link IRenderer.drawImageRect}, which is optional:
 * `CanvasRenderer` implements it, `SVGRenderer` deliberately does not (an SVG
 * blit embeds its source as a data URL, so a per-cell sub-rect would inline the
 * whole atlas thousands of times — and vector text is the correct output for a
 * vector export anyway). Callers must keep their `fillText` path for renderers
 * that lack it:
 *
 * ```ts
 * const slot = atlas.get(font, color, glyph);
 * if (slot && r.drawImageRect) {
 *   r.drawImageRect(atlas.source, slot.sx, slot.sy, slot.sw, slot.sh,
 *                   x - slot.offsetX, baselineY - slot.offsetY, slot.w, slot.h);
 * } else {
 *   r.fillText(glyph, x, baselineY, font, color);
 * }
 * ```
 */

/** Where one glyph lives in the atlas, and how to blit it at a baseline. */
export interface GlyphSlot {
  /** Source X in atlas *device* pixels. */
  sx: number;
  /** Source Y in atlas *device* pixels. */
  sy: number;
  /** Source width in atlas *device* pixels. */
  sw: number;
  /** Source height in atlas *device* pixels. */
  sh: number;
  /** Destination width in CSS pixels. */
  w: number;
  /** Destination height in CSS pixels. */
  h: number;
  /** Left inset (CSS px) of the glyph origin inside the slot. */
  offsetX: number;
  /** Distance (CSS px) from the slot top down to the text baseline. */
  offsetY: number;
  /** The cluster these pixels represent. */
  glyph: string;
  /** The CSS font shorthand these pixels were rasterized with. */
  font: string;
  /** Advance width (CSS px) of the cluster, i.e. `measureText().width`. */
  advance: number;
  /**
   * Ink extent left of the glyph origin (CSS px), from `actualBoundingBoxLeft`.
   *
   * Carried on the slot so a blit can be mapped back to the same geometry a
   * `fillText` would have produced. Without it, instrumentation that traces draw
   * calls to verify grid positioning (`e2e/text-projection.e2e.ts`) can see only
   * a destination rect and cannot recover where the glyph origin sat inside it.
   */
  left: number;
  /** Ink extent right of the glyph origin (CSS px), from `actualBoundingBoxRight`. */
  right: number;
}

/** Instrumentation counters, e.g. to surface a HUD hit rate. */
export interface GlyphRasterAtlasStats {
  /** Requests served from an existing slot. */
  hits: number;
  /** Requests that had to rasterize. */
  misses: number;
  /** Glyphs currently resident. */
  size: number;
  /**
   * Times the atlas filled up and was reset.
   *
   * Steady-state thrash means the glyph set is unbounded for the configured
   * size, and the atlas is doing net harm — every reset re-rasterizes everything.
   * A caller that watches this can fall back to `fillText` permanently.
   */
  resets: number;
}

/** Options for {@link GlyphRasterAtlas}. */
export interface GlyphRasterAtlasOptions {
  /**
   * Device-pixel-ratio to rasterize at. Slots record device pixels while `w`/`h`
   * stay in CSS pixels, so the blit is DPR-correct without caller arithmetic.
   * Default `1`.
   */
  dpr?: number;
  /**
   * Max atlas edge in device pixels, capped at 8192 — comfortably inside the
   * lowest common `maxTextureSize` while leaving room for thousands of glyphs.
   * Exceeding a browser's real limit yields a silently blank canvas, so this is
   * clamped rather than trusted. Default `2048`.
   */
  maxSize?: number;
}

/** Largest atlas edge permitted, in device pixels. */
const HARD_MAX_SIZE = 8192;
/** Transparent-pixel guard between slots, so a blit cannot sample its neighbour. */
const PAD = 2;

/**
 * A glyph atlas. Create one per renderer/scene — instances share no state, so
 * multiple scenes or an SSR pass never collide.
 */
export class GlyphRasterAtlas {
  private readonly slots = new Map<string, GlyphSlot | null>();
  private readonly dpr: number;
  private readonly maxSize: number;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  /**
   * Shelf packing: glyphs land left-to-right on a row, then a new row starts.
   * A monospace grid produces near-uniform widths, so shelves waste very little
   * and cost one comparison per insert — a real 2D packer would buy nothing here.
   */
  private penX = PAD;
  private penY = PAD;
  private rowHeight = 0;

  private _hits = 0;
  private _misses = 0;
  private _resets = 0;

  constructor(options: GlyphRasterAtlasOptions = {}) {
    this.dpr = Math.max(1, options.dpr ?? 1);
    this.maxSize = Math.min(HARD_MAX_SIZE, Math.max(256, options.maxSize ?? 2048));
  }

  /** Live instrumentation snapshot. */
  get stats(): GlyphRasterAtlasStats {
    return {
      hits: this._hits,
      misses: this._misses,
      size: this.slots.size,
      resets: this._resets,
    };
  }

  /**
   * The atlas canvas, to pass as the blit source.
   *
   * `null` until the first successful {@link get}, and in any non-DOM context.
   */
  get source(): HTMLCanvasElement | null {
    return this.canvas;
  }

  private ensureCanvas(): boolean {
    if (this.ctx) return true;
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    canvas.width = this.maxSize;
    canvas.height = this.maxSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    this.canvas = canvas;
    this.ctx = ctx;
    return true;
  }

  /**
   * Look up a glyph, rasterizing it into the atlas on first request.
   *
   * @param font - Full CSS `font` shorthand, used for measuring and painting.
   * @param color - CSS color baked into the pixels.
   * @param glyph - A single grapheme cluster. Long strings are rejected
   *   (`null`): they defeat the atlas's fixed-slot packing and belong in
   *   `fillText` or {@link TextRasterCache}.
   * @returns The slot, or `null` when the caller must fall back to `fillText`
   *   (headless, unrasterizable, or too large to pack).
   */
  get(font: string, color: string, glyph: string): GlyphSlot | null {
    const key = font + '\u0000' + color + '\u0000' + glyph;
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      // A cached `null` is a remembered failure: re-measuring an unpackable glyph
      // every frame would cost more than the blit ever saved.
      if (existing) this._hits++;
      return existing;
    }
    this._misses++;

    // A cluster can legitimately be several code units (combining marks, emoji
    // ZWJ sequences); a whole word cannot. 8 admits the former, rejects the
    // latter without a full segmenter.
    if (glyph.length === 0 || glyph.length > 8) {
      this.slots.set(key, null);
      return null;
    }
    if (!this.ensureCanvas()) return null;
    const ctx = this.ctx!;

    ctx.font = font;
    const metrics = ctx.measureText(glyph);
    const advance = metrics.width;
    // Prefer true glyph metrics (they cover emoji and ascender/descender
    // overshoot); fall back to font-relative estimates where absent.
    const ascent =
      metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || advance * 0.9;
    const descent =
      metrics.actualBoundingBoxDescent || metrics.fontBoundingBoxDescent || advance * 0.25;
    const left = metrics.actualBoundingBoxLeft || 0;
    const right = metrics.actualBoundingBoxRight || advance;

    const offsetX = Math.ceil(left) + PAD;
    const offsetY = Math.ceil(ascent) + PAD;
    const w = offsetX + Math.ceil(right) + PAD;
    const h = offsetY + Math.ceil(descent) + PAD;
    if (!(w > 0) || !(h > 0)) {
      this.slots.set(key, null);
      return null;
    }

    const dpr = this.dpr;
    const dw = Math.ceil(w * dpr);
    const dh = Math.ceil(h * dpr);

    // A glyph wider or taller than the whole atlas can never be packed; remember
    // the failure rather than resetting forever in a loop.
    if (dw + PAD * 2 > this.maxSize || dh + PAD * 2 > this.maxSize) {
      this.slots.set(key, null);
      return null;
    }

    // Advance the shelf, wrapping to a new row and resetting the atlas when full.
    if (this.penX + dw + PAD > this.maxSize) {
      this.penX = PAD;
      this.penY += this.rowHeight + PAD;
      this.rowHeight = 0;
    }
    if (this.penY + dh + PAD > this.maxSize) {
      // Full. Clearing wholesale (rather than evicting) keeps packing trivial:
      // slots are positions, so freeing one leaves a hole no simple packer can
      // reuse. Every live glyph re-rasterizes on its next miss, which is why
      // `stats.resets` is worth watching — repeated resets mean this atlas is
      // the wrong tool for the content.
      this.reset();
      if (!this.ensureCanvas()) return null;
      this.ctx!.font = font;
    }

    const sx = this.penX;
    const sy = this.penY;
    const c = this.ctx!;
    c.save();
    c.translate(sx, sy);
    if (dpr !== 1) c.scale(dpr, dpr);
    c.font = font;
    c.textBaseline = 'alphabetic';
    c.fillStyle = color;
    // Ligature and kerning suppression is pointless for a single cluster, and
    // `textRendering` is unimplemented on the engine that would need it, so the
    // atlas simply stores one cluster per slot — which is itself what makes a
    // grid render identically across engines.
    c.fillText(glyph, offsetX, offsetY);
    c.restore();

    this.penX += dw + PAD;
    if (dh > this.rowHeight) this.rowHeight = dh;

    const slot: GlyphSlot = {
      sx,
      sy,
      sw: dw,
      sh: dh,
      w,
      h,
      offsetX,
      offsetY,
      glyph,
      font,
      advance,
      left,
      right,
    };
    this.slots.set(key, slot);
    return slot;
  }

  /**
   * Find the slot occupying a source position, or `null`.
   *
   * The inverse of {@link get}: it maps a blit back to the glyph it drew. Exists
   * for instrumentation — a test or devtool that traces `drawImage` calls sees
   * only a source rect, and needs this to recover which cluster was painted and
   * with what metrics. Linear over resident slots, so it is a diagnostic, not a
   * per-frame call.
   */
  slotAt(sx: number, sy: number): GlyphSlot | null {
    for (const slot of this.slots.values()) {
      if (slot && slot.sx === sx && slot.sy === sy) return slot;
    }
    return null;
  }

  /**
   * Drop every glyph and reuse the canvas.
   *
   * Call after a font or theme change: slots are keyed by `(font, color, glyph)`
   * so stale entries are never *returned* wrongly, but they do occupy space.
   */
  reset(): void {
    this.slots.clear();
    this.penX = PAD;
    this.penY = PAD;
    this.rowHeight = 0;
    this._resets++;
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** Release the backing canvas and all slots. */
  destroy(): void {
    this.slots.clear();
    this.canvas = null;
    this.ctx = null;
    this.penX = PAD;
    this.penY = PAD;
    this.rowHeight = 0;
    this._hits = 0;
    this._misses = 0;
    this._resets = 0;
  }
}
