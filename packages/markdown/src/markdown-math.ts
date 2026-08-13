import {
  type InlineObjectBox,
  type InlineObjectSurface,
  type DevtoolsDescriptor,
} from '@vectojs/core';
import type { emitSVG, layout } from '@vectojs/tex';
import type { Token, Tokens } from 'marked';

import { MarkdownContainer } from './markdown-entities';

/**
 * The two `@vectojs/tex` entry points, as types only.
 *
 * `import type` erases at compile time, so these create no module edge and the
 * engine stays behind the dynamic `import()` in {@link preloadMathJax}. A value
 * import of either — or of `KATEX_FONT_SCALE`, which is why that constant is
 * re-declared below rather than imported — would pull the whole engine into
 * every consumer's entry chunk and undo the split this module exists to keep.
 */
type TexLayout = typeof layout;
type TexEmit = typeof emitSVG;

/**
 * TeX math: the lazily loaded MathJax converter, the SVG data-URI cache, the
 * inline raster store and its repaint subscription, and the `MathBlock` entity.
 *
 * `mathConverter` and `inlineMathRasterWaiters` stay **private to this module**.
 * The component reaches them only through `isMathJaxReady()` and the
 * subscribe/unsubscribe pair, because exporting mutable module state across a
 * file boundary makes the ownership of a cache impossible to follow.
 *
 * Imports `MarkdownContainer` from `./markdown-entities` rather than from
 * `Markdown.ts`, and that is load-bearing, not stylistic. `MathBlock extends
 * MarkdownContainer` is evaluated when this module initializes; with the base
 * class declared in `Markdown.ts` the cycle resolves the binding to `undefined`
 * and throws `TypeError: Class extends value undefined is not a constructor or
 * null` on import — measured, not theorised. 22 of 27 test files enter through
 * `../src/Markdown`, which is the order that trips it. See
 * `forge/decisions/file-decomposition-2026-08.md`.
 */

/**
 * The math engine is loaded on demand, the first time a document actually has a
 * formula to typeset.
 *
 * `@vectojs/tex` is by far the heaviest thing this package can pull in, so the
 * lazy import stays even though the engine itself is fully synchronous. Measured
 * 2026-08-06 with `bun build --splitting --minify --target=browser` against a
 * consumer that imports `Markdown` and renders only prose: 19 chunks totalling
 * 2 199 869 bytes (748 713 gzipped) with `mathjax-full`, and 379 224
 * (118 670 gzipped) with every `mathjax-full` import stubbed out. The math
 * engine is 84% of that bundle. A static import would put all of it in the entry
 * chunk, because `renderMathToSVGDataURI` is reachable from `Markdown`'s render
 * arm and so cannot be tree-shaken — a prose-only consumer would pay the whole
 * engine to render a paragraph.
 *
 * The cost of that is real and worth stating plainly: the FIRST formula on a
 * page cannot be typeset synchronously. It renders as a CodeBlock of TeX
 * source — the same honest "not typeset yet" state an unclosed fence already
 * uses — and is replaced once the module resolves. Call `preloadMathJax()` and
 * await it before constructing if you need the first formula to be typeset in
 * the same tick. Every formula after the module resolves is synchronous again.
 *
 * The `MathJax` in the public names is historical. `preloadMathJax` and
 * `isMathJaxReady` were named when `mathjax-full` was the engine, and they are
 * public API pinned by `test/publicApi.test.ts`, so they keep those names rather
 * than break every consumer over a rename. What they mean is "the math engine",
 * whichever one that is.
 */
type MathConverter = (formula: string, displayMode: boolean, color: string) => MathRender | null;

let mathConverter: MathConverter | null = null;
let mathLoad: Promise<void> | null = null;

/**
 * Begin (or join) loading the math engine, resolving once formulas typeset
 * synchronously.
 *
 * Idempotent and safe to call from anywhere: the promise is cached, so N callers
 * and N documents share one module load. Rejection is swallowed deliberately —
 * a failed load must degrade to TeX source in a CodeBlock, not reject a caller's
 * `await close()` or leave an unhandled rejection on the page. `mathConverter`
 * simply stays null and every formula keeps rendering as source.
 */
