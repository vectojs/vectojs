import {
  BidiResolver,
  Entity,
  type DevtoolsDescriptor,
  GlyphRasterAtlas,
  type GlyphRasterAtlasStats,
  IRenderer,
  type InlineObjectBox,
  type InlineObjectSurface,
  OBJECT_REPLACEMENT,
  prepareContentGrid,
  type ContentProjection,
  type PreparedContentGrid,
  type StyledSpan,
  type TextStyle,
  SVGEntity,
  beginVectoUserTiming,
  endVectoUserTiming,
  VECTO_USER_TIMING,
} from '@vectojs/core';
import { marked, type Token, type Tokens, type TokensList } from 'marked';
import {
  createStreamController,
  type BoundStreamController,
  type IncompleteMarkdownMode,
  type StreamController,
  type StreamControllerOptions,
} from './StreamController';

/**
 * Monotonic clock, falling back to `Date.now` where `performance` is absent.
 *
 * Used only for the streaming stats, so a coarse fallback is acceptable — but the
 * fallback matters: a worker round trip under 1ms would read as 0 and make the
 * total look like the worker cost nothing.
 */
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function lexMarkdown(text: string, userTiming: boolean): TokensList {
  if (!userTiming) return marked.lexer(text);
  const timing = beginVectoUserTiming(VECTO_USER_TIMING.markdown.parse);
  try {
    return marked.lexer(text);
  } finally {
    if (timing) endVectoUserTiming(timing);
  }
}

marked.use({
  extensions: [
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) {
        return src.match(/(?<![\\$])\$(?![$\s])/)?.index;
      },
      tokenizer(src) {
        // Guard against currency: "$5 to $10" must NOT become one math span.
        // Require, à la pandoc: the opening `$` is not `$$` and is immediately
        // followed by a non-space, non-digit; the content has no literal `$`
        // (only escaped `\$`) and no newline; the closing `$` is preceded by a
        // non-space and not followed by a digit. So "$x+1$" is math, but "$5",
        // "$5 to $10", "$$", and "cost $9 each" are not.
        const match = /^\$(?![$\s\d])((?:\\\$|[^$\n])*?)(?<!\s)\$(?!\d)/.exec(src);
        if (match) {
          return {
            type: 'inlineMath',
            raw: match[0],
            text: match[1].trim(),
          };
        }
        return undefined;
      },
      renderer(token) {
        return token.raw;
      },
    },
  ],
});

import { measureText, RichText, Stack, Table, Text, Image, UIComponent } from '@vectojs/ui';

// @ts-ignore
import { WORKER_SOURCE_STRING } from './MarkdownWorkerSource';

// ── MathJax Setup ────────────────────────────────────────────────────────────

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
type MathConverter = (formula: string, displayMode: boolean) => MathRender | null;

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
    mathConverter = (formula, displayMode) =>
      convertMathToSVGDataURI(formula, displayMode, (f, d) =>
        adaptor.innerHTML(htmlMathJax.convert(f, { display: d }) as never),
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
function exToPx(ex: number, fontSize: number): number {
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
function fontSizeFromFont(font: string): number | undefined {
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
function paintInlineMath(uri: string, surface: InlineObjectSurface, box: InlineObjectBox): void {
  const raster = ensureInlineMathRaster(uri);
  if (!raster.decoded || !raster.bitmap) return;
  surface.drawImage(raster.bitmap, box.x, box.y, box.width, box.height);
}

const MATH_LANGS = new Set(['math', 'latex', 'tex']);

/**
 * Whether a token subtree contains an `inlineMath` token.
 *
 * Recursive because inline math nests: inside `strong`/`em`, a link's children, a
 * list item's tokens, a blockquote, or a table cell. Used only to decide whether
 * to start the lazy MathJax load, so a false negative delays typesetting rather
 * than corrupting output — but a missed nesting site means a formula in, say, a
 * table cell never typesets at all.
 */
function containsInlineMath(token: Token): boolean {
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
function isFenceClosed(raw: string): boolean {
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
/**
 * Whether a paragraph renders as a `Stack` of runs and images rather than one
 * `RichText`.
 *
 * The same test the `paragraph` render arm uses, so the reconciler and the
 * renderer cannot disagree about which shape a token produces.
 */
function paragraphHasImage(token: Tokens.Paragraph): boolean {
  return token.tokens?.some((child) => child.type === 'image') === true;
}

/** Index of the last `image` token in an inline run, or -1 if there is none. */
function lastIndexOfImage(tokens: Token[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === 'image') return i;
  }
  return -1;
}

/**
 * How many `Stack` children the paragraph render arm builds for an inline run.
 *
 * One child per image, plus one per *maximal run* of consecutive non-image
 * tokens — the arm merges those into a single `RichText` via `flushText`, so this
 * is not `tokens.length`. Kept in lockstep with that arm; it is what
 * `updateImageParagraph` checks to confirm the entity it was handed is the one
 * built for the old tokens.
 */
function expectedImageParagraphChildren(tokens: Token[]): number {
  let children = 0;
  let inTextRun = false;
  for (const token of tokens) {
    if (token.type === 'image') {
      children++;
      inTextRun = false;
    } else if (!inTextRun) {
      children++;
      inTextRun = true;
    }
  }
  return children;
}

function rendersAsMath(token: Tokens.Code): boolean {
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
function renderMathToSVGDataURI(formula: string, displayMode: boolean): MathRender | null {
  const key = `${displayMode ? 1 : 0}\u0000${formula}`;
  const hit = mathCache.get(key);
  if (hit) return hit;
  if (!mathConverter) return null;
  const converted = mathConverter(formula, displayMode);
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
): MathRender | null {
  try {
    const svgString = typeset(formula, displayMode);

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

// ── Worker Setup ─────────────────────────────────────────────────────────────

let markdownWorker: Worker | null = null;
let workerIdCounter = 0;
// Distinguishes Markdown instances in the worker's prior-raws cache (one worker
// is shared by every instance on the page).
let workerInstanceCounter = 0;
// `cb` receives (matchLen, tail): the caller's own tokens[0..matchLen) are
// still valid (unchanged raw source) and only `tail` is new — see the
// matching comment in MarkdownWorker.ts for why the worker sends a diff
// instead of the full re-lexed tree on every call.
// `cb`'s third argument says the result came from the main-thread fallback lexer
// rather than the worker, which matters because the worker's copy of the source
// is then behind and the next request must not send a delta against it.
// `onNeedResync` is invoked instead of `cb` when the worker reports that what it
// holds for this instance (prior token raws, or the document source itself) is
// missing or stale; the requester re-dispatches once with both attached.
/**
 * What the worker's lex actually cost, as opposed to how much of the token array
 * survived the diff. Absent on the main-thread fallback path, which does its own
 * lexing and is timed by the caller.
 */
interface LexCost {
  /** Wall-clock ms inside `marked.lexer()`. */
  lexerMs: number;
  /** Characters handed to the lexer — the WHOLE accumulated source, every time. */
  sourceCharsLexed: number;
}

const workerCallbacks = new Map<
  number,
  {
    cb: (matchLen: number, tail: TokensList, local?: boolean, lex?: LexCost) => void;
    onNeedResync?: () => void;
    /**
     * This request produced no update at all and never will — the worker failed
     * AND the main-thread fallback lexer threw too. The requester's in-flight
     * bookkeeping has to be cleared by something, or a `close()` awaiting
     * settlement would wait on a reply that can no longer come.
     */
    onDropped?: () => void;
    text: string;
    userTiming: boolean;
  }
>();

/**
 * The worker failed for this request (lexer threw, or the worker itself
 * died). Dropping the callback would lose that update for good — for the
 * final chunk of a stream that means content that never renders. Parse on
 * the main thread instead; it is the exact code path the no-Worker
 * environments already use. No prefix to trust here (this is a fresh local
 * parse, not a diff against the caller's own snapshot), so treat the whole
 * result as new — the caller's own `updateTokens` still reconciles it
 * correctly, just without the transfer-size saving for this one call.
 */
function runSyncFallback(entry: {
  cb: (matchLen: number, tail: TokensList, local?: boolean, lex?: LexCost) => void;
  onDropped?: () => void;
  text: string;
  userTiming: boolean;
}): void {
  try {
    // `local: true` — the worker did not produce this, so it never saw this
    // source and the requester must resync before it can send a delta again.
    entry.cb(0, lexMarkdown(entry.text, entry.userTiming), true);
  } catch (err) {
    console.warn('Markdown sync fallback parse failed', err);
    // Both paths are gone, so no update will ever land for this request. Tell the
    // requester, or its in-flight flag stays set forever and anything awaiting
    // settlement (a `close()`) never resolves.
    entry.onDropped?.();
  }
}

if (typeof Worker !== 'undefined') {
  try {
    const blob = new Blob([WORKER_SOURCE_STRING], {
      type: 'application/javascript',
    });
    markdownWorker = new Worker(URL.createObjectURL(blob));
    markdownWorker.onmessage = (e) => {
      const { id, matchLen, tail, error, needResync, lexerMs, sourceCharsLexed } = e.data;
      const entry = workerCallbacks.get(id);
      if (entry) {
        workerCallbacks.delete(id);
        if (needResync && entry.onNeedResync) {
          // The worker can't trust what it holds — retry with the full text and
          // the prior raws attached.
          entry.onNeedResync();
        } else if (needResync) {
          // No retry path (shouldn't happen); parse locally rather than drop it.
          runSyncFallback(entry);
        } else if (!error) {
          entry.cb(matchLen as number, tail as TokensList, false, {
            lexerMs: typeof lexerMs === 'number' ? lexerMs : 0,
            sourceCharsLexed: typeof sourceCharsLexed === 'number' ? sourceCharsLexed : 0,
          });
        } else {
          runSyncFallback(entry);
        }
      }
    };
    markdownWorker.onerror = () => {
      // The worker itself crashed: flush every pending request synchronously
      // and stop routing to it.
      const pending = [...workerCallbacks.values()];
      workerCallbacks.clear();
      markdownWorker = null;
      for (const entry of pending) runSyncFallback(entry);
    };
  } catch (err) {
    console.warn('Failed to initialize MarkdownWorker', err);
  }
}

// ── Theme ────────────────────────────────────────────────────────────────────

/** Color and typography theme for Markdown rendering. */
export interface MarkdownTheme {
  /** Body text color. */
  textColor?: string;
  /** Heading text color. */
  headingColor?: string;
  /** Code text color (inline + block). */
  codeColor?: string;
  /** Code block background color. */
  codeBgColor?: string;
  /** Blockquote border/accent color. */
  quoteBorderColor?: string;
  /** Blockquote text color. */
  quoteTextColor?: string;
  /** Horizontal-rule color. */
  hrColor?: string;
  /** Table background color. */
  tableBgColor?: string;
  /** Table header background color. */
  tableHeaderBgColor?: string;
  /** Body font. */
  bodyFont?: string;
  /** Monospace font for code. */
  codeFont?: string;
  /** Base font size in px. */
  fontSize?: number;
}

const DEFAULT_THEME: Required<MarkdownTheme> = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: 'rgba(30, 41, 59, 0.85)',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#94a3b8',
  hrColor: 'rgba(148, 163, 184, 0.3)',
  tableBgColor: 'rgba(15, 15, 25, 0.4)',
  tableHeaderBgColor: 'rgba(255, 255, 255, 0.08)',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
};

// ── Helper entities ──────────────────────────────────────────────────────────

/** A thin horizontal line (for `<hr>`). */
class HorizontalRule extends Entity {
  color: string;
  constructor(w: number, color: string) {
    super();
    this.width = w;
    this.height = 1;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(this.width, 0);
    r.stroke(this.color, 1);
  }
}

/** A vertical accent bar for blockquotes. */
class QuoteBorder extends Entity {
  color: string;
  constructor(height: number, color: string) {
    super();
    this.width = 4;
    this.height = height;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 2);
    r.fill(this.color);
  }
}

/** A simple concrete container entity for nested layouts. */
class MarkdownContainer extends Entity {
  isPointInside(_globalX: number, _globalY: number): boolean {
    return false;
  }
  render(_r: any): void {}
}

// ── Code block with syntax-keyword highlighting ─────────────────────────────

/** Keyword sets for basic syntax highlighting. */
const KEYWORD_SETS: Record<string, Set<string>> = {
  js: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
  ]),
  ts: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
    'type',
    'interface',
    'enum',
    'as',
    'is',
    'readonly',
    'implements',
    'abstract',
    'public',
    'private',
    'protected',
    'static',
    'void',
    'never',
    'any',
    'unknown',
  ]),
  py: new Set([
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'import',
    'from',
    'as',
    'with',
    'try',
    'except',
    'raise',
    'finally',
    'pass',
    'break',
    'continue',
    'and',
    'or',
    'not',
    'in',
    'is',
    'None',
    'True',
    'False',
    'yield',
    'lambda',
    'global',
    'nonlocal',
    'del',
    'assert',
    'async',
    'await',
  ]),
  rust: new Set([
    'fn',
    'let',
    'mut',
    'const',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'match',
    'return',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'use',
    'mod',
    'crate',
    'self',
    'super',
    'where',
    'as',
    'in',
    'ref',
    'move',
    'async',
    'await',
    'true',
    'false',
    'type',
    'unsafe',
    'extern',
    'dyn',
    'static',
  ]),
};

// Aliases
KEYWORD_SETS['javascript'] = KEYWORD_SETS['js'];
KEYWORD_SETS['typescript'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['python'] = KEYWORD_SETS['py'];
KEYWORD_SETS['rs'] = KEYWORD_SETS['rust'];

/** Segment of highlighted code text. */
interface CodeSegment {
  text: string;
  color: string;
}

/** Tokenize a line of code into colored segments (keyword / string / comment / default). */
function highlightLine(line: string, lang: string, theme: Required<MarkdownTheme>): CodeSegment[] {
  const keywords = KEYWORD_SETS[lang];
  if (!keywords) {
    return [{ text: line, color: theme.codeColor }];
  }

  const segments: CodeSegment[] = [];
  const KEYWORD_COLOR = '#c084fc'; // purple-ish
  const STRING_COLOR = '#86efac'; // green
  const COMMENT_COLOR = '#64748b'; // slate
  const NUMBER_COLOR = '#fbbf24'; // amber

  let i = 0;
  let buf = '';

  const flush = (color: string) => {
    if (buf) {
      segments.push({ text: buf, color });
      buf = '';
    }
  };

  while (i < line.length) {
    const ch = line[i];

    // Single-line comment
    if (ch === '/' && line[i + 1] === '/') {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }
    // Python / Rust comment
    if (ch === '#' && (lang === 'py' || lang === 'python' || lang === 'rust' || lang === 'rs')) {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }

    // Strings. Only colored when the quote actually CLOSES on this line —
    // otherwise a stray quote (a Rust lifetime `&'a str`, an apostrophe in an
    // identifier or trailing prose, a generic `'` in shell) would swallow the
    // whole rest of the line as a green "string". An unterminated quote falls
    // through and is treated as ordinary punctuation.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2; // skip the escape and whatever it escapes
          continue;
        }
        if (line[j] === quote) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        flush(theme.codeColor);
        segments.push({ text: line.slice(i, j + 1), color: STRING_COLOR });
        i = j + 1; // past the closing quote
        continue;
      }
      // Unterminated: emit as plain text and move on.
      buf += ch;
      i++;
      continue;
    }

    // Numbers
    if (/\d/.test(ch) && (i === 0 || /[\s(,=+\-*/<>[\]{}:;]/.test(line[i - 1]))) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[\d._xXa-fA-F]/.test(line[j])) j++;
      segments.push({ text: line.slice(i, j), color: NUMBER_COLOR });
      i = j;
      continue;
    }

    // Word boundaries (potential keywords)
    if (/[a-zA-Z_]/.test(ch)) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      segments.push({
        text: word,
        color: keywords.has(word) ? KEYWORD_COLOR : theme.codeColor,
      });
      i = j;
      continue;
    }

    buf += ch;
    i++;
  }

  flush(theme.codeColor);
  return segments;
}

