export interface GlyphAtlas {
  [char: string]: {
    width: number;
    baseSize: number;
    ast: any;
  };
}

export interface LayoutNode {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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

  constructor(maxWidth: number, maxHeight: number) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;

    // Auto-detect browser locale for intelligent CJK and Western word boundaries
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    this.wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    this.charSegmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  }

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

      const segments = this.wordSegmenter.segment(paragraph);

      for (const segment of segments) {
        const word = segment.segment;

        let wordWidth = 0;
        const graphemes = Array.from(this.charSegmenter.segment(word)).map((g) => g.segment);

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
  chars: string[] = new Array(LayoutResultBuffer.CAPACITY);
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