export function preloadMathJax(): Promise<void> {
  if (mathLoad) return mathLoad;
  mathLoad = (async () => {
    // One dynamic import of one ESM package, which is what replaced six dynamic
    // imports of `mathjax-full`'s CommonJS entry points. Those needed an
    // `interop` helper to read named exports, because esbuild wraps a CJS module
    // and emits only `export default require_x()` — a defect that typechecked,
    // passed every unit test, and failed in a real browser bundle with
    // `liteAdaptor is not a function`. `@vectojs/tex` is ESM with real named
    // exports, so the helper is gone rather than ported.
    const { emitSVG, layout } = await import('@vectojs/tex');
    mathConverter = (formula, displayMode, color) =>
      convertMathToSVGDataURI(formula, displayMode, color, layout, emitSVG);
  })().catch((e) => {
    console.error('Math engine failed to load; formulas will render as TeX source', e);
  });
  return mathLoad;
}

/** Whether formulas can be typeset without waiting. Exposed for tests. */
export function isMathJaxReady(): boolean {
  return mathConverter !== null;
}

/**
 * The math font's x-height ratio: how many em one `ex` is.
 *
 * Measured 2026-07-31 against `mathjax-full` via `liteAdaptor`, which reported
 * its box in `ex` against 1000 internal units per em: units/ex came out 442.0 for
 * every probed formula, consistently from both the width and height attributes
 * (441.95–442.08). See `tmp/agents/probe-ex-to-px.ts`.
 *
 * It survived the switch to `@vectojs/tex` unchanged, and its exact value no
 * longer affects what a reader sees. `@vectojs/tex` reports em rather than `ex`,
 * so {@link EX_PER_KATEX_EM} divides by this constant on the way into the cache
 * and {@link exToPx} multiplies by it on the way out — **it cancels**. Verified
 * both arithmetically and by mutation: a 2 em formula at fontSize 16 resolves to
 * 38.72 px whether this is 0.4421, 0.431, 0.5 or 0.3, and changing it to 0.31
 * leaves all 11 tests in `test/mathBoxGeometry.test.ts` passing. Only
 * `KATEX_FONT_SCALE` survives that round trip, which is why dropping it fails 3
 * of those tests and mis-sizes every formula by 21%.
 *
 * So it is now an internal representation unit, not a measurement anything
 * depends on. It is kept because `MathRender` stores `ex` deliberately: `ex` is
 * font-relative, so one cached conversion is reused across runs of different
 * sizes (a formula in a heading and the same formula in body prose). Do not read
 * it as KaTeX's x-height — KaTeX's own `fontMetrics` reports `xHeight: 0.431`
 * (`src/kernel/fontMetrics.ts:46`), 2.6% away from this, and the two are not the
 * same quantity.
 *
 * This replaced a hardcoded `* 8` whose comment read "1ex is approx 8px in our
 * font size". That constant is exact only near fontSize 18.1px, so it mis-sized
 * every formula at any other size — +13% at this package's own 16px default,
 * +51% at 12px, −43% at 32px.
 */
const EX_PER_EM = 0.4421;

/** Convert an `ex` measurement to px at a given font size. */
export function exToPx(ex: number, fontSize: number): number {
  return ex * fontSize * EX_PER_EM;
}

/**
 * The px size out of a CSS font shorthand (`'bold 28px Inter, sans-serif'` → 28).
 *
 * `undefined` when there is no `px` size to read, so the caller can fall back to
 * the theme rather than silently substituting a wrong number. `@vectojs/ui` has an
 * equivalent `fontSizePx` in `measure.ts`, but it is not re-exported from that
 * package's barrel and it returns a hardcoded 16 on failure, which would hide a
 * malformed font behind a plausible-looking box.
 *
 * Deliberately not a regex. The obvious `/(\d+(?:\.\d+)?)px/` is polynomial: the
 * digit run can backtrack from every start position when no `px` follows, so a
 * font string of many digits costs O(n^2) — CodeQL flagged exactly that here
 * (`js/polynomial-redos`, high), and `font` comes from caller-supplied theme
 * input. Anchoring on `px` first and walking back over the digits is linear.
 */
