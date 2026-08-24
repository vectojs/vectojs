import { ArabicShaper, fontMetricsVersion, getFontMetrics } from '@vectojs/core';
import { createMeasuringContext, getSharedMeasuringContext } from '@vectojs/core';

/**
 * Shared text measurement utilities backed by a single lazily-created offscreen
 * Canvas 2D context. DOM-free environments fall back to a rough estimate so the
 * core math stays portable (no `document` access at module load).
 *
 * The two context helpers now live in `@vectojs/text` (the leaf of the package
 * graph) so `text`, `layout`, `ui` and `core` all measure through one attached
 * canvas instead of four. They are re-exported here because this module was
 * their original home and `RichText`, `Text` and the ui tests import them from
 * this path. See `@vectojs/text`'s `measureContext.ts` for the measurements
 * behind the measure-where-you-paint rule.
 */
export { createMeasuringContext, getSharedMeasuringContext };

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
// every frame: `Input` caret positioning (growing prefixes) and percentage
// labels. A bounded LRU keeps the working set hot while capping
// memory (dynamic text would otherwise grow an unbounded map). A `Map` preserves
// insertion order, so the first key is the least-recently-used.
const MEASURE_CACHE_MAX = 1000;
const measureCache = new Map<string, number>();

const fontMetricsListeners = new Set<() => void>();

/**
 * Fire every font-metrics subscriber and clear the shared LRU. Called by the
 * `document.fonts` listeners below; also exported so environments (and tests)
 * that detect font availability changes themselves can raise the same signal.
 */
export function notifyFontMetricsChanged(): void {
  measureCache.clear();
  for (const listener of fontMetricsListeners) listener();
}

if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.ready.then(notifyFontMetricsChanged);
  document.fonts.addEventListener('loadingdone', notifyFontMetricsChanged);
}

/**
 * Subscribers notified when the pixels behind any measurement may have changed
 * — a webfont finishing its load. `measureText`'s LRU above clears itself, but
 * per-instance caches inside components (Button's intrinsic width, Input's key'd
 * layout, Text's prepared glyph atlas, …) survive unless each one re-measures;
 * this is the single signal they all subscribe to instead of six divergent
 * `document.fonts` listeners. Returns an unsubscribe function.
 */
export function onFontMetricsChanged(listener: () => void): () => void {
  fontMetricsListeners.add(listener);
  return () => {
    fontMetricsListeners.delete(listener);
  };
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
  // `\u0000` cannot appear in a CSS font shorthand or in measured text drawn
  // from a string literal without deliberate effort, so joining on it keeps
  // `(font, text)` pairs distinct: a plain space aliased
  // `('16px sans-serif', 'bold 4px x')` onto `('16px sans-serif bold', '4px x')`.
  const key = `${font}\u0000${text}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    // Promote to most-recently-used (delete + re-insert moves it to the end).
    measureCache.delete(key);
    measureCache.set(key, cached);
    return cached;
  }

  // Miss: shape now (contextual forms change advance widths for Arabic).
  const shaped = ArabicShaper.shapeArabic(text).shapedText;
  const ctx = getSharedMeasuringContext();
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