// ── Single CodeBlock entity ─────────────────────────────────────────────────

/**
 * A single self-rendering entity for fenced code blocks.
 *
 * Replaces the old N×M child-entity explosion (Container → Stack → Text per
 * segment per line) with a flat leaf that draws its own background + text.
 */
export class CodeBlock extends UIComponent {
  private lines: CodeSegment[][];
  private grid: PreparedContentGrid | null = null;
  /** Raw (unhighlighted) lines of the last build, for prefix reuse in buildLines. */
  private rawLines: string[] | null = null;
  private cellWidth = 0;
  private source: string;

  private lang: string;
  private theme: Required<MarkdownTheme>;
  private lineH = 24;
  private pad = 18;
  private codeFont: string;
  public selectable: boolean;

  constructor(
    code: string,
    lang: string,
    maxWidth: number,
    theme: Required<MarkdownTheme>,
    selectable = true,
  ) {
    super();
    this.source = code;
    this.lang = lang;
    this.theme = theme;
    this.codeFont = `15px ${theme.codeFont}`;
    this.selectable = selectable;

    this.lines = [];
    this.width = maxWidth;
    this.buildLines(code);
  }

  /** Re-parse code content (e.g. for live editing). */
  setCode(code: string, lang?: string): this {
    if (lang !== undefined) this.lang = lang;
    this.source = code;
    this.buildLines(code);
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native selection for this code block. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    this.scene?.markDirty();
    return this;
  }

  public override getContentProjection(): ContentProjection | null {
    if (!this.source) return null;
    const grid = this.ensureGrid();
    return {
      text: this.source,
      font: this.codeFont,
      lineHeight: this.lineH,
      // Every row is absolutely positioned from the same local coordinates as
      // render(). A single pre-wrap DOM text node would introduce browser
      // wrapping for long source lines that canvas intentionally keeps intact.
      lines: grid.lines.map((line, row) => ({
        text: this.source.slice(line.sourceStart, line.sourceEnd),
        separatorAfter: this.source.slice(line.sourceEnd, line.nextSourceStart) || undefined,
        x: this.pad,
        y: this.pad + row * this.lineH,
        baseline: this.lineH * 0.75,
        font: this.codeFont,
        lineHeight: this.lineH,
      })),
      selectable: this.selectable,
      // render() draws cell-by-cell (no ligatures can form); the DOM copy
      // must not ligate either or Firefox selection geometry drifts.
      ligatures: 'none',
      grid,
    };
  }

  /**
   * Re-highlight the code, reusing the highlight of any unchanged line prefix.
   *
   * Streaming appends to the END of a block, so all but the last line or two are
   * byte-identical to the previous call — yet this used to re-highlight every
   * line on every chunk, making a streamed block O(N) per append and O(N^2)
   * overall. Reusing the stable prefix makes an append proportional to what
   * actually changed.
   *
   * The last previously-seen line is deliberately NOT reused: a chunk usually
   * lands mid-line, so that line's text (and therefore its tokenization) changes.
   */
  private buildLines(code: string): void {
    const rawLines = code.split(/\r\n|\r|\n/);
    const previous = this.rawLines;
    // Longest identical prefix, excluding the previous last line (see above).
    let reusable = 0;
    if (previous && this.lines.length === previous.length) {
      const limit = Math.min(previous.length - 1, rawLines.length);
      while (reusable < limit && previous[reusable] === rawLines[reusable]) reusable++;
    }

    if (reusable > 0) {
      const next = this.lines.slice(0, reusable);
      for (let i = reusable; i < rawLines.length; i++) {
        next.push(highlightLine(rawLines[i]!, this.lang, this.theme));
      }
      this.lines = next;
    } else {
      this.lines = rawLines.map((l) => highlightLine(l, this.lang, this.theme));
    }

    this.rawLines = rawLines;
    this.grid = null;
    this.height = this.pad * 2 + rawLines.length * this.lineH;
  }

  private ensureGrid(): PreparedContentGrid {
    const cellWidth = this.cellWidth || Math.max(1, measureText('M', this.codeFont));
    if (
      !this.grid ||
      this.grid.source !== this.source ||
      this.grid.font !== this.codeFont ||
      this.grid.cellWidth !== cellWidth
    ) {
      this.grid = prepareContentGrid(this.source, {
        font: this.codeFont,
        cellWidth,
        lineHeight: this.lineH,
        baseline: this.lineH * 0.75,
      });
    }
    return this.grid;
  }

  /** Code blocks are decorative — not interactive. */
  isPointInside(): boolean {
    return false;
  }

  render(r: IRenderer): void {
    // Background
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this.theme.codeBgColor);

    const grid = this.ensureGrid();

    // Per-cluster grid drawing: every grapheme cluster is its own fillText at
    // col × cellWidth. Positioning whole segments on the grid is not enough —
    // Firefox applies OpenType ligatures on Canvas2D (Chrome doesn't), so a
    // run like "ffi affinity" ligates internally, compresses, and leaves a
    // gap before the next segment. Ligatures cannot form across separate
    // fillText calls, which makes the drawn grid identical in every browser
    // (canvas textRendering:'optimizeSpeed' would be cheaper, but Firefox —
    // the one engine that needs it — doesn't implement it). Wide CJK/emoji
    // clusters advance two cells, terminal wcwidth-style, so following
    // tokens no longer overlap them.
    // Where the renderer can blit a source rect, draw each cluster from a shared
    // glyph atlas instead. Identical call count and geometry, but ~2x cheaper per
    // call on both engines because the source texture never changes. A
    // per-run-canvas cache was measured *slower* than fillText on Chrome at scale
    // (0.87x at 40k cells) for exactly that reason — see
    // `forge/baselines/raster-cache-findings.md`.
    const atlas = codeGlyphAtlas(r);
    const atlasSource = atlas?.source ?? null;
    const blit = atlas ? r.drawImageRect : undefined;

    for (let row = 0; row < grid.lines.length; row++) {
      const yBaseline = this.pad + row * this.lineH + this.lineH * 0.75;
      const segments = this.lines[row];
      let segmentIndex = 0;
      let segmentEnd = segments[0]?.text.length ?? 0;
      const lineStart = grid.lines[row].sourceStart;
      for (const cell of grid.lines[row].cells) {
        const localSourceStart = cell.sourceStart - lineStart;
        while (segmentIndex < segments.length - 1 && localSourceStart >= segmentEnd) {
          segmentIndex++;
          segmentEnd += segments[segmentIndex].text.length;
        }
        const sourceText = this.source.slice(cell.sourceStart, cell.sourceEnd);
        if (cell.advance <= 0 || sourceText === ' ' || sourceText === '\t') continue;
        const color = segments[segmentIndex]?.color ?? this.theme.codeColor;
        const x = this.pad + cell.x;

        if (blit && atlas) {
          const slot = atlas.get(this.codeFont, color, cell.glyph);
          // `atlas.source` is null until the first successful rasterization, so
          // it is read per cell rather than hoisted — the first cell of the first
          // frame is what creates it.
          const src = atlasSource ?? atlas.source;
          if (slot && src) {
            // Destination offsets mirror the fillText baseline convention, so the
            // blit lands exactly where the glyph would have been drawn.
            blit.call(
              r,
              src,
              slot.sx,
              slot.sy,
              slot.sw,
              slot.sh,
              x - slot.offsetX,
              yBaseline - slot.offsetY,
              slot.w,
              slot.h,
            );
            continue;
          }
          // Anything the atlas declined (a cluster too large to pack, a headless
          // context) falls through to fillText below.
        }
        r.fillText(cell.glyph, x, yBaseline, this.codeFont, color);
      }
    }
  }
}

/**
 * The process-wide glyph atlas for code blocks, created on first use.
 *
 * Shared rather than per-`CodeBlock` so a document's glyph set is rasterized once:
 * streamed markdown creates many code blocks over the same font and theme, and a
 * per-instance atlas would re-rasterize for each, discarding the reuse the whole
 * approach depends on. Slots carry `(font, colour, glyph)`, so multiple themes or
 * font sizes coexist correctly and merely occupy more slots.
 *
 * Returns `undefined` when the renderer cannot blit a sub-rect (`SVGRenderer`, or
 * any renderer omitting the optional method), leaving the caller on `fillText` —
 * which is also the correct output for a vector export.
 */
let sharedCodeAtlas: GlyphRasterAtlas | null = null;
function codeGlyphAtlas(r: IRenderer): GlyphRasterAtlas | undefined {
  if (typeof r.drawImageRect !== 'function') return undefined;
  if (typeof document === 'undefined') return undefined;
  sharedCodeAtlas ??= new GlyphRasterAtlas({
    // Match the display so a HiDPI blit stays crisp. Capped at 3 because atlas
    // area grows with dpr² and a 4x display would otherwise blow the size cap
    // with a few hundred glyphs.
    dpr: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1,
    maxSize: 2048,
  });
  return sharedCodeAtlas;
}

/**
 * Instrumentation for the shared code-block glyph atlas, or `null` before first
 * use.
 *
 * Exposed so an app or benchmark can confirm the atlas is actually active and
 * reusing slots. Watch `resets`: a steadily climbing count means the glyph set is
 * unbounded for the atlas size, so every reset re-rasterizes everything and the
 * atlas is doing net harm rather than saving work.
 */
export function codeAtlasStats(): GlyphRasterAtlasStats | null {
  return sharedCodeAtlas ? sharedCodeAtlas.stats : null;
}

/**
 * The shared code-block atlas itself, or `null` before first use.
 *
 * For instrumentation that must map a traced `drawImage` back to the glyph it
 * painted — a blit carries only a source rect, so `slotAt()` is the only way to
 * recover the cluster and its metrics. Used by `e2e/text-projection.e2e.ts` to
 * keep the code-grid positioning assertions working on the blit path.
 */
export function codeAtlas(): GlyphRasterAtlas | null {
  return sharedCodeAtlas;
}

// ── Inline token → RichText entities ─────────────────────────────────────────

/** Decode basic HTML entities that `marked` emits in token text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Recursively walk the inline token tree, accumulating {@link StyledSpan}s
 * with inherited style overrides (bold, italic, etc.).
 */
function collectSpans(
  tokens: Token[],
  inherited: TextStyle,
  theme: Required<MarkdownTheme>,
  out: StyledSpan[],
  /**
   * The size the enclosing block is drawn at, when it is not the theme body size.
   *
   * Only inline math uses it: `ex` is font-relative, so a formula's reserved box
   * has to be resolved against the size of the run it sits in. A heading carries
   * its size in its `font` string rather than in any span style, so it cannot be
   * recovered from `inherited`.
   */
  blockFontSize?: number,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const t = token as Tokens.Strong;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, bold: true }, theme, out, blockFontSize);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, bold: true },
          });
        }
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, italic: true }, theme, out, blockFontSize);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, italic: true },
          });
        }
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        out.push({
          text: decodeEntities(t.text),
          // Inline code renders in the theme's monospace family (not just tinted
          // prose) — TextStyle.fontFamily drives both measurement and drawing.
          style: {
            ...inherited,
            color: theme.codeColor,
            fontFamily: theme.codeFont,
          },
        });
        break;
      }
      case 'br': {
        // Hard break (trailing `\` / double space). The layout engine treats
        // `\n` as a paragraph break, so a newline span renders it.
        out.push({ text: '\n' });
        break;
      }
      case 'html': {
        // Inline HTML. `<br>` is the one tag with an inline-text meaning —
        // table cells rely on it for line breaks (`| a<br>b |`). Everything
        // else is markup: never print raw tags as visible text.
        const t = token as Tokens.HTML;
        const raw = t.raw ?? t.text ?? '';
        const brCount = (raw.match(/<br\s*\/?>/gi) ?? []).length;
        for (let i = 0; i < brCount; i++) out.push({ text: '\n' });
        break;
      }
      case 'inlineMath': {
        const t = token as any;
        // Typeset into a reserved inline box when MathJax is available. The run's
        // own size drives the conversion, so `$x$` inside a heading scales with
        // the heading rather than with body prose.
        const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
        const rendered = renderMathToSVGDataURI(t.text, false);
        if (rendered) {
          // Bound outside the painter so the closure captures the URI rather than
          // the whole `MathRender`, and so it cannot see a later loop iteration's.
          const uri = rendered.uri;
          out.push({
            text: OBJECT_REPLACEMENT,
            style: inherited,
            object: {
              width: exToPx(rendered.widthEx, runSize),
              height: exToPx(rendered.heightEx, runSize),
              depth: exToPx(rendered.depthEx, runSize),
              // The TeX source is the accessible name: without it a screen reader
              // receives only the invisible U+FFFC sentinel.
              alt: t.text,
              // Without this the box is reserved and stays empty. The engine does
              // not draw objects, and nothing else in the tree holds the raster.
              paint: (surface, box) => paintInlineMath(uri, surface, box),
            },
          });
        } else {
          // MathJax has not loaded yet, or conversion failed. Keep the previous
          // styled-source rendering; `ensureMathJax()` retypesets from tokens once
          // the library lands, so for a document that is merely waiting this is a
          // transient state rather than the final output.
          out.push({
            text: decodeEntities(t.raw),
            style: { ...inherited, color: '#fcd34d' },
          }); // yellow/gold for inline math
        }
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        // Recurse into link children (they may contain bold/italic/code)
        const linkStyle: TextStyle = {
          ...inherited,
          href: t.href,
          color: '#38bdf8',
        };
        if (t.tokens && t.tokens.length > 0) {
          collectSpans(t.tokens, linkStyle, theme, out, blockFontSize);
        } else {
          out.push({ text: decodeEntities(t.text), style: linkStyle });
        }
        break;
      }
      case 'text': {
        const t = token as Tokens.Text;
        // Text tokens may themselves contain nested inline tokens (e.g. from
        // paragraph splitting).  Recurse when present.
        if ('tokens' in t && (t as any).tokens?.length) {
          collectSpans((t as any).tokens, inherited, theme, out, blockFontSize);
        } else {
          const decoded = decodeEntities(t.text);
          if (decoded) {
            const style = Object.keys(inherited).length > 0 ? inherited : undefined;
            out.push({ text: decoded, style });
          }
        }
        break;
      }
      default: {
        // Fallback: grab raw `.text` if available
        if ('text' in token) {
          const decoded = decodeEntities((token as any).text);
          if (decoded) {
            const style = Object.keys(inherited).length > 0 ? inherited : undefined;
            out.push({ text: decoded, style });
          }
        }
        break;
      }
    }
  }
}

/**
 * One trailing inline construct that has opened but not closed yet.
 *
 * `at` is the index in the scanned text of the construct's first syntax
 * character, so the caller can split there: everything before it keeps whatever
 * `marked` already decided, everything after it is the construct's content.
 */
interface UnclosedInline {
  kind: 'strong' | 'em' | 'codespan' | 'link';
  /** Index of the opening marker's first character. */
  at: number;
  /** Index just past the opening marker, where the content starts. */
  contentAt: number;
}