export function fontSizeFromFont(font: string): number | undefined {
  const pxIndex = font.indexOf('px');
  if (pxIndex <= 0) return undefined;

  let start = pxIndex;
  while (start > 0) {
    const ch = font[start - 1];
    if ((ch >= '0' && ch <= '9') || ch === '.') start--;
    else break;
  }
  if (start === pxIndex) return undefined;

  const size = parseFloat(font.slice(start, pxIndex));
  return Number.isFinite(size) ? size : undefined;
}

/**
 * A converted formula: its SVG data URI and the intrinsic box scraped off it.
 *
 * The box is in **`ex` units**, not px, because `ex` is font-relative and one
 * cached conversion is reused across runs of different sizes (inline math in a
 * heading versus body prose). Callers resolve to px with {@link exToPx} at the
 * size of the run the formula actually sits in.
 */
interface MathRender {
  uri: string;
  /** Intrinsic width in `ex`. */
  widthEx: number;
  /** Intrinsic height in `ex`, ascent + descent. */
  heightEx: number;
  /**
   * How far the box descends below the text baseline, in `ex`, as a positive
   * number.
   *
   * MathJax emits this as `style="vertical-align:-N ex"` on the root `<svg>`.
   * Measured on 8 formulas spanning subscripts, superscripts, fractions, big
   * operators and radicals, it equals the viewBox-derived depth exactly, so it
   * is read straight off the attribute rather than computed from the viewBox.
   */
  depthEx: number;
}

/**
 * Converted formulas, keyed on `<displayMode>\u0000<formula>`.
 *
 * `htmlMathJax.convert()` is the most expensive single call in this package, and
 * the same formula recurs constantly: a re-rendered document, a retried message,
 * the same identity written twice in one proof, and — the case that motivated
 * this — a closed fence whose `raw` grows by the newline that follows it, which
 * invalidates the token without changing the formula.
 *
 * Bounded by insertion order (oldest evicted first) rather than true LRU. The
 * access pattern is "convert once per formula, occasionally re-convert on a
 * rebuild", not a long-lived working set with hot and cold halves, so per-hit
 * recency bookkeeping would cost more than the eviction quality it buys.
 */
const mathCache = new Map<string, MathRender>();
const MATH_CACHE_LIMIT = 256;

/**
 * Decoded raster for each inline formula's SVG, keyed by data URI.
 *
 * Module-level rather than per-instance because {@link collectSpans} is a free
 * function with no access to the owning entity, and because the same formula in
 * two documents decodes to the same bitmap. An entry is created on first paint
 * attempt, not eagerly: a formula that never scrolls into view is never decoded.
 *
 * Bounded, unlike its first draft. Two mechanisms keep it in line with
 * {@link mathCache}: {@link renderMathToSVGDataURI} deletes the raster whose
 * render it just evicted, and {@link ensureInlineMathRaster} additionally caps
 * the map at {@link INLINE_RASTER_LIMIT}, evicting the least-recently-painted
 * entry first (the paint path re-inserts on every hit, so a bitmap that is
 * still on screen stays recent and is not evicted). A later re-paint simply
 * re-decodes, at worst flashing the formula blank for one frame — the same
 * trade the mathCache eviction already makes.
 */
const inlineMathRasters = new Map<string, InlineMathRaster>();

/** Upper bound on {@link inlineMathRasters}. A decoded bitmap costs its decoded
 *  pixels in memory, and a long-lived document (a streamed chat, a re-themed
 *  feed) once grew this map without limit while mathCache capped at 256. */
const INLINE_RASTER_LIMIT = MATH_CACHE_LIMIT;

