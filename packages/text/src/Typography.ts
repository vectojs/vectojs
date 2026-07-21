let typographyContext: CanvasRenderingContext2D | null | undefined;
const baselineCache = new Map<string, number>();

/**
 * Return the baseline offset inside a CSS line box for a canvas-compatible
 * font. Canvas text and a native editor must use this identical value whenever
 * one mirrors the other; CSS otherwise centers font metrics in the line box.
 *
 * The 0.8 fallback preserves the framework's deterministic, DOM-free text
 * contract in SSR and test environments where Canvas 2D is unavailable.
 */
export function cssLineBoxBaseline(font: string, lineHeight: number): number {
  if (typeof document === 'undefined') return lineHeight * 0.8;
  const key = `${font}\u0000${lineHeight}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;

  if (typographyContext === undefined) {
    typographyContext = document.createElement('canvas').getContext('2d');
  }
  if (!typographyContext) return lineHeight * 0.8;

  typographyContext.font = font;
  const metrics = typographyContext.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent;
  if (!(ascent > 0) || !(descent >= 0)) return lineHeight * 0.8;

  const baseline = (lineHeight - ascent - descent) / 2 + ascent;
  baselineCache.set(key, baseline);
  return baseline;
}

/** Clear cached browser font metrics after a webfont finishes loading. */
export function clearCssLineBoxMetrics(): void {
  baselineCache.clear();
}
