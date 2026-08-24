import { getFontMetrics } from './fontMetrics';
import { getSharedMeasuringContext } from './measureContext';

const baselineCache = new Map<string, number>();
// Bound on the baseline cache: keys are raw `font` shorthand strings, so a
// session rendering dynamically-sized text would otherwise grow one entry per
// distinct (font, lineHeight) pair for the lifetime of the process — evicted
// only by an explicit `clearCssLineBoxMetrics()`. A plain insertion-order LRU
// is enough: re-inserting a hit key moves it to the newest end, and the oldest
// entry is dropped once the bound is exceeded. 512 entries cover every font in
// a realistic document many times over; a miss merely re-measures one string.
const BASELINE_CACHE_MAX = 512;

function rememberBaseline(key: string, baseline: number): void {
  if (baselineCache.size >= BASELINE_CACHE_MAX) {
    const oldest = baselineCache.keys().next().value;
    if (oldest !== undefined) baselineCache.delete(oldest);
  }
  baselineCache.set(key, baseline);
}

/**
 * The px size and family out of a CSS font shorthand, for a metrics lookup.
 *
 * Anchored on `px` and walking back over the digits rather than using the
 * obvious `/(\d+(?:\.\d+)?)px/`, which is polynomial — the digit run backtracks
 * from every start position when no `px` follows, and `font` is caller-supplied.
 * CodeQL flagged exactly that pattern elsewhere in this repo
 * (`js/polynomial-redos`, high). `@vectojs/ui` and `@vectojs/markdown` each have
 * a similar parser; they deliberately disagree on the failure value (16 versus
 * `undefined`), so they are not unified here.
 */
function splitFontShorthand(font: string): { size: number; family: string } | undefined {
  const pxIndex = font.indexOf('px');
  if (pxIndex <= 0) return undefined;

  let start = pxIndex;
  while (start > 0) {
    const ch = font[start - 1];
    if ((ch >= '0' && ch <= '9') || ch === '.') start--;
    else break;
  }
  if (start === pxIndex) return undefined;

  const size = Number.parseFloat(font.slice(start, pxIndex));
  if (!Number.isFinite(size) || size <= 0) return undefined;

  let rest = font.slice(pxIndex + 2).trimStart();
  if (rest.startsWith('/')) {
    let i = 1;
    while (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t') i++;
    rest = rest.slice(i).trimStart();
  }
  if (rest === '') return undefined;

  return { size, family: rest };
}

/**
 * Baseline from DOM-free metrics registered via `registerFontMetrics`, falling
 * back to the historical `0.8 * lineHeight` when the family has none.
 *
 * Uses the same centering formula as the canvas path so a registered font and a
 * real browser agree: CSS distributes the leading evenly above and below the
 * font's own ascent + descent.
 */
function registeredBaseline(font: string, lineHeight: number): number {
  const parsed = splitFontShorthand(font);
  if (!parsed) return lineHeight * 0.8;

  const source = getFontMetrics(parsed.family);
  if (source?.ascenderEm === undefined || source.descenderEm === undefined) {
    return lineHeight * 0.8;
  }

  const ascent = source.ascenderEm * parsed.size;
  // `descenderEm` is negative (y-down from the baseline); canvas reports its
  // descent as a positive magnitude, so flip the sign to match.
  const descent = -source.descenderEm * parsed.size;
  if (!(ascent > 0) || !(descent >= 0)) return lineHeight * 0.8;

  return (lineHeight - ascent - descent) / 2 + ascent;
}

/**
 * Return the baseline offset inside a CSS line box for a canvas-compatible
 * font. Canvas text and a native editor must use this identical value whenever
 * one mirrors the other; CSS otherwise centers font metrics in the line box.
 *
 * The 0.8 fallback preserves the framework's deterministic, DOM-free text
 * contract in SSR and test environments where Canvas 2D is unavailable.
 */
export function cssLineBoxBaseline(font: string, lineHeight: number): number {
  if (typeof document === 'undefined') return registeredBaseline(font, lineHeight);
  const key = `${font}\u0000${lineHeight}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) {
    // LRU refresh: re-insert so the key counts as recently used.
    baselineCache.delete(key);
    baselineCache.set(key, cached);
    return cached;
  }

  // Attached, not detached — see `measureContext` for why. A detached context
  // reads `fontBoundingBox*` from a different font than the one being painted
  // on Firefox, so the baseline it derives is a different font's baseline.
  const ctx = getSharedMeasuringContext();
  if (!ctx) return registeredBaseline(font, lineHeight);

  ctx.font = font;
  const metrics = ctx.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent;
  if (!(ascent > 0) || !(descent >= 0)) return lineHeight * 0.8;

  const baseline = (lineHeight - ascent - descent) / 2 + ascent;
  rememberBaseline(key, baseline);
  return baseline;
}

/** Clear cached browser font metrics after a webfont finishes loading. */
export function clearCssLineBoxMetrics(): void {
  baselineCache.clear();
}
