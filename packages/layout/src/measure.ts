import type { GlyphMeasurer } from './LayoutEngine';

/**
 * Create a {@link GlyphMeasurer} backed by a single lazily-created offscreen
 * Canvas 2D context.
 *
 * Each grapheme is measured once at `baseSize` and cached; because canvas
 * `measureText` advance width is linear in font size, later queries at any
 * `fontSize` are derived by pure arithmetic (no re-measure). This gives the
 * {@link LayoutEngine} real per-glyph metrics for text that has no pre-baked
 * vector atlas, fixing the coarse `0.5em` line-breaking fallback.
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
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;

  const font = `${baseSize}px ${fontFamily}`;
  const cache = new Map<string, number>();

  return {
    measure(char: string, fontSize: number): number {
      let base = cache.get(char);
      if (base === undefined) {
        ctx.font = font;
        base = ctx.measureText(char).width;
        cache.set(char, base);
      }
      return base * (fontSize / baseSize);
    },
  };
}