interface InlineMathRaster {
  /** `undefined` when this environment has no `Image` (SSR, plain unit tests). */
  bitmap?: HTMLImageElement;
  decoded: boolean;
}

/**
 * Called after an inline formula's raster decodes, so the owner can repaint.
 *
 * The paint callback cannot request its own repaint: it is handed a draw surface,
 * not the scene. Every live document subscribes, because a raster decoded for one
 * may be the bitmap another is waiting on — they share {@link inlineMathRasters}.
 */
const inlineMathRasterWaiters = new Set<() => void>();

/**
 * Subscribe `notify` to inline-formula raster decodes.
 *
 * A function rather than exporting the `Set`, so the collection stays private to
 * this module once the math cluster moves out of `Markdown.ts`. Idempotent per
 * closure, since `Set` de-duplicates.
 */
export function subscribeInlineMathRaster(notify: () => void): void {
  inlineMathRasterWaiters.add(notify);
}

/**
 * Unsubscribe `notify`.
 *
 * Must be called on teardown: the set is module-level and lives as long as the
 * page, so a retained closure retains the whole entity tree that created it.
 */
export function unsubscribeInlineMathRaster(notify: () => void): void {
  inlineMathRasterWaiters.delete(notify);
}

/**
 * Ensure the raster for `uri` is decoding, and return it.
 *
 * Synchronous and idempotent: the paint path calls it on every frame the formula
 * is visible, and only the first call starts a decode. Every hit re-inserts the
 * entry, making the map LRU-ordered so the cap below evicts the bitmap painted
 * longest ago rather than one still on screen.
 */
function ensureInlineMathRaster(uri: string): InlineMathRaster {
  const existing = inlineMathRasters.get(uri);
  if (existing) {
    inlineMathRasters.delete(uri);
    inlineMathRasters.set(uri, existing);
    return existing;
  }

  const entry: InlineMathRaster = { decoded: false };
  inlineMathRasters.set(uri, entry);
  // Bound the map at the same size as mathCache: a long-lived document that
  // paints thousands of distinct formulas must not retain a decoded bitmap for
  // each of them. The evicted formula re-decodes on its next paint, which is
  // one blank frame for a formula that has not been painted recently.
  while (inlineMathRasters.size > INLINE_RASTER_LIMIT) {
    const oldest = inlineMathRasters.keys().next().value;
    if (oldest === undefined || oldest === uri) break;
    inlineMathRasters.delete(oldest);
  }

  // Guarded for the same reason `Image` guards it: jsdom and SSR have no
  // `globalThis.Image`, and a formula must degrade to a blank box rather than
  // throwing out of a layout.
  if (typeof globalThis.Image !== 'undefined') {
    const bitmap = new globalThis.Image();
    bitmap.onload = () => {
      entry.decoded = true;
      for (const notify of inlineMathRasterWaiters) notify();
    };
    bitmap.src = uri;
    entry.bitmap = bitmap;
  }
  return entry;
}

/**
 * Paint one inline formula into the box the layout engine reserved for it.
 *
 * Draws nothing until the raster has decoded — one frame of blank box, then a
 * repaint via {@link inlineMathRasterWaiters}. Drawing a placeholder slab instead
 * would flash a grey rectangle mid-sentence on every first paint.
 */
export function paintInlineMath(
  uri: string,
  surface: InlineObjectSurface,
  box: InlineObjectBox,
): void {
  const raster = ensureInlineMathRaster(uri);
  if (!raster.decoded || !raster.bitmap) return;
  surface.drawImage(raster.bitmap, box.x, box.y, box.width, box.height);
}

export const MATH_LANGS = new Set(['math', 'latex', 'tex']);

/**
 * Whether a token subtree contains an `inlineMath` token.
 *
 * Recursive because inline math nests: inside `strong`/`em`, a link's children, a
 * list item's tokens, a blockquote, or a table cell. Used only to decide whether
 * to start the lazy MathJax load, so a false negative delays typesetting rather
 * than corrupting output — but a missed nesting site means a formula in, say, a
 * table cell never typesets at all.
 */
