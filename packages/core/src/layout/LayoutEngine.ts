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
}

/**
 * The complete output of a text layout pass — an ordered list of positioned
 * glyphs and the total bounding-box dimensions.
 */
export interface LayoutResult {
  nodes: LayoutNode[];
  totalWidth: number;
  totalHeight: number;
}

/** A single measured grapheme (the "cold" half of the cold/hot split). */
export interface PreparedGlyph {
  char: string;
  /** Advance width at the prepared `fontSize`. */
  width: number;
  /** Inline style (rich text only); drives per-glyph size, color and baseline. */
  style?: TextStyle;
}

/** A measured word/segment, ready to be placed without re-measuring. */
export interface PreparedWord {
  glyphs: PreparedGlyph[];
  /** Sum of glyph advances — used for word-level wrap decisions. */
  width: number;
  isWordLike: boolean | undefined;
  /** Pre-computed `word.trim().length === 0`. */
  isWhitespace: boolean;
}

/** A measured paragraph; `isEmpty` marks a blank line (forced newline). */
export interface PreparedParagraph {
  words: PreparedWord[];
  isEmpty: boolean;
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
}

/**
 * A rectangular region (in the text's local coordinate space) that text must
 * flow around — the v1 of "文字绕流" / exclusion shapes. A left/right rect acts
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
 * VectoUI Global Layout Engine (Intl.Segmenter)
 * Advanced Typography Engine supporting CJK, Emoji, and Western Graphemes
 */
export class LayoutEngine {
  public maxWidth: number;
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
  private lastAtlas: GlyphAtlas | null = null;
  private measurer: GlyphMeasurer | null;

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
      this.lastAtlas = fontAtlas;
    }

    const paragraphs: PreparedParagraph[] = [];

    for (const paragraph of text.split('\n')) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        continue;
      }

      const key = `${fontSize} ${paragraph}`;
      const cached = this.paragraphCache.get(key);
      if (cached) {
        paragraphs.push(cached);
        continue;
      }

      const words: PreparedWord[] = [];
      for (const segment of this.getWordSegments(paragraph)) {
        const word = segment.segment;
        const glyphs: PreparedGlyph[] = [];
        let width = 0;
        for (const char of this.getGraphemes(word)) {
          const w = this.glyphWidth(char, fontAtlas, fontSize);
          glyphs.push({ char, width: w });
          width += w;
        }
        words.push({
          glyphs,
          width,
          isWordLike: segment.isWordLike,
          isWhitespace: word.trim().length === 0,
        });
      }
      const prepared: PreparedParagraph = { words, isEmpty: false };
      if (this.paragraphCache.size > 1000) this.paragraphCache.clear();
      this.paragraphCache.set(key, prepared);
      paragraphs.push(prepared);
    }

    return { paragraphs, fontSize };
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
    // Flatten to text + a per-UTF16-unit style map (one shared object per run).
    let fullText = '';
    const styleAt: Array<TextStyle | undefined> = [];
    for (const span of spans) {
      const merged: TextStyle | undefined =
        span.style || baseStyle ? { ...baseStyle, ...span.style } : undefined;
      fullText += span.text;
      for (let i = 0; i < span.text.length; i++) styleAt.push(merged);
    }

    const paragraphs: PreparedParagraph[] = [];
    let offset = 0;
    for (const paragraph of fullText.split('\n')) {
      if (paragraph.length === 0) {
        paragraphs.push({ words: [], isEmpty: true });
        offset += 1; // the consumed '\n'
        continue;
      }
      const words: PreparedWord[] = [];
      let pOff = offset;
      for (const segment of this.getWordSegments(paragraph)) {
        const word = segment.segment;
        const glyphs: PreparedGlyph[] = [];
        let width = 0;
        for (const char of this.getGraphemes(word)) {
          const style = styleAt[pOff];
          const w = this.glyphWidth(char, fontAtlas, style?.fontSize ?? baseFontSize);
          glyphs.push({ char, width: w, style });
          width += w;
          pOff += char.length;
        }
        words.push({
          glyphs,
          width,
          isWordLike: segment.isWordLike,
          isWhitespace: word.trim().length === 0,
        });
      }
      paragraphs.push({ words, isEmpty: false });
      offset += paragraph.length + 1; // + the consumed '\n'
    }

    return { paragraphs, fontSize: baseFontSize };
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
   * @param exclusions - Optional rect regions text flows around ("文字绕流"); each
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

    for (const paragraph of prepared.paragraphs) {
      if (paragraph.isEmpty) {
        currentY += fontSize * 1.5;
        currentX = 0;
        continue;
      }

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

      for (const word of paragraph.words) {
        // Word-level wrap: keep the word whole by jumping to the next free
        // segment, or to the next line when this was the last one.
        if (currentX + word.width > segs[si].x1 && currentX > segs[si].x0) {
          if (word.isWordLike === false && word.isWhitespace) continue;
          if (si < segs.length - 1) {
            si++;
            currentX = segs[si].x0;
          } else {
            currentY += lineHeight;
            if (!startLine(lineHeight)) break;
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

          layoutNodes.push({
            char: glyph.char,
            x: currentX,
            // Drop smaller glyphs to the shared baseline (no-op when gfs === pMax).
            y: currentY + (pMax - gfs),
            width: charWidth,
            height: gfs,
            style: glyph.style,
          });

          currentX += charWidth;
          if (currentX > maxLineWidth) maxLineWidth = currentX;
        }
      }

      currentX = 0;
      currentY += lineHeight;
    }

    return { nodes: layoutNodes, totalWidth: maxLineWidth, totalHeight: currentY };
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
