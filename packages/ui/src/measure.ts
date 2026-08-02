import { ArabicShaper, fontMetricsVersion, getFontMetrics } from '@vectojs/core';

/**
 * Shared text measurement utilities backed by a single lazily-created offscreen
 * Canvas 2D context. DOM-free environments fall back to a rough estimate so the
 * core math stays portable (no `document` access at module load).
 */

/**
 * Create a 2D context for measuring, attached to the document.
 *
 * The canvas is **appended** rather than left detached, and that is
 * load-bearing rather than tidiness. The rule is *measure where you paint*:
 * Firefox resolves a generic CSS family (`monospace`, `sans-serif`) through a
 * per-language font preference that is only reachable from a document style
 * context, so a canvas outside any document falls back to a hardcoded 0.5em
 * advance. The engine paints on a real attached canvas, so a detached measurer
 * advanced every run 20% short of the glyphs actually drawn and the next run
 * landed on the tail of the previous one.
 *
 * Measured with `16px monospace` on `iiiiWWWW`, against the painted ink as
 * ground truth (`actualBoundingBoxRight` 77.2, last inked pixel x = 76):
 *
 * | document      | engine's real canvas | this helper | detached |
 * | ------------- | -------------------- | ----------- | -------- |
 * | Firefox, lang | 76.8                 | **76.8**    | **64.0** |
 * | Firefox, none | 64.0                 | **64.0**    | 64.0     |
 * | Chromium, any | 76.8                 | **76.8**    | 76.8     |
 *
 * Note the second row: in a document with no `<html lang>` Firefox genuinely
 * paints at the 0.5em fallback, and the helper correctly reports 64 there. What
 * matters is not the absolute number but that this context always agrees with
 * the one being painted on — which it did in 6/6 engine × document combinations,
 * while a detached context disagrees in Firefox whenever a `lang` is present.
 *
 * Attachment is the only factor that mattered; forcing a reflow, `display:none`
 * vs `opacity:0`, and awaiting `document.fonts.ready` all measured identically.
 * It must be attached **before** the first `measureText`, or a width cache holds
 * the wrong values for the rest of the session.
 *
 * @returns A measuring context, or `null` in a DOM-free environment.
 */
export function createMeasuringContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  // Kept out of layout and off-screen; never painted, only measured against.
  canvas.style.cssText = 'position:absolute;opacity:0;left:-9999px;top:0;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  // A DOM-free document (or one without a body yet) still measures correctly on
  // Chromium and simply keeps Firefox's old behaviour, so this is best-effort.
  document.body?.appendChild(canvas);
  return canvas.getContext('2d');
}

let sharedCtx: CanvasRenderingContext2D | null | undefined;

function getCtx(): CanvasRenderingContext2D | null {
  if (sharedCtx !== undefined) return sharedCtx;
  sharedCtx = createMeasuringContext();
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

/**
 * Extract the family portion of a CSS font shorthand (drops a leading
 * `<n>px` and an optional `/<line-height>`).
 *
 * Sibling of {@link fontSizePx}: together they decompose a shorthand into the
 * two things a DOM-free metrics lookup needs.
 *
 * @param font - A CSS font shorthand, e.g. `'600 16px/1.4 Inter, sans-serif'`.
 * @returns The family portion, or `'sans-serif'` when none is found.
 */
export function familyOf(font: string): string {
  const pxIndex = font.indexOf('px');
  if (pxIndex < 0) return font.trim() || 'sans-serif';

  let rest = font.slice(pxIndex + 2).trimStart();
  if (rest.startsWith('/')) {
    let i = 1;
    while (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t') i++;
    rest = rest.slice(i).trimStart();
  }

  return rest || 'sans-serif';
}

/**
 * Measure `text` from DOM-free metrics registered via `registerFontMetrics`.
 *
 * Prefers the source's whole-string `measureEm`, which honors kerning, and falls
 * back to summing per-grapheme advances. Returns `undefined` when the family has
 * no registration, so the caller keeps its own fallback.
 */
function measureWithRegisteredMetrics(text: string, font: string): number | undefined {
  const source = getFontMetrics(familyOf(font));
  if (!source) return undefined;

  const size = fontSizePx(font);
  const whole = source.measureEm?.(text);
  if (whole !== undefined) return whole * size;

  let em = 0;
  // Iterate by code point, not UTF-16 unit, so an astral character is one
  // advance rather than two half-measured surrogates.
  for (const char of text) em += source.advanceEm(char) ?? 0.5;
  return em * size;
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

// Registering font metrics changes what a measurement should return, exactly as
// a webfont finishing its load does above — so the cached answers computed
// before it are stale and must be dropped. Compared lazily rather than
// subscribed to, because this module has no teardown hook to unsubscribe from.
let cachedMetricsVersion = fontMetricsVersion();
function invalidateOnMetricsChange(): void {
  const current = fontMetricsVersion();
  if (current !== cachedMetricsVersion) {
    cachedMetricsVersion = current;
    measureCache.clear();
  }
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
  // Key on the RAW text, not the shaped form: shaping is a deterministic
  // function of the text, so `(font, raw) → width` is an equally valid mapping —
  // and it means a cache HIT no longer has to shape first. Keying on the shaped
  // text made every hit pay `shapeArabic()`, which measured at ~60% of the whole
  // hit cost (49.7ms of 83ms per 20k hits) and is pure overhead for the ASCII
  // majority, where it returns the input unchanged but still allocates an
  // index map. Two raws that shape identically now occupy two entries — correct,
  // just marginally less dense.
  invalidateOnMetricsChange();
  const key = `${font} ${text}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    // Promote to most-recently-used (delete + re-insert moves it to the end).
    measureCache.delete(key);
    measureCache.set(key, cached);
    return cached;
  }

  // Miss: shape now (contextual forms change advance widths for Arabic).
  const shaped = ArabicShaper.shapeArabic(text).shapedText;
  const ctx = getCtx();
  let width: number;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(shaped).width;
  } else {
    width = measureWithRegisteredMetrics(shaped, font) ?? shaped.length * fontSizePx(font) * 0.5;
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