export function containsInlineMath(token: Token): boolean {
  if (token.type === 'inlineMath') return true;
  const anyToken = token as Tokens.Generic;
  if (Array.isArray(anyToken.tokens) && anyToken.tokens.some(containsInlineMath)) {
    return true;
  }
  // `list` holds items in `items`, and each item holds its own `tokens`.
  if (Array.isArray(anyToken.items) && anyToken.items.some(containsInlineMath)) {
    return true;
  }
  // `table` holds `header` cells and `rows` (an array of arrays of cells).
  if (Array.isArray(anyToken.header) && anyToken.header.some(containsInlineMath)) {
    return true;
  }
  if (Array.isArray(anyToken.rows)) {
    for (const row of anyToken.rows as Token[][]) {
      if (Array.isArray(row) && row.some(containsInlineMath)) return true;
    }
  }
  return false;
}

/** Opening fence: up to three spaces, then three or more of ` or ~. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Closing fence: the same run, at least as long, then nothing but whitespace. */
const FENCE_CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;

/**
 * Whether a fenced-code token's source actually contains its closing fence.
 *
 * `marked` lexes an unterminated fence as a COMPLETE `code` token as soon as the
 * info string is read, so a formula streamed a few characters at a time arrives
 * as a long run of whole tokens, nearly all of them syntactically invalid TeX.
 * The token carries no "closed" flag (probed against marked 18.0.7: the keys are
 * exactly `type`, `raw`, `lang`, `text` whether or not the fence is closed), so
 * `raw` is the only signal. Per CommonMark a closing fence is a line of at least
 * as many of the SAME fence character as the opening, indented at most three
 * spaces, followed by nothing but whitespace.
 */
export function isFenceClosed(raw: string): boolean {
  const lines = raw.split('\n');
  const open = FENCE_OPEN_RE.exec(lines[0]);
  if (!open) return false;
  const marker = open[1][0];
  const minLen = open[1].length;
  for (let i = 1; i < lines.length; i++) {
    const close = FENCE_CLOSE_RE.exec(lines[i]);
    if (close && close[1][0] === marker && close[1].length >= minLen) return true;
  }
  return false;
}

/**
 * Whether this `code` token renders as a typeset formula rather than a CodeBlock.
 *
 * Single source of truth for that decision, because three places have to agree
 * on it: the render arm, the top-level in-place update path, and the blockquote
 * tail path. If the two update paths disagreed with the renderer they would call
 * `setCode` on an entity that is not a CodeBlock, or leave a CodeBlock on screen
 * where a formula belongs.
 *
 * An empty closed fence is deliberately NOT math: it renders as the empty
 * CodeBlock any other empty fence would, rather than as a zero-width image.
 */
export function rendersAsMath(token: Tokens.Code): boolean {
  return (
    MATH_LANGS.has((token.lang ?? '').toLowerCase()) &&
    token.text.trim() !== '' &&
    isFenceClosed(token.raw)
  );
}

/**
 * A cached formula render, or null when one is not available *yet*.
 *
 * Null deliberately means two things at once — "MathJax is not loaded" and "the
 * conversion failed" — because the caller's response to both is identical: show
 * the TeX source in a CodeBlock. Keeping them one signal is what let the render
 * arm stay unchanged when loading became lazy. A cache hit is answered even
 * before MathJax loads, so a formula already converted once (the common case on
 * a re-render, and for the closed fence whose `raw` grows by a trailing newline)
 * never waits on the module.
 *
 * The cache lookup being ahead of the `mathConverter` check is intentional but
 * currently unobservable: `mathConverter` only ever goes null -> set, so nothing
 * can be in the cache while it is still null. Swapping the two lines changes no
 * behaviour today (confirmed by mutation: no test fails). It is written this way
 * so the cache stays authoritative if the converter ever becomes resettable.
 */
