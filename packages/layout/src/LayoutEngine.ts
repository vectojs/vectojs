import { ArabicShaper } from '@vectojs/text';
import { BidiResolver } from '@vectojs/text';

/**
 * Glyphs sized by the engine's own `0.5em` guess — no atlas entry and no
 * measurer at all. See {@link unmeasuredGlyphCount}.
 */
let unmeasuredGlyphs = 0;
let warnedUnmeasured = false;
let warnUnmeasured = true;

/**
 * How many glyphs have been sized by the `0.5em` guess in this process.
 *
 * Non-zero means some text is laid out with fabricated metrics: line widths,
 * wrap points, and justification are all wrong for those glyphs. Distinct from
 * {@link LayoutResult.fallbackToCanvas}, which only reports that a glyph was
 * missing from the *atlas* — that is the normal path for `Text`/`RichText`
 * (both pass an empty atlas), so it is true on essentially every paragraph even
 * in a browser and says nothing about measurement quality.
 *
 * The usual cause is a DOM-free environment (Node SSR, a worker with no canvas)
 * with no font metrics registered. Register them with `registerFontMetrics` or
 * `registerMSDFFontMetrics` from `@vectojs/text`.
 *
 * Counts only glyphs for which no measurer could be consulted. A measurer that
 * is present but has no entry for one glyph applies its own per-glyph fallback,
 * which this does not see — zero here means "every advance came from some real
 * metrics source", not "every glyph was found in its font".
 */
export function unmeasuredGlyphCount(): number {
  return unmeasuredGlyphs;
}

/** Reset {@link unmeasuredGlyphCount} and re-arm the one-time warning. */
export function resetUnmeasuredGlyphCount(): void {
  unmeasuredGlyphs = 0;
  warnedUnmeasured = false;
}

/**
 * Silence the one-time console warning about unmeasured glyphs.
 *
 * For a caller that has decided the `0.5em` approximation is acceptable — a
 * layout whose text is never displayed, say. {@link unmeasuredGlyphCount} keeps
 * counting either way.
 */
export function setUnmeasuredGlyphWarning(enabled: boolean): void {
  warnUnmeasured = enabled;
}

/**
 * Map from a single grapheme character to its pre-measured glyph metrics.
 *
 * Each entry provides the glyph's pixel `width` at `baseSize`, and an `ast`
 * property holding the raw vector path data used by the renderer.
 */
export interface GlyphAtlas {
  [char: string]: {
    width: number;
    baseSize: number;
    ast: any;
  };
}

/**
 * The shared "no pre-measured glyphs" atlas, for callers that measure entirely
 * through a {@link GlyphMeasurer}.
 *
 * Exists because {@link LayoutEngine.prepare} and {@link LayoutEngine.prepareRich}
 * drop every memoized paragraph when the atlas argument is not the SAME OBJECT as
 * the previous call — glyph advances depend on it, so a changed atlas has to
 * invalidate. Passing a fresh `{}` literal per call therefore cleared both caches
 * on every layout, which is exactly what `Text` and `RichText` used to do: measured
 * through the real `RichText`, five identical re-layouts produced 0 cache hits and
 * 12 misses, so the memo was dead code on the only paths that used it. Reusing this
 * frozen constant restores it (measured 2.68x on 200 re-layouts of 12 paragraphs:
 * 88.03ms -> 32.82ms, hits 0 -> 2388).
 *
 * Frozen so a caller cannot accidentally make it non-empty and silently poison
 * every other consumer's advances.
 */
export const EMPTY_GLYPH_ATLAS: GlyphAtlas = Object.freeze({}) as GlyphAtlas;

/**
 * Resolves the pixel advance width of a single grapheme at a given font size,
 * for glyphs not present in a pre-baked {@link GlyphAtlas}.
 *
 * Implemented by {@link createCanvasMeasurer} (canvas `measureText`), but kept
 * abstract so callers can supply their own metrics source.
 */
export interface GlyphMeasurer {
  /** Measure one grapheme's advance at `fontSize`. `fontFamily`, when given,
   *  overrides the measurer's base family for this glyph — needed so a run in a
   *  different family (e.g. inline monospace `code` inside proportional prose)
   *  is measured at its own metrics, not the base font's.
   *  `bold` and `italic`, when given, request measuring with those styles active
   *  so the measured width matches what the renderer will paint — a bold glyph is
   *  genuinely wider than its regular counterpart in most fonts. */
  measure(
    char: string,
    fontSize: number,
    fontFamily?: string,
    bold?: boolean,
    italic?: boolean,
  ): number;
}

/**
 * Per-run inline style for rich text ({@link LayoutEngine.prepareRich}). All
 * fields are optional and inherited from the call's base style when omitted.
 */
export interface TextStyle {
  /** Font size in px for this run; overrides the base size (affects width + line height). */
  fontSize?: number;
  /** Fill color, e.g. `'#38bdf8'`. */
  color?: string;
  /** Bold weight (affects both measurement and rendering since LayoutEngine 2.x). */
  bold?: boolean;
  /** Italic slant (affects both measurement and rendering since LayoutEngine 2.x). */
  italic?: boolean;
  /**
   * CSS font-family for this run, overriding the base family (e.g. a monospace
   * stack for inline `code`). Affects both measurement (width) and rendering,
   * so a run in a different family lays out at its own metrics. When omitted the
   * run uses the component's base family.
   */
  fontFamily?: string;
  /**
   * Strike a line through this run (rendering only; advances are unchanged).
   *
   * Distinct from the underline a link gets, which is implied by {@link href}
   * rather than requested: a struck run is a semantic state of the content (GFM
   * `~~deleted~~`), so it must be expressible independently of any destination.
   */
  lineThrough?: boolean;
  /**
   * Vertical offset of this run's baseline in px, **positive = UP** (the CSS
   * `vertical-align` convention: superscript is positive, subscript negative).
   *
   * Render-only in the horizontal sense — advances are unchanged — but it IS a
   * measurement change: a run shifted far enough that its glyph box would leave
   * the line box grows the line, exactly like a tall inline object. Modest
   * shifts (a superscript at 0.75em raised ~0.3em) fit inside the existing
   * slack `0.8 * (pMax - gfs)` above a smaller run and grow nothing.
   *
   * The sign is the opposite of {@link InlineObject.depth} (positive = below
   * the baseline there) on purpose: baseline shift is written the way a web
   * author thinks of vertical-align, while `depth` mirrors MathJax's emitted
   * CSS, whose values are already sign-flipped relative to the visual sense.
   */
  baselineShift?: number;
  /**
   * Underline this run (rendering only; advances are unchanged).
   *
   * Distinct from the underline a link gets, which is implied by {@link href}
   * rather than requested — same reasoning as {@link lineThrough}: GFM has no
   * `~~ins~~`-shaped strikethrough syntax for underline, but `markdown-it-ins`'s
   * `++inserted++` is exactly that shape, and a struck run and an inserted run
   * are independent semantic states of the content, not a destination.
   */
  underline?: boolean;
  /**
   * Paint a background behind this run's glyph box, e.g. `'#fef08a'`.
   *
   * A **fill color**, not a boolean, because `==marked==` text (`markdown-it-mark`)
   * carries no inherent color the way `lineThrough`/`underline` do — CSS `mark`'s
   * UA-stylesheet default is `background-color: Mark` (a yellow highlight), and a
   * consumer needs to be able to pick a different one without a second field.
   * Undefined paints nothing, matching every other optional style field here.
   */
  highlightColor?: string;
  /**
   * This run is a recognised abbreviation; the value is its expansion, e.g.
   * `'HyperText Markup Language'` for a run of `'HTML'`.
   *
   * Rendering-only, like {@link lineThrough}/{@link underline} — carried
   * through to the positioned nodes so a consumer can paint the
   * `markdown-it-abbr` dotted-underline convention and surface the expansion
   * as a tooltip/native `title`, without the layout engine itself knowing
   * anything about abbreviations. A string rather than a boolean because the
   * expansion IS the payload a consumer needs, the same reasoning as
   * {@link highlightColor} over a bare flag.
   */
  abbrTitle?: string;
  /** Hyperlink destination; carried through to the positioned nodes for hit-testing / a11y. */
  href?: string;
}

/**
 * The character an {@link InlineObject} span must consist of: U+FFFC OBJECT
 * REPLACEMENT CHARACTER.
 *
 * Using the standard Unicode sentinel rather than a private-use codepoint means
 * a caller that ignores `object` still gets sane behavior — the character is
 * defined to render as nothing meaningful and carries no width of its own.
 */
export const OBJECT_REPLACEMENT = '\ufffc';

/**
 * A non-text box occupying inline space: the metrics the engine needs to
 * reserve advance for something it does not shape (a typeset formula, an icon,
 * an embedded entity).
 *
 * The engine reserves the space and reports where it landed; it never draws the
 * object. Two ways to fill the box: give the object a {@link InlineObject.paint}
 * callback and let the text renderer invoke it, or read the positioned
 * {@link OBJECT_REPLACEMENT} glyph back out of the layout result and place a
 * separate entity there. Prefer `paint` — it travels with the span, so it cannot
 * be forgotten at one construction site out of several.
 *
 * All three values are in px at final size — already resolved by the caller, not
 * scaled by the run's `fontSize`. An object is a fixed box, unlike a glyph whose
 * advance scales with its size.
 */
export interface InlineObject {
  /** Horizontal advance to reserve. Must be finite and >= 0. */
  width: number;
  /** Total box height, ascent + descent. Feeds the line's height calculation. */
  height: number;
  /**
   * How far the box extends *below* the text baseline, as a positive number.
   * `0` sits the box entirely on the baseline; `height` hangs it entirely below.
   *
   * This mirrors CSS `vertical-align` with the sign flipped: MathJax emits
   * `vertical-align: -0.486ex`, which is `depth: 0.486 * exToPx`.
   */
  depth?: number;
  /**
   * Text equivalent for the accessible name, selection, and copy — the object's
   * alt text (a formula's TeX source, an icon's label).
   *
   * Without this the raw {@link OBJECT_REPLACEMENT} sentinel reaches the
   * accessibility layer, where it is meaningless to a screen reader and copies as
   * an invisible character. Consumers that assemble text from spans should
   * substitute this for the sentinel.
   */
  alt?: string;
  /**
   * What this object draws, when `alt` does not determine it.
   *
   * Part of the paragraph memo key and of inline-object equality, exactly like
   * {@link alt}, and for the same reason: two objects that compare equal share a
   * cached paragraph, and a cached paragraph carries the FIRST one's
   * {@link paint}. So an object whose picture is chosen by something other than
   * its accessible name must say so here, or the second is painted as the first.
   *
   * A Markdown image sets it to the image's URL: `![badge](pass.svg)` and
   * `![badge](fail.svg)` have identical `alt`, identical metrics, and different
   * pictures — a badge column in a table is the ordinary case, and without this
   * every row paints the first row's badge. Inline math does NOT need it, because
   * its data URI is a pure function of the TeX source that already lands in
   * `alt`.
   *
   * Not a cache key for the drawing itself and not read during paint — it only
   * has to differ when the painters differ. A URL, a hash, or any stable string
   * is fine; an identity that varies per call (a counter, `Math.random()`) would
   * defeat the memo instead, the same way putting the closure itself in the key
   * would.
   */
  key?: string;
  /**
   * Draws the object's content into the box the engine reserved for it.
   *
   * The engine never calls this — it does not render. A text renderer painting a
   * laid-out result calls it once per object node, passing the resolved box, and
   * skips painting the {@link OBJECT_REPLACEMENT} sentinel itself.
   *
   * Supplying the painter with the object rather than registering it on the
   * renderer is deliberate. The painter then travels with the span through
   * flattening, caching, and reuse, so it cannot be forgotten at one of the
   * several places a consumer constructs styled text. Inline math shipped without
   * it and rendered a blank gap: the box was reserved, positioned, and
   * accessible, and nothing ever drew in it.
   *
   * Called during a paint, so it must be synchronous and cheap. An object whose
   * content is still loading should draw nothing and request a repaint when it is
   * ready.
   *
   * Deliberately NOT part of the paragraph memo key, unlike `alt`. Measured: two
   * objects with identical metrics and identical `alt` but different `paint`
   * closures share a cached paragraph, and the second is served the FIRST's
   * closure. That is safe when the drawing is a function of `alt` — inline math's
   * URI is a pure function of its TeX source, so both closures draw the same
   * thing. A consumer whose painter draws something `alt` does not determine must
   * set {@link key}, because adding the closure to the key would defeat the memo
   * entirely: a fresh closure per call never compares equal.
   */
  paint?: (surface: InlineObjectSurface, box: InlineObjectBox) => void;
}

