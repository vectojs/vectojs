import { ArabicShaper } from '../text/ArabicShaper';
import { BidiResolver } from '../text/BidiResolver';

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
 * Resolves the pixel advance width of a single grapheme at a given font size,
 * for glyphs not present in a pre-baked {@link GlyphAtlas}.
 *
 * Implemented by {@link createCanvasMeasurer} (canvas `measureText`), but kept
 * abstract so callers can supply their own metrics source.
 */
export interface GlyphMeasurer {
  measure(char: string, fontSize: number): number;
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
  /** Bold weight (rendering only; width still measured at base metrics). */
  bold?: boolean;
  /** Italic slant (rendering only). */
  italic?: boolean;
  /** Hyperlink destination; carried through to the positioned nodes for hit-testing / a11y. */
  href?: string;
}

/** A run of text sharing one {@link TextStyle}, the input unit of {@link LayoutEngine.prepareRich}. */
export interface StyledSpan {
  text: string;
  style?: TextStyle;
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
  sourceIndex?: number;
  sourceLength?: number;
  isRTL?: boolean;
  combining?: string[];
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
export interface PreparedGlyph {
  char: string;
  /** Advance width at the prepared `fontSize`. */
  width: number;
  /** Inline style (rich text only); drives per-glyph size, color and baseline. */
  style?: TextStyle;
  level: number;
  sourceIndex: number;
  sourceLength: number;
  combining?: string[];
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
  /** Advance width of '-' at `fontSize`, for wrap-time hyphen insertion. */
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
  }

  constructor(maxWidth: number, maxHeight: number, measurer?: GlyphMeasurer | null) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.measurer = measurer ?? null;