/**
 * Find the last unclosed inline construct in one trailing text run.
 *
 * Only ever called with the text of the FINAL inline token of the document's
 * final paragraph. That is the only place an unclosed construct can be: a
 * construct that closed is already its own `strong`/`em`/`codespan`/`link`
 * token, so whatever syntax characters survive into a plain text token are
 * exactly the ones `marked` could not pair up.
 *
 * Returns `null` when nothing plausible is open, which is the common case and
 * must stay cheap — this runs once per streamed chunk.
 */
function findUnclosedInline(text: string): UnclosedInline | null {
  let best: UnclosedInline | null = null;

  // Backtick first, and it wins outright. Inside a code span nothing else is
  // syntax, so an emphasis marker to the right of an open backtick is content,
  // not a competing candidate.
  const tick = text.lastIndexOf('`');
  if (tick !== -1 && tick < text.length - 1) {
    return { kind: 'codespan', at: tick, contentAt: tick + 1 };
  }
  if (tick !== -1) return null;

  // `**bo` / `*it`, and the `_` forms. Two requirements, both load-bearing:
  // the marker run must be WHOLE (`\*{1,2}(?!\*)`), or `**` alone matches as a
  // single `*` opening on a content of `*` and renders one italic asterisk; and
  // it must be followed by a non-space, since CommonMark cannot open emphasis on
  // `* ` and a marker with nothing after it has no content to style.
  const emphasis = /(\*{1,2}(?!\*)|_{1,2}(?!_))(?=[^\s])/g;
  for (let match = emphasis.exec(text); match !== null; match = emphasis.exec(text)) {
    const marker = match[1];
    const at = match.index;
    // `_` cannot open emphasis intraword (`snake_case`, `a_b`), so requiring a
    // boundary before it is what keeps identifiers from turning italic
    // mid-stream. `*` has no such restriction in CommonMark.
    if (marker[0] === '_' && at > 0 && /[\w]/.test(text[at - 1])) continue;
    best = {
      kind: marker.length === 2 ? 'strong' : 'em',
      at,
      contentAt: at + marker.length,
    };
  }

  // `[label](url` — an unmatched `[` with no completed `](…)` after it. Checked
  // last and only when it opens to the right of any emphasis candidate, for the
  // same reason backticks win: the later opener is the one still collecting text.
  const bracket = text.lastIndexOf('[');
  if (bracket !== -1 && bracket < text.length - 1 && (best === null || bracket > best.at)) {
    const closed = /\]\([^)]*\)/.test(text.slice(bracket));
    if (!closed) {
      best = { kind: 'link', at: bracket, contentAt: bracket + 1 };
    }
  }

  return best;
}

/** Parse inline markdown tokens and produce a {@link RichText} entity. */
function renderInlineToRichText(
  tokens: Token[] | undefined,
  fallbackText: string,
  font: string,
  color: string,
  maxWidth: number,
  theme: Required<MarkdownTheme>,
  selectable: boolean,
  onLinkClick?: (url: string) => void,
): RichText {
  const spans: StyledSpan[] = [];
  if (tokens && tokens.length > 0) {
    // `blockFontSize` carries the block's own size to the inline-math arm. A
    // heading's size lives only in this `font` string — its spans carry no
    // `fontSize` — so without it an `$x$` in an `h1` would reserve a body-sized
    // box. Passed as its own argument rather than seeded into `inherited` so no
    // text span gains an explicit fontSize it did not have before, which would
    // change every heading's paragraph-memo key.
    collectSpans(tokens, {}, theme, spans, fontSizeFromFont(font));
  }
  // Fallback: if no spans were produced, use the raw text
  if (spans.length === 0) {
    spans.push({ text: decodeEntities(fallbackText) });
  }
  return new RichText(spans, {
    font,
    color,
    maxWidth,
    linkColor: '#38bdf8',
    selectable,
    onLinkClick,
  });
}

// ── Main Markdown component ─────────────────────────────────────────────────

export interface MarkdownOptions {
  maxWidth?: number;
  theme?: MarkdownTheme;
  onLinkClick?: (url: string) => void;
  /** Allow browser-native drag selection and copy for rendered text. Default `true`. */
  selectable?: boolean;
  /** Emit a `vecto:markdown:parse` User Timing measure. Default `false`. */
  userTiming?: boolean;
}

interface BlockMetrics {
  marginBefore: number;
  marginAfter: number;
  indentStart: number;
  availableWidth: number;
}

/**
 * Renders Markdown content into a VectoJS entity tree using {@link marked}.
 *
 * Supported token types:
 * - **Headings** (h1–h6) with scaled font sizes
 * - **Paragraphs** with word-wrapping
 * - **Code blocks** with syntax-keyword highlighting and a rounded background
 * - **Blockquotes** with a left accent bar
 * - **Unordered / ordered lists** with bullets / numbers
 * - **Horizontal rules**
 * - **Inline code** (via backticks)
 *
 * @example
 * const md = new Markdown('# Hello\\nSome *text*', { maxWidth: 600 });
 * scene.add(md.setPosition(40, 40));
 */
export class Markdown extends UIComponent {
  public content: Stack;
  public maxWidth: number;
  public theme: Required<MarkdownTheme>;
  public onLinkClick?: (url: string) => void;
  public selectable: boolean;
  private activeBlockMetrics: BlockMetrics | null = null;
  /**
   * Called after a streamed append has re-laid-out the document.
   *
   * Not required for a `VirtualList` to track a streaming row's height: the list
   * re-reads `height` on every mounted row each frame, so it sees this entity grow
   * without being told. Prefer that over wiring this up — it fires from the append
   * path only, **not** from `setContent()`, so it is not a complete size signal.
   */
  public onLayoutUpdated?: () => void;
  private rawMarkdown: string;
  private streamController: BoundStreamController | null = null;
  /**
   * Trailing-unclosed-syntax policy of the active stream, or `'literal'` when no
   * stream is open.
   *
   * Held here rather than read back off the controller because it is a rendering
   * concern: `StreamController` owns buffering and pacing and has no view of the
   * entity tree, while the guess is a transform applied where spans are built.
   */
  private streamIncompleteMode: IncompleteMarkdownMode = 'literal';
  /** End-of-stream callback of the active stream, if it supplied one. */
  private streamOnStable: ((blocks: readonly Entity[]) => void) | null = null;
  /**
   * The trailing paragraph entity currently showing an optimistic guess, plus the
   * token it was rendered from.
   *
   * Both halves are needed. The entity is what must be re-rendered to drop the
   * guess; the token is what it must be re-rendered FROM, and it is the only
   * copy — `this.tokens` has already moved on by the time an unwind is decided.
   * `null` means no guess is live, which is the state every `'literal'` stream
   * and every closed stream stays in.
   */
  private optimisticTail: { entity: Entity; token: Tokens.Paragraph } | null = null;
  /** Resolvers waiting for every in-flight worker append to have been applied. */
  private appendSettledWaiters: Array<() => void> = [];
  /** True only inside an `onStable` callback, to reject reentrant mutation. */
  private inStableCallback = false;
  /** Set by {@link destroy} so late settlement work skips a torn-down tree. */
  private isDestroyed = false;
  /**
   * This instance's entry in {@link inlineMathRasterWaiters}, or `undefined` if it
   * has never rendered inline math.
   *
   * Subscribed lazily so a document without formulas costs nothing, and held as a
   * field only so {@link destroy} can remove the exact closure it added.
   */
  private inlineMathRepaint?: () => void;
  /**
   * True while this document is waiting on the lazy MathJax load.
   *
   * Tracked per instance rather than read off the module state because it also
   * gates settlement: `await close()` and `onStable` must not resolve while a
   * formula is still showing TeX source, or a caller doing expensive one-time
   * work on a "final" document would measure and export placeholder boxes.
   */
  private mathLoadPending = false;
  private _userTiming: boolean;
  private tokens: Token[] = [];
  // At most one worker lex request in flight at a time. Required for the
  // delta-transfer protocol below to be safe: the request captures a
  // snapshot of `this.tokens` to reconstruct the full array from the
  // worker's (matchLen, tail) response, and that snapshot would go stale if
  // another request's callback could run — and mutate `this.tokens` — while
  // this one is still pending. `appendPending` means "more text arrived
  // while a request was in flight"; the in-flight callback re-dispatches
  // with the latest accumulated text once it resolves.
  private appendInFlight = false;
  private appendPending = false;
  /**
   * Streaming counters for the DevTools inspector.
   *
   * Cheap enough to keep always-on (a handful of integer increments per append).
   *
   * These describe the **token diff and the transfer**, not the parser. `marked`
   * has no incremental lexing API, so the worker calls `marked.lexer()` on the
   * whole accumulated source for every chunk and the lexer's cost is O(document)
   * per append no matter how well the diff goes. That is what `lexerMs` and
   * `sourceCharsLexed` are for; an earlier version of these counters was named as
   * though a high prefix match meant less lexing, which sent readers to optimise
   * the already-solved transfer path.
   */
  private streamStats = {
    appends: 0,
    workerResponses: 0,
    /**
     * Sum of `matchLen`: leading tokens whose `raw` was unchanged, so the main
     * thread kept its existing token objects and child entities. A prefix match,
     * not a lexer saving — the worker still lexed them.
     */
    tokensPrefixMatched: 0,
    /**
     * Sum of returned tail lengths: tokens the worker sent back because their
     * `raw` differed. This is the structured-clone payload size in tokens, which
     * is what the delta protocol exists to keep small.
     */
    tokensReturned: 0,
    /** Total ms spent inside `marked.lexer()` across worker responses. */
    lexerMs: 0,
    /**
     * Characters handed to the lexer, summed across responses. Grows ~O(n^2) over
     * a stream of n chunks, because every chunk re-lexes the whole document.
     */
    sourceCharsLexed: 0,
    /** Total round-trip ms across worker lex requests, dispatch to callback. */
    workerMs: 0,
    /** Longest single worker round trip, which is what a dropped frame feels. */
    workerMsMax: 0,
    /**
     * Source length of the stable prefix on the most recent append: the text the
     * worker matched and did not re-read.
     */
    stablePrefixChars: 0,
    /** Source length of the tail whose tokens changed on the most recent append. */
    changedTailChars: 0,
    /** Child entities kept across reconciles, either untouched or updated in place. */
    entitiesReused: 0,
    /** Child entities destroyed and rebuilt across reconciles. */
    entitiesRebuilt: 0,
    /** In-place updates via setCode/setSpans, the streaming fast path. */
    inPlaceUpdates: 0,
  };
  // Worker request ids dispatched by *this* instance that haven't resolved yet.
  // The module-level `workerCallbacks` map holds a closure capturing `this`, so
  // destroying a Markdown mid-stream would pin the whole entity (and its subtree)
  // until the worker replied. `destroy()` drops these so the instance is GC-able.
  private pendingWorkerIds = new Set<number>();
  // Identity + token-list version for the worker's prior-raws cache. The worker
  // keeps this instance's last raw list so a streaming append sends only the new
  // text; `tokenVersion` is bumped on EVERY `this.tokens` mutation so any change
  // the worker didn't produce (setContent, a sync-fallback parse) invalidates
  // that cache instead of silently diffing against stale raws.
  private readonly workerInstanceId = `md-${workerInstanceCounter++}`;
  private tokenVersion = 0;
  /**
   * How many characters of {@link rawMarkdown} the worker is known to hold.
   *
   * The worker keeps the document source too, not just the prior token raws, so a
   * steady-state append posts only the new chunk instead of the whole document —
   * that term was O(document) per chunk, i.e. O(N²) over a stream, and unlike the
   * re-lex it accompanies it is paid on the MAIN thread (structured-cloning the
   * string happens in `postMessage`, not in the worker). Measured on a 240Hz
   * panel: 4µs per append at 8KB rising to 220µs at 512KB on Chrome, against a
   * flat ~2µs for a chunk-sized post.
   *
   * 0 means the worker holds nothing for this instance, so the next request must
   * carry the full text. It is only advanced when a response proves the worker
   * accepted that source, and reset to 0 by anything the worker did not produce
   * ({@link setContent}, a sync-fallback parse, a worker error or crash).
   */
  private workerSourceLen = 0;
  // `tokenChildPrefix[i]` = how many of `tokens[0..i)` render a child entity, so
  // `updateTokens` can map a token index to its child slot in O(1). Maintained
  // incrementally by setTokens() (only the changed suffix is recomputed).
  private readonly tokenChildPrefix: number[] = [];

  /**
   * Replace the token list, invalidate the worker's cached raws for it, and
   * refresh {@link tokenChildPrefix} — the token-index → child-entity-index
   * prefix sum `updateTokens` needs.
   *
   * `validFrom` is the number of leading tokens whose prefix entries are still
   * correct (the raw-equal prefix), so only the changed suffix is recomputed
   * instead of rebuilding over every token on every streamed chunk.
   */
  private setTokens(tokens: Token[], validFrom = 0): void {
    this.tokens = tokens;
    this.tokenVersion++;

    const prefix = this.tokenChildPrefix;
    const keep = Math.min(validFrom, prefix.length, tokens.length);
    prefix.length = keep;
    // Resume the running child count from the kept prefix's last entry.
    let childIdx = 0;
    if (keep > 0) {
      childIdx = prefix[keep - 1];
      if (this.producesEntity(tokens[keep - 1])) childIdx++;
    }
    for (let i = keep; i < tokens.length; i++) {
      prefix.push(childIdx);
      if (this.producesEntity(tokens[i])) childIdx++;
    }
  }

  constructor(markdownText: string, opts: MarkdownOptions = {}) {
    super();
    this.maxWidth = opts.maxWidth ?? 800;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.onLinkClick = opts.onLinkClick;
    this.selectable = opts.selectable ?? true;
    this._userTiming = opts.userTiming ?? false;

    this.content = new Stack({ direction: 'vertical', gap: 16 });
    this.add(this.content);

    this.rawMarkdown = markdownText;
    this.setTokens([]);
    this.renderMarkdown(markdownText);
  }