export function renderMathToSVGDataURI(
  formula: string,
  displayMode: boolean,
  color: string,
): MathRender | null {
  // The color is part of the key because it is baked into the cached SVG bytes.
  // Keying on the formula alone would serve a re-themed document the previous
  // theme's bitmap, which is invisible rather than merely wrong when the two
  // themes are light and dark.
  const key = `${displayMode ? 1 : 0}\u0000${color}\u0000${formula}`;
  const hit = mathCache.get(key);
  if (hit) return hit;
  if (!mathConverter) return null;
  const converted = mathConverter(formula, displayMode, color);
  if (converted) {
    if (mathCache.size >= MATH_CACHE_LIMIT) {
      const oldest = mathCache.keys().next().value;
      if (oldest !== undefined) {
        // Drop the raster whose render just left the cache, or the decoded
        // bitmap would outlive its conversion and pin memory indefinitely.
        const evicted = mathCache.get(oldest);
        mathCache.delete(oldest);
        if (evicted) inlineMathRasters.delete(evicted.uri);
      }
    }
    mathCache.set(key, converted);
  }
  return converted;
}

/**
 * Padding around the ink, in KaTeX em, passed explicitly to {@link emitSVG}.
 *
 * `emitSVG` defaults to this same value, but it is named and passed here because
 * the box arithmetic below depends on it: the SVG's `width`/`height` attributes
 * include it on all sides while `EmitResult.{width,height,depth}` do not. Taking
 * the default would silently couple this module's geometry to another package's
 * default, and a change there would misalign every formula with nothing pointing
 * at the cause.
 */
const MATH_PAD_EM = 0.05;

/**
 * KaTeX's own font scale, duplicated from `@vectojs/tex`'s `KATEX_FONT_SCALE`.
 *
 * That package exports the same constant, and importing it would be the obvious
 * thing to do — but a value import creates a static module edge and pulls the
 * entire engine into every consumer's entry chunk, which is the one property
 * {@link preloadMathJax}'s dynamic import exists to protect. So it is re-declared
 * here, and `test/mathBoxGeometry.test.ts` asserts the two stay equal by
 * importing both, which is a test-time cost only.
 *
 * The value is upstream's: `.katex { font-size: 1.21em }` in `katex.scss:24`.
 */
const KATEX_FONT_SCALE = 1.21;

/**
 * How many `ex` one KaTeX em is.
 *
 * Two constants compose here. `@vectojs/tex` emits geometry in the span tree's
 * own em, and KaTeX renders at `font-size: 1.21em` (`katex.scss:24`, exported as
 * `KATEX_FONT_SCALE`), so one em of emitted geometry is 1.21x the consumer's font
 * size. {@link EX_PER_EM} then converts the consumer's em to `ex`.
 *
 * Verified against real KaTeX in Chromium rather than derived: four display-mode
 * formulas spanning 1.79–2.93 em of total height all measured **19.3559 px per
 * em at font-size 16** (spread 0.033%), and 19.3559/16 = 1.20975 against the
 * constant's 1.21 — agreement to 0.02%. Width was not re-derived here because
 * KaTeX's `.katex-html` bounding box is the *line* box (a constant 21.00 px at
 * font-size 16 for every inline formula, whatever it contains), which makes a
 * DOM width probe meaningless; Phase 1 had already validated emitted width
 * against real KaTeX to 0.004%.
 */
const EX_PER_KATEX_EM = KATEX_FONT_SCALE / EX_PER_EM;

