declare module 'bidi-js' {
  interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }

  interface Bidi {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): EmbeddingLevels;
    /** Ranges `[start, end]` (inclusive) of characters to reverse for UAX #9 L2,
     *  ordered highest embedding level first, over `[start, end]` of `text`. */
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    /** Visual-order → logical-index permutation for `text` (UAX #9 L1+L2). */
    getReorderedIndices(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): number[];
  }

  export default function bidiFactory(): Bidi;
}
