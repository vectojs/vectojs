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

  public layoutText(text: string, fontAtlas: GlyphAtlas, fontSize: number = 32): LayoutResult {
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

          // If a SINGLE word is wider than maxWidth, we MUST character-wrap it!
          if (currentX + charWidth > this.maxWidth && currentX > 0) {
            currentX = 0;
            currentY += lineHeight;
          }

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