/**
 * Typeset a formula through `@vectojs/tex` and package it as a {@link MathRender}.
 *
 * `layout` and `emitSVG` are injected rather than imported at module scope so
 * this file holds no static reference to `@vectojs/tex` — a static one would
 * defeat the lazy import in {@link preloadMathJax} and pull the whole engine into
 * every consumer's entry chunk, prose-only ones included.
 *
 * ## Why the box is not `EmitResult`'s box
 *
 * `EmitResult.{width,height,depth}` describe the **ink**. The emitted SVG's
 * `width`/`height` attributes describe the ink **plus `padEm` on all four
 * sides**, and it is the SVG that gets rasterized into the box reserved here —
 * `paintInlineMath` calls `drawImage(bitmap, x, y, box.width, box.height)`, which
 * stretches the whole image to whatever box it is given. Reporting the ink box
 * would therefore squash every formula by the padding, and reporting a depth
 * without the padding would seat every formula `padEm` too high above the
 * baseline. Both are uniform enough to look like a font-metric bug rather than an
 * arithmetic one, so the padding terms are written out explicitly below.
 *
 * ## Degrading
 *
 * Returns `null` on a parse failure and on any glyph the shipped table lacks
 * (`EmitResult.missing`), which the caller renders as TeX source in a CodeBlock.
 * A partially-drawn formula silently missing a symbol is worse than showing the
 * source: the source is at least correct and copyable, whereas `\sum` rendered
 * with its operator absent reads as a different equation.
 */
function convertMathToSVGDataURI(
  formula: string,
  displayMode: boolean,
  color: string,
  layout: TexLayout,
  emitSVG: TexEmit,
): MathRender | null {
  try {
    const emitted = emitSVG(layout(formula, { displayMode }), {
      color,
      padEm: MATH_PAD_EM,
    });

    // A whitelist miss. The engine emits no placement for a glyph it cannot
    // resolve, so the formula would render with that symbol simply absent.
    if (emitted.missing.length > 0) return null;

    const pad2 = MATH_PAD_EM * 2;
    // `btoa` rather than a TextEncoder chain, matching what this did under
    // MathJax: the output is ASCII-safe SVG markup and this runs in a browser.
    const base64 = btoa(unescape(encodeURIComponent(emitted.svg)));
    return {
      uri: `data:image/svg+xml;base64,${base64}`,
      widthEx: (emitted.width + pad2) * EX_PER_KATEX_EM,
      heightEx: (emitted.height + emitted.depth + pad2) * EX_PER_KATEX_EM,
      depthEx: (emitted.depth + MATH_PAD_EM) * EX_PER_KATEX_EM,
    };
  } catch (e) {
    // A TeX parse error, which is the common case: a reader mid-formula in a
    // streamed document has written syntactically invalid TeX in every frame
    // until they finish it.
    console.error('Math typesetting error', e);
    return null;
  }
}

/**
 * One display formula: a `$$..$$` block or a closed ```` ```math ```` fence.
 *
 * A named class rather than a bare {@link MarkdownContainer} because the formula
 * needs a stable handle, and after the switch to an inline object it has none:
 * the typeset raster lives in a `paint` closure captured by the span, so removing
 * the `Image` entity left nothing exposing either the source or the SVG bytes.
 * Devtools, tests, and anything auditing what a formula actually rendered all
 * want that. `markstream-vue` reaches the same conclusion from the DOM side and
 * publishes `data-markstream-mode` on its math node for the same reason.
 *
 * Deliberately carries no typeset-vs-source flag. A formula MathJax has not
 * converted yet renders as a bare {@link CodeBlock} of its TeX, which this class
 * does not wrap — wrapping it would put a container between `content` and a
 * `CodeBlock` that the streamed `setCode` path locates by type. So a flag would
 * have exactly one reachable value, which is the dead-API trap that cost CTX-0208
 * a debugging pass. Add it together with wrapping the fallback, or not at all.
 */
export class MathBlock extends MarkdownContainer {
  /**
   * The TeX source, exactly as written between the delimiters.
   *
   * Also the projected text and the accessible name, so this is the one string a
   * reader can find, select, and copy.
   */
  public readonly formula: string;
  /** The `data:image/svg+xml` URI of the typeset glyphs. */
  public readonly svgUri: string;

  constructor(formula: string, svgUri: string) {
    super();
    this.formula = formula;
    this.svgUri = svgUri;
  }

  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    return {
      kind: 'MathBlock',
      groups: [
        {
          label: 'Math',
          fields: [{ label: 'formula', value: this.formula, readOnly: true }],
        },
      ],
    };
  }
}
