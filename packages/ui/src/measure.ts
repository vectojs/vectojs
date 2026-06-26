/**
 * Shared text measurement utilities backed by a single lazily-created offscreen
 * Canvas 2D context. DOM-free environments fall back to a rough estimate so the
 * core math stays portable (no `document` access at module load).
 */

let sharedCtx: CanvasRenderingContext2D | null | undefined;

function getCtx(): CanvasRenderingContext2D | null {
  if (sharedCtx !== undefined) return sharedCtx;
  sharedCtx =
    typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  return sharedCtx;
}

/**
 * Extract the pixel font size from a CSS font shorthand.
 *
 * Must match the `<number>px` token — NOT a leading `parseFloat`, which would
 * wrongly return the font *weight* for shorthands like `'600 16px sans-serif'`.
 *
 * @param font - A CSS font shorthand, e.g. `'600 16px sans-serif'`.
 * @returns The px size, or `16` when none is found.
 */
export function fontSizePx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? parseFloat(m[1]) : 16;
}

/**
 * Measure the rendered width of `text` in the given CSS `font`.
 *
 * @param text - The string to measure.
 * @param font - A CSS font shorthand, e.g. `'16px sans-serif'`.
 * @returns Pixel width; a rough `0.5em`-per-char estimate when no DOM is available.
 */
export function measureText(text: string, font: string): number {
  const ctx = getCtx();
  if (!ctx) {
    return text.length * fontSizePx(font) * 0.5;
  }
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Greedily wrap `text` into lines no wider than `maxWidth`, honoring explicit
 * newlines. Words longer than `maxWidth` are placed on their own line (not split).
 *
 * @param text - The text to wrap (newlines force line breaks).
 * @param font - CSS font shorthand used for measurement.
 * @param maxWidth - Maximum line width in pixels.
 * @returns The wrapped lines.
 */
export function wrapLines(text: string, font: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measureText(candidate, font) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}
