import {
  type InlineObjectBox,
  type InlineObjectSurface,
  type DevtoolsDescriptor,
} from '@vectojs/core';
import type { Token, Tokens } from 'marked';

import { MarkdownContainer } from './markdown-entities';

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
 * MathJax is loaded on demand, the first time a document actually has a formula
 * to typeset.
 *
 * It is by far the heaviest thing this package can pull in: measured 2026-07-30,
 * a browser bundle of a consumer that imports `Markdown` and renders only prose
 * is 2,157,251 bytes (723,602 gzipped), and excluding `mathjax-full` takes that
 * to 337,894 (105,256 gzipped). MathJax is 85% of the bundle, and it used to be
 * unconditional: these were six static imports and the `htmlMathJax` document
 * below was constructed at module scope, so every consumer paid the bytes plus
 * ~155 ms of module evaluation and ~6 ms of setup whether or not any document
 * ever contained a fence. A dynamic import lets a bundler split it into its own
 * chunk (verified with `bun build --splitting`: the entry chunk drops to 725
 * bytes and MathJax lands in separate chunks fetched on first use).
 *
 * The cost of that is real and worth stating plainly: the FIRST formula on a
 * page cannot be typeset synchronously any more. It renders as a CodeBlock of
 * TeX source — the same honest "not typeset yet" state an unclosed fence already
 * uses — and is replaced once the module resolves. Call `preloadMathJax()` and
 * await it before constructing if you need the first formula to be typeset in
 * the same tick. Every formula after the module resolves is synchronous again.
 */
type MathConverter = (formula: string, displayMode: boolean, color: string) => MathRender | null;

let mathConverter: MathConverter | null = null;
let mathLoad: Promise<void> | null = null;

/**
 * Begin (or join) loading MathJax, resolving once formulas typeset synchronously.
 *
 * Idempotent and safe to call from anywhere: the promise is cached, so N callers
 * and N documents share one module load. Rejection is swallowed deliberately —
 * a failed load must degrade to TeX source in a CodeBlock, not reject a caller's
 * `await close()` or leave an unhandled rejection on the page. `mathConverter`
 * simply stays null and every formula keeps rendering as source.
 */

/**
 * Read a named export off a dynamically imported CommonJS module.
 *
 * `mathjax-full` ships CommonJS, and a dynamic import of it does NOT reliably
 * put its exports on the namespace object. Bun's resolver hoists them, so
 * `const { liteAdaptor } = await import(...)` works under vitest — but esbuild
 * (and Rollup/webpack in the same situation) wraps the CJS module and emits only
 * `export default require_liteAdaptor()`, no named exports at all. Verified by
 * reading the generated chunk: `exports.liteAdaptor = liteAdaptor` inside the
 * wrapper, `export default require_liteAdaptor()` outside it, nothing else.
 *
 * So destructuring the namespace directly typechecks, passes every unit test,
 * and then fails in a real browser bundle with `liteAdaptor is not a function`.
 * That is exactly what happened here, and only the real-browser e2e caught it.
 * Prefer the named export when the bundler provided one, fall back to `default`.
 */
function interop<K extends string>(mod: unknown, key: K): Record<K, any> {
  const ns = mod as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  if (typeof ns?.[key] !== 'undefined') return ns as Record<K, any>;
  const fallback = ns?.default;
  if (fallback && typeof fallback[key] !== 'undefined') return fallback as Record<K, any>;
  throw new Error(`mathjax-full module is missing export "${key}"`);
}

export function preloadMathJax(): Promise<void> {
  if (mathLoad) return mathLoad;
  mathLoad = (async () => {
    const [mathjaxMod, texMod, svgMod, adaptorMod, handlerMod, packagesMod] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ]);
    const { mathjax } = interop(mathjaxMod, 'mathjax');
    const { TeX } = interop(texMod, 'TeX');
    const { SVG } = interop(svgMod, 'SVG');
    const { liteAdaptor } = interop(adaptorMod, 'liteAdaptor');
    const { RegisterHTMLHandler } = interop(handlerMod, 'RegisterHTMLHandler');
    const { AllPackages } = interop(packagesMod, 'AllPackages');
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor as never);
    const tex = new TeX({ packages: AllPackages });
    const svg = new SVG({ fontCache: 'local' });
    const htmlMathJax = mathjax.document('', { InputJax: tex, OutputJax: svg });
    mathConverter = (formula, displayMode, color) =>
      convertMathToSVGDataURI(
        formula,
        displayMode,
        (f, d) => adaptor.innerHTML(htmlMathJax.convert(f, { display: d }) as never),
        color,
      );
  })().catch((e) => {
    console.error('MathJax failed to load; formulas will render as TeX source', e);
  });
  return mathLoad;
}

/** Whether formulas can be typeset without waiting. Exposed for tests. */
export function isMathJaxReady(): boolean {
  return mathConverter !== null;
}

