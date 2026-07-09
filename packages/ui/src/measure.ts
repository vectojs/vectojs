import { ArabicShaper } from '@vectojs/core';

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
  const pxIndex = font.indexOf('px');
  if (pxIndex <= 0) return 16;

  let start = pxIndex - 1;
  while (start >= 0) {
    const ch = font[start];
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      start--;
    } else {
      break;
    }
  }

  const raw = font.slice(start + 1, pxIndex);
  if (raw === '') return 16;
  const size = Number.parseFloat(raw);
  return Number.isFinite(size) ? size : 16;
}

// Cache `(font, text) → width`. Native `measureText` forces a layout/context
// switch each call — wasteful for hot paths that re-measure the same strings
// every frame: `wrapLines` (per-word candidates) and `Input` caret positioning
// (growing prefixes). A bounded LRU keeps the working set hot while capping
// memory (dynamic text would otherwise grow an unbounded map). A `Map` preserves
// insertion order, so the first key is the least-recently-used.
const MEASURE_CACHE_MAX = 1000;
const measureCache = new Map<string, number>();

if (typeof document !== 'undefined' && document.fonts) {
  const clearCache = () => measureCache.clear();
  document.fonts.ready.then(clearCache);
  document.fonts.addEventListener('loadingdone', clearCache);
}

/**
 * Measure the rendered width of `text` in the given CSS `font`, memoized via a
 * bounded LRU.
 *
 * @param text - The string to measure.
 * @param font - A CSS font shorthand, e.g. `'16px sans-serif'`.
 * @returns Pixel width; a rough `0.5em`-per-char estimate when no DOM is available.
 */
export function measureText(text: string, font: string): number {
  const shaped = ArabicShaper.shapeArabic(text).shapedText;
  const key = `${font} ${shaped}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    // Promote to most-recently-used (delete + re-insert moves it to the end).
    measureCache.delete(key);
    measureCache.set(key, cached);
    return cached;
  }

  const ctx = getCtx();
  let width: number;
  if (!ctx) {
    width = shaped.length * fontSizePx(font) * 0.5;
  } else {
    ctx.font = font;
    width = ctx.measureText(shaped).width;
  }

  measureCache.set(key, width);
  if (measureCache.size > MEASURE_CACHE_MAX) {
    // Evict the least-recently-used entry (oldest insertion-order key).
    measureCache.delete(measureCache.keys().next().value!);
  }
  return width;
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