/**
 * Where {@link InlineObject.paint} lands, in the text's local coordinate space.
 *
 * `y` is the box's top, already resolved against the line's baseline and the
 * object's {@link InlineObject.depth} — a painter does not repeat that
 * arithmetic.
 */
export interface InlineObjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The drawing surface {@link InlineObject.paint} receives.
 *
 * Structurally a subset of `@vectojs/core`'s `IRenderer`, declared here because
 * this package sits *below* `core` and cannot import from it. It is deliberately
 * the two blit calls and nothing else: this package is a layout engine and has no
 * business describing a renderer beyond what an inline object needs to draw
 * itself. A real renderer satisfies it without being adapted.
 */
export interface InlineObjectSurface {
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  drawImageRect?(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * A run of text sharing one {@link TextStyle}, the input unit of
 * {@link LayoutEngine.prepareRich}.
 *
 * A span is either text or a single inline object, never both. When `object` is
 * set, `text` must be exactly one {@link OBJECT_REPLACEMENT}; the engine reserves
 * `object.width` instead of measuring the character.
 */
export interface StyledSpan {
  text: string;
  style?: TextStyle;
  /**
   * Reserve inline space for a non-text box instead of shaping `text`.
   *
   * Requires `text === OBJECT_REPLACEMENT`. A span whose `text` is anything else
   * ignores this field, because the engine keys the reservation on the sentinel
   * character so it survives the flattening into the per-character style map.
   */
  object?: InlineObject;
}

/**
 * A single positioned glyph produced by {@link LayoutEngine.layoutText}.
 */
export interface LayoutNode {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Inline style carried from rich text; `undefined` for plain (single-style) layout. */
  style?: TextStyle;
  /**
   * Set when this node is a reserved {@link InlineObject} rather than a glyph.
   * `char` is {@link OBJECT_REPLACEMENT}, `width`/`height` are the object's box,
   * and `x`/`y` are its top-left — draw the real content there and skip painting
   * the character.
   */
  object?: InlineObject;
  sourceIndex?: number;
  sourceLength?: number;
  isRTL?: boolean;
}

/**
 * The complete output of a text layout pass — an ordered list of positioned
 * glyphs and the total bounding-box dimensions.
 */
export interface LayoutResult {
  nodes: LayoutNode[];
  totalWidth: number;
  totalHeight: number;
  fallbackToCanvas?: boolean;
}

/** A single measured grapheme (the "cold" half of the cold/hot split). */
/** The internal caches {@link LayoutEngine.cacheStats} reports on. */
export type LayoutCacheName = 'word' | 'grapheme' | 'paragraph' | 'richParagraph';

/** One cache's tallies. `hitRate` is null until the cache has been consulted. */
export interface LayoutCacheStat {
  hits: number;
  misses: number;
  /** Full flushes, not evicted entries: these caches clear wholesale at their cap. */
  evictions: number;
  size: number;
  capacity: number;
  hitRate: number | null;
}

export type LayoutCacheStats = Record<LayoutCacheName, LayoutCacheStat>;

export interface PreparedGlyph {
  char: string;
  /** Advance width at the prepared `fontSize`. */
  width: number;
  /** Inline style (rich text only); drives per-glyph size, color and baseline. */
  style?: TextStyle;
  /**
   * Set when this glyph is a reserved {@link InlineObject} box rather than a
   * character. `width` is the object's reserved advance, and `char` is
   * {@link OBJECT_REPLACEMENT}.
   *
   * Read this off the positioned result to find where to draw the real content.
   */
  object?: InlineObject;
  level: number;
  sourceIndex: number;
  sourceLength: number;
  /**
   * Set when the glyph atlas had no entry for this glyph, so its advance came
   * from the canvas measurer instead of the atlas.
   *
   * The engine already computed this to decide the paragraph's
   * `fallbackToCanvas` flag and then discarded it, leaving "some glyph in this
   * paragraph fell back" as the finest available granularity — which is not
   * enough to find WHICH character is the expensive one. Recorded only when true,
   * so the common case adds no property.
   */
  atlasMiss?: true;
}

/** A measured word/segment, ready to be placed without re-measuring. */
export interface PreparedWord {
  glyphs: PreparedGlyph[];
  /** Sum of glyph advances — used for word-level wrap decisions. */
  width: number;
  isWordLike: boolean | undefined;
  /** Pre-computed `word.trim().length === 0`. */
  isWhitespace: boolean;
  /**
   * Glyph indices where the word may break with a visible hyphen — from
   * soft hyphens (U+00AD) in the source or the engine's `hyphenate` hook.
   */
  breakPoints?: number[];
}

/** A measured paragraph; `isEmpty` marks a blank line (forced newline). */
export interface PreparedParagraph {
  words: PreparedWord[];
  isEmpty: boolean;
  fallbackToCanvas?: boolean;
  baseLevel?: number;
}

/**
 * The result of the **cold** measurement pass ({@link LayoutEngine.prepare}):
 * segmented + measured text that is independent of layout constraints
 * (`maxWidth`/`maxHeight`/exclusion masks). Reuse it across cheap **hot**
 * re-layouts ({@link LayoutEngine.layoutPrepared}) on resize / reposition,
 * avoiding the per-frame `Intl.Segmenter` + measurement cost.
 */
export interface PreparedText {
  paragraphs: PreparedParagraph[];
  fontSize: number;
  fallbackToCanvas?: boolean;
  /**
   * Advance width of '-' at `fontSize`, for wrap-time hyphen insertion.
   *
   * Set only when some word carries break points — the sole consumer of this
   * value — so a paragraph without hyphenation opportunities performs no '-'
   * measurement (and, without registered metrics, raises no spurious
   * unmeasured-glyph warning). Absent means layout falls back to `0.3em`.
   */
  hyphenWidth?: number;
}

/**
 * A rectangular region (in the text's local coordinate space) that text must
 * flow around — the v1 of text flow exclusion shapes. A left/right rect acts
 * like a CSS float; a centered rect splits the affected lines in two.
 */
export interface ExclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A free horizontal interval `[x0, x1)` available for text on one line. */
export interface LineSegment {
  x0: number;
  x1: number;
}

/**
 * The free horizontal segments left in `[0, maxWidth]` for a line whose box
 * spans the vertical band `[top, bottom)`, after subtracting every
 * {@link ExclusionRect} that overlaps that band. Returns the full width when
 * nothing overlaps, and `[]` when an exclusion (or union of them) spans the
 * whole width. Pure — the testable core of exclusion flow.
 *
 * Time O(n log n) in the number of overlapping exclusions; space O(n).
 */
export function computeLineSegments(
  top: number,
  bottom: number,
  maxWidth: number,
  exclusions: ExclusionRect[],
): LineSegment[] {
  // x-intervals of the exclusions that vertically overlap this band, clamped.
  const blocks: Array<[number, number]> = [];
  for (const r of exclusions) {
    if (r.y < bottom && r.y + r.height > top) {
      const x0 = Math.max(0, r.x);
      const x1 = Math.min(maxWidth, r.x + r.width);
      if (x1 > x0) blocks.push([x0, x1]);
    }
  }
  if (blocks.length === 0) return [{ x0: 0, x1: maxWidth }];

  // Merge overlapping/touching blocks, then take the complement within [0,maxWidth].
  blocks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }

  const segs: LineSegment[] = [];
  let cursor = 0;
  for (const [bx0, bx1] of merged) {
    if (bx0 > cursor) segs.push({ x0: cursor, x1: bx0 });
    cursor = Math.max(cursor, bx1);
  }
  if (cursor < maxWidth) segs.push({ x0: cursor, x1: maxWidth });
  return segs;
}

/**
 * True if `text` contains any character whose shaping/ordering depends on its
 * neighbours — i.e. where appending or changing text elsewhere in the string
 * can alter an ALREADY-shaped glyph. That rules out the incremental
 * suffix-only reshaping in {@link LayoutEngine.prepareRich}'s streaming fast
 * path, which assumes each grapheme shapes independently and left-to-right.
 *
 * Deliberately conservative: it OVER-reports (returns true for scripts that
 * might in practice be safe) so the fast path is only ever taken for plainly
 * context-free text (ASCII, Latin, Cyrillic, Greek, CJK, kana, standalone
 * emoji, punctuation). Anything RTL/bidi (Hebrew, Arabic), joining/cursive,
 * combining, Indic/SE-Asian, or emoji-sequence-forming (ZWJ, variation
 * selectors, skin-tone modifiers) falls through to the correct full shaper.
 */
/**
 * Split `text` into paragraphs on any line ending (`\r\n`, `\n`, or a lone
 * `\r`), reporting for each how many characters of the ORIGINAL string it
 * consumed (its own length plus its separator's).
 *
 * Splitting on `'\n'` alone leaves a CRLF's `\r` at the end of the paragraph,
 * where it gets shaped and laid out as a real glyph — a visible tofu box in most
 * fonts, which also inflates the line width and shifts selection. Line endings
 * must never reach the glyph loop. But source offsets (`sourceIndex`, and the
 * per-character style lookup on the rich path) index the ORIGINAL text, so the
 * separator's true length has to be carried through instead of assumed to be 1.
 */
function splitParagraphs(text: string): Array<{ text: string; consumed: number }> {
  const out: Array<{ text: string; consumed: number }> = [];
  const re = /\r\n|[\r\n]/g;
  let start = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push({
      text: text.slice(start, m.index),
      consumed: m.index - start + m[0].length,
    });
    start = re.lastIndex;
    m = re.exec(text);
  }
  // Trailing segment (nothing after it to consume).
  out.push({ text: text.slice(start), consumed: text.length - start });
  return out;
}