/**
 * MathJax's x-height ratio: how many em one `ex` is.
 *
 * Its SVG output uses 1000 internal units per em and reports the box in `ex`, so
 * this is `unitsPerEx / 1000`. Measured 2026-07-31 against `mathjax-full` via
 * `liteAdaptor`: units/ex came out 442.0 for every probed formula, consistently
 * from both the width and height attributes (441.95–442.08). See
 * `tmp/agents/probe-ex-to-px.ts`.
 *
 * This replaced a hardcoded `* 8` whose comment read "1ex is approx 8px in our
 * font size". That constant is exact only near fontSize 18.1px, so it mis-sized
 * every formula at any other size — +13% at this package's own 16px default,
 * +51% at 12px, −43% at 32px.
 */
const EX_PER_EM = 0.4421;

/** Convert a MathJax `ex` measurement to px at a given font size. */
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
 * Unbounded on purpose, unlike {@link mathCache}. Entries are `HTMLImageElement`
 * handles keyed by the URI already held in that bounded cache, so this map cannot
 * outgrow it by more than the formulas a document currently displays. A cap here
 * would evict a bitmap that is still on screen and make it flash back to blank.
 */
const inlineMathRasters = new Map<string, InlineMathRaster>();

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
 * is visible, and only the first call starts a decode.
 */
function ensureInlineMathRaster(uri: string): InlineMathRaster {
  const existing = inlineMathRasters.get(uri);
  if (existing) return existing;

  const entry: InlineMathRaster = { decoded: false };
  inlineMathRasters.set(uri, entry);

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
      if (oldest !== undefined) mathCache.delete(oldest);
    }
    mathCache.set(key, converted);
  }
  return converted;
}

/**
 * Give a MathJax SVG an explicit color so it survives base64 encoding.
 *
 * MathJax paints glyphs with `fill="currentColor"` and `stroke="currentColor"`,
 * which inherits the surrounding CSS color in an inline SVG. This package does
 * not inline it: {@link convertMathToSVGDataURI} base64s the markup into a
 * `data:image/svg+xml` URI and hands it to an `Image`. A data URI is a separate
 * document, so nothing is inherited and `currentColor` falls back to its initial
 * value — black. Against this package's own dark default theme
 * (`textColor: '#e2e8f0'` on a dark surface) that renders every formula
 * invisible, which is what dogfooding an editor demo surfaced.
 *
 * Setting `color` on the root establishes the value `currentColor` resolves to
 * *inside* that isolated document, so the existing `fill`/`stroke` attributes
 * are left untouched and MathJax keeps control of which parts paint.
 *
 * A root `style` already exists on MathJax output (it carries
 * `vertical-align`), so the color is prepended to it when present rather than
 * added as a second attribute — two `style` attributes would leave the second
 * ignored.
 */
function applyMathColor(svg: string, color: string): string {
  const openTag = svg.match(/<svg\b[^>]*>/);
  if (!openTag) return svg;
  const tag = openTag[0];
  const colored = /\bstyle="/.test(tag)
    ? tag.replace(/\bstyle="/, `style="color:${color};`)
    : tag.replace(/^<svg\b/, `<svg style="color:${color}"`);
  return svg.replace(tag, colored);
}

/**
 * Scrape a formula's SVG and intrinsic box out of a typeset call.
 *
 * `typeset` is injected rather than closed over so this stays free of any
 * `mathjax-full` reference — a static one here would defeat the lazy import and
 * pull the whole library back into the entry chunk.
 */
function convertMathToSVGDataURI(
  formula: string,
  displayMode: boolean,
  typeset: (formula: string, displayMode: boolean) => string,
  color: string,
): MathRender | null {
  try {
    const svgString = applyMathColor(typeset(formula, displayMode), color);

    // Parse ex sizes (e.g. width="40.3ex" height="5.2ex")
    const wMatch = svgString.match(/width="([^"]+)ex"/);
    const hMatch = svgString.match(/height="([^"]+)ex"/);
    const wEx = wMatch ? parseFloat(wMatch[1]) : 10;
    const hEx = hMatch ? parseFloat(hMatch[1]) : 2;
    // Depth below the baseline, from `style="vertical-align:-0.486ex"`. Negative
    // in the attribute (CSS raises a positive vertical-align), positive here.
    // Absent for a formula that sits entirely on the baseline.
    const vMatch = svgString.match(/vertical-align:\s*(-?[\d.]+)ex/);
    const depthEx = vMatch ? Math.max(0, -parseFloat(vMatch[1])) : 0;

    // Use btoa since this executes in the browser
    const base64 = btoa(unescape(encodeURIComponent(svgString)));
    return {
      uri: `data:image/svg+xml;base64,${base64}`,
      widthEx: wEx,
      heightEx: hEx,
      depthEx,
    };
  } catch (e) {
    console.error('MathJax error', e);
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