  private renderMarkdown(text: string): void {
    const tokens = lexMarkdown(text, this._userTiming);
    this.setTokens(tokens);
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) {
        this.content.add(el);
      }
    }

    this.width = this.content.width;
    this.height = this.content.height;
  }

  /** Create a frame-coalesced stream bound to this Markdown instance. */
  public createStream(options: StreamControllerOptions = {}): StreamController {
    if (this.streamController) {
      throw new Error('Markdown already has an active StreamController');
    }
    const controller = createStreamController(
      {
        append: (chunk) => this.appendMarkdownCore(chunk),
        release: (released) => {
          if (this.streamController !== released) return;
          this.streamController = null;
          this.streamIncompleteMode = 'literal';
          this.streamOnStable = null;
          // Covers abort()/destroy(), which release without ever running onClose:
          // a guess must not outlive the stream that justified it. After a normal
          // close() this is already a no-op — onClose unwound it.
          this.unwindOptimisticTail();
        },
        onClose: async () => {
          // The last committed chunk may still be in the worker. Waiting here is
          // what makes `await close()` mean "the document reflects everything
          // written", which onStable's contract depends on.
          await this.waitForAppendSettled();
          if (this.isDestroyed) return;
          // Converge on marked's own output: a guess is never part of the final
          // document, so a literal and an optimistic stream of the same source
          // end identically.
          this.unwindOptimisticTail();
          const onStable = this.streamOnStable;
          if (!onStable) return;
          this.inStableCallback = true;
          try {
            onStable(Array.from(this.content.children));
          } finally {
            this.inStableCallback = false;
          }
        },
      },
      options,
    );
    if (controller.state === 'open') {
      this.streamController = controller;
      this.streamIncompleteMode = options.incompleteMode ?? 'literal';
      this.streamOnStable = options.onStable ?? null;
    }
    return controller;
  }

  /** Replace all markdown content (full rebuild). */
  public setContent(markdown: string): this {
    this.assertNotInStableCallback('setContent');
    this.streamController?.abort(new Error('Markdown content was replaced'));
    // Drop any in-flight worker request. Its `matchLen` is relative to a token
    // snapshot captured from the document being replaced, and its closure still
    // holds that snapshot, so applying the reply would rebuild the tree from a
    // document that no longer exists — leaving `tokens` disagreeing with
    // `rawMarkdown`, which makes the NEXT append diff against tokens the source
    // never had. The reply is genuinely worthless rather than merely late: the
    // text it describes was just discarded by this call.
    //
    // Clearing `appendInFlight` is the other half. It gates every dispatch, so
    // leaving it set after dropping the callback would make the next append set
    // `appendPending` and wait forever for a reply that can no longer arrive.
    for (const id of this.pendingWorkerIds) workerCallbacks.delete(id);
    this.pendingWorkerIds.clear();
    this.appendInFlight = false;
    this.appendPending = false;
    // The replies those callbacks would have delivered are gone, so anything
    // awaiting settlement has to be released here or it waits forever.
    this.flushAppendSettledWaiters();
    this.rawMarkdown = markdown;
    // The worker's copy of the source now describes a document that no longer
    // exists, so the next append must resend the text rather than a delta.
    //
    // Two other mechanisms would eventually catch a stale length — the
    // `workerSourceLen <= sentLength` guard in dispatchAppend rejects it when the
    // replacement is shorter, and the `tokenVersion` bump in setTokens() below
    // makes the worker ask for a resync either way — but neither is a substitute.
    // The guard misses a replacement that grows past the old length, and relying
    // on the version bump means paying a wasted round trip on a request built
    // from an offset into a document that no longer exists.
    this.workerSourceLen = 0;
    // Destroy (not just detach) all children so their subtrees' resources —
    // MSDF worker slots, GPU buffers, portal observers — are released instead
    // of stranded. destroy() detaches from `content` as it goes.
    while (this.content.children.length > 0) {
      this.content.children[this.content.children.length - 1].destroy();
    }
    this.setTokens([]);
    this.renderMarkdown(markdown);
    return this;
  }

  /**
   * Tear down this Markdown block: drop any in-flight worker callbacks (each
   * pins `this` via its closure, so a mid-stream destroy would otherwise keep
   * the whole subtree alive until the worker replied), then recurse into the
   * content subtree via `super.destroy()` so every block's resources are freed.
   */
  /**
   * Repaint this document when an inline formula's raster finishes decoding.
   *
   * Idempotent — called on every render of a math-bearing token, and the set holds
   * one closure per instance.
   */
  private subscribeInlineMathRepaint(): void {
    if (this.inlineMathRepaint || this.isDestroyed) return;
    const repaint = () => {
      if (this.isDestroyed) return;
      this.scene?.markDirty();
    };
    this.inlineMathRepaint = repaint;
    inlineMathRasterWaiters.add(repaint);
  }

  public override destroy(): void {
    // Set before the controller teardown below, which reaches this instance again
    // through the host's `release` hook: settlement work must know the tree is
    // going away rather than re-render into it.
    this.isDestroyed = true;
    this.optimisticTail = null;
    this.streamController?.destroy();
    for (const id of this.pendingWorkerIds) workerCallbacks.delete(id);
    this.pendingWorkerIds.clear();
    this.appendInFlight = false;
    this.appendPending = false;
    // A pending MathJax load holds settlement open, and its continuation now
    // returns early on `isDestroyed` without flushing. Clearing this first is
    // what lets the flush below actually release, instead of leaving an awaiting
    // `close()` pending forever against a torn-down tree.
    this.mathLoadPending = false;
    // Nothing will reply now, so release any settlement waiter rather than
    // leaving a `close()` pending against a destroyed instance.
    this.flushAppendSettledWaiters();
    // Unsubscribe from inline-formula decodes. The set is module-level and lives
    // as long as the page, so leaving the closure in it would retain this whole
    // entity tree after destroy.
    if (this.inlineMathRepaint) {
      inlineMathRasterWaiters.delete(this.inlineMathRepaint);
      this.inlineMathRepaint = undefined;
    }
    // Release this instance's prior-raws entry in the (shared) worker, so a page
    // that creates and drops many blocks doesn't retain their raws forever.
    markdownWorker?.postMessage({
      instance: this.workerInstanceId,
      dispose: true,
    });
    super.destroy();
  }

  /**
   * Streaming and parse state — the markdown streaming inspector.
   *
   * Source length, chunk count, worker in-flight state, and the stable-prefix
   * versus changed-tail split. That last ratio is the one worth watching: it is
   * how you tell incremental reuse is working from outside, and nothing else
   * surfaces it. A ratio near 1 means the worker matched almost the whole prefix
   * and rebuilt only the tail's entities; near 0 means almost nothing was reused.
   * Neither says anything about lexer CPU, which is O(document) per append — that
   * is what the Parser cost group reports.
   */
  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    const s = this.streamStats;
    const diffedTokens = s.tokensPrefixMatched + s.tokensReturned;
    const tokenPrefixReuseRatio = diffedTokens > 0 ? s.tokensPrefixMatched / diffedTokens : 0;
    return {
      kind: 'Markdown',
      groups: [
        {
          label: 'Source',
          fields: [
            {
              label: 'sourceLength',
              value: this.rawMarkdown.length,
              readOnly: true,
            },
            {
              label: 'topLevelTokens',
              value: this.tokens.length,
              readOnly: true,
            },
            {
              label: 'childEntities',
              value: this.content.children.length,
              readOnly: true,
            },
            { label: 'selectable', value: this.selectable },
          ],
        },
        {
          label: 'Streaming',
          fields: [
            { label: 'appends', value: s.appends, readOnly: true },
            {
              label: 'workerResponses',
              value: s.workerResponses,
              hint: 'Fewer than appends means chunks were coalesced while a request was in flight',
              readOnly: true,
            },
            {
              label: 'appendInFlight',
              value: this.appendInFlight,
              hint: 'One lex request at a time; the delta protocol requires it',
              readOnly: true,
            },
            {
              label: 'appendPending',
              value: this.appendPending,
              readOnly: true,
            },
            {
              label: 'workerMsAvg',
              value:
                s.workerResponses > 0
                  ? Math.round((s.workerMs / s.workerResponses) * 100) / 100
                  : 0,
              hint: 'Mean lex round trip, dispatch to applied',
              readOnly: true,
            },
            {
              label: 'workerMsMax',
              value: Math.round(s.workerMsMax * 100) / 100,
              hint: 'Worst single round trip — this is the one a dropped frame comes from',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Delta shape',
          fields: [
            {
              label: 'stablePrefixChars',
              value: s.stablePrefixChars,
              hint: 'Source characters the worker matched and did not re-read, on the last append',
              readOnly: true,
            },
            {
              label: 'changedTailChars',
              value: s.changedTailChars,
              hint: 'Source characters whose tokens changed on the last append. Growing with the document means the delta is not a delta',
              readOnly: true,
            },
            {
              label: 'entitiesReused',
              value: s.entitiesReused,
              hint: 'Child entities kept untouched across reconciles',
              readOnly: true,
            },
            {
              label: 'entitiesRebuilt',
              value: s.entitiesRebuilt,
              hint: 'Child entities destroyed and reconstructed',
              readOnly: true,
            },
            {
              label: 'inPlaceUpdates',
              value: s.inPlaceUpdates,
              hint: 'setCode/setSpans on the growing last block — the streaming fast path',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Incremental reuse',
          fields: [
            {
              label: 'tokensPrefixMatched',
              value: s.tokensPrefixMatched,
              hint: 'Sum of matchLen: leading tokens whose raw was unchanged, so their entities were kept',
              readOnly: true,
            },
            {
              label: 'tokensReturned',
              value: s.tokensReturned,
              hint: 'Sum of returned tail lengths: the changed suffix the worker cloned back',
              readOnly: true,
            },
            {
              label: 'tokenPrefixReuseRatio',
              value: Math.round(tokenPrefixReuseRatio * 1000) / 1000,
              hint: 'matched / (matched + returned). Near 1 means small transfers and high entity reuse — NOT less lexing',
              readOnly: true,
            },
          ],
        },
        {
          label: 'Parser cost',
          fields: [
            {
              label: 'lexerMs',
              value: Math.round(s.lexerMs * 10) / 10,
              hint: 'Total ms inside marked.lexer() — the whole source, every append',
              readOnly: true,
            },
            {
              label: 'sourceCharsLexed',
              value: s.sourceCharsLexed,
              hint: 'Characters lexed, summed over appends. Grows ~O(n^2) across a stream',
              readOnly: true,
            },
          ],
        },
      ],
      notes:
        s.workerResponses === 0 && s.appends > 0
          ? [
              'No worker responses yet: either the worker is unavailable and parsing ran synchronously on the main thread, or the first request is still in flight.',
            ]
          : tokenPrefixReuseRatio > 0 && tokenPrefixReuseRatio < 0.5
            ? [
                `Only ${Math.round(tokenPrefixReuseRatio * 100)}% of tokens matched the prior prefix, so most of the token array is being returned and its entities rebuilt every chunk. Note the LEXER is O(document) per append regardless — see lexerMs.`,
              ]
            : s.changedTailChars > 0 &&
                this.rawMarkdown.length > 0 &&
                s.changedTailChars / this.rawMarkdown.length > 0.5
              ? [
                  `The last append changed ${s.changedTailChars} of ${this.rawMarkdown.length} characters. A changed tail that grows with the document means the delta is not a delta, so almost every entity is rebuilt per chunk.`,
                ]
              : undefined,
    };
  }

  /** Enable or disable User Timing for subsequent parses. */
  public setUserTiming(enabled: boolean): this {
    this._userTiming = enabled;
    return this;
  }

  /** Whether Markdown parse User Timing is enabled. */
  public get userTiming(): boolean {
    return this._userTiming;
  }

  /** Enable or disable native selection for existing and future Markdown text. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    const apply = (entity: Entity): void => {
      const candidate = entity as Entity & {
        setSelectable?: (value: boolean) => unknown;
      };
      candidate.setSelectable?.(selectable);
      for (const child of entity.children) apply(child);
    };
    for (const child of this.content.children) apply(child);
    this.scene?.markDirty();
    return this;
  }

  /** Append a markdown chunk incrementally. Reuses unchanged prefix entities. */
  public appendMarkdown(chunk: string): this {
    // An onStable callback is handed a snapshot of the finished document; mutating
    // that document from inside it would make the snapshot a lie and re-enter the
    // reconciler from within its own settlement path.
    this.assertNotInStableCallback('appendMarkdown');
    this.streamController?.flush();
    return this.appendMarkdownCore(chunk);
  }

  private appendMarkdownCore(chunk: string): this {
    this.rawMarkdown += chunk;
    this.streamStats.appends++;

    if (!markdownWorker) {
      // No worker (unsupported, failed to construct, or crashed and was dropped):
      // lex here. Nothing the worker holds is advanced by this, so a later
      // request — if a worker ever exists again — must resend the full text.
      this.workerSourceLen = 0;
      const newTokens = lexMarkdown(this.rawMarkdown, this._userTiming);
      this.updateTokens(newTokens);
      return this;
    }

    if (this.appendInFlight) {
      // `this.rawMarkdown` already has this chunk folded in — the next
      // dispatch picks it up naturally, no separate buffer needed.
      this.appendPending = true;
      return this;
    }
    this.dispatchAppend();
    return this;
  }

  /**
   * Post one lex request for the accumulated text.
   *
   * Two shapes. Steady state sends a DELTA — `{ append }` plus the expected total
   * length — because the worker keeps both this instance's prior token raws and
   * the document source itself (keyed by `workerInstanceId` + `tokenVersion`).
   * Re-sending the document each chunk made main->worker transfer O(document) per
   * chunk, i.e. O(N²) over a stream, and that cost is paid on the main thread:
   * `postMessage` structured-clones the string synchronously before the worker
   * ever wakes. `resync` forces the FULL shape instead — the whole text plus the
   * prior raw list — and is used for the first request for this instance, after
   * anything the worker did not produce (`setContent`, a sync-fallback parse), and
   * whenever the worker reports it cannot trust what it holds (`needResync`).
   */
  private dispatchAppend(resync = false): void {
    if (!markdownWorker) return;
    this.appendInFlight = true;
    const id = workerIdCounter++;
    // Snapshot now — this is the array the worker's `matchLen` is relative
    // to, and it must stay fixed until this exact response is applied (see
    // the field comment on `appendInFlight` for why that requires
    // coalescing rather than tracking `this.tokens` live).
    const oldTokensSnapshot = this.tokens;
    const baseVersion = this.tokenVersion;
    const dispatchedAt = now();
    // The length this request brings the worker's source to. Captured at dispatch
    // because `this.rawMarkdown` can grow again (coalesced appends) before the
    // response lands, and what the worker then holds is this, not the latest.
    const sentLength = this.rawMarkdown.length;
    // A delta is only valid if the worker holds a prefix of the current source.
    // `workerSourceLen === 0` means it holds nothing for this instance.
    const canSendDelta = !resync && this.workerSourceLen > 0 && this.workerSourceLen <= sentLength;
    this.pendingWorkerIds.add(id);
    workerCallbacks.set(id, {
      cb: (matchLen, tail, local = false, lex) => {
        this.pendingWorkerIds.delete(id);
        this.streamStats.workerResponses++;
        this.streamStats.tokensPrefixMatched += matchLen;
        this.streamStats.tokensReturned += tail.length;
        if (lex) {
          this.streamStats.lexerMs += lex.lexerMs;
          this.streamStats.sourceCharsLexed += lex.sourceCharsLexed;
        }
        const elapsed = now() - dispatchedAt;
        this.streamStats.workerMs += elapsed;
        if (elapsed > this.streamStats.workerMsMax) this.streamStats.workerMsMax = elapsed;
        // `local` means this result came from the main-thread fallback lexer, so
        // the worker never saw this source and whatever it holds is now behind.
        // Forcing the next request to resync is the only safe reading: a delta
        // applied to a stale cached source would lex text the caller never has.
        this.workerSourceLen = local ? 0 : sentLength;
        // Character counts, not token counts: a stable prefix of 40 tokens says
        // nothing about how much text the worker skipped, and the O(document) vs
        // O(appended) question is about characters.
        let prefixChars = 0;
        for (let i = 0; i < matchLen; i++) prefixChars += oldTokensSnapshot[i]?.raw.length ?? 0;
        this.streamStats.stablePrefixChars = prefixChars;
        this.streamStats.changedTailChars = this.rawMarkdown.length - prefixChars;
        this.appendInFlight = false;
        const newTokens = [...oldTokensSnapshot.slice(0, matchLen), ...tail] as TokensList;
        // The worker's matchLen is exactly the prefix it kept, and `newTokens` is
        // built from that same slice, so it is correct by construction here.
        this.updateTokens(newTokens, matchLen);
        if (this.appendPending) {
          this.appendPending = false;
          this.dispatchAppend();
        }
        // Last, deliberately: `appendInFlight` was cleared above and the
        // re-dispatch just set it back to `true` if more text had arrived — both
        // synchronously, so nothing watching the flag itself could see the gap.
        // Checking only here is what makes a settlement waiter wait through a
        // coalesced re-dispatch instead of resolving one chunk early.
        this.flushAppendSettledWaiters();
      },
      // The worker can't trust what it holds for this request; retry it once with
      // the full text and raws attached. `this.tokens` is untouched (no
      // updateTokens ran), so the retry's snapshot and version still line up.
      onNeedResync: () => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        // Whatever the worker had is unusable, so the retry must not send a delta.
        this.workerSourceLen = 0;
        this.dispatchAppend(true);
      },
      // Neither the worker nor the fallback lexer could produce tokens for this
      // request, so `this.tokens` stays as it was. Only the in-flight bookkeeping
      // needs unwinding — including any coalesced chunk waiting behind it, which
      // still has to be attempted.
      onDropped: () => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        // Nothing proved the worker holds this source; force the next request full.
        this.workerSourceLen = 0;
        if (this.appendPending) {
          this.appendPending = false;
          this.dispatchAppend(true);
        }
        this.flushAppendSettledWaiters();
      },
      text: this.rawMarkdown,
      userTiming: this._userTiming,
    });
    markdownWorker.postMessage({
      id,
      instance: this.workerInstanceId,
      baseVersion,
      userTimingName: this._userTiming ? VECTO_USER_TIMING.markdown.parse : undefined,
      ...(canSendDelta
        ? {
            append: this.rawMarkdown.slice(this.workerSourceLen),
            // What the worker's source must total once it applies this append. It
            // rejects a mismatch with one resync rather than lexing a source that
            // has diverged from this one — a dropped or duplicated chunk would
            // otherwise return a matchLen against tokens this instance never had.
            expectedLength: sentLength,
          }
        : {
            text: this.rawMarkdown,
            oldRaws: oldTokensSnapshot.map((t) => t.raw),
          }),
    });
  }

  /**
   * Spans for one paragraph token exactly as `marked` produced it.
   *
   * The literal baseline: what every release renders, and what an optimistic
   * guess is unwound back to.
   */
  private literalParagraphSpans(token: Tokens.Paragraph): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (token.tokens && token.tokens.length > 0) {
      collectSpans(token.tokens, {}, this.theme, spans);
    }
    if (spans.length === 0) spans.push({ text: token.text });
    return spans;
  }

  /**
   * Update a reused blockquote's tail child in place, or report that it cannot be.
   *
   * The render arm builds `container[border, innerStack]` where every inner block
   * sits in its own single-child `wrapper`, so the tail entity is
   * `innerStack.children.at(-1).children[0]`. Only the LAST inner block may be
   * updated: the inner token list is prefix-stable exactly like the top level (a
   * growing quote keeps its earlier blocks byte-identical), so anything before the
   * tail is untouched and anything more complicated than a changed tail falls back
   * to the caller's rebuild.
   *
   * Returns `false` without mutating anything when the shape is not the simple
   * grow-the-tail case, which is the signal for the caller to rebuild. Every early
   * return has to leave the entity untouched, or a rejected reuse would leave a
   * half-updated quote on screen.
   */
  /**
   * Build one list item's spans: inline content plus its marker.
   *
   * Shared by the `list` render arm and the streamed-reuse path below, because
   * the two must produce byte-identical spans — a reused list that disagreed with
   * a rebuilt one about its marker or its entity decoding would make a streamed
   * document differ from the same source pasted at once.
   */
  /**
   * Inline spans for one table cell.
   *
   * Always returns at least one span. A cell whose markup collapses to nothing —
   * an empty cell, but also a bare `<span>`, an image, or an HTML comment, none
   * of which `collectSpans` emits for — falls back to its decoded source text,
   * which is what the previous string-returning path rendered. That guarantee is
   * what lets every cell be a `RichText`: an empty cell would otherwise become a
   * `Text`, and since `Text` has `setText` while `RichText` has `setSpans` and
   * nothing converts between them, a cell that starts empty and later gains
   * content could not be updated in place. A streamed table needs exactly that,
   * because `marked` materializes a partial row as a full row of empty cells and
   * then fills them one at a time.
   */
  private tableCellSpans(cell: Tokens.TableCell, t: Required<MarkdownTheme>): StyledSpan[] {
    const spans: StyledSpan[] = [];
    collectSpans(cell.tokens, {}, t, spans);
    if (spans.length === 0) spans.push({ text: decodeEntities(cell.text) });
    return spans;
  }

  /**
   * Spans for one run of consecutive non-image inline tokens.
   *
   * A paragraph holding an image renders as a `Stack` of alternating text runs
   * and images, and this is one text run. Shared by the render arm and
   * {@link updateImageParagraph} so a reused run cannot drift from a rebuilt one.
   *
   * The empty fallback mirrors `renderInlineToRichText('', …)`, which the render
   * arm passed for these runs: a run is only created when it has at least one
   * token, so the fallback is for tokens that emit no spans at all rather than
   * for an empty run.
   */
  private inlineRunSpans(tokens: Token[], t: Required<MarkdownTheme>): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (tokens.length > 0) collectSpans(tokens, {}, t, spans);
    if (spans.length === 0) spans.push({ text: '' });
    return spans;
  }

  /** One text run of an image-bearing paragraph, as both paths build it. */
  private inlineRunRichText(
    tokens: Token[],
    availableWidth: number,
    t: Required<MarkdownTheme>,
  ): RichText {
    return new RichText(this.inlineRunSpans(tokens, t), {
      font: `${t.fontSize}px ${t.bodyFont}`,
      color: t.textColor,
      maxWidth: availableWidth,
      linkColor: '#38bdf8',
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  /**
   * One image inside a paragraph, sized by a guess until its bitmap decodes.
   *
   * Width and height start at a 16:10 guess because the intrinsic size is not
   * known until the browser has the bitmap; `onLoad` corrects both from
   * `naturalWidth`/`naturalHeight`. Extracted from the render arm so the streamed
   * path reuses this exact entity rather than constructing a second variant.
   *
   * `markDirty()` is unconditional, matching the display-math sibling. It used
   * to sit inside the `naturalWidth && naturalHeight` check, which meant a
   * source that loads successfully while reporting a zero dimension left the
   * scene un-notified. `Image` sets `loaded` before invoking this callback, so
   * its `render()` starts drawing the bitmap either way — the cost was not a
   * stale placeholder but a box frozen at the guess: measured on Chromium and
   * Firefox, an `<svg width="0" height="0">` paragraph image kept 800x480 of
   * reserved layout forever while a normal raster corrected to 80x60. An
   * `onDemand` scene repaints only when marked, so nothing reclaimed it.
   *
   * The box is deliberately left at the guess when the bitmap reports zero.
   * Collapsing it to 0x0 would make the paragraph reflow correctly but would
   * also silently delete a reserved region on the strength of one browser
   * quirk, and `Image.render()` still blits whatever the bitmap holds. Sizing
   * policy for a zero-dimension source is a separate decision from notifying
   * the scene, which is the actual defect here.
   */
  private paragraphImage(imgToken: Tokens.Image, availableWidth: number): Image {
    const initialWidth = Math.min(800, availableWidth);
    const initialHeight = Math.round(initialWidth * 0.6); // Guess 16:10 aspect ratio initially
    const img = new Image(imgToken.href, {
      width: initialWidth,
      height: initialHeight,
      alt: imgToken.text,
      radius: 8,
      onLoad: () => {
        const bmp = (img as any).bitmap;
        if (bmp && bmp.naturalWidth && bmp.naturalHeight) {
          const aspect = bmp.naturalHeight / bmp.naturalWidth;
          img.width = Math.min(bmp.naturalWidth, availableWidth);
          img.height = Math.round(img.width * aspect);
        }
        this.scene?.markDirty();
      },
    });
    return img;
  }

  /** One table cell entity, shared by the render arm and the streamed-table path. */
  private tableCellRichText(
    cell: Tokens.TableCell,
    header: boolean,
    t: Required<MarkdownTheme>,
  ): RichText {
    return new RichText(this.tableCellSpans(cell, t), {
      font: `${t.fontSize - 2}px ${t.bodyFont}`,
      color: header ? t.headingColor : t.textColor,
      baseStyle: header ? { bold: true } : undefined,
      linkColor: '#38bdf8',
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  private listItemSpans(token: Tokens.List, index: number): StyledSpan[] {
    const item = token.items[index];
    const num = Number(token.start ?? 1) + index;
    // Build the inline content spans first; the marker is placed after, on
    // the side that matches the item's reading direction.
    const contentSpans: StyledSpan[] = [];
    if (item.tokens && item.tokens.length > 0) {
      // List item tokens are block-level; dig into paragraph children
      for (const inner of item.tokens) {
        if (inner.type === 'text' && 'tokens' in inner && (inner as any).tokens?.length) {
          collectSpans(
            (inner as any).tokens,
            {},
            this.theme as Required<MarkdownTheme>,
            contentSpans,
          );
        } else if ('tokens' in inner && (inner as any).tokens?.length) {
          collectSpans(
            (inner as any).tokens,
            {},
            this.theme as Required<MarkdownTheme>,
            contentSpans,
          );
        } else if ('text' in inner) {
          contentSpans.push({ text: decodeEntities((inner as any).text) });
        }
      }
    } else {
      contentSpans.push({ text: decodeEntities(item.text) });
    }

    // Place the marker on the reading-start side. An RTL item must show
    // its marker at the visual RIGHT; a leading neutral bullet would
    // bidi-reorder to the visual LEFT. Appending the marker as a TRAILING
    // span fixes it: `" •"` reorders to visual `"• …"`, and `" .N"` to
    // `"N. …"` — both flush-right in reading order. LTR keeps the marker
    // leading as before.
    const itemIsRtl = BidiResolver.getBaseLevel(contentSpans.map((s) => s.text).join('')) % 2 === 1;
    return itemIsRtl
      ? [...contentSpans, { text: token.ordered ? ` .${num}` : ' \u2022' }]
      : [{ text: token.ordered ? `${num}. ` : '• ' }, ...contentSpans];
  }

  /** Construct the `RichText` for one list item. */
  private listItemRichText(
    token: Tokens.List,
    index: number,
    availableWidth: number,
    t: Required<MarkdownTheme>,
  ): RichText {
    // No `x` offset and no width reserved for one. Until 2026-07-30 this set
    // `itemRt.x = 12 // Indent` and passed `availableWidth - 24`, but the indent
    // was dead: `Stack.appendFast` assigns `child.x = 0` for a vertical stack
    // (packages/ui/src/Stack.ts:160) and `Stack` declares `x`/`y` as
    // layout-controlled, so `add()` overwrote it. Probed: every item's `x` was 0.
    // The 24px reserve therefore compensated for an indent that never rendered,
    // shrinking the wrap width for no reason. A list nested in a blockquote is
    // indented by the quote's own wrapper (`el.x = indentStart`), not here.
    return new RichText(this.listItemSpans(token, index), {
      font: `${t.fontSize}px ${t.bodyFont}`,
      color: t.textColor,
      maxWidth: availableWidth,
      linkColor: '#38bdf8',
      selectable: this.selectable,
      onLinkClick: this.onLinkClick,
    });
  }

  /**
   * Reuse a streamed list's `Stack` instead of rebuilding every item.
   *
   * Returns `false` to mean "rebuild instead", exactly like
   * {@link updateBlockquoteTail}, and every rejection path leaves the entity
   * untouched so a refused reuse cannot leave a half-updated list on screen.
   *
   * This is the shape a stream actually produces: items are APPENDED, and only
   * the last one grows. That matters for the ordinal marker, which is
   * position-derived (`start + index`) — under append an already-rendered item's
   * index never changes, so its marker stays correct. A mid-list insertion would
   * shift every later ordinal, but no stream produces one.
   *
   * Two traps this guards, both found by probing marked 18.0.7 rather than by
   * reading:
   *
   * - **A retained item's `raw` is NOT stable.** `items[1].raw` goes `"- two"` ->
   *   `"- two\\n"` when item 3 arrives, so a byte-equality guard on `raw` fails on
   *   every chunk and the fast path would never fire. `text` is stable; compare
   *   that.
   * - **A tight list can become loose.** Adding a blank line flips
   *   `token.loose`, which re-lexes every item's children from `text` to
   *   `paragraph`. Item 0's own `text` is unchanged, so a naive guard would reuse
   *   and keep stale spans. Bail when `loose` flips.
   */
  private updateStreamedList(stack: Entity, oldToken: Tokens.List, newToken: Tokens.List): boolean {
    if (!(stack instanceof Stack)) return false;
    // A list may only have grown. Fewer items means an edit, not a stream.
    if (newToken.items.length < oldToken.items.length || oldToken.items.length === 0) return false;
    // `ordered` and `start` feed every marker; `loose` changes how items lex.
    if (oldToken.ordered !== newToken.ordered) return false;
    if ((oldToken.start ?? 1) !== (newToken.start ?? 1)) return false;
    if (oldToken.loose !== newToken.loose) return false;
    // The stack must be the one the render arm built for these items.
    if (stack.children.length !== oldToken.items.length) return false;

    // Every item before the last retained one must be unchanged. Compare `text`,
    // not `raw` — see the trap note above.
    const lastRetained = oldToken.items.length - 1;
    for (let i = 0; i < lastRetained; i++) {
      if (oldToken.items[i].text !== newToken.items[i].text) return false;
    }

    // Same derivation renderToken uses, so an appended item is measured exactly
    // as a rebuilt one would be. A top-level list has no activeBlockMetrics, so
    // this is `maxWidth`; the fallback is spelled out rather than assumed.
    const availableWidth = this.activeBlockMetrics?.availableWidth ?? this.maxWidth;
    const t = this.theme;

    // The last retained item may have grown; rewrite its spans in place.
    const tailEntity = stack.children[lastRetained];
    if (oldToken.items[lastRetained].text !== newToken.items[lastRetained].text) {
      if (!('setSpans' in tailEntity)) return false;
      (tailEntity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.listItemSpans(newToken, lastRetained),
      );
    }

    // Then append whatever arrived after it.
    for (let i = oldToken.items.length; i < newToken.items.length; i++) {
      stack.add(this.listItemRichText(newToken, i, availableWidth, t));
    }

    // `add()` already maintained the stack's box via its append fast path, but a
    // grown tail item did not, so resync on that. Safe when nothing was appended
    // too: resizeLastChild falls back to a full layout() when its invariants do
    // not hold.
    const last = stack.children.at(-1);
    if (last) stack.resizeLastChild(last);
    return true;
  }

  /**
   * Reuse a streamed image-bearing paragraph's `Stack` instead of rebuilding it.
   *
   * Returns `false` to mean "rebuild instead", and every rejection happens before
   * any mutation, so a refused reuse leaves the entity exactly as it was.
   *
   * This was the last silent fallthrough in the in-place reuse path. A paragraph
   * holding an image renders as a `Stack` of alternating text runs and images
   * rather than one `RichText`, so it has no `setSpans` and failed the ordinary
   * paragraph gate — with no `else`, which is what made the miss invisible:
   * `inPlaceUpdates` stayed flat while `entitiesRebuilt` climbed. Measured on a
   * six-chunk stream, `inPlaceUpdates` 0 / `entitiesRebuilt` 4 with an image
   * against 4 / 0 for the identical shape without one. Every rebuild also
   * re-created the `Image`, discarding its decoded bitmap and its corrected
   * intrinsic size.
   *
   * It is *only* a performance path. The obvious worry — that a fresh `Image`
   * starts at `loaded = false` and so repaints its placeholder slab — was
   * measured and does not happen: sampling the real canvas pixel at the image
   * centre in both Chromium and Firefox gives zero placeholder frames after the
   * first paint, at 60ms and at 0ms between chunks, because a cached bitmap
   * decodes before the next frame.
   *
   * The reuse is deliberately narrow: **only a growing trailing text run**. Probed
   * against `marked@18.0.7`, that is the shape a stream actually produces once an
   * image has closed — the image token's `raw` and its index are then stable while
   * trailing prose grows, and the token list settles at
   * `[…, image, text]` and stops changing length. Anything else (a new image
   * arriving, an image token changing, a run appearing before the last image)
   * falls through to the rebuild, which is correct and rare.
   *
   * Note the child list is not one entity per token: consecutive non-image tokens
   * are merged into one `RichText` by the render arm's `flushText`, so
   * `[text, text, image]` is two children, not three. The guards therefore compare
   * *token runs* split at the last image, never token index against child index.
   */
  private updateImageParagraph(
    entity: Entity,
    oldToken: Tokens.Paragraph,
    newToken: Tokens.Paragraph,
  ): boolean {
    // The `Stack` gate is what makes `children` and `resizeLastChild` meaningful:
    // an ordinary paragraph's entity is a `RichText`, which has neither the child
    // list this reasons about nor that method. Mutation-checked as caught by the
    // child-count guard below as well (a `RichText` reports zero children), but it
    // must stay: without it the resync at the end calls an undefined method.
    if (!(entity instanceof Stack)) return false;
    const oldTokens = oldToken.tokens;
    const newTokens = newToken.tokens;
    if (!oldTokens || !newTokens) return false;

    // Both sides must be the image-bearing shape this method owns. A paragraph
    // that only just gained its first image is a shape change, not a growing
    // tail, so it rebuilds.
    //
    // Mutation-checked as redundant in practice — an image-free paragraph never
    // arrives here, because the branch above claims it via `setSpans`, and if one
    // did its `RichText` entity would fail the `Stack` gate. Kept because without
    // it `-1` would make the prefix loop a no-op and slice the WHOLE token list as
    // the tail, which is a silently wrong reuse rather than a rejection.
    const oldLastImage = lastIndexOfImage(oldTokens);
    const newLastImage = lastIndexOfImage(newTokens);
    if (oldLastImage < 0 || newLastImage < 0) return false;

    // The prefix through the last image must be byte-identical. This is what
    // makes reuse safe without comparing entities: it proves every existing
    // child except a trailing text run is still correct, including each image's
    // `href` and `alt`, and that no image was inserted or removed.
    //
    // The index equality is a precondition of that loop rather than an
    // independent check — mutation-checked as redundant, because when a second
    // image arrives the raw comparison catches the same paragraph one token
    // earlier. It stays because the loop below only compares `0..newLastImage`,
    // so without it a shorter old prefix would be read past its end.
    if (oldLastImage !== newLastImage) return false;
    for (let i = 0; i <= newLastImage; i++) {
      if (oldTokens[i].raw !== newTokens[i].raw) return false;
    }

    // Only a trailing run may differ, and only by growing. A shrinking tail is
    // not something an append-only stream produces, and reusing on one would
    // leave the `Stack`'s cached height too large.
    const oldTail = oldTokens.slice(oldLastImage + 1);
    const newTail = newTokens.slice(newLastImage + 1);
    if (newTail.length === 0) return false;
    const oldTailRaw = oldTail.map((t) => t.raw).join('');
    const newTailRaw = newTail.map((t) => t.raw).join('');
    if (!newTailRaw.startsWith(oldTailRaw)) return false;

    // The entity must be the one the render arm built for the old tokens: one
    // child per image, plus one per text run. Recomputing it from the old tokens
    // rather than trusting a count keeps this correct for any arrangement of
    // runs, including two adjacent images.
    const expectedOldChildren = expectedImageParagraphChildren(oldTokens);
    if (entity.children.length !== expectedOldChildren) return false;

    const t = this.theme;
    const availableWidth = this.activeBlockMetrics?.availableWidth ?? this.maxWidth;

    if (oldTail.length === 0) {
      // The trailing run is new: the paragraph ended at its image last time, and
      // prose has now started after it. Append one run.
      entity.add(this.inlineRunRichText(newTail, availableWidth, t));
    } else {
      // The common case: the existing trailing run grew.
      //
      // The `RichText` check is defence in depth, and mutation-checked as
      // unreachable: a non-empty `oldTail` means the render arm ran `flushText`
      // after the last image, so the last child IS that run's `RichText`. An
      // `Image` can only be last when `oldTail` is empty, which is the branch
      // above. Kept because it is what makes `setSpans` provably safe here.
      const tailEntity = entity.children[entity.children.length - 1];
      if (!(tailEntity instanceof RichText)) return false;
      tailEntity.setSpans(this.inlineRunSpans(newTail, t));
    }

    // Resync the Stack from its new last child.
    //
    // Load-bearing, and only visibly so when the tail gains a LINE:
    // `RichText.setSpans` re-lays out the child but does not touch its parent's
    // cached box, so without this a wrapped tail leaves the `Stack` at its old
    // height (measured 320 where 368 is correct). A tail growing within one line
    // hides it, and `Stack.add` happens to update the height itself, which is why
    // the append branch alone would not reveal it. `resizeLastChild` falls back to
    // a full `layout()` when its invariants do not hold, so it is safe for both.
    const last = entity.children[entity.children.length - 1];
    if (last) entity.resizeLastChild(last);
    return true;
  }

  /**
   * Reuse a streamed table's `Table` entity instead of rebuilding every cell.
   *
   * Returns `false` to mean "rebuild instead", and every rejection happens before
   * any mutation, so a refused reuse leaves the entity exactly as it was.
   *
   * A `table` token carries every row, so the rebuild path costs Θ(C·N²)
   * `RichText` constructions across a stream — and a further 2×, because
   * `Table.layout()` re-runs `fitCell` on every cell. This was the last block
   * type without an in-place path.
   *
   * Two shapes have to be handled, because of how `marked` lexes a growing table
   * (probed against 18.0.7): a partial row is materialized immediately as a FULL
   * row padded with empty cells, and its cells are then filled one at a time. A
   * 2×2 table passes through eleven distinct row states, of which only two are
   * clean row appends. So handling appends alone would reject most chunks and
   * leave the quadratic cost essentially in place:
   *
   * 1. the last row's cells are rewritten in place via `setSpans`, and
   * 2. genuinely new rows go through `Table.appendRows`.
   *
   * Cells are compared by `text`, never `raw` — a table cell has no `raw` at all
   * (its keys are `text`/`tokens`/`header`/`align`).
   */
  private updateStreamedTable(
    entity: Entity,
    oldToken: Tokens.Table,
    newToken: Tokens.Table,
  ): boolean {
    if (!(entity instanceof Table)) return false;

    // The column count is fixed when the delimiter row lexes: marked pads short
    // rows and truncates long ones to `header.length`, so this can never fire in
    // practice. It is what licenses indexing every row by the header's columns.
    if (oldToken.header.length !== newToken.header.length) return false;
    // `Table` has no header mutator, so a changed header must rebuild.
    for (let c = 0; c < oldToken.header.length; c++) {
      if (oldToken.header[c].text !== newToken.header[c].text) return false;
    }

    // Append-only. Unlike a list, an EMPTY old table is not rejected: a table is
    // lexed with zero rows as soon as its delimiter row arrives, so that is the
    // first state every streamed table is in and the first reuse opportunity.
    if (newToken.rows.length < oldToken.rows.length) return false;
    // This entity must be the one the render arm built for these tokens.
    if (entity.rows.length !== oldToken.rows.length) return false;

    // Every row before the last retained one must be untouched. Probed stable, so
    // this is the cheap correctness net rather than an expected rejection.
    const lastRetained = oldToken.rows.length - 1;
    for (let r = 0; r < lastRetained; r++) {
      const oldRow = oldToken.rows[r];
      const newRow = newToken.rows[r];
      for (let c = 0; c < oldToken.header.length; c++) {
        if (oldRow[c]?.text !== newRow[c]?.text) return false;
      }
    }

    // Every cell this arm built is a RichText, but the entity could have been
    // constructed elsewhere; verify before mutating anything.
    if (lastRetained >= 0) {
      for (let c = 0; c < oldToken.header.length; c++) {
        const cell = entity.rows[lastRetained]?.[c];
        if (!(cell instanceof RichText)) return false;
      }
    }

    // ── Past every guard; mutation starts here ──────────────────────────
    const t = this.theme as Required<MarkdownTheme>;
    let changed = false;

    // 1. Rewrite the last retained row's cells whose text moved on.
    if (lastRetained >= 0) {
      const oldRow = oldToken.rows[lastRetained];
      const newRow = newToken.rows[lastRetained];
      for (let c = 0; c < oldToken.header.length; c++) {
        if (oldRow[c]?.text === newRow[c]?.text) continue;
        const cell = entity.rows[lastRetained][c] as RichText;
        cell.setSpans(this.tableCellSpans(newRow[c], t));
        changed = true;
      }
    }

    // 2. Append the rows that actually arrived.
    if (newToken.rows.length > oldToken.rows.length) {
      const added = newToken.rows
        .slice(oldToken.rows.length)
        .map((row) => row.map((cell) => this.tableCellRichText(cell, false, t)));
      // appendRows() ends in layout(), which also re-measures the cells rewritten
      // above, so no separate relayout is needed on this path.
      entity.appendRows(added);
    } else if (changed) {
      // Only cells changed, so nothing appended: re-measure them.
      entity.layout();
    }

    return true;
  }

  private updateBlockquoteTail(container: Entity, oldInner: Token[], newInner: Token[]): boolean {
    // Only the tail block may differ: every earlier inner token must be
    // byte-identical, and no block may have been added or removed. `space` tokens
    // render nothing, so compare tokens and map to children separately.
    if (oldInner.length !== newInner.length || newInner.length === 0) return false;
    const tail = newInner.length - 1;
    for (let i = 0; i < tail; i++) {
      if (oldInner[i].raw !== newInner[i].raw) return false;
    }
    const oldTail = oldInner[tail];
    const newTail = newInner[tail];
    if (oldTail.type !== newTail.type) return false;

    // container = [border, innerStack]; the render arm adds them in that order.
    const innerStack = container.children[1];
    if (!(innerStack instanceof Stack)) return false;
    const wrapper = innerStack.children.at(-1);
    if (!wrapper || wrapper.children.length !== 1) return false;
    const entity = wrapper.children[0];

    // The tail token must be the one that owns that last wrapper. A tail token
    // that renders nothing (a trailing `space`) would leave the last wrapper owned
    // by an earlier block, so updating it would write the wrong entity.
    if (!this.producesEntity(newTail)) return false;

    if (newTail.type === 'paragraph' && 'setSpans' in entity) {
      // Literal spans only. The optimistic guess is reserved for the document's
      // trailing paragraph; a paragraph nested in a quote is not it, and giving it
      // a guess would need a second unwind path keyed on the nested entity.
      (entity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.literalParagraphSpans(newTail as Tokens.Paragraph),
      );
    } else if (newTail.type === 'heading' && 'setSpans' in entity) {
      // Same depth guard as the top-level heading path: `setSpans` cannot change
      // `font`, and a heading's size comes from its depth.
      if ((oldTail as Tokens.Heading).depth !== (newTail as Tokens.Heading).depth) {
        return false;
      }
      (entity as Entity & { setSpans: (s: StyledSpan[]) => unknown }).setSpans(
        this.headingSpans(newTail as Tokens.Heading),
      );
    } else if (
      newTail.type === 'code' &&
      entity instanceof CodeBlock &&
      !rendersAsMath(newTail as Tokens.Code)
    ) {
      const codeToken = newTail as Tokens.Code;
      entity.setCode(codeToken.text, codeToken.lang ?? undefined);
    } else {
      // Any other tail type (list, table, nested blockquote) has no mutator to
      // call. A math fence whose closing fence has arrived also lands here: it
      // must become an Image, and no mutator turns a CodeBlock into one.
      return false;
    }

    // Propagate the tail's new box outward by hand: wrapper, then the stack, then
    // the border, then the container. The render arm computes all four the same
    // way, so this keeps a reused quote geometrically identical to a rebuilt one.
    wrapper.width = entity.x + entity.width;
    wrapper.height = entity.height;
    innerStack.resizeLastChild(wrapper);
    const border = container.children[0];
    if (border instanceof QuoteBorder) border.height = innerStack.height || 20;
    container.height = Math.max(border?.height ?? 0, innerStack.height);
    return true;
  }

  /**
   * Spans for a heading being updated in place.
   *
   * Kept in lockstep with the `heading` arm of {@link renderToken}, which builds
   * its `RichText` through `renderInlineToRichText`: same `collectSpans` call and
   * the same `decodeEntities` fallback when a heading has no inline tokens (`##`
   * with no text yet, which a stream produces before its first word arrives). A
   * plain `token.text` fallback here would leave an entity-bearing heading
   * undecoded on the in-place path but decoded on a fresh render.
   */
  private headingSpans(token: Tokens.Heading): StyledSpan[] {
    const spans: StyledSpan[] = [];
    if (token.tokens && token.tokens.length > 0) {
      collectSpans(token.tokens, {}, this.theme, spans);
    }
    if (spans.length === 0) spans.push({ text: decodeEntities(token.text) });
    return spans;
  }

  /**
   * Spans for the trailing paragraph with its last unclosed inline construct
   * rendered as though it had closed, or `null` when there is nothing to guess.
   *
   * `null` is the answer for every `'literal'` stream, every closed or absent
   * stream, and any trailing paragraph whose syntax is all balanced — so the
   * caller falls back to {@link literalParagraphSpans} and pays nothing.
   *
   * Only the paragraph's LAST inline token is scanned. An unclosed construct can
   * only be there: anything that closed is already its own `strong`/`em`/
   * `codespan`/`link` token, so a syntax character surviving into a trailing
   * plain-text run is one `marked` could not pair. Scanning the whole raw string
   * instead would re-find the markers of already-closed constructs.
   */
  private optimisticParagraphSpans(token: Tokens.Paragraph): StyledSpan[] | null {
    if (this.streamIncompleteMode !== 'optimistic') return null;
    if (this.streamController?.state !== 'open') return null;

    const inline = token.tokens;
    if (!inline || inline.length === 0) return null;
    // How many trailing tokens form the unstructured run, and its text. Normally
    // one plain `text` token — but `[label](https://ex` lexes as a `text` token
    // ending in `](` PLUS an autolink token for the bare URL, because marked
    // autolinks a naked URL it finds there. Left as two tokens the `[` is invisible
    // to the scan, so that pair is rejoined into one run.
    let runLength = 1;
    let runText: string;
    const last = inline[inline.length - 1];
    const prev = inline.length > 1 ? inline[inline.length - 2] : null;
    const isFlatText = (token: Token): boolean =>
      token.type === 'text' && !(token as unknown as { tokens?: Token[] }).tokens?.length;
    if (
      last.type === 'link' &&
      last.raw === (last as Tokens.Link).text &&
      prev !== null &&
      isFlatText(prev) &&
      (prev as Tokens.Text).text.endsWith('](')
    ) {
      runLength = 2;
      runText = (prev as Tokens.Text).text + last.raw;
    } else if (isFlatText(last)) {
      runText = (last as Tokens.Text).text;
    } else {
      // A nested-token text run has structure inside it, so it is not the flat
      // trailing run this scan is defined over.
      return null;
    }

    const found = findUnclosedInline(runText);
    if (!found) return null;

    // Everything before the trailing run keeps exactly the styling `marked` gave
    // it — those tokens are not what changed between chunks.
    const spans: StyledSpan[] = [];
    if (inline.length > runLength) {
      collectSpans(inline.slice(0, -runLength), {}, this.theme, spans);
    }
    const head = runText.slice(0, found.at);
    if (head) spans.push({ text: decodeEntities(head) });

    let content = runText.slice(found.contentAt);
    if (found.kind === 'link') {
      // `[label](htt` — show the label only. With no closing paren there is no
      // URL yet, so there is nothing safe to make clickable, and printing the
      // half-typed destination is noise.
      const close = content.indexOf('](');
      if (close !== -1) content = content.slice(0, close);
    }
    if (!content) return null;

    const style = this.optimisticStyle(found.kind);
    spans.push({ text: decodeEntities(content), style });
    return spans;
  }

  /** Display style for a guessed-closed construct. */
  private optimisticStyle(kind: UnclosedInline['kind']): TextStyle | undefined {
    switch (kind) {
      case 'strong':
        return { bold: true };
      case 'em':
        return { italic: true };
      case 'codespan':
        return { color: this.theme.codeColor, fontFamily: this.theme.codeFont };
      // A link with no closing paren has no href, so it renders as plain text —
      // no link color and no click affordance for a destination nobody has yet.
      case 'link':
        return undefined;
    }
  }

  /**
   * Re-render the paragraph currently showing a guess from its own tokens, with
   * no overlay, and forget it.
   *
   * Idempotent and free when no guess is live, which is what lets `close()`,
   * `abort()`, and a mid-stream staleness check all call it unconditionally.
   */
  /**
   * Start the MathJax load, and re-typeset this document once it resolves.
   *
   * Called from two places, for two different reasons:
   *
   * - When an OPEN math fence is rendered. This is a prefetch, and it is what
   *   makes the lazy load invisible while streaming: the module starts loading
   *   the moment a formula begins arriving, several chunks before its closing
   *   fence, so by the time the fence closes the converter is usually already
   *   installed and the formula typesets synchronously on the normal path.
   * - When a CLOSED fence could not be typeset because the module is not ready.
   *   That is the case a rebuild actually exists for: a document constructed with
   *   math already complete, or a stream that closed a fence faster than the
   *   module loaded.
   *
   * Idempotent per instance. Concurrent callers coalesce onto the one cached
   * module promise, and `mathLoadPending` keeps a second rebuild from being
   * queued while the first is outstanding.
   */
  private ensureMathJax(): void {
    if (mathConverter || this.mathLoadPending || this.isDestroyed) return;
    this.mathLoadPending = true;
    void preloadMathJax().then(() => {
      this.mathLoadPending = false;
      // Destroyed while the module was in flight: the tree this would rebuild
      // is gone, and re-rendering into it would resurrect a detached subtree.
      if (this.isDestroyed) return;
      // A failed load leaves the converter null. Every formula stays TeX source,
      // which is exactly what is on screen already, so a rebuild would be pure
      // cost for an identical tree.
      if (mathConverter) this.retypesetFromTokens();
      // Settlement was held open for this; release it either way.
      this.flushAppendSettledWaiters();
    });
  }

  /**
   * Rebuild every block from the tokens already lexed, without re-lexing.
   *
   * Used only when MathJax arrives after a formula has already been rendered as
   * source. Rebuilding wholesale rather than surgically replacing the math blocks
   * is the deliberate choice: `tokenChildPrefix` maps token indices to child
   * slots positionally, so swapping one child in place would have to keep that
   * mapping, the `Stack`'s cached box, and every following sibling's position in
   * agreement by hand. Re-rendering the same token list in the same order leaves
   * the mapping trivially correct, and this runs at most once per document — the
   * same cost as the `setContent` rebuild that already exists.
   *
   * The optimistic tail is dropped first. Its `entity` is about to be destroyed,
   * so the pointer would dangle; unwinding restores literal spans, and if the
   * stream is still open the next chunk re-applies a guess.
   */
  private retypesetFromTokens(): void {
    this.unwindOptimisticTail();
    const tokens = this.tokens;
    while (this.content.children.length > 0) {
      this.content.children[this.content.children.length - 1].destroy();
    }
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) this.content.add(el);
    }
    this.width = this.content.width;
    this.height = this.content.height;
    this.scene?.markDirty();
  }

  private unwindOptimisticTail(): void {
    const tail = this.optimisticTail;
    this.optimisticTail = null;
    if (!tail || this.isDestroyed) return;
    const entity = tail.entity as Entity & {
      setSpans?: (spans: StyledSpan[]) => unknown;
    };
    // Gone from the tree (destroyed by a later reconcile, or replaced wholesale
    // by setContent) — nothing to unwind, and re-rendering it would resurrect
    // spans on a detached entity.
    if (!entity.setSpans || entity.parent !== this.content) return;
    entity.setSpans(this.literalParagraphSpans(tail.token));
    // Height changed, so the container's cached box has to follow. The O(1)
    // resync is only valid while this really is the last child; once a later
    // block exists, every sibling below it moves and a full reflow is required.
    if (this.content.children.at(-1) === entity) {
      this.content.resizeLastChild(entity);
    } else {
      this.content.layout();
    }
    this.width = this.content.width;
    this.height = this.content.height;
    this.scene?.markDirty();
  }

  /**
   * Drop a guess that is no longer on the document's trailing paragraph.
   *
   * A coalesced append can add a block after the paragraph that owns the guess,
   * at which point the guess is frozen — the construct can never close, because
   * no further text lands in that paragraph. Without this the stale styling would
   * survive until `close()`.
   *
   * `writtenThisPass` is the entity whose spans this reconcile already rewrote,
   * if any: for that one, literal spans are on screen already and re-rendering it
   * would be wasted layout, so only the bookkeeping is cleared.
   */
  private dropStaleOptimisticTail(trailing: Entity | null, writtenThisPass: Entity | null): void {
    const tail = this.optimisticTail;
    if (!tail || tail.entity === trailing) return;
    if (tail.entity === writtenThisPass) {
      this.optimisticTail = null;
      return;
    }
    this.unwindOptimisticTail();
  }

  /**
   * Resolve once every in-flight worker append has actually been applied.
   *
   * Committing text is not the same as the document reflecting it: `append()`
   * reaches `dispatchAppend()`, which `postMessage()`s and returns, and the reply
   * that runs `updateTokens()` lands later. Without waiting here, `close()` could
   * resolve — and `onStable` fire — against a document missing its last chunk.
   *
   * An outstanding lazy MathJax load counts as unsettled for the same reason. A
   * document whose formulas are still TeX source is not final in any sense a
   * caller of `onStable` cares about: the boxes are the wrong size, so measuring
   * or exporting there would capture placeholders.
   */
  private waitForAppendSettled(): Promise<void> {
    if (!this.appendInFlight && !this.mathLoadPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.appendSettledWaiters.push(resolve);
    });
  }

  /**
   * Release settlement waiters, but only once nothing is outstanding.
   *
   * Called at the very END of the worker callback, after its coalesced-re-dispatch
   * check, rather than wherever `appendInFlight` goes false. Within that callback
   * `appendInFlight` is cleared and then, if another chunk arrived while the
   * request was in flight, set straight back to `true` by the re-dispatch — both
   * synchronously, before anything watching the flag could observe the gap. Only
   * checking here, after that, waits through the re-dispatch instead of resolving
   * one chunk early.
   */
  private flushAppendSettledWaiters(): void {
    if (this.appendInFlight || this.mathLoadPending || this.appendSettledWaiters.length === 0) {
      return;
    }
    const waiters = this.appendSettledWaiters;
    this.appendSettledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Throw if a public mutation is attempted from inside an `onStable` callback. */
  private assertNotInStableCallback(method: string): void {
    if (this.inStableCallback) {
      throw new Error(`Markdown.${method}() cannot be called from an onStable callback`);
    }
  }

  private updateTokens(newTokens: TokensList, knownMatchLen?: number): void {
    const oldTokens = this.tokens;
    const oldChildren = [...this.content.children]; // snapshot

    // The raw-equal prefix length. The worker already computed this to decide
    // what tail to send, so when it hands the value over there is nothing to
    // re-derive — this loop was re-scanning every token's `raw` string on the
    // main thread for a result the worker had already produced.
    //
    // Validated rather than trusted blindly: `knownMatchLen` is relative to the
    // token snapshot the request was issued against, and a bug (or a future
    // protocol change) that let it exceed either array would silently reuse the
    // wrong entities. Out-of-range falls through to the scan.
    let matchLen: number;
    const minLen = Math.min(oldTokens.length, newTokens.length);
    if (knownMatchLen !== undefined && knownMatchLen >= 0 && knownMatchLen <= minLen) {
      matchLen = knownMatchLen;
    } else {
      matchLen = 0;
      for (let i = 0; i < minLen; i++) {
        if (oldTokens[i].raw === newTokens[i].raw) {
          matchLen++;
        } else {
          break;
        }
      }
    }

    // Old-token-index → child-entity index (tokens that render nothing don't
    // consume a child slot — see producesEntity). This prefix sum is maintained
    // incrementally by setTokens(), so it's already valid for `oldTokens` here:
    // reading it is O(1) instead of the O(total blocks) rebuild this used to do
    // on every streamed chunk.
    const oldTokenToChild = this.tokenChildPrefix;
    // The raw-equal prefix length, captured before the in-place paragraph branch
    // below mutates `matchLen`. Everything before it is unchanged, so the child
    // prefix sum stays valid there and only the suffix is recomputed.
    const rawMatchLen = matchLen;
    // The guess this pass produced, and the entity whose spans it already wrote.
    // Both are settled by one post-pass below rather than by each render site, so
    // there is a single place that decides which entity may carry a guess.
    let pendingTail: { entity: Entity; token: Tokens.Paragraph } | null = null;
    let spansWrittenTo: Entity | null = null;

    // Handle the common streaming case: the last token changed but kept its type,
    // so its entity can be updated in place instead of destroyed and rebuilt.
    //
    // `code` is here alongside `paragraph` because an unclosed fenced block is the
    // second most common shape an LLM streams, and it is the worst case for the
    // rebuild path: CodeBlock re-tokenizes and re-measures its whole grid on
    // construction, so a block growing one line at a time paid that for every
    // chunk. `setCode()` already existed for live editing; the reconciler simply
    // never called it.
    //
    // `heading` is the third, and was the cheapest to add: it already renders to a
    // `RichText` through the very same `renderInlineToRichText` a paragraph uses,
    // so the mutator was there and only the dispatch below was missing. It carries
    // an extra depth guard the other two do not need — see that branch.
    //
    // Still rebuilt every chunk: `blockquote` (a container of recursively rendered
    // children, so it needs tail-child descent), and `list`/`table` (no mutator
    // exists to call — `Table` exposes only `setSelectable`, so reuse there means
    // new public @vectojs/ui API plus key-based row identity, since the ordinal
    // marker is position-derived).
    const lastTokenSameType =
      matchLen === oldTokens.length - 1 &&
      matchLen < newTokens.length &&
      oldTokens[matchLen]?.type === newTokens[matchLen]?.type;

    if (lastTokenSameType && newTokens[matchLen]?.type === 'code') {
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const codeToken = newTokens[matchLen] as Tokens.Code;
      const oldCodeToken = oldTokens[matchLen] as Tokens.Code;
      const isMath = rendersAsMath(codeToken);
      if (isMath && rendersAsMath(oldCodeToken) && oldCodeToken.text === codeToken.text) {
        // Both sides are the same typeset formula, so the rendered entity is
        // already correct and there is nothing to mutate. This is the common
        // shape right after a fence closes: the next chunk appends the newline
        // that follows it, which changes `raw` (so the prefix match stops short)
        // without changing the formula. Reusing here skips a rebuild and, more
        // to the point, an SVG re-decode.
        this.streamStats.inPlaceUpdates++;
        matchLen++;
      } else if (existingEntity instanceof CodeBlock && !isMath) {
        // Language can change mid-stream: ```` ``` ```` then the info string
        // arrives on the next chunk, so pass it through rather than assuming it
        // is stable.
        //
        // `!isMath` is what lets a closing fence land: while the fence is open a
        // math block IS a CodeBlock, and the chunk that closes it must fall
        // through to the rebuild path to become a formula. Without the guard
        // `setCode` would keep the CodeBlock and the formula would never typeset.
        existingEntity.setCode(codeToken.text, codeToken.lang ?? undefined);
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        // Same O(1) tail resync as the paragraph path: the block is still the
        // Stack's last child, so its own box changed but no sibling moved.
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'paragraph') {
      // Update existing paragraph entity in-place via setSpans
      const entityIdx = oldTokenToChild[matchLen];
      const existingEntity = oldChildren[entityIdx];
      // The `setSpans` path is only valid while the paragraph still renders as one
      // `RichText`. It dispatches on the ENTITY's shape, so without the token check
      // a plain paragraph that gains its first image kept its `RichText` and was
      // handed the image paragraph's spans — and `collectSpans` emits nothing for
      // an `image` token, so the picture was silently DROPPED. Streamed
      // `'Figure: '` then `'![a](u.png)'` rendered a bare `RichText` where a
      // one-shot build gives `Stack[RichText, Image]`. Pre-existing: reproduced
      // unchanged on the commit before this one.
      if (
        existingEntity &&
        'setSpans' in existingEntity &&
        !paragraphHasImage(newTokens[matchLen] as Tokens.Paragraph)
      ) {
        // Re-render the paragraph's inline tokens
        const pToken = newTokens[matchLen] as Tokens.Paragraph;
        // `lastTokenSameType` is indexed off the OLD token list, so it does not
        // imply this is the document's last block: one coalesced append can close
        // this paragraph and start a new block in the same update. Only the real
        // trailing paragraph may carry an optimistic guess.
        const isTrailing = matchLen === newTokens.length - 1;
        const optimistic = isTrailing ? this.optimisticParagraphSpans(pToken) : null;
        // One setSpans either way: computing the guess instead of the literal
        // spans, rather than writing literal spans and then overwriting them,
        // keeps the streaming hot path at a single layout per chunk.
        (existingEntity as any).setSpans(optimistic ?? this.literalParagraphSpans(pToken));
        spansWrittenTo = existingEntity;
        if (optimistic) pendingTail = { entity: existingEntity, token: pToken };
        this.streamStats.inPlaceUpdates++;
        matchLen++; // This token is now handled
        // Streaming's hot path: the growing paragraph is still the Stack's
        // last child, so its own size changed but no sibling moved — resync
        // the container's cached width/height in O(1) instead of falling
        // through to the unconditional full `layout()` this used to run on
        // every single streamed chunk regardless of what actually changed.
        this.content.resizeLastChild(existingEntity);
      } else if (
        existingEntity &&
        this.updateImageParagraph(
          existingEntity,
          oldTokens[matchLen] as Tokens.Paragraph,
          newTokens[matchLen] as Tokens.Paragraph,
        )
      ) {
        // A paragraph containing an image renders as a `Stack`, which has no
        // `setSpans`, so it fell out of the branch above and was rebuilt on every
        // chunk. This `else` is the fix; until it existed the miss was invisible,
        // because the `if` had no alternative and simply dropped through to the
        // destroy/render loops with `inPlaceUpdates` never incrementing.
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'heading') {
      // A heading renders through the same `renderInlineToRichText` as a
      // paragraph, so the entity it produced already has `setSpans` — the
      // reconciler simply never dispatched to it, and a heading streamed a word
      // at a time rebuilt its RichText and re-shaped its text on every chunk.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const hToken = newTokens[matchLen] as Tokens.Heading;
      const oldToken = oldTokens[matchLen] as Tokens.Heading;
      // Depth must be unchanged to reuse. `RichText.setSpans` replaces the runs
      // and re-lays out but does NOT touch `font`, which is constructor-only, and
      // a heading's font size is derived from its depth. Streaming `#` and then
      // `# T` lexes to `## T`: the same token index goes from depth 1 to depth 2
      // while still being a `heading`, so reusing blindly would paint an h2 at
      // h1's size. Fall through to the rebuild in that case.
      if (existingEntity && 'setSpans' in existingEntity && oldToken?.depth === hToken.depth) {
        (existingEntity as any).setSpans(this.headingSpans(hToken));
        // No optimistic guess for headings. `optimisticParagraphSpans` reads
        // `incompleteMode` for the trailing *paragraph*; a heading is a single
        // short line whose unclosed emphasis closes within a chunk or two, so the
        // guess would buy a frame of styling at the cost of another code path
        // that has to be unwound on close(). Literal spans only.
        spansWrittenTo = existingEntity;
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        // Same O(1) tail resync as the paragraph and code paths.
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'blockquote') {
      // A blockquote is the one reusable block that owns a subtree rather than a
      // single entity, so reuse means descending to its tail child instead of
      // calling a mutator on the block itself. A quote streamed line by line
      // otherwise rebuilt every inner block plus the border on every chunk.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const newInner = (newTokens[matchLen] as Tokens.Blockquote).tokens;
      const oldInner = (oldTokens[matchLen] as Tokens.Blockquote).tokens;
      if (
        existingEntity instanceof MarkdownContainer &&
        newInner &&
        oldInner &&
        this.updateBlockquoteTail(existingEntity, oldInner, newInner)
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'list') {
      // A list is the worst rebuild case in this reconciler, because the token
      // keeps EVERY item: a list streamed to N items rebuilt 1+2+…+N RichTexts,
      // i.e. Theta(N^2). Measured before this path existed, a 32-item list cost
      // 528 constructions against 32 for the same list built once.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      if (
        existingEntity &&
        this.updateStreamedList(
          existingEntity,
          oldTokens[matchLen] as Tokens.List,
          newTokens[matchLen] as Tokens.List,
        )
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'table') {
      // The last block type to get an in-place path, and the most expensive one
      // to rebuild: a table token carries every row, so the rebuild cost is
      // Theta(C*N^2) cell constructions across a stream, plus a further 2x
      // because Table.layout() re-runs fitCell on every cell.
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      if (
        existingEntity &&
        this.updateStreamedTable(
          existingEntity,
          oldTokens[matchLen] as Tokens.Table,
          newTokens[matchLen] as Tokens.Table,
        )
      ) {
        this.streamStats.inPlaceUpdates++;
        matchLen++;
        this.content.resizeLastChild(existingEntity);
      }
    }

    // Destroy excess old entities (from matchLen onward). destroy() (not just
    // remove()) so a discarded block's subtree resources are released, and it
    // detaches from `content` itself. Starts AT matchLen — the old loop walked
    // every token from 0 only to skip the matched prefix with an `i >= matchLen`
    // test, making it O(total blocks) per streamed chunk.
    // Everything before matchLen kept its entity untouched, which is the reuse
    // the incremental path exists to produce.
    for (let i = 0; i < matchLen; i++) {
      if (this.producesEntity(oldTokens[i])) this.streamStats.entitiesReused++;
    }
    for (let i = matchLen; i < oldTokens.length; i++) {
      if (this.producesEntity(oldTokens[i])) {
        this.streamStats.entitiesRebuilt++;
        const idx = oldTokenToChild[i];
        if (idx < oldChildren.length) {
          oldChildren[idx].destroy();
        }
      }
    }

    // Add new entities for tokens beyond matchLen
    const lastIndex = newTokens.length - 1;
    for (let i = matchLen; i < newTokens.length; i++) {
      const el = this.renderToken(newTokens[i]);
      if (!el) continue;
      this.content.add(el);
      // A fresh trailing paragraph — the first one of a stream, or one following
      // a block that just closed — gets the same guess the in-place branch above
      // applies. `renderToken` is the documented subclass override seam, so the
      // overlay is applied over its result here instead of by threading a mode
      // parameter through that signature.
      if (i === lastIndex && newTokens[i].type === 'paragraph' && 'setSpans' in el) {
        const pToken = newTokens[i] as Tokens.Paragraph;
        const optimistic = this.optimisticParagraphSpans(pToken);
        if (optimistic) {
          (el as any).setSpans(optimistic);
          this.content.resizeLastChild(el);
          pendingTail = { entity: el, token: pToken };
          spansWrittenTo = el;
        }
      }
    }

    // One place decides which entity may carry a guess. A coalesced append can
    // add a block after the paragraph that owned the previous guess, and that
    // guess is then frozen — no further text can land in that paragraph, so the
    // construct can never close and the styling would otherwise survive to
    // close(). `spansWrittenTo` is excluded from the re-render because literal
    // spans are already on screen for it.
    this.dropStaleOptimisticTail(pendingTail?.entity ?? null, spansWrittenTo);
    if (pendingTail) this.optimisticTail = pendingTail;

    // The raw-equal prefix is unchanged, so its child-index entries stay valid;
    // only the suffix prefix-sum is recomputed.
    this.setTokens(newTokens, rawMatchLen);
    // No explicit layout() here: the common in-place resize above uses
    // resizeLastChild(), and any add()/remove() calls in the loops above
    // already keep `content`'s own width/height correct as they happen (see
    // Stack.add()'s fastAppendDirty resync) — an unconditional full layout()
    // on every call would silently redo (or, for the pure-resize case,
    // needlessly perform for the first time) an O(children) walk on every
    // single streamed chunk.
    this.width = this.content.width;
    this.height = this.content.height;

    this.scene?.markDirty();
    if (this.onLayoutUpdated) {
      this.onLayoutUpdated();
    }
  }

  /**
   * Render one nested block with a temporary width/margin context while
   * preserving `renderToken` as the subclass override seam.
   */
  private renderTokenWithMetrics(token: Token, metrics: BlockMetrics): Entity | null {
    const previous = this.activeBlockMetrics;
    this.activeBlockMetrics = metrics;
    try {
      return this.renderToken(token);
    } finally {
      this.activeBlockMetrics = previous;
    }
  }

  /**
   * Whether {@link renderToken} produces a child entity for this token (vs
   * `null`). `updateTokens` maps token indices to child-entity indices, and the
   * reconcile/removal loops must skip EXACTLY the tokens that render nothing —
   * not just `space`. A `space`, a non-SVG raw `html` block (an HTML comment,
   * a bare `<div>`), or a fallback token without `text` all render null; before
   * this, only `space` was skipped, so a null-rendering `html`/`def` token
   * before the growing tail shifted every subsequent entity index by one and
   * the wrong entity was updated or destroyed. Kept in lockstep with
   * `renderToken`'s null returns.
   */

  protected producesEntity(token: Token): boolean {
    switch (token.type) {
      case 'space':
        return false;
      case 'html': {
        const text = (token as Tokens.HTML).text.toLowerCase();
        return text.includes('<svg') && text.includes('</svg>');
      }
      case 'heading':
      case 'paragraph':
      case 'code':
      case 'blockquote':
      case 'list':
      case 'table':
      case 'hr':
        return true;
      default:
        return 'text' in token;
    }
  }

  protected renderToken(token: Token): Entity | null {
    const t = this.theme;
    const bodyFont = `${t.fontSize}px ${t.bodyFont}`;
    const metrics = this.activeBlockMetrics ?? {
      marginBefore: 0,
      marginAfter: 0,
      indentStart: 0,
      availableWidth: this.maxWidth,
    };
    const availableWidth = metrics.availableWidth;

    // Inline `$...$` needs MathJax just as a fence does, and only the `code` arm
    // below used to ask for it — so a document whose only math was inline never
    // started the load and its formulas stayed TeX source forever. Checked here
    // rather than per-arm because inline math can appear in a heading, list item,
    // blockquote, or table cell, not just a paragraph.
    if (containsInlineMath(token)) {
      if (!mathConverter) this.ensureMathJax();
      // A typeset formula paints from a raster that decodes asynchronously, and
      // the paint callback has no way to ask for a repaint itself. Subscribed here
      // rather than at span-collection time because that is a free function with
      // no access to this instance.
      this.subscribeInlineMathRepaint();
    }

    switch (token.type) {
      // ── Headings ─────────────────────────────────────────────────────
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const sizes = [32, 28, 24, 20, 18, 16];
        const size = sizes[Math.min(hToken.depth - 1, 5)];
        const headingFont = `bold ${size}px ${t.bodyFont}`;
        return renderInlineToRichText(
          hToken.tokens,
          hToken.text,
          headingFont,
          t.headingColor,
          availableWidth,
          t,
          this.selectable,
          this.onLinkClick,
        );
      }

      // ── Paragraphs ───────────────────────────────────────────────────
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        if (!paragraphHasImage(pToken)) {
          return renderInlineToRichText(
            pToken.tokens,
            pToken.text,
            bodyFont,
            t.textColor,
            availableWidth,
            t,
            this.selectable,
            this.onLinkClick,
          );
        }

        // Split paragraph into a Stack if it contains images
        const stack = new Stack({
          direction: 'vertical',
          gap: 16,
          maxWidth: availableWidth,
        });
        let currentTokens: Token[] = [];

        const flushText = () => {
          if (currentTokens.length > 0) {
            stack.add(this.inlineRunRichText(currentTokens, availableWidth, t));
            currentTokens = [];
          }
        };

        for (const child of pToken.tokens) {
          if (child.type === 'image') {
            flushText();
            stack.add(this.paragraphImage(child as Tokens.Image, availableWidth));
          } else {
            currentTokens.push(child);
          }
        }
        flushText();
        return stack;
      }

      // ── Code blocks ──────────────────────────────────────────────────
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').toLowerCase();

        // A math fence is typeset only once its closing fence arrives. While it
        // is still open it renders as an ordinary CodeBlock showing the TeX
        // source, which is both the honest thing to show (the formula genuinely
        // is not finished) and the cheap one: MathJax is the most expensive call
        // in this package, and converting every prefix of a streamed formula
        // spends all of it on syntactically invalid TeX that renders as an error
        // glyph nobody wants to see. As a CodeBlock it also gets the existing
        // `setCode` in-place update, so the growing source costs one mutator
        // call per chunk instead of a rebuild.
        // Begin loading MathJax as soon as a math fence appears, even while it is
        // still open. During a stream that prefetch is what hides the lazy load
        // entirely: the module is fetched over the several chunks it takes the
        // formula to arrive, so the closing fence typesets on the synchronous
        // path below.
        if (MATH_LANGS.has(lang)) this.ensureMathJax();

        if (rendersAsMath(codeToken)) {
          const mathData = renderMathToSVGDataURI(codeToken.text, true);
          if (mathData) {
            // `ex` is font-relative, so resolve it against the theme's body size.
            // This is what the old hardcoded `* 8` got wrong: it was exact only
            // near 18.1px, so a block formula was ~13% oversized at the 16px
            // default and far worse at other sizes.
            const intrinsicW = exToPx(mathData.widthEx, t.fontSize);
            const intrinsicH = exToPx(mathData.heightEx, t.fontSize);
            // Provide a generous default height, it will scale based on width
            const mathImg = new Image(mathData.uri, {
              width: Math.min(availableWidth, intrinsicW),
              height: intrinsicH * Math.min(1, availableWidth / intrinsicW),
              alt: codeToken.text,
              // The SVG decodes asynchronously and Image paints a placeholder
              // until it lands. Without this an `onDemand` scene, which repaints
              // only when marked dirty, leaves the formula a blank slab forever.
              onLoad: () => {
                this.scene?.markDirty();
              },
            });
            // Let the layout flow it as a block
            const wrapper = new MarkdownContainer();
            mathImg.x = 16;
            mathImg.y = 8;
            wrapper.add(mathImg);
            wrapper.width = mathImg.width + 16;
            wrapper.height = mathImg.height + 16;
            return wrapper;
          }
        }

        return new CodeBlock(codeToken.text, lang, availableWidth, t, this.selectable);
      }

      // ── Blockquotes ──────────────────────────────────────────────────
      case 'blockquote': {
        const bqToken = token as Tokens.Blockquote;
        const innerStack = new Stack({ direction: 'vertical', gap: 8 });
        const indentStart = Math.min(16, availableWidth);
        const childMetrics: BlockMetrics = {
          marginBefore: 0,
          marginAfter: 0,
          indentStart,
          availableWidth: Math.max(0, availableWidth - indentStart),
        };

        // Recursively render inner tokens
        if (bqToken.tokens) {
          for (const inner of bqToken.tokens) {
            const el = this.renderTokenWithMetrics(inner, childMetrics);
            if (el) {
              const wrapper = new MarkdownContainer();
              el.x = childMetrics.indentStart;
              wrapper.add(el);
              wrapper.width = el.width + childMetrics.indentStart;
              wrapper.height = el.height;
              innerStack.add(wrapper);
            }
          }
        }

        // Add the vertical accent bar
        const border = new QuoteBorder(innerStack.height || 20, t.quoteBorderColor);

        // A plain Entity, not a Stack: the border and text overlay at the same
        // position (both at x=0, y=0), they aren't laid out sequentially. A
        // Stack re-runs its own sequential layout on every add() (see
        // Stack.add), which would silently move the second child below the
        // first regardless of any position set on it beforehand.
        const container = new MarkdownContainer();
        border.x = 0;
        border.y = 0;
        container.add(border);

        // Overlay the inner text stack
        innerStack.y = 0;
        innerStack.x = 0;
        container.add(innerStack);
        container.width = availableWidth;
        container.height = Math.max(border.height, innerStack.height);

        return container;
      }

      // ── Lists ────────────────────────────────────────────────
      case 'list': {
        const listToken = token as Tokens.List;
        const listStack = new Stack({ direction: 'vertical', gap: 6 });
        for (let i = 0; i < listToken.items.length; i++) {
          listStack.add(this.listItemRichText(listToken, i, availableWidth, t));
        }
        return listStack;
      }

      // ── Table ────────────────────────────────────────────────────────
      case 'table': {
        const tblToken = token as Tokens.Table;

        const headers = tblToken.header.map((cell) => this.tableCellRichText(cell, true, t));
        const rows = tblToken.rows.map((row) =>
          row.map((cell) => this.tableCellRichText(cell, false, t)),
        );

        return new Table({
          headers,
          rows,
          width: availableWidth,
          textColor: t.textColor,
          headerTextColor: t.headingColor,
          font: `${t.fontSize - 2}px ${t.bodyFont}`,
          borderColor: t.hrColor,
          bg: t.tableBgColor,
          headerBg: t.tableHeaderBgColor,
          selectable: this.selectable,
        });
      }

      // ── Horizontal rule ──────────────────────────────────────────────
      case 'hr':
        return new HorizontalRule(availableWidth, t.hrColor);

      // ── Whitespace ───────────────────────────────────────────────────
      case 'space':
        return null;

      // ── HTML (Support raw SVGs) ──────────────────────────────────────
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        if (
          htmlToken.text.toLowerCase().includes('<svg') &&
          htmlToken.text.toLowerCase().includes('</svg>')
        ) {
          return new SVGEntity(htmlToken.text);
        }
        return null;
      }

      // ── Fallback ─────────────────────────────────────────────────────
      default:
        if ('text' in token) {
          return new Text((token as any).text, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: availableWidth,
            lineHeight: 24,
            selectable: this.selectable,
          });
        }
        return null;
    }
  }

  /** Structural — children draw themselves. */
  public render(_r: IRenderer): void {}
}