    // Auto-detect browser locale for intelligent CJK and Western word boundaries
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    this.wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    this.charSegmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  }

  private getWordSegments(
    paragraph: string,
  ): Array<{ segment: string; isWordLike: boolean | undefined }> {
    const cached = this.wordCache.get(paragraph);
    if (cached) return cached;

    const fresh = Array.from(this.wordSegmenter.segment(paragraph)).map((s) => ({
      segment: s.segment,
      isWordLike: s.isWordLike,
    }));
    if (this.wordCache.size > 500) this.wordCache.clear();
    this.wordCache.set(paragraph, fresh);
    return fresh;
  }

  /**
   * Resolve a grapheme's advance width at `fontSize`, in priority order:
   * pre-baked atlas entry → injected {@link GlyphMeasurer} → `0.5em` fallback.
   */
  private glyphWidth(char: string, fontAtlas: GlyphAtlas, fontSize: number): number {
    const glyphInfo = fontAtlas[char];
    if (glyphInfo) return glyphInfo.width * (fontSize / glyphInfo.baseSize);
    if (this.measurer) return this.measurer.measure(char, fontSize);
    return fontSize * 0.5;
  }

  private glyphKeyFor(grapheme: string, fontAtlas: GlyphAtlas): string {
    if (fontAtlas[grapheme]) return grapheme;
    const firstCodePoint = Array.from(grapheme)[0];
    if (firstCodePoint && fontAtlas[firstCodePoint]) return firstCodePoint;
    return grapheme;
  }

  private getGraphemes(word: string): string[] {
    const cached = this.graphemeCache.get(word);
    if (cached) return cached;

    const fresh = Array.from(this.charSegmenter.segment(word)).map((g) => g.segment);
    if (this.graphemeCache.size > 2000) this.graphemeCache.clear();
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

    for (const paragraph of text.split('\n')) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        offset += 1;
        continue;
      }

      const key = `${fontSize} ${paragraph}`;
      const cached = this.paragraphCache.get(key);
      if (cached) {
        paragraphs.push(cached);
        if (cached.fallbackToCanvas) fallbackToCanvas = true;
        offset += paragraph.length + 1;
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

          const w = this.glyphWidth(glyphKey, fontAtlas, fontSize);

          glyphs.push({
            char,
            width: w,
            level,
            sourceIndex,
            sourceLength,
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
      if (this.paragraphCache.size > 1000) this.paragraphCache.clear();
      this.paragraphCache.set(key, prepared);
      paragraphs.push(prepared);
      offset += paragraph.length + 1;
    }

    return {
      paragraphs,
      fontSize,
      fallbackToCanvas: fallbackToCanvas || undefined,
      hyphenWidth: this.glyphWidth(this.glyphKeyFor('-', fontAtlas), fontAtlas, fontSize),
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
    for (const span of spans) {
      const merged: TextStyle | undefined =
        span.style || baseStyle ? { ...baseStyle, ...span.style } : undefined;
      fullText += span.text;
      for (let i = 0; i < span.text.length; i++) styleAt.push(merged);
    }

    // A compact, *value*-based RLE signature of the styles over [start, start+len)
    // — so a cached paragraph is reused whether or not the caller reuses the same
    // style object instances (it just has to apply the same fontSize/color/…).
    const styleSig = (start: number, len: number): string => {
      let sig = '';
      let i = 0;
      while (i < len) {
        const s = styleAt[start + i];
        const fp = s
          ? `${s.fontSize ?? ''}/${s.color ?? ''}/${s.bold ? 1 : 0}/${s.italic ? 1 : 0}/${s.href ?? ''}`
          : '';
        let run = 1;
        while (i + run < len) {
          const t = styleAt[start + i + run];
          const tfp = t
            ? `${t.fontSize ?? ''}/${t.color ?? ''}/${t.bold ? 1 : 0}/${t.italic ? 1 : 0}/${t.href ?? ''}`
            : '';
          if (tfp !== fp) break;
          run++;
        }
        sig += `${fp}:${run};`;
        i += run;
      }
      return sig;
    };

    const paragraphs: PreparedParagraph[] = [];
    let offset = 0;
    let fallbackToCanvas = false;

    for (const paragraph of fullText.split('\n')) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        offset += 1; // the consumed '\n'
        continue;
      }

      const key = `${baseFontSize} ${paragraph} ${styleSig(offset, paragraph.length)}`;
      const cached = this.richParagraphCache.get(key);
      if (cached) {
        paragraphs.push(cached);
        if (cached.fallbackToCanvas) fallbackToCanvas = true;
        offset += paragraph.length + 1;
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

          const hasGlyph = !!fontAtlas[glyphKey];
          if (char.trim().length > 0 && !hasGlyph) {
            pFallback = true;
            fallbackToCanvas = true;
          }

          const w = this.glyphWidth(glyphKey, fontAtlas, gfs);

          glyphs.push({
            char,
            width: w,
            style,
            level,
            sourceIndex,
            sourceLength,
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
      if (this.richParagraphCache.size > 1000) this.richParagraphCache.clear();
      this.richParagraphCache.set(key, prepared);
      paragraphs.push(prepared);
      offset += paragraph.length + 1; // + the consumed '\n'
    }

    return {
      paragraphs,
      fontSize: baseFontSize,
      fallbackToCanvas: fallbackToCanvas || undefined,
    };
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

        // Re-assign visual coordinates LTR inside the run
        let x = runStartX;
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
          if (lastContent > 0) {
            const contentEnd = run[lastContent].x + run[lastContent].width;
            const slack = justifyTo - contentEnd;
            // Guard against grotesque stretching on very short lines.
            if (slack > 0 && slack <= (justifyTo - runStartX) * 0.5) {
              const spaceIdx: number[] = [];
              for (let k = 1; k < lastContent; k++) {
                if (run[k].char.trim() === '') spaceIdx.push(k);
              }
              if (spaceIdx.length > 0) {
                // Word-spaced text: widen each inter-word gap equally.
                const extra = slack / spaceIdx.length;
                let shift = 0;
                let nextSpace = 0;
                for (let k = 0; k <= lastContent; k++) {
                  run[k].x += shift;
                  if (nextSpace < spaceIdx.length && k === spaceIdx[nextSpace]) {
                    run[k].width += extra;
                    shift += extra;
                    nextSpace++;
                  }
                }
              } else {
                // Space-less (CJK) line: distribute between every glyph.
                const extra = slack / lastContent;
                for (let k = 1; k <= lastContent; k++) run[k].x += extra * k;
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
      // making every offset below collapse to the original behavior).
      let pMax = fontSize;
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          const gfs = glyph.style?.fontSize ?? fontSize;
          if (gfs > pMax) pMax = gfs;
        }
      }
      const lineHeight = pMax * 1.5;
      if (!startLine(lineHeight)) break; // out of vertical bounds

      const wordQueue = paragraph.words.slice();
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
            // Drop smaller glyphs to the shared baseline (no-op when gfs === pMax).
            y: currentY + (pMax - gfs),
            width: charWidth,
            height: gfs,
            style: glyph.style,
            level: glyph.level,
            sourceIndex: glyph.sourceIndex,
            sourceLength: glyph.sourceLength,
            combining: glyph.combining,
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
    const lineHeight = fontSize * 1.5;
    let currentX = 0;
    let currentY = 0;

    for (const paragraph of prepared.paragraphs) {
      if (paragraph.isEmpty) {
        currentY += lineHeight;
        currentX = 0;
        continue;
      }

      for (const word of paragraph.words) {
        if (currentX + word.width > this.maxWidth && currentX > 0) {
          if (word.isWordLike === false && word.isWhitespace) continue;
          currentX = 0;
          currentY += lineHeight;
        }

        for (const glyph of word.glyphs) {
          if (buffer.count >= LayoutResultBuffer.CAPACITY) break;

          const charWidth = glyph.width;

          let foundSpot = false;
          while (currentY < this.maxHeight) {
            if (currentX + charWidth > this.maxWidth && currentX > 0) {
              currentX = 0;
              currentY += lineHeight;
              continue;
            }
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, fontSize)) {
              currentX += charWidth;
              continue;
            }
            foundSpot = true;
            break;
          }

          if (!foundSpot || currentY >= this.maxHeight) break;

          if (currentX === 0 && glyph.char.trim().length === 0) continue;

          const idx = buffer.count;
          buffer.chars[idx] = glyph.char;
          buffer.xs[idx] = currentX;
          buffer.ys[idx] = currentY;
          buffer.ws[idx] = charWidth;
          buffer.hs[idx] = fontSize;
          buffer.count++;

          currentX += charWidth;
        }
      }

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
  /** Character for each glyph slot. */
  chars: string[] = Array.from({ length: LayoutResultBuffer.CAPACITY });
  /** Number of valid glyphs written in this buffer. */
  count: number = 0;

  /** Reset the buffer for reuse. Does NOT free memory. */
  reset(): void {
    this.count = 0;
  }

  /** Convert to the standard LayoutResult format (allocates — use sparingly). */
  toLayoutResult(): LayoutResult {
    const nodes: LayoutNode[] = [];
    for (let i = 0; i < this.count; i++) {
      nodes.push({
        char: this.chars[i],
        x: this.xs[i],
        y: this.ys[i],
        width: this.ws[i],
        height: this.hs[i],
      });
    }
    return { nodes, totalWidth: 0, totalHeight: 0 };
  }
}
