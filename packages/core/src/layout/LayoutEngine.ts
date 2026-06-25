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
 * A single positioned glyph produced by {@link LayoutEngine.layoutText}.
 */
export interface LayoutNode {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
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

/**
 * VectoUI Global Layout Engine (Intl.Segmenter)
 * Advanced Typography Engine supporting CJK, Emoji, and Western Graphemes
 */
export class LayoutEngine {
  public maxWidth: number;
  public maxHeight: number;
  private wordSegmenter: Intl.Segmenter;
  private charSegmenter: Intl.Segmenter;
  private wordCache: Map<string, Array<{ segment: string; isWordLike: boolean }>> = new Map();
  private graphemeCache: Map<string, string[]> = new Map();

  constructor(maxWidth: number, maxHeight: number) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;

    // Auto-detect browser locale for intelligent CJK and Western word boundaries
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    this.wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    this.charSegmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  }

  private getWordSegments(paragraph: string): Array<{ segment: string; isWordLike: boolean }> {
    let cached = this.wordCache.get(paragraph);
    if (!cached) {
      cached = Array.from(this.wordSegmenter.segment(paragraph)).map((s) => ({
        segment: s.segment,
        isWordLike: s.isWordLike,
      }));
      if (this.wordCache.size > 500) this.wordCache.clear();
      this.wordCache.set(paragraph, cached);
    }
    return cached;
  }

  private getGraphemes(word: string): string[] {
    let cached = this.graphemeCache.get(word);
    if (!cached) {
      cached = Array.from(this.charSegmenter.segment(word)).map((g) => g.segment);
      if (this.graphemeCache.size > 2000) this.graphemeCache.clear();
      this.graphemeCache.set(word, cached);
    }
    return cached;
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
    const layoutNodes: LayoutNode[] = [];
    let currentX = 0;
    let currentY = 0;
    const lineHeight = fontSize * 1.5;

    // Hard split by forced newlines first
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        currentY += lineHeight;
        currentX = 0;
        continue;
      }

      const segments = this.getWordSegments(paragraph);

      for (const segment of segments) {
        const word = segment.segment;

        let wordWidth = 0;
        const graphemes = this.getGraphemes(word);

        // 1. Measure the entire word first
        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          wordWidth += glyphInfo
            ? glyphInfo.width * (fontSize / glyphInfo.baseSize)
            : fontSize * 0.5;
        }

        // 2. Line wrap logic
        if (currentX + wordWidth > this.maxWidth && currentX > 0) {
          // If it's pure whitespace, don't trigger a hard wrap, let it trail
          if (segment.isWordLike === false && word.trim().length === 0) {
            continue;
          }
          currentX = 0;
          currentY += lineHeight;
        }

        // 3. Layout characters
        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          const charWidth = glyphInfo
            ? glyphInfo.width * (fontSize / glyphInfo.baseSize)
            : fontSize * 0.5;

          // Dynamically find the next available spot that doesn't collide with the mask
          let foundSpot = false;
          while (currentY < this.maxHeight) {
            // Line wrap
            if (currentX + charWidth > this.maxWidth && currentX > 0) {
              currentX = 0;
              currentY += lineHeight;
              continue;
            }

            // Check Exclusion Mask (Physics/Video collision)
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, fontSize)) {
              currentX += charWidth; // Skip over the masked shape
              continue;
            }

            foundSpot = true;
            break;
          }

          if (!foundSpot || currentY >= this.maxHeight) break; // Out of bounds

          // Don't render invisible leading characters at the START of a new line
          if (currentX === 0 && char.trim().length === 0) {
            continue;
          }

          layoutNodes.push({
            char: char,
            x: currentX,
            y: currentY,
            width: charWidth,
            height: fontSize,
          });

          currentX += charWidth;
        }
      }

      // End of paragraph
      currentX = 0;
      currentY += lineHeight;
    }

    return {
      nodes: layoutNodes,
      totalWidth: this.maxWidth,
      totalHeight: currentY,
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
    buffer.reset();
    let currentX = 0;
    let currentY = 0;
    const lineHeight = fontSize * 1.5;

    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        currentY += lineHeight;
        currentX = 0;
        continue;
      }

      const segments = this.getWordSegments(paragraph);

      for (const segment of segments) {
        const word = segment.segment;

        let wordWidth = 0;
        const graphemes = this.getGraphemes(word);

        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          wordWidth += glyphInfo
            ? glyphInfo.width * (fontSize / glyphInfo.baseSize)
            : fontSize * 0.5;
        }

        if (currentX + wordWidth > this.maxWidth && currentX > 0) {
          if (segment.isWordLike === false && word.trim().length === 0) {
            continue;
          }
          currentX = 0;
          currentY += lineHeight;
        }

        for (const char of graphemes) {
          if (buffer.count >= LayoutResultBuffer.CAPACITY) break;

          const glyphInfo = fontAtlas[char];
          const charWidth = glyphInfo
            ? glyphInfo.width * (fontSize / glyphInfo.baseSize)
            : fontSize * 0.5;

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

          if (currentX === 0 && char.trim().length === 0) {
            continue;
          }

          const idx = buffer.count;
          buffer.chars[idx] = char;
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
