/**
 * VectoUI Layout Engine
 * Calculates the X, Y coordinates and Bounding Boxes for UI components and Text.
 * This is the pure math substitute for the Browser's DOM Reflow engine.
 */
export class LayoutEngine {
  constructor(maxWidth, maxHeight) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    // Intl.Segmenter is used to split text accurately without breaking emojis or graphemes.
    this.segmenter = new Intl.Segmenter(navigator.language, { granularity: 'word' });
  }

  /**
   * Performs an auto-wrap layout for a string of text based on a Glyph Atlas.
   * @param {string} text - The input text string to render.
   * @param {Object} fontAtlas - A dictionary mapping characters to their vector BoundingBox.
   * @param {number} fontSize - Desired size scaler.
   * @returns {Array} List of layout nodes with { char, x, y } coordinates.
   */
  layoutText(text, fontAtlas, fontSize = 32) {
    const layoutNodes = [];
    let currentX = 0;
    let currentY = 0;
    const lineHeight = fontSize * 1.5;

    // Use Intl.Segmenter to handle multi-language wrapping natively
    const segments = this.segmenter.segment(text);

    for (const segment of segments) {
      const word = segment.segment;
      let wordWidth = 0;

      // 1. Measure the width of the entire word first
      for (const char of word) {
        const glyphInfo = fontAtlas[char];
        if (glyphInfo) {
          wordWidth += glyphInfo.width * (fontSize / glyphInfo.baseSize);
        } else {
          // Fallback width for space or missing glyphs
          wordWidth += fontSize * 0.5;
        }
      }

      // 2. Check for Line Wrap (if the word exceeds maxWidth)
      if (currentX + wordWidth > this.maxWidth && currentX > 0) {
        currentX = 0;
        currentY += lineHeight;
      }

      // 3. Layout each character in the word
      for (const char of word) {
        const glyphInfo = fontAtlas[char];
        const charWidth = glyphInfo
          ? glyphInfo.width * (fontSize / glyphInfo.baseSize)
          : fontSize * 0.5;

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

    return {
      nodes: layoutNodes,
      totalWidth: this.maxWidth,
      totalHeight: currentY + lineHeight,
    };
  }
}
