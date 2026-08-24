import {
  fontMetricsVersion,
  getFontMetrics,
  getSharedMeasuringContext,
  type FontMetricsSource,
} from '@vectojs/text';
import type { GlyphMeasurer } from './LayoutEngine';

/**
 * Create a {@link GlyphMeasurer} backed by the shared attached measuring
 * context.
 *
 * Each grapheme is measured once at `baseSize` and cached; because canvas
 * `measureText` advance width is linear in font size, later queries at any
 * `fontSize` are derived by pure arithmetic (no re-measure). This gives the
 * {@link LayoutEngine} real per-glyph metrics for text that has no pre-baked
 * vector atlas, fixing the coarse `0.5em` line-breaking fallback.
 *
 * Honors the {@link GlyphMeasurer} contract for per-run overrides: a
 * `fontFamily`/`bold`/`italic` passed to `measure()` measures (and caches) at
 * that style instead of returning the base font's numbers, so an inline
 * `monospace` or bold run breaks lines by its own metrics.
 *
 * Uses `getSharedMeasuringContext()` rather than its own canvas, and the
 * *attached* part is load-bearing here in a way it is not for a pure geometry
 * consumer: this measurer decides **where lines break**. A detached context
 * resolves a generic family to a different font in Gecko — measured 20% short on
 * `monospace` — so wrapping computed from it puts breaks in the wrong place
 * before any projection is involved. See `measureContext.ts` for the numbers.
 *
 * Returns `null` in DOM-free environments (SSR, workers without a canvas) so
 * callers stay portable and the engine keeps its `0.5em` fallback.
 *
 * @param fontFamily - CSS font family used for measurement; should match what
 *   the renderer actually draws (e.g. `TextEntity` falls back to `sans-serif`).
 * @param baseSize - Pixel size at which each glyph is measured and cached.
 * @returns A measurer, or `null` when no Canvas 2D context is available.
 */
export function createCanvasMeasurer(
  fontFamily: string = 'sans-serif',
  baseSize: number = 100,
): GlyphMeasurer | null {
  if (typeof document === 'undefined') return null;
  const ctx = getSharedMeasuringContext();
  if (!ctx) return null;

  const cache = new Map<string, number>();

  return {
    measure(
      char: string,
      fontSize: number,
      runFamily?: string,
      bold?: boolean,
      italic?: boolean,
    ): number {
      // A per-run override (inline `monospace`, a bold run) measures at its own
      // style rather than returning base-family numbers, per the
      // `GlyphMeasurer` contract. The cache key carries the style, so a run
      // override never poisons the base cache or vice versa.
      const key = `${runFamily ?? ''}\u0000${bold ? 'b' : ''}${italic ? 'i' : ''}\u0000${char}`;
      let base = cache.get(key);
      if (base === undefined) {
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${baseSize}px ${runFamily ?? fontFamily}`;
        base = ctx.measureText(char).width;
        cache.set(key, base);
      }
      return base * (fontSize / baseSize);
    },
  };
}

/**
 * Create a {@link GlyphMeasurer} backed by DOM-free metrics registered with
 * `registerFontMetrics` / `registerMSDFFontMetrics` from `@vectojs/text`.
 *
 * Returns `null` when nothing is registered for the family, so a caller can
 * chain it after {@link createCanvasMeasurer} and fall through to the engine's
 * `0.5em` default exactly as before.
 *
 * A glyph the source has no advance for falls back to `0.5em` for that glyph
 * alone, rather than disqualifying the whole measurer — a font missing one
 * codepoint still has correct metrics for the rest of the line.
 *
 * **Bold and italic are ignored by this measurer.** Registered metrics carry a
 * single advance table per family, so `_bold`/`_italic` are accepted (the
 * {@link GlyphMeasurer} contract requires the parameters) but discarded. SSR
 * bold text therefore measures at regular widths, and a headless wrap can
 * differ from the painted output where weight changes advances materially.
 * When that matters, measure on a canvas via {@link createCanvasMeasurer},
 * which resolves per-weight metrics from real font rendering.
 *
 * @param fontFamily - CSS family to look up.
 * @returns A measurer, or `null` when the family has no registered metrics.
 */
export function createMetricsMeasurer(fontFamily: string = 'sans-serif'): GlyphMeasurer | null {
  if (!getFontMetrics(fontFamily)) return null;

  // Resolved lazily and re-resolved only when the registry changes. Capturing
  // the source once would pin whichever was registered when this measurer was
  // built, so replacing a family's metrics (a webfont swap, corrected data)
  // would be silently ignored — and a memoized measurer, as `TextEntity` keeps,
  // would never see the change at all. Looking it up on every glyph instead
  // measured +13% on the measurer path, because `normalizeFamily` allocates a
  // split array per call; a version compare is one integer read.
  let baseSource: FontMetricsSource | undefined;
  let baseVersion = -1;
  let runSource: FontMetricsSource | undefined;
  let runFamily: string | undefined;
  let runVersion = -1;

  return {
    measure(
      char: string,
      fontSize: number,
      family?: string,
      _bold?: boolean,
      _italic?: boolean,
    ): number {
      if (baseVersion !== fontMetricsVersion()) {
        baseVersion = fontMetricsVersion();
        baseSource = getFontMetrics(fontFamily);
        runVersion = -1;
      }

      let source = baseSource;
      if (family !== undefined) {
        // A per-run family (inline monospace, say) may differ from the
        // paragraph's base. Runs come in contiguous stretches, so caching the
        // last one resolves each stretch once. An unregistered run family falls
        // back to the base source rather than to 0.5em, because the wrong
        // font's real metrics are still far closer than a flat half-em.
        if (runVersion !== baseVersion || runFamily !== family) {
          runVersion = baseVersion;
          runFamily = family;
          runSource = getFontMetrics(family);
        }
        source = runSource ?? baseSource;
      }

      const em = source?.advanceEm(char);
      return em === undefined ? fontSize * 0.5 : em * fontSize;
    },
  };
}

/**
 * Resolve the best available {@link GlyphMeasurer} for a family: a real Canvas
 * 2D context first, then registered DOM-free metrics, then `null`.
 *
 * Canvas wins deliberately. It measures the font the renderer will actually
 * draw with, including synthesized weights, so preferring registered metrics
 * would let a stale or approximate registration override ground truth in the
 * one environment that has ground truth. Registered metrics exist to replace a
 * flat `0.5em` guess, not to second-guess the browser.
 *
 * @param fontFamily - CSS family used for measurement.
 * @param baseSize - Pixel size for the canvas measurer's glyph cache.
 * @returns A measurer, or `null` when neither source is available.
 */
export function resolveGlyphMeasurer(
  fontFamily: string = 'sans-serif',
  baseSize: number = 100,
): GlyphMeasurer | null {
  return createCanvasMeasurer(fontFamily, baseSize) ?? createMetricsMeasurer(fontFamily);
}