export function isComplexScript(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x0300) continue; // ASCII + Latin-1 (nothing context-sensitive here)
    if (
      (c >= 0x0300 && c <= 0x036f) || // combining diacritical marks
      (c >= 0x0483 && c <= 0x0489) || // combining Cyrillic
      (c >= 0x0590 && c <= 0x08ff) || // Hebrew..Arabic Extended-A (RTL + joining)
      (c >= 0x0900 && c <= 0x1cff) || // Indic + SE-Asian complex scripts
      (c >= 0x1ab0 && c <= 0x1aff) || // combining diacritical marks extended
      (c >= 0x1dc0 && c <= 0x1dff) || // combining diacritical marks supplement
      (c >= 0x200b && c <= 0x200f) || // ZW space/NJ/J, LRM/RLM
      (c >= 0x202a && c <= 0x202e) || // bidi embeddings/overrides
      (c >= 0x2060 && c <= 0x206f) || // word joiner, bidi isolates, invisibles
      (c >= 0x20d0 && c <= 0x20ff) || // combining marks for symbols
      (c >= 0x1f3fb && c <= 0x1f3ff) || // emoji skin-tone modifiers
      (c >= 0xfb1d && c <= 0xfdff) || // Hebrew/Arabic presentation forms A
      (c >= 0xfe00 && c <= 0xfe2f) || // variation selectors + combining half marks
      (c >= 0xfe70 && c <= 0xfeff) // Arabic presentation forms B
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Value-equality of two per-character style maps over `[0, len)`. Used by the
 * streaming fast path to confirm an appended paragraph didn't also rewrite the
 * styling of its reused prefix. Cheap: unstyled positions are `undefined ===
 * undefined` (identity), and only genuinely styled runs pay a field compare —
 * no allocation (unlike an RLE signature string).
 */
/**
 * Value-equality of two per-character inline-object maps over `[0, len)`.
 *
 * Needed for the same reason as {@link styleRangeEquals}: an object's `width` is
 * an advance, so a prefix whose object metrics changed cannot have its shaping
 * reused. Compared by value, not identity, because a caller that rebuilds its
 * span array per chunk hands over a fresh object each time even when the formula
 * is unchanged — comparing by identity would defeat streaming reuse entirely.
 *
 * Both sides absent is the common case and exits on the `=== ` identity check.
 */
function objectRangeEquals(
  a: Array<InlineObject | undefined> | undefined,
  b: Array<InlineObject | undefined> | undefined,
  len: number,
): boolean {
  if (a === b) return true; // both undefined, or literally the same array
  for (let i = 0; i < len; i++) {
    const x = a?.[i];
    const y = b?.[i];
    if (x === y) continue;
    if (!x || !y) return false;
    if (
      x.width !== y.width ||
      x.height !== y.height ||
      (x.depth ?? 0) !== (y.depth ?? 0) ||
      x.alt !== y.alt ||
      x.key !== y.key
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Grow `pMax` so a baseline-shifted glyph fits inside the line box, or return
 * `pMax` unchanged when the shift fits the existing slack.
 *
 * The line box is `1.5 * pMax` tall with the shared baseline at `0.8 * pMax`
 * (ascent ratio 0.8 / descent 0.2, the same split the glyph `y` placement
 * uses). A raised run (`shift > 0`) must keep its glyph top — baseline minus
 * the shift minus `0.8 * gfs` — at or below the line top; a lowered run
 * (`shift < 0`) must keep its glyph bottom — baseline plus `0.2 * gfs` minus
 * the shift — at or above the line bottom. Everything else (the dominant case:
 * a superscript at 0.75em raised ~0.3em) fits the slack above/below a smaller
 * run and grows nothing, keeping line rhythm identical to unstyled text.
 *
 * Shared by all three pMax walks (`measurePrepared`, `layoutPrepared`, and the
 * zero-GC buffer path) so a line's height can never diverge between them.
 */
function shiftedExtent(gfs: number, shift: number, pMax: number): number {
  if (shift > 0) {
    // Raised: top = 0.8*pMax - shift - 0.8*gfs must stay >= 0 (line top).
    const need = shift + 0.8 * gfs;
    if (need > 0.8 * pMax) return need / 0.8;
  } else if (shift < 0) {
    // Lowered: bottom = 0.8*pMax - shift + 0.2*gfs must stay <= 1.5*pMax,
    // i.e. the descent slack 0.7*pMax must cover -shift + 0.2*gfs.
    const need = -shift + 0.2 * gfs;
    if (need > 0.7 * pMax) return need / 0.7;
  }
  return pMax;
}

function styleRangeEquals(
  a: Array<TextStyle | undefined>,
  b: Array<TextStyle | undefined>,
  len: number,
): boolean {
  if (b.length < len) return false;
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (!x || !y) return false;
    if (
      x.fontSize !== y.fontSize ||
      x.color !== y.color ||
      x.bold !== y.bold ||
      x.italic !== y.italic ||
      x.href !== y.href ||
      x.underline !== y.underline ||
      x.lineThrough !== y.lineThrough ||
      x.highlightColor !== y.highlightColor ||
      x.abbrTitle !== y.abbrTitle ||
      // fontFamily is passed to glyphWidth(), so it changes advances and belongs in
      // any style comparison used to decide reuse. Added 2026-07-30 alongside the
      // styleSig fix.
      //
      // It is defence in depth rather than a reachable fix today: the cold
      // single-paragraph path below consults `richParagraphCache` FIRST, and that
      // key now carries fontFamily, so a family change is caught there before this
      // comparison is ever asked about one. Verified by mutation — reverting this
      // line alone changes no measured width. Kept because the two are supposed to
      // agree on what "same style" means, and a future reordering that reached the
      // streaming path first would otherwise silently reuse prefix shaping measured
      // in a different family.
      x.fontFamily !== y.fontFamily ||
      x.baselineShift !== y.baselineShift
    ) {
      return false;
    }
  }
  return true;
}

/**
 * GH-457: Pre-merge word segments that must not be separated by line breaks.
 * Rule 1 — '@' must stay with the following identifier (e.g., @vectojs/core).
 * Rule 2 — Trailing/closing punctuation must not start a line; merge it onto
 *          the preceding word.
 */
function suppressLineBreaks(words: PreparedWord[]): PreparedWord[] {
  const ORPHAN_PUNCT = new Set(['.', ',', ':', ';', ')', ']', '}', '!', '?']);
  const result: PreparedWord[] = [];
  let i = 0;
  while (i < words.length) {
    const cur = words[i];
    // Rule 1: Merge '@' with all immediately following non-whitespace words.
    if (cur.glyphs.length === 1 && cur.glyphs[0].char === '@' && !cur.isWhitespace) {
      const merged = { ...cur };
      let j = i + 1;
      while (j < words.length && !words[j].isWhitespace) {
        // Carry the merged word's hyphenation opportunities, re-based from its
        // own glyph indices into the merged word's (they shift by however many
        // glyphs precede them).
        const offset = merged.glyphs.length;
        const nextBreakPoints = words[j].breakPoints;
        if (nextBreakPoints?.length) {
          merged.breakPoints = [
            ...(merged.breakPoints ?? []),
            ...nextBreakPoints.map((bp) => bp + offset),
          ];
        }
        merged.glyphs = [...merged.glyphs, ...words[j].glyphs];
        merged.width += words[j].width;
        merged.isWordLike = true;
        j++;
      }
      result.push(merged);
      i = j;
      continue;
    }
    // Rule 2: Merge orphan trailing punctuation onto the preceding word.
    // Skip trailing whitespace words when searching backward: Intl.Segmenter
    // yields `["word", " ", "!"]` for `"word !"`, and merging the `!` onto the
    // whitespace word would make a `" !"` pseudo-word that defeats the wrap
    // swallow check below and lets the `!` start a line — the exact failure
    // this rule exists to prevent.
    if (
      result.length > 0 &&
      cur.glyphs.length === 1 &&
      !cur.isWhitespace &&
      ORPHAN_PUNCT.has(cur.glyphs[0].char)
    ) {
      let prevIdx = result.length - 1;
      while (prevIdx >= 0 && result[prevIdx].isWhitespace) prevIdx--;
      if (prevIdx >= 0) {
        const prev = result[prevIdx];
        // The literal rebuild must carry hyphenation across the merge: prev's
        // own breakPoints survive unchanged (its glyphs stay first), and cur's
        // shift by prev's glyph count.
        result[prevIdx] = {
          glyphs: [...prev.glyphs, ...cur.glyphs],
          width: prev.width + cur.width,
          isWordLike: prev.isWordLike,
          isWhitespace: false,
          ...(prev.breakPoints?.length || cur.breakPoints?.length
            ? {
                breakPoints: [
                  ...(prev.breakPoints ?? []),
                  ...(cur.breakPoints ?? []).map((bp) => bp + prev.glyphs.length),
                ],
              }
            : {}),
        };
        i++;
        continue;
      }
    }
    result.push(cur);
    i++;
  }
  return result;
}

/**
 * VectoJS Global Layout Engine (Intl.Segmenter)
 * Advanced Typography Engine supporting CJK, Emoji, and Western Graphemes
 */
export class LayoutEngine {
  public maxWidth: number;
  /**
   * Horizontal alignment. `'justify'` stretches inter-word spaces (or, for
   * space-less CJK lines, inter-character gaps) so wrapped lines end flush at
   * `maxWidth`; the last line of each paragraph stays ragged. Only applies to
   * the object layout path without exclusion shapes.
   */
  public textAlign: 'left' | 'justify' = 'left';
  public maxHeight: number;
  public preserveLeadingSpaces: boolean = false;
  private wordSegmenter: Intl.Segmenter;
  private charSegmenter: Intl.Segmenter;
  private wordCache: Map<string, Array<{ segment: string; isWordLike: boolean | undefined }>> =
    new Map();
  private graphemeCache: Map<string, string[]> = new Map();
  // Paragraph-level memo so re-`prepare()` of mostly-unchanged text (streaming
  // append, live logs) reuses untouched paragraphs by reference instead of
  // re-segmenting/re-measuring the whole document — turning per-token cost from
  // O(document) into O(changed paragraph). Keyed by fontSize + text; invalidated
  // when the font atlas (which drives glyph widths) changes.
  private paragraphCache: Map<string, PreparedParagraph> = new Map();
  // Same memo for the rich path ({@link prepareRich}); keyed by fontSize + text +
  // a per-paragraph *value* signature of the inline styles, so a streaming
  // typewriter that appends styled runs reuses its untouched paragraphs.
  private richParagraphCache: Map<string, PreparedParagraph> = new Map();
  // Single-slot incremental cache for the streaming fast path: the most
  // recently shaped single, simple-script paragraph plus each word's end
  // offset in the source. When the next prepareRich() call is a strict
  // extension of `text` (a growing Markdown block re-prepared per chunk),
  // its shaped prefix words are reused verbatim and only the new suffix is
  // shaped — turning a growing paragraph's per-chunk cost from O(length) into
  // O(appended). See {@link prepareRich}'s incremental branch.
  private streamShapeCache: {
    fontSize: number;
    atlas: GlyphAtlas;
    styleAt: Array<TextStyle | undefined>;
    /**
     * Reserved inline objects over the cached prefix, compared on reuse for the
     * same reason `styleAt` is: an object's width is an advance, so a prefix whose
     * object changed is not a valid prefix to reuse. Undefined when the cached
     * paragraph had no objects, which is the overwhelmingly common case.
     */
    objectAt?: Array<InlineObject | undefined>;
    text: string;
    // The engine's own mutable arrays, distinct from anything stored in the
    // value-keyed memo (richParagraphCache), so the streaming extension can
    // pop/push them in place — O(appended) per chunk — without ever mutating a
    // memoized paragraph. The latest extension DOES hand `words` out in its
    // returned PreparedParagraph; that result is meant for immediate use (the
    // next append mutates the array), which is exactly how RichText consumes
    // it (prepare → layout → discard, per chunk).
    words: PreparedWord[];
    wordSrcEnds: number[];
    wordFallbacks: boolean[];
    /** Running count of fallback words, so the paragraph flag is O(1). */
    fallbackCount: number;
  } | null = null;
  /**
   * Hit/miss/eviction tallies per cache, readable via {@link cacheStats}.
   *
   * Kept because the caches are the difference between O(appended) and
   * O(document) on a streaming paragraph, and until now there was no way to tell
   * whether one was working: a key that varies by accident (a style signature
   * that includes an object identity, a font size that arrives as 15.999998)
   * turns every lookup into a miss and the memo into pure overhead, with no
   * symptom other than being slow. Three integer increments per lookup is a cost
   * worth paying to make that visible.
   */
  private cacheCounters: Record<
    LayoutCacheName,
    { hits: number; misses: number; evictions: number }
  > = {
    word: { hits: 0, misses: 0, evictions: 0 },
    grapheme: { hits: 0, misses: 0, evictions: 0 },
    paragraph: { hits: 0, misses: 0, evictions: 0 },
    richParagraph: { hits: 0, misses: 0, evictions: 0 },
  };
  private lastAtlas: GlyphAtlas | null = null;
  private measurer: GlyphMeasurer | null;

  private _hyphenate: ((word: string) => string[]) | null = null;

  /**
   * Optional hyphenator: given a word, return its break parts (e.g.
   * `['hyphen', 'ation']`). Used at wrap time when a word doesn't fit; a
   * visible '-' is drawn at the chosen break. Soft hyphens (U+00AD) in the
   * source work without any hyphenator. Setting this clears the prepared
   * caches (break opportunities are baked in during prepare()).
   */
  public get hyphenate(): ((word: string) => string[]) | null {
    return this._hyphenate;
  }
  public set hyphenate(fn: ((word: string) => string[]) | null) {
    this._hyphenate = fn;
    this.paragraphCache.clear();
    this.richParagraphCache.clear();
    this.streamShapeCache = null;
  }

  constructor(maxWidth: number, maxHeight: number, measurer?: GlyphMeasurer | null) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.measurer = measurer ?? null;

    // Auto-detect browser locale for intelligent CJK and Western word boundaries
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    this.wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    this.charSegmenter = new Intl.Segmenter(locale, {
      granularity: 'grapheme',
    });
  }

  private getWordSegments(
    paragraph: string,
  ): Array<{ segment: string; isWordLike: boolean | undefined }> {
    const cached = this.wordCache.get(paragraph);
    if (cached) {
      this.cacheCounters.word.hits++;
      return cached;
    }
    this.cacheCounters.word.misses++;

    const fresh = Array.from(this.wordSegmenter.segment(paragraph)).map((s) => ({
      segment: s.segment,
      isWordLike: s.isWordLike,
    }));
    if (this.wordCache.size > 500) {
      this.wordCache.clear();
      this.cacheCounters.word.evictions++;
    }
    this.wordCache.set(paragraph, fresh);
    return fresh;
  }

  /**
   * Resolve a grapheme's advance width at `fontSize`, in priority order:
   * pre-baked atlas entry → injected {@link GlyphMeasurer} → `0.5em` fallback.
   */
  private glyphWidth(
    char: string,
    fontAtlas: GlyphAtlas,
    fontSize: number,
    fontFamily?: string,
    bold?: boolean,
    italic?: boolean,
  ): number {
    // A run-specific family (e.g. inline monospace code) skips the atlas — the
    // atlas is baked for the base family, so measuring it there would return the
    // wrong advance; go straight to the measurer with the run's family.
    // Bold/italic also bypass the atlas for the same reason: the atlas is baked
    // at base weight and slant, so bold or italic glyphs are wider or slanted
    // differently than what the atlas records.
    const glyphInfo = fontFamily === undefined && !bold && !italic ? fontAtlas[char] : undefined;
    if (glyphInfo) return glyphInfo.width * (fontSize / glyphInfo.baseSize);
    if (this.measurer) return this.measurer.measure(char, fontSize, fontFamily, bold, italic);

    // Neither source can answer, so this advance is fabricated. Count it and say
    // so once: the failure is otherwise completely silent — layout, hit-testing
    // and a11y all keep reporting success against widths that can be off by
    // +125% on narrow text and -47% on wide (measured against Chrome at 32px).
    unmeasuredGlyphs++;
    if (warnUnmeasured && !warnedUnmeasured) {
      warnedUnmeasured = true;
      console.warn(
        '[@vectojs/layout] No font metrics available, so glyph advances are a flat ' +
          '0.5em guess and text will be measured and wrapped incorrectly. In a ' +
          'DOM-free environment (Node SSR, a worker without a canvas), register ' +
          'metrics with registerFontMetrics/registerMSDFFontMetrics from ' +
          '@vectojs/text. Silence this with setUnmeasuredGlyphWarning(false).',
      );
    }
    return fontSize * 0.5;
  }

  /**
   * Hit/miss/eviction tallies and current size for each internal cache.
   *
   * A hit rate near zero on a repeated workload means the key is varying when it
   * should not — the failure mode the counters exist to expose, since it looks
   * identical to having no cache at all. Eviction counts a full flush, not one
   * entry: every cache here clears wholesale when it exceeds its cap.
   */
  public cacheStats(): LayoutCacheStats {
    const sizes: Record<LayoutCacheName, number> = {
      word: this.wordCache.size,
      grapheme: this.graphemeCache.size,
      paragraph: this.paragraphCache.size,
      richParagraph: this.richParagraphCache.size,
    };
    const caps: Record<LayoutCacheName, number> = {
      word: 500,
      grapheme: 2000,
      paragraph: 1000,
      richParagraph: 1000,
    };
    const out = {} as LayoutCacheStats;
    for (const name of Object.keys(sizes) as LayoutCacheName[]) {
      const c = this.cacheCounters[name];
      const lookups = c.hits + c.misses;
      out[name] = {
        hits: c.hits,
        misses: c.misses,
        evictions: c.evictions,
        size: sizes[name],
        capacity: caps[name],
        hitRate: lookups === 0 ? null : c.hits / lookups,
      };
    }
    return out;
  }

  /** Zero the cache tallies without discarding the cached entries themselves. */
  public resetCacheStats(): void {
    for (const name of Object.keys(this.cacheCounters) as LayoutCacheName[]) {
      this.cacheCounters[name] = { hits: 0, misses: 0, evictions: 0 };
    }
  }

  private glyphKeyFor(grapheme: string, fontAtlas: GlyphAtlas): string {
    if (fontAtlas[grapheme]) return grapheme;
    const firstCodePoint = Array.from(grapheme)[0];
    if (firstCodePoint && fontAtlas[firstCodePoint]) return firstCodePoint;
    return grapheme;
  }

  private getGraphemes(word: string): string[] {
    const cached = this.graphemeCache.get(word);
    if (cached) this.cacheCounters.grapheme.hits++;
    else this.cacheCounters.grapheme.misses++;
    if (cached) return cached;

    const fresh = Array.from(this.charSegmenter.segment(word)).map((g) => g.segment);
    if (this.graphemeCache.size > 2000) {
      this.graphemeCache.clear();
      this.cacheCounters.grapheme.evictions++;
    }
    this.graphemeCache.set(word, fresh);
    return fresh;
  }

  /**
   * Lay out a Unicode string into a list of positioned {@link LayoutNode} glyphs.
   *
   * Uses `Intl.Segmenter` to correctly handle CJK, emoji, and Western word
   * boundaries.  An optional `exclusionMask` callback allows glyphs to flow
   * around arbitrary shapes (e.g. physics bodies or video regions).
   *
   * @param text - The raw text string to lay out (newlines force paragraph breaks).
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param fontSize - Target font size in pixels (default: `32`).
   * @param exclusionMask - Optional callback returning `true` when a candidate
   *   glyph bounding box overlaps a forbidden region; the engine skips that
   *   position and advances horizontally.
   * @returns A {@link LayoutResult} with all positioned glyph nodes and total dimensions.
   * @example
   * const result = engine.layoutText('Hello 世界', atlas, 24);
   * result.nodes.forEach(n => console.log(n.char, n.x, n.y));
   */
  public layoutText(
    text: string,
    fontAtlas: GlyphAtlas,
    fontSize: number = 32,
    exclusionMask?: (x: number, y: number, w: number, h: number) => boolean,
  ): LayoutResult {
    return this.layoutPrepared(this.prepare(text, fontAtlas, fontSize), exclusionMask);
  }

  /**
   * **Cold pass.** Segment and measure `text` once into a reusable
   * {@link PreparedText}. Runs `Intl.Segmenter` (word + grapheme) and resolves
   * each grapheme's advance width — the expensive work. The result is
   * independent of `maxWidth`/`maxHeight`/exclusion masks, so it can be re-laid
   * out cheaply by {@link layoutPrepared} on resize / reposition / animation.
   *
   * @param text - The raw text string (newlines force paragraph breaks).
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param fontSize - Target font size in pixels (default: `32`).
   */
  public prepare(text: string, fontAtlas: GlyphAtlas, fontSize: number = 32): PreparedText {
    // Glyph widths depend on the atlas; drop memoized paragraphs if it changed.
    if (fontAtlas !== this.lastAtlas) {
      this.paragraphCache.clear();
      this.richParagraphCache.clear();
      this.lastAtlas = fontAtlas;
    }

    const paragraphs: PreparedParagraph[] = [];
    let offset = 0;
    let fallbackToCanvas = false;

    // Any line ending (CRLF / LF / lone CR) ends a paragraph and is excluded from
    // the text handed to the shaper; `consumed` keeps source offsets exact.
    for (const { text: paragraph, consumed } of splitParagraphs(text)) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        offset += consumed;
        continue;
      }

      const key = `${fontSize} ${paragraph}`;
      const cached = this.paragraphCache.get(key);
      if (cached) this.cacheCounters.paragraph.hits++;
      else this.cacheCounters.paragraph.misses++;
      if (cached) {
        paragraphs.push(cached);
        if (cached.fallbackToCanvas) fallbackToCanvas = true;
        offset += consumed;
        continue;
      }

      // 1. Contextual shaping
      const { shapedText, indexMap } = ArabicShaper.shapeArabic(paragraph);

      // 2. BiDi Level Resolution
      const levels = BidiResolver.resolveLevels(shapedText);

      const words: PreparedWord[] = [];
      let shapedCharIdx = 0;
      let pFallback = false;

      for (const segment of this.getWordSegments(shapedText)) {
        const word = segment.segment;
        const glyphs: PreparedGlyph[] = [];
        let width = 0;
        let breakPoints: number[] | undefined;

        for (const char of this.getGraphemes(word)) {
          // Soft hyphen: an invisible break opportunity — record it, render nothing.
          if (char === '\u00ad') {
            (breakPoints ??= []).push(glyphs.length);
            shapedCharIdx += char.length;
            continue;
          }
          const visualStart = shapedCharIdx;
          const visualEnd = shapedCharIdx + char.length;

          const rawStart = indexMap[visualStart];
          const rawEnd = visualEnd === shapedText.length ? paragraph.length : indexMap[visualEnd];

          const sourceIndex = offset + rawStart;
          const sourceLength = rawEnd - rawStart;

          const glyphKey = this.glyphKeyFor(char, fontAtlas);
          const level = levels[visualStart];

          // Check if glyph is present in atlas
          const hasGlyph = !!fontAtlas[glyphKey];
          if (char.trim().length > 0 && !hasGlyph) {
            pFallback = true;
            fallbackToCanvas = true;
          }

          const w = this.glyphWidth(glyphKey, fontAtlas, fontSize, undefined, false, false);

          glyphs.push({
            char,
            width: w,
            level,
            sourceIndex,
            sourceLength,
            // Retained per glyph, not just aggregated into the paragraph flag:
            // knowing a paragraph fell back does not say which character caused
            // it, and that character is the one worth looking at.
            // Whitespace is excluded here for the same reason it is excluded from
            // the paragraph fallback flag: a space needs no glyph, so a missing one
            // is not a fallback cause and reporting it would bury the real one.
            ...(hasGlyph || char.trim().length === 0 ? {} : { atlasMiss: true as const }),
          });
          width += w;
          shapedCharIdx += char.length;
        }

        // Pluggable hyphenator: derive break opportunities for plain words
        // that don't already carry soft hyphens.
        if (!breakPoints && this._hyphenate && segment.isWordLike && glyphs.length > 3) {
          const parts = this._hyphenate(word);
          if (parts.length > 1) {
            breakPoints = [];
            let count = 0;
            for (let pi = 0; pi < parts.length - 1; pi++) {
              for (const _g of this.getGraphemes(parts[pi])) count++;
              breakPoints.push(count);
            }
          }
        }

        words.push({
          glyphs,
          width,
          isWordLike: segment.isWordLike,
          isWhitespace: word.trim().length === 0,
          breakPoints,
        });
      }

      const prepared: PreparedParagraph = {
        words,
        isEmpty: false,
        fallbackToCanvas: pFallback || undefined,
        baseLevel: BidiResolver.getBaseLevel(shapedText),
      };
      if (this.paragraphCache.size > 1000) {
        this.paragraphCache.clear();
        this.cacheCounters.paragraph.evictions++;
      }
      this.paragraphCache.set(key, prepared);
      paragraphs.push(prepared);
      offset += consumed;
    }

    // The hyphen advance is consulted only when a word actually carries break
    // points (soft hyphens or hyphenator output — the source need not contain a
    // literal '-'). Measuring it unconditionally meant every prepare() pass paid
    // an atlas probe or measurer call for '-', and in a metrics-less
    // environment that call incremented `unmeasuredGlyphs` and consumed the
    // one-time warning on text containing no hyphenation opportunity at all.
    let mayHyphenate = false;
    for (const paragraph of paragraphs) {
      if (paragraph.words.some((w) => w.breakPoints && w.breakPoints.length > 0)) {
        mayHyphenate = true;
        break;
      }
    }

    return {
      paragraphs,
      fontSize,
      fallbackToCanvas: fallbackToCanvas || undefined,
      hyphenWidth: mayHyphenate
        ? this.glyphWidth(
            this.glyphKeyFor('-', fontAtlas),
            fontAtlas,
            fontSize,
            undefined,
            false,
            false,
          )
        : undefined,
    };
  }

  /**
   * **Cold pass for rich text.** Like {@link prepare}, but takes an array of
   * {@link StyledSpan}s so different inline runs (bold / italic / color / size /
   * links) compose on the same wrapped lines. Each grapheme carries the
   * (base-merged) style of the span it came from — so a style change *mid-word*
   * (e.g. `He` + **`llo`**) is honored. Run `fontSize` affects measured width and
   * line height; the rest is rendering metadata carried through to the nodes.
   *
   * The result feeds the same {@link layoutPrepared} as plain text.
   *
   * @param spans - The styled runs, in document order.
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param baseFontSize - Size for runs without an explicit `fontSize` (default 32).
   * @param baseStyle - Style inherited by every run (each run's own style wins).
   */
  public prepareRich(
    spans: StyledSpan[],
    fontAtlas: GlyphAtlas,
    baseFontSize: number = 32,
    baseStyle?: TextStyle,
  ): PreparedText {
    // Glyph widths depend on the atlas; drop memoized paragraphs if it changed.
    if (fontAtlas !== this.lastAtlas) {
      this.paragraphCache.clear();
      this.richParagraphCache.clear();
      this.lastAtlas = fontAtlas;
    }

    // Flatten to text + a per-UTF16-unit style map (one shared object per run).
    let fullText = '';
    const styleAt: Array<TextStyle | undefined> = [];
    // Parallel to styleAt: the inline object reserved at this index, if any. Kept
    // separate from TextStyle because an object is content, not style — merging it
    // would make it inherit from baseStyle, which is meaningless for a box.
    const objectAt: Array<InlineObject | undefined> = [];
    let hasObject = false;
    for (const span of spans) {
      const merged: TextStyle | undefined =
        span.style || baseStyle ? { ...baseStyle, ...span.style } : undefined;
      fullText += span.text;
      // An object span is keyed on the sentinel character, so it survives this
      // flattening; a span that sets `object` without it is treated as plain text.
      const obj =
        span.object !== undefined && span.text === OBJECT_REPLACEMENT ? span.object : undefined;
      if (obj) hasObject = true;
      for (let i = 0; i < span.text.length; i++) {
        styleAt.push(merged);
        objectAt.push(obj);
      }
    }

    // A compact, *value*-based RLE signature of the styles over [start, start+len)
    // — so a cached paragraph is reused whether or not the caller reuses the same
    // style object instances (it just has to apply the same fontSize/color/…).
    //
    // EVERY field that can change a glyph advance must be in here, or two different
    // paragraphs collide on one key. `fontFamily` was missing until 2026-07-30 even
    // though glyphWidth() takes it (see the `style?.fontFamily` arguments below):
    // measured with a stable atlas, a `fontFamily: 'wide'` paragraph was served the
    // metrics of an identical-length 'serif' one — 48px where 144px was correct.
    // It was latent only because the memo was never hit: Text/RichText passed a
    // fresh `{}` atlas per call, which cleared it every time. Reviving the cache
    // and fixing this key are therefore ONE change; doing either alone is wrong.
    // An inline object's metrics are part of the fingerprint for the same reason
    // fontFamily is: they change the advance. They are MORE dangerous than a style
    // field, because every object span flattens to the identical text (one U+FFFC)
    // and often an identical style — so with the metrics omitted, two differently
    // sized formulas in the same paragraph position produce byte-identical keys and
    // the second is served the first's layout. `text` alone cannot disambiguate them.
    const fingerprint = (idx: number): string => {
      const s = styleAt[idx];
      const base = s
        ? `${s.fontSize ?? ''}/${s.color ?? ''}/${s.bold ? 1 : 0}/${s.italic ? 1 : 0}/${s.href ?? ''}/${s.fontFamily ?? ''}/${s.baselineShift ?? ''}/${s.underline ? 1 : 0}/${s.lineThrough ? 1 : 0}/${s.highlightColor ?? ''}/${s.abbrTitle ?? ''}`
        : '';
      const o = objectAt[idx];
      // `alt` is in the key even though it changes no advance: it reaches the
      // accessible name, so two formulas that differ only in alt text must not
      // share a cached paragraph or the second is announced as the first. `key` is
      // in for the same reason one step further out — it identifies what the
      // object PAINTS when `alt` does not, so without it two images with the same
      // alt and different URLs share a paragraph and the second draws the first.
      return o
        ? `${base}/@${o.width},${o.height},${o.depth ?? 0},${o.alt ?? ''},${o.key ?? ''}`
        : base;
    };
    const styleSig = (start: number, len: number): string => {
      let sig = '';
      let i = 0;
      while (i < len) {
        const fp = fingerprint(start + i);
        let run = 1;
        while (i + run < len) {
          if (fingerprint(start + i + run) !== fp) break;
          run++;
        }
        sig += `${fp}:${run};`;
        i += run;
      }
      return sig;
    };

    // ── Streaming fast path ─────────────────────────────────────────────
    // The overwhelmingly common streaming case is one simple-script paragraph
    // re-prepared once per appended chunk (a growing Markdown block). Shaping
    // its whole text every time makes that block cost O(length) per chunk =
    // O(length^2) over the stream. Instead reuse the previously-shaped prefix
    // words and shape only the appended suffix. Only single-paragraph,
    // context-free text qualifies (see isComplexScript) — anything else falls
    // through to the correct full shaper below, unchanged.
    if (
      fullText.length > 0 &&
      fullText.indexOf('\n') === -1 &&
      // A lone '\r' (classic-Mac ending) is a line break too, and must not be
      // shaped as a glyph — let the paragraph path below handle it.
      fullText.indexOf('\r') === -1 &&
      !isComplexScript(fullText)
    ) {
      const cache = this.streamShapeCache;
      // ── Streaming hot path: strict extension of the cached paragraph ──
      // No memo key is built here (that alone is O(length) string work per
      // chunk); the extension is verified by a cheap prefix compare and only
      // the appended suffix is shaped.
      if (
        cache &&
        cache.fontSize === baseFontSize &&
        cache.atlas === fontAtlas &&
        fullText.length > cache.text.length &&
        cache.words.length > 0 &&
        fullText.startsWith(cache.text) &&
        styleRangeEquals(styleAt, cache.styleAt, cache.text.length) &&
        objectRangeEquals(objectAt, cache.objectAt, cache.text.length)
      ) {
        // Re-segment the whole trailing SAME-CATEGORY (whitespace vs
        // non-whitespace) run, not just the last cached word. Intl.Segmenter can
        // merge or re-split an entire adjacent non-whitespace run once more text
        // arrives — streamed char-by-char, "3"+"."+"1" one-shot segments as
        // "3.1" and "a "+" " as "a  " — so freezing all-but-the-last word leaves
        // spurious mid-number/URL/abbrev boundaries that a one-shot shape never
        // produces. A whitespace↔non-whitespace transition, by contrast, is a
        // hard boundary the appended suffix can never dissolve, so reshaping from
        // the start of the trailing run yields exactly the one-shot segmentation.
        // (Cost is O(trailing-run + appended); a long no-whitespace run streamed
        // one char at a time degrades toward O(n²) — an accepted trade for
        // correctness, same caveat the streaming cache already carries.)
        const end = cache.text.length;
        const lastIsWs = end > 0 && /\s/.test(cache.text[end - 1]!);
        let reshapeFrom = end;
        while (reshapeFrom > 0 && /\s/.test(cache.text[reshapeFrom - 1]!) === lastIsWs) {
          reshapeFrom--;
        }
        // Keep every cached word ending at or before the reshape boundary.
        let keep = 0;
        while (keep < cache.wordSrcEnds.length && cache.wordSrcEnds[keep] <= reshapeFrom) {
          keep++;
        }
        const tail = this.shapeSimpleRun(
          fullText,
          reshapeFrom,
          styleAt,
          baseFontSize,
          fontAtlas,
          objectAt,
        );
        for (let i = keep; i < cache.wordFallbacks.length; i++) {
          if (cache.wordFallbacks[i]) cache.fallbackCount--;
        }
        cache.words.length = keep;
        cache.wordSrcEnds.length = keep;
        cache.wordFallbacks.length = keep;
        for (let i = 0; i < tail.words.length; i++) {
          cache.words.push(tail.words[i]);
          cache.wordSrcEnds.push(tail.wordSrcEnds[i]);
          cache.wordFallbacks.push(tail.wordFallbacks[i]);
          if (tail.wordFallbacks[i]) cache.fallbackCount++;
        }
        cache.text = fullText;
        cache.styleAt = styleAt;
        cache.objectAt = hasObject ? objectAt : undefined;
        const pFallback = cache.fallbackCount > 0;
        return {
          paragraphs: [
            {
              words: cache.words,
              isEmpty: false,
              fallbackToCanvas: pFallback || undefined,
              baseLevel: 0,
            },
          ],
          fontSize: baseFontSize,
          fallbackToCanvas: pFallback || undefined,
        };
      }

      // ── Cold single-paragraph path (first shape / shrink / style change) ──
      // Uses the value-keyed memo so identical repeats and a later multi-
      // paragraph prepare still reuse this paragraph object by reference.
      const sig = styleSig(0, fullText.length);
      const key = `${baseFontSize} ${fullText} ${sig}`;
      const cached = this.richParagraphCache.get(key);
      if (cached) this.cacheCounters.richParagraph.hits++;
      else this.cacheCounters.richParagraph.misses++;
      if (cached) {
        return {
          paragraphs: [cached],
          fontSize: baseFontSize,
          fallbackToCanvas: cached.fallbackToCanvas,
        };
      }
      const shaped = this.shapeSimpleRun(fullText, 0, styleAt, baseFontSize, fontAtlas, objectAt);
      const pFallback = shaped.wordFallbacks.some(Boolean);
      const prepared: PreparedParagraph = {
        words: shaped.words,
        isEmpty: false,
        fallbackToCanvas: pFallback || undefined,
        baseLevel: 0,
      };
      if (this.richParagraphCache.size > 1000) {
        this.richParagraphCache.clear();
        this.cacheCounters.richParagraph.evictions++;
      }
      this.richParagraphCache.set(key, prepared);
      let fallbackCount = 0;
      for (const f of shaped.wordFallbacks) if (f) fallbackCount++;
      // Copies, so a later in-place streaming extension never mutates the
      // `prepared` object just memoized above (it holds `shaped.words`).
      this.streamShapeCache = {
        fontSize: baseFontSize,
        atlas: fontAtlas,
        styleAt,
        // Stored only when present, so the no-object case compares by identity
        // (undefined === undefined) and costs nothing.
        ...(hasObject ? { objectAt } : {}),
        text: fullText,
        words: shaped.words.slice(),
        wordSrcEnds: shaped.wordSrcEnds.slice(),
        wordFallbacks: shaped.wordFallbacks.slice(),
        fallbackCount,
      };
      return {
        paragraphs: [prepared],
        fontSize: baseFontSize,
        fallbackToCanvas: pFallback || undefined,
      };
    }

    const paragraphs: PreparedParagraph[] = [];
    let offset = 0;
    let fallbackToCanvas = false;

    // Line endings (CRLF / LF / lone CR) never reach the shaper; `consumed` keeps
    // `offset` aligned to the ORIGINAL text, which both `sourceIndex` and the
    // per-character style lookup below index into.
    for (const { text: paragraph, consumed } of splitParagraphs(fullText)) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        offset += consumed;
        continue;
      }

      const key = `${baseFontSize} ${paragraph} ${styleSig(offset, paragraph.length)}`;
      const cached = this.richParagraphCache.get(key);
      if (cached) this.cacheCounters.richParagraph.hits++;
      else this.cacheCounters.richParagraph.misses++;
      if (cached) {
        paragraphs.push(cached);
        if (cached.fallbackToCanvas) fallbackToCanvas = true;
        offset += consumed;
        continue;
      }

      // 1. Contextual shaping
      const { shapedText, indexMap } = ArabicShaper.shapeArabic(paragraph);

      // 2. BiDi Level Resolution
      const levels = BidiResolver.resolveLevels(shapedText);

      const words: PreparedWord[] = [];
      let shapedCharIdx = 0;
      let pFallback = false;

      for (const segment of this.getWordSegments(shapedText)) {
        const word = segment.segment;
        const glyphs: PreparedGlyph[] = [];
        let width = 0;
        let breakPoints: number[] | undefined;

        for (const char of this.getGraphemes(word)) {
          // Soft hyphen: an invisible break opportunity — record it, render nothing.
          if (char === '\u00ad') {
            (breakPoints ??= []).push(glyphs.length);
            shapedCharIdx += char.length;
            continue;
          }
          const visualStart = shapedCharIdx;
          const visualEnd = shapedCharIdx + char.length;

          const rawStart = indexMap[visualStart];
          const rawEnd = visualEnd === shapedText.length ? paragraph.length : indexMap[visualEnd];

          const sourceIndex = offset + rawStart;
          const sourceLength = rawEnd - rawStart;

          const glyphKey = this.glyphKeyFor(char, fontAtlas);
          const level = levels[visualStart];

          const style = styleAt[offset + rawStart];
          const gfs = style?.fontSize ?? baseFontSize;
          const obj = objectAt[offset + rawStart];

          // An object reserves its own advance and is never shaped, so it is also
          // not an atlas miss: the atlas is not expected to hold U+FFFC, and
          // counting it would report a canvas fallback that never happened.
          const hasGlyph = obj !== undefined || !!fontAtlas[glyphKey];
          if (char.trim().length > 0 && !hasGlyph) {
            pFallback = true;
            fallbackToCanvas = true;
          }

          const w = obj
            ? obj.width
            : this.glyphWidth(
                glyphKey,
                fontAtlas,
                gfs,
                style?.fontFamily,
                style?.bold,
                style?.italic,
              );

          glyphs.push({
            char,
            width: w,
            style,
            ...(obj ? { object: obj } : {}),
            level,
            sourceIndex,
            sourceLength,
            // Whitespace is excluded here for the same reason it is excluded from
            // the paragraph fallback flag: a space needs no glyph, so a missing one
            // is not a fallback cause and reporting it would bury the real one.
            ...(hasGlyph || char.trim().length === 0 ? {} : { atlasMiss: true as const }),
          });
          width += w;
          shapedCharIdx += char.length;
        }

        // Pluggable hyphenator: derive break opportunities for plain words
        // that don't already carry soft hyphens.
        if (!breakPoints && this._hyphenate && segment.isWordLike && glyphs.length > 3) {
          const parts = this._hyphenate(word);
          if (parts.length > 1) {
            breakPoints = [];
            let count = 0;
            for (let pi = 0; pi < parts.length - 1; pi++) {
              for (const _g of this.getGraphemes(parts[pi])) count++;
              breakPoints.push(count);
            }
          }
        }

        words.push({
          glyphs,
          width,
          isWordLike: segment.isWordLike,
          isWhitespace: word.trim().length === 0,
          breakPoints,
        });
      }

      const prepared: PreparedParagraph = {
        words,
        isEmpty: false,
        fallbackToCanvas: pFallback || undefined,
        baseLevel: BidiResolver.getBaseLevel(shapedText),
      };
      if (this.richParagraphCache.size > 1000) {
        this.richParagraphCache.clear();
        this.cacheCounters.richParagraph.evictions++;
      }
      this.richParagraphCache.set(key, prepared);
      paragraphs.push(prepared);
      offset += consumed; // paragraph + the '\r' (if any) + the consumed '\n'
    }

    return {
      paragraphs,
      fontSize: baseFontSize,
      fallbackToCanvas: fallbackToCanvas || undefined,
    };
  }

  /**
   * Shape one run of a simple, context-free single paragraph — the worker
   * behind {@link prepareRich}'s streaming fast path. Produces exactly the
   * per-glyph output the full rich shaper would for the same text (Arabic
   * shaping is a no-op, BiDi levels are all 0, the source index map is the
   * identity — so all three are skipped), but starting at `startOffset` so
   * an already-shaped prefix can be reused. Returns each word plus its end
   * offset in the paragraph and whether it needed a Canvas2D fallback, so the
   * caller can splice reused and freshly-shaped words together and recompute
   * the paragraph-level fallback flag.
   */
  private shapeSimpleRun(
    paragraph: string,
    startOffset: number,
    styleAt: Array<TextStyle | undefined>,
    baseFontSize: number,
    fontAtlas: GlyphAtlas,
    objectAt?: Array<InlineObject | undefined>,
  ): {
    words: PreparedWord[];
    wordSrcEnds: number[];
    wordFallbacks: boolean[];
  } {
    const words: PreparedWord[] = [];
    const wordSrcEnds: number[] = [];
    const wordFallbacks: boolean[] = [];
    let charIdx = startOffset; // source index within the whole paragraph

    for (const segment of this.getWordSegments(paragraph.slice(startOffset))) {
      const word = segment.segment;
      const glyphs: PreparedGlyph[] = [];
      let width = 0;
      let breakPoints: number[] | undefined;
      let wordFallback = false;

      for (const char of this.getGraphemes(word)) {
        if (char === '\u00ad') {
          // Soft hyphen: an invisible break opportunity — record, render nothing.
          (breakPoints ??= []).push(glyphs.length);
          charIdx += char.length;
          continue;
        }
        const glyphKey = this.glyphKeyFor(char, fontAtlas);
        const style = styleAt[charIdx];
        const gfs = style?.fontSize ?? baseFontSize;
        const obj = objectAt?.[charIdx];
        // See the full-shaping path: a reserved object is not an atlas miss.
        const inAtlas = obj !== undefined || !!fontAtlas[glyphKey];
        if (char.trim().length > 0 && !inAtlas) wordFallback = true;
        const w = obj
          ? obj.width
          : this.glyphWidth(
              glyphKey,
              fontAtlas,
              gfs,
              style?.fontFamily,
              style?.bold,
              style?.italic,
            );
        glyphs.push({
          char,
          width: w,
          style,
          ...(obj ? { object: obj } : {}),
          level: 0,
          sourceIndex: charIdx,
          sourceLength: char.length,
          // The streaming fast path needs the same per-glyph record as the two
          // full-shaping paths, or a streamed paragraph reports a fallback with
          // no way to see which glyph caused it.
          ...(inAtlas || char.trim().length === 0 ? {} : { atlasMiss: true as const }),
        });
        width += w;
        charIdx += char.length;
      }

      if (!breakPoints && this._hyphenate && segment.isWordLike && glyphs.length > 3) {
        const parts = this._hyphenate(word);
        if (parts.length > 1) {
          breakPoints = [];
          let count = 0;
          for (let pi = 0; pi < parts.length - 1; pi++) {
            for (const _g of this.getGraphemes(parts[pi])) count++;
            breakPoints.push(count);
          }
        }
      }

      words.push({
        glyphs,
        width,
        isWordLike: segment.isWordLike,
        isWhitespace: word.trim().length === 0,
        breakPoints,
      });
      wordSrcEnds.push(charIdx);
      wordFallbacks.push(wordFallback);
    }

    return { words, wordSrcEnds, wordFallbacks };
  }

  /**
   * **Hot pass.** Place an already-measured {@link PreparedText} into positioned
   * glyphs. Does only wrap/positioning arithmetic — no `Intl.Segmenter`, no
   * re-measurement — so it is cheap enough to call every frame or on every
   * resize. Reads the engine's current `maxWidth`/`maxHeight`, so changing those
   * and re-calling reflows the same prepared text.
   *
   * @param prepared - Output of {@link prepare}.
   * @param exclusionMask - Optional per-glyph collision callback (see {@link layoutText}).
   * @param exclusions - Optional rect regions text flows around (exclusion shapes); each
   *   line is split into the free x-segments left after subtracting them. Omitting
   *   it (or passing `[]`) leaves the single-column path byte-for-byte unchanged.
   */
  /**
   * Line count + total height for prepared text at the engine's current
   * `maxWidth`, WITHOUT positioning any glyph or allocating a node.
   *
   * `layoutPrepared()` exists to produce positioned glyphs — selection geometry
   * and the a11y projection need them. But a caller that only wants "how tall is
   * this at this width" (a virtualized list measuring rows, a resize pass
   * deciding heights, an autosizing container) pays the full O(glyphs) walk plus
   * one `LayoutNode` allocation per glyph for data it discards.
   *
   * This walks the prepared WORD widths instead — O(words), zero allocation —
   * reusing the same greedy wrap decisions as the full path. Prompted by
   * benchmarking against `@chenglou/pretext`, whose hot path is segment-level for
   * exactly this reason; see `comparisons/text-layout-pretext/`.
   *
   * Break decisions match `layoutPrepared()` for the single-column case
   * (no exclusions, no hyphenation, no per-glyph exclusion mask). Text that
   * needs any of those must use the full path.
   */
  public measurePrepared(prepared: PreparedText): {
    lineCount: number;
    height: number;
  } {
    const fontSize = prepared.fontSize;
    let lineCount = 0;
    let height = 0;

    for (const paragraph of prepared.paragraphs) {
      if (paragraph.isEmpty) {
        lineCount += 1;
        height += fontSize * 1.5;
        continue;
      }
      // Tallest glyph drives this paragraph's line height, same as the full path.
      let pMax = fontSize;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const gfs = glyph.style?.fontSize ?? fontSize;
          if (gfs > pMax) pMax = gfs;
          const shift = glyph.style?.baselineShift ?? 0;
          if (shift !== 0) pMax = shiftedExtent(gfs, shift, pMax);
        }
      }
      // An inline object is a fixed box, not a scaled em: grow pMax until the
      // part of it above the baseline fits, and track how far the deepest one
      // hangs below the baseline so the line extends for it — the exact loops
      // `layoutPrepared()` runs, so heights agree with what it produces.
      let objDescent = 0;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const o = glyph.object;
          if (!o) continue;
          const depth = o.depth ?? 0;
          const ascent = o.height - depth;
          if (ascent > pMax * 0.8) pMax = ascent / 0.8;
          if (depth > objDescent) objDescent = depth;
        }
      }
      const lineHeight = Math.max(pMax * 1.5, pMax * 0.8 + objDescent);

      let x = 0;
      let lines = 1;
      const words = suppressLineBreaks(paragraph.words);
      for (const word of words) {
        if (x + word.width > this.maxWidth && x > 0) {
          // Trailing whitespace never forces a wrap (matches the full path).
          if (word.isWordLike === false && word.isWhitespace) continue;
          lines++;
          x = 0;
        }
        // A word wider than the measure can't fit on any line, so the full path
        // breaks it mid-word at glyph boundaries. Walk its glyph advances to
        // count those overflow lines rather than reporting one impossible line.
        if (word.width > this.maxWidth) {
          for (const glyph of word.glyphs) {
            if (x + glyph.width > this.maxWidth && x > 0) {
              lines++;
              x = 0;
            }
            x += glyph.width;
          }
          continue;
        }
        x += word.width;
      }
      lineCount += lines;
      height += lines * lineHeight;
    }
    return { lineCount, height };
  }

  public layoutPrepared(
    prepared: PreparedText,
    exclusionMask?: (x: number, y: number, w: number, h: number) => boolean,
    exclusions?: ExclusionRect[],
  ): LayoutResult {
    const layoutNodes: LayoutNode[] = [];
    const fontSize = prepared.fontSize;
    let currentX = 0;
    let currentY = 0;
    let maxLineWidth = 0;

    // Line state: the free segments of the current band and which one we're in.
    // Without exclusions there is always exactly one full-width segment, so every
    // segment-aware branch below collapses to the original single-column logic.
    const hasEx = !!(exclusions && exclusions.length);
    let segs: LineSegment[] = [{ x0: 0, x1: this.maxWidth }];
    let si = 0;

    // Buffering nodes of the current line for Bidi visual reordering
    let currentLineNodes: any[] = [];
    let paragraphBaseLevel = 0;

    const commitLine = (justifyTo?: number) => {
      if (currentLineNodes.length === 0) return;

      // RTL paragraphs are packed left (currentX starts at the segment's x0),
      // then reordered within runs — but the line as a whole must sit flush
      // RIGHT. Compute a whole-line shift so the last-placed glyph ends at the
      // wrap edge. Skipped when: justify already flushes to the edge; a finite
      // wrap width is absent (unbounded 1e9 sentinel → nothing to align to); or
      // exclusions split the line into gap-separated runs (right-aligning across
      // arbitrary exclusion bands is a separate, harder case — left for a
      // follow-up so this stays a focused, correct fix for the common path).
      let lineShift = 0;
      if (
        paragraphBaseLevel % 2 === 1 &&
        justifyTo === undefined &&
        !hasEx &&
        this.maxWidth < 1e9
      ) {
        let lineMinX = Infinity;
        let lineMaxRight = -Infinity;
        for (const node of currentLineNodes) {
          if (node.x < lineMinX) lineMinX = node.x;
          if (node.x + node.width > lineMaxRight) lineMaxRight = node.x + node.width;
        }
        // Trailing whitespace was reset to base level by L1 and sits at the
        // line's logical end; for RTL that's the left, so it doesn't extend the
        // visual right edge. Align the content's right edge to maxWidth.
        const shift = this.maxWidth - lineMaxRight;
        if (shift > 0) lineShift = shift;
      }

      // 1. Group contiguous visual runs to preserve gaps (e.g. exclusion masks, indentations)
      const runs: any[][] = [];
      let currentRun: any[] = [];

      for (let j = 0; j < currentLineNodes.length; j++) {
        const node = currentLineNodes[j];
        const prev = currentLineNodes[j - 1];

        // If there is a gap, start a new run
        if (prev && Math.abs(node.x - (prev.x + prev.width)) > 0.001) {
          runs.push(currentRun);
          currentRun = [];
        }
        currentRun.push(node);
      }
      if (currentRun.length > 0) {
        runs.push(currentRun);
      }

      // 2. Process each contiguous run independently
      for (const run of runs) {
        const runStartX = run[0].x;

        // Visual reordering per UAX #9
        BidiResolver.reorderVisual(run, paragraphBaseLevel);

        // Re-assign visual coordinates LTR inside the run, shifted flush-right
        // for an RTL paragraph (lineShift is 0 for LTR / justify / unbounded).
        let x = runStartX + lineShift;
        for (const node of run) {
          node.x = x;
          node.isRTL = node.level % 2 === 1;
          x += node.width;
        }

        // Justify: stretch this run so its content ends flush at the target.
        // Only single-run lines qualify (multi-run = exclusion gaps that must
        // be preserved); the paragraph-final line never passes a target.
        if (justifyTo !== undefined && runs.length === 1) {
          let lastContent = run.length - 1;
          while (lastContent >= 0 && run[lastContent].char.trim() === '') lastContent--;
          // Leading whitespace in VISUAL order. For an RTL line the logical
          // trailing space is reset to the base level by L1 and lands here, at
          // the visual left; leaving it in place would push the content a
          // space-width right of the wrap edge's mirror (the line would start at
          // x = x0 + spaceWidth instead of x0). Collapse it so justified content
          // spans the full measure, exactly as the non-justified RTL path does
          // via its whole-line flush-right shift.
          let firstContent = 0;
          while (firstContent < run.length && run[firstContent].char.trim() === '') {
            firstContent++;
          }
          if (firstContent > 0 && firstContent <= lastContent) {
            const collapse = run[firstContent].x - runStartX;
            if (collapse > 0) {
              for (let k = 0; k < firstContent; k++) run[k].width = 0;
              for (let k = 0; k <= lastContent; k++) run[k].x -= collapse;
            }
          }
          if (lastContent > firstContent) {
            const contentEnd = run[lastContent].x + run[lastContent].width;
            const slack = justifyTo - contentEnd;
            // Guard against grotesque stretching on very short lines.
            if (slack > 0 && slack <= (justifyTo - runStartX) * 0.5) {
              const spaceIdx: number[] = [];
              for (let k = firstContent + 1; k < lastContent; k++) {
                if (run[k].char.trim() === '') spaceIdx.push(k);
              }
              if (spaceIdx.length > 0) {
                // Word-spaced text: widen each inter-word gap equally.
                const extra = slack / spaceIdx.length;
                let shift = 0;
                let nextSpace = 0;
                for (let k = firstContent; k <= lastContent; k++) {
                  run[k].x += shift;
                  if (nextSpace < spaceIdx.length && k === spaceIdx[nextSpace]) {
                    run[k].width += extra;
                    shift += extra;
                    nextSpace++;
                  }
                }
              } else {
                // Space-less (CJK) line: distribute between every glyph.
                const span = lastContent - firstContent;
                const extra = slack / span;
                for (let k = firstContent + 1; k <= lastContent; k++) {
                  run[k].x += extra * (k - firstContent);
                }
              }
              if (justifyTo > maxLineWidth) maxLineWidth = justifyTo;
            }
          }
        }

        // Add to final layout result
        for (const node of run) {
          layoutNodes.push(node as LayoutNode);
        }
      }
      currentLineNodes = [];
    };

    // (Re)compute the segments for the line box starting at `currentY`, skipping
    // bands an exclusion fully covers. Sets segs/si/currentX; advances currentY
    // past blocked bands. Returns false when it runs past maxHeight.
    const startLine = (lineHeight: number): boolean => {
      while (currentY < this.maxHeight) {
        const s = hasEx
          ? computeLineSegments(currentY, currentY + lineHeight, this.maxWidth, exclusions!)
          : segs;
        if (s.length > 0) {
          segs = s;
          si = 0;
          currentX = segs[0].x0;
          return true;
        }
        currentY += lineHeight; // whole band excluded → drop to the next line
      }
      return false;
    };

    const justifyTarget = this.textAlign === 'justify' && !hasEx ? this.maxWidth : undefined;
    const hyphenWidth = prepared.hyphenWidth ?? fontSize * 0.3;

    for (const paragraph of prepared.paragraphs) {
      if (paragraph.isEmpty) {
        commitLine(); // Flush previous line
        currentY += fontSize * 1.5;
        currentX = 0;
        continue;
      }

      paragraphBaseLevel = paragraph.baseLevel ?? 0;

      // Tallest run in the paragraph drives line height + the shared baseline, so
      // mixed-size inline runs sit on one baseline (plain text: pMax === fontSize,
      // making every offset below collapse to the original behavior). A run whose
      // baseline is shifted far enough to leave the line box grows it too, via
      // the same `shiftedExtent` the measure and buffer paths use.
      let pMax = fontSize;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const gfs = glyph.style?.fontSize ?? fontSize;
          if (gfs > pMax) pMax = gfs;
          const shift = glyph.style?.baselineShift ?? 0;
          if (shift !== 0) pMax = shiftedExtent(gfs, shift, pMax);
        }
      }
      // An inline object is a fixed box, not a scaled em: the part of it ABOVE the
      // baseline is `height - depth`, and the baseline sits `pMax * 0.8` below the
      // line top (see the glyph `y` below). Grow pMax until that ascent fits, or a
      // formula taller than its surrounding text would be clipped by the line box.
      let objDescent = 0;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const o = glyph.object;
          if (!o) continue;
          const depth = o.depth ?? 0;
          const ascent = o.height - depth;
          if (ascent > pMax * 0.8) pMax = ascent / 0.8;
          if (depth > objDescent) objDescent = depth;
        }
      }
      // Default leading (0.5 * pMax) already covers a normal glyph's descender; an
      // object may hang further, so extend the line only by the excess.
      const lineHeight = Math.max(pMax * 1.5, pMax * 0.8 + objDescent);
      if (!startLine(lineHeight)) break; // out of vertical bounds

      const wordQueue = suppressLineBreaks(paragraph.words.slice());
      for (let qi = 0; qi < wordQueue.length; qi++) {
        const word = wordQueue[qi];
        // Word-level wrap: keep the word whole by jumping to the next free
        // segment, or to the next line when this was the last one.
        if (currentX + word.width > segs[si].x1) {
          // Hyphen break: place the longest fitting prefix plus a visible '-'
          // and requeue the remainder, instead of wrapping the whole word.
          // Runs even at line start, where a word longer than the line would
          // otherwise fall through to per-glyph overflow.
          if (!hasEx && word.breakPoints && word.breakPoints.length > 0) {
            const avail = segs[si].x1 - currentX;
            let chosen = -1;
            let prefixWidth = 0;
            let acc = 0;
            let bpIdx = 0;
            for (let g = 0; g < word.glyphs.length && bpIdx < word.breakPoints.length; g++) {
              acc += word.glyphs[g].width;
              if (g + 1 === word.breakPoints[bpIdx]) {
                if (acc + hyphenWidth <= avail) {
                  chosen = word.breakPoints[bpIdx];
                  prefixWidth = acc;
                }
                bpIdx++;
              }
            }
            if (chosen > 0) {
              const anchorGlyph = word.glyphs[chosen - 1];
              const prefix: PreparedWord = {
                glyphs: [
                  ...word.glyphs.slice(0, chosen),
                  {
                    char: '-',
                    width: hyphenWidth,
                    level: anchorGlyph.level,
                    sourceIndex: anchorGlyph.sourceIndex,
                    sourceLength: 0,
                  },
                ],
                width: prefixWidth + hyphenWidth,
                isWordLike: true,
                isWhitespace: false,
              };
              const rest: PreparedWord = {
                glyphs: word.glyphs.slice(chosen),
                width: word.width - prefixWidth,
                isWordLike: true,
                isWhitespace: false,
                breakPoints: word.breakPoints.filter((bp) => bp > chosen).map((bp) => bp - chosen),
              };
              wordQueue.splice(qi, 1, prefix, rest);
              qi--;
              continue;
            }
          }

          if (currentX > segs[si].x0) {
            if (word.isWordLike === false && word.isWhitespace) continue;
            if (si < segs.length - 1) {
              si++;
              currentX = segs[si].x0;
            } else {
              commitLine(justifyTarget); // Flush visual line before wrap
              currentY += lineHeight;
              if (!startLine(lineHeight)) break;
            }
          }
        }

        for (const glyph of word.glyphs) {
          const charWidth = glyph.width;
          const gfs = glyph.style?.fontSize ?? fontSize;

          let foundSpot = false;
          while (currentY < this.maxHeight) {
            if (currentX + charWidth > segs[si].x1 && currentX > segs[si].x0) {
              if (si < segs.length - 1) {
                si++;
                currentX = segs[si].x0;
              } else {
                commitLine(justifyTarget); // Flush visual line before wrap
                currentY += lineHeight;
                if (!startLine(lineHeight)) break;
              }
              continue;
            }
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, gfs)) {
              currentX += charWidth;
              continue;
            }
            foundSpot = true;
            break;
          }

          if (!foundSpot || currentY >= this.maxHeight) break; // Out of bounds

          // Don't render invisible leading characters at the START of a segment
          if (
            currentX === segs[si].x0 &&
            glyph.char.trim().length === 0 &&
            !this.preserveLeadingSpaces
          )
            continue;

          currentLineNodes.push({
            char: glyph.char,
            x: currentX,
            // Canvas text is positioned by baseline, while `y` is the local
            // top used by the renderer. Offset smaller runs by their baseline
            // delta, not by their full em-box delta, so mixed-size glyphs share
            // one real baseline in every Canvas 2D implementation.
            //
            // A baseline-shifted run moves along its OWN baseline, so its top
            // subtracts the shift (`baselineShift` is positive = up) from the
            // shared-baseline position. The line box already grew to fit it, if
            // it needed to, in the pMax pass above.
            //
            // An object is a fixed box rather than a scaled em, so it is placed by
            // sitting its BOTTOM at `baseline + depth`: its top is therefore
            // `baseline - (height - depth)`. The baseline is at `pMax * 0.8`.
            y: glyph.object
              ? currentY + pMax * 0.8 - (glyph.object.height - (glyph.object.depth ?? 0))
              : currentY + (pMax - gfs) * 0.8 - (glyph.style?.baselineShift ?? 0),
            width: charWidth,
            height: glyph.object ? glyph.object.height : gfs,
            style: glyph.style,
            ...(glyph.object ? { object: glyph.object } : {}),
            level: glyph.level,
            sourceIndex: glyph.sourceIndex,
            sourceLength: glyph.sourceLength,
          });

          currentX += charWidth;
          if (currentX > maxLineWidth) maxLineWidth = currentX;
        }
      }

      commitLine(); // Flush paragraph end visual line
      currentX = 0;
      currentY += lineHeight;
    }

    return {
      nodes: layoutNodes,
      totalWidth: maxLineWidth,
      totalHeight: currentY,
      fallbackToCanvas: prepared.fallbackToCanvas,
    };
  }

  /**
   * Lay out a Unicode string directly into a pre-allocated {@link LayoutResultBuffer}.
   *
   * Avoids GC allocations by writing results directly to flat typed arrays in the buffer.
   *
   * @param text - The raw text string to lay out.
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param fontSize - Target font size in pixels.
   * @param buffer - The pre-allocated buffer to write layout results into.
   * @param exclusionMask - Optional collision-detection callback.
   */
  public layoutTextIntoBuffer(
    text: string,
    fontAtlas: GlyphAtlas,
    fontSize: number,
    buffer: LayoutResultBuffer,
    exclusionMask?: (x: number, y: number, w: number, h: number) => boolean,
  ): void {
    this.layoutPreparedIntoBuffer(this.prepare(text, fontAtlas, fontSize), buffer, exclusionMask);
  }

  /**
   * **Hot pass, zero-GC variant.** Place an already-measured {@link PreparedText}
   * directly into a pre-allocated {@link LayoutResultBuffer}. Like
   * {@link layoutPrepared} but writes flat typed arrays instead of allocating
   * {@link LayoutNode} objects — the per-frame path for large dynamic scenes.
   */
  public layoutPreparedIntoBuffer(
    prepared: PreparedText,
    buffer: LayoutResultBuffer,
    exclusionMask?: (x: number, y: number, w: number, h: number) => boolean,
  ): void {
    buffer.reset();
    const fontSize = prepared.fontSize;
    let currentX = 0;
    let currentY = 0;

    // Slots [lineStart, buffer.count) hold the current visual line in LOGICAL
    // order; commitLine turns them into VISUAL order (UAX #9 L2) and assigns the
    // final x + shared-baseline y — mirroring layoutPrepared's commitLine so the
    // zero-GC path agrees glyph-for-glyph with the allocating one.
    let lineStart = 0;
    let paragraphBaseLevel = 0;

    const commitLine = (): void => {
      const end = buffer.count;
      const len = end - lineStart;
      if (len <= 0) return;

      // Reorder only when the line actually carries RTL content: a pure-LTR line
      // (the common hot path) stays fully allocation-free here.
      let hasRTL = paragraphBaseLevel % 2 === 1;
      for (let i = lineStart; !hasRTL && i < end; i++) {
        if (buffer.levels[i] % 2 === 1) hasRTL = true;
      }

      if (hasRTL) {
        let str = '';
        const lvls = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          str += buffer.chars[lineStart + i];
          lvls[i] = buffer.levels[lineStart + i];
        }
        // Reverse each L2 segment in place across ALL parallel arrays, so a
        // glyph's char/width/height/level/baselineShift travel together into
        // visual order.
        const segments = BidiResolver.reorderSegments(str, lvls, paragraphBaseLevel);
        for (const [segStart, segEnd] of segments) {
          let left = lineStart + segStart;
          let right = lineStart + segEnd;
          while (left < right) {
            const tc = buffer.chars[left];
            buffer.chars[left] = buffer.chars[right];
            buffer.chars[right] = tc;
            const tw = buffer.ws[left];
            buffer.ws[left] = buffer.ws[right];
            buffer.ws[right] = tw;
            const th = buffer.hs[left];
            buffer.hs[left] = buffer.hs[right];
            buffer.hs[right] = th;
            const tl = buffer.levels[left];
            buffer.levels[left] = buffer.levels[right];
            buffer.levels[right] = tl;
            const tb = buffer.baselineShifts[left];
            buffer.baselineShifts[left] = buffer.baselineShifts[right];
            buffer.baselineShifts[right] = tb;
            const to = buffer.topOffsets[left];
            buffer.topOffsets[left] = buffer.topOffsets[right];
            buffer.topOffsets[right] = to;
            left++;
            right--;
          }
        }
      }

      // Assign visual x left-to-right from the (now visually ordered) widths. An
      // RTL paragraph packs left while placing, so shift the whole line so its
      // content ends flush at the wrap edge (skipped when the width is the
      // unbounded 1e9 sentinel — nothing to align to).
      let contentW = 0;
      for (let i = lineStart; i < end; i++) contentW += buffer.ws[i];
      const rtlShift =
        paragraphBaseLevel % 2 === 1 && this.maxWidth < 1e9 && contentW < this.maxWidth
          ? this.maxWidth - contentW
          : 0;
      let x = rtlShift;
      for (let i = lineStart; i < end; i++) {
        buffer.xs[i] = x;
        // The per-slot offset from the line top was computed at write time —
        // shared-baseline delta for text glyphs (smaller runs sit lower so all
        // sizes share one real baseline), baseline-shift moves along its own
        // baseline, and objects sit their bottom at `baseline + depth` — so it
        // mirrors the allocating path glyph-for-glyph and survives the reversal.
        buffer.ys[i] = currentY + buffer.topOffsets[i];
        x += buffer.ws[i];
      }
    };

    for (const paragraph of prepared.paragraphs) {
      if (paragraph.isEmpty) {
        currentY += fontSize * 1.5;
        currentX = 0;
        continue;
      }

      paragraphBaseLevel = paragraph.baseLevel ?? 0;

      // Tallest run in the paragraph drives line height + the shared baseline
      // (plain single-size text: pMax === fontSize, so every offset below
      // collapses to the original behavior). A baseline-shifted run that would
      // leave the line box grows it, matching the allocating path. An inline
      // object grows it too: pMax until its above-baseline part fits, plus an
      // extension for how far it hangs below — the same two loops as the
      // allocating path, so both paths report one line height.
      let pMax = fontSize;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const gfs = glyph.style?.fontSize ?? fontSize;
          if (gfs > pMax) pMax = gfs;
          const shift = glyph.style?.baselineShift ?? 0;
          if (shift !== 0) pMax = shiftedExtent(gfs, shift, pMax);
        }
      }
      let objDescent = 0;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const o = glyph.object;
          if (!o) continue;
          const depth = o.depth ?? 0;
          const ascent = o.height - depth;
          if (ascent > pMax * 0.8) pMax = ascent / 0.8;
          if (depth > objDescent) objDescent = depth;
        }
      }
      const lineHeight = Math.max(pMax * 1.5, pMax * 0.8 + objDescent);
      lineStart = buffer.count;
      // Tallest glyph on the line → shared baseline. Per-paragraph: always
      // derived from pMax before the first read below, never across iterations.
      const lineMax = pMax;

      for (const word of paragraph.words) {
        if (currentX + word.width > this.maxWidth && currentX > 0) {
          if (word.isWordLike === false && word.isWhitespace) continue;
          commitLine();
          lineStart = buffer.count;
          currentX = 0;
          currentY += lineHeight;
        }

        for (const glyph of word.glyphs) {
          if (buffer.count >= LayoutResultBuffer.CAPACITY) break;

          const charWidth = glyph.width;
          const gfs = glyph.style?.fontSize ?? fontSize;

          let foundSpot = false;
          while (currentY < this.maxHeight) {
            if (currentX + charWidth > this.maxWidth && currentX > 0) {
              commitLine();
              lineStart = buffer.count;
              currentX = 0;
              currentY += lineHeight;
              continue;
            }
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, gfs)) {
              currentX += charWidth;
              continue;
            }
            foundSpot = true;
            break;
          }

          if (!foundSpot || currentY >= this.maxHeight) break;

          // Don't render invisible leading characters at the START of a line,
          // unless the caller opted in — same rule as the allocating path.
          if (currentX === 0 && glyph.char.trim().length === 0 && !this.preserveLeadingSpaces)
            continue;

          // Written in LOGICAL order at a provisional x/y; commitLine assigns
          // the final visual x and the shared-baseline y for the whole line.
          // Each slot's offset from the line top is precomputed exactly as the
          // allocating path computes `y`, so it travels with the glyph through
          // the L2 reversal (see topOffsets on the buffer).
          const idx = buffer.count;
          buffer.chars[idx] = glyph.char;
          buffer.xs[idx] = currentX;
          buffer.ys[idx] = currentY;
          buffer.ws[idx] = charWidth;
          buffer.hs[idx] = glyph.object ? glyph.object.height : gfs;
          buffer.topOffsets[idx] = glyph.object
            ? lineMax * 0.8 - (glyph.object.height - (glyph.object.depth ?? 0))
            : (lineMax - gfs) * 0.8 - (glyph.style?.baselineShift ?? 0);
          buffer.baselineShifts[idx] = glyph.style?.baselineShift ?? 0;
          buffer.levels[idx] = (glyph.level ?? paragraphBaseLevel) & 0x7f;
          buffer.count++;

          currentX += charWidth;
        }
      }

      commitLine();
      lineStart = buffer.count;
      currentX = 0;
      currentY += lineHeight;
    }
  }
}

/**
 * Pre-allocated buffer for zero-GC layout results.
 * Reuse a single instance across frames by calling reset() before each layout pass.
 */
export class LayoutResultBuffer {
  static readonly CAPACITY = 16384;
  /** X positions of each glyph. */
  xs: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Y positions of each glyph. */
  ys: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Widths of each glyph. */
  ws: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Heights of each glyph. */
  hs: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Baseline shift (px, positive = up) of each glyph; 0 for unshifted. */
  baselineShifts: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Per-glyph offset from the line top to the glyph's local top — the exact
   *  `y - currentY` the allocating path computes, precomputed at write time so
   *  it survives the BiDi slot reversal. Scratch for commitLine's y pass;
   *  consumers should read `ys` for final positions. */
  topOffsets: Float32Array = new Float32Array(LayoutResultBuffer.CAPACITY);
  /** Character for each glyph slot. */
  chars: string[] = Array.from({ length: LayoutResultBuffer.CAPACITY });
  /** Resolved BiDi embedding level of each glyph (even = LTR, odd = RTL). Used
   *  for visual reordering; also lets a consumer know a glyph's direction. */
  levels: Uint8Array = new Uint8Array(LayoutResultBuffer.CAPACITY);
  /** Number of valid glyphs written in this buffer. */
  count: number = 0;

  /** Reset the buffer for reuse. Does NOT free memory. */
  reset(): void {
    this.count = 0;
  }

  /** Convert to the standard LayoutResult format (allocates — use sparingly). */
  toLayoutResult(): LayoutResult {
    const nodes: LayoutNode[] = [];
    // Derived from the committed slots rather than hard-coded: max right edge
    // and lowest glyph bottom are exactly the ink box this buffer holds, so a
    // consumer of the converted result gets honest dimensions.
    let totalWidth = 0;
    let totalHeight = 0;
    for (let i = 0; i < this.count; i++) {
      nodes.push({
        char: this.chars[i],
        x: this.xs[i],
        y: this.ys[i],
        width: this.ws[i],
        height: this.hs[i],
      });
      const right = this.xs[i] + this.ws[i];
      if (right > totalWidth) totalWidth = right;
      const bottom = this.ys[i] + this.hs[i];
      if (bottom > totalHeight) totalHeight = bottom;
    }
    return { nodes, totalWidth, totalHeight };
  }
}
