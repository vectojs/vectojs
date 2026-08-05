import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

/** The minimum shape {@link BidiResolver.reorderVisual} reads from a layout node:
 *  its `char` (to reconstruct the run string) and resolved `level`. The reorder
 *  is a stable in-place permutation, so callers keep their own richer node type. */
export interface BidiNode {
  char: string;
  level: number;
}

/** A resolved half-open visual rectangle span over a logical range, expressed as
 *  a contiguous run of VISUAL positions `[visualStart, visualEnd)`. A single
 *  logical selection range can map to several of these when it straddles a
 *  direction boundary (e.g. a logical range covering LTR digits inside RTL
 *  Arabic becomes two visually-separated rectangles). */
export interface VisualRun {
  visualStart: number;
  visualEnd: number;
}

// A static-only class is the published shape of this API — callers do
// `BidiResolver.getBaseLevel(...)`. Converting it to loose functions or a
// namespace would be a breaking change to @vectojs/text for no behavioural gain.
// oxlint-disable-next-line typescript/no-extraneous-class
export class BidiResolver {
  /** Base paragraph embedding level (0 = LTR, 1 = RTL) per UAX #9 P2/P3. */
  public static getBaseLevel(text: string): number {
    return bidi.getEmbeddingLevels(text).paragraphs[0]?.level ?? 0;
  }

  /** Per-character resolved embedding levels (UAX #9 X1–I2). */
  public static resolveLevels(text: string): Uint8Array {
    return bidi.getEmbeddingLevels(text).levels;
  }

  /**
   * Visual-order → logical-index permutation for `text` (UAX #9 L1+L2), i.e.
   * `indices[v]` is the logical index of the character drawn at visual column
   * `v`. This is bidi-js's authoritative reorder (complete L1 whitespace/
   * separator reset + L2 level reversals), replacing the previous hand-rolled
   * reversal whose L1 only reset a single trailing-whitespace run.
   *
   * This permutation is the source↔visual bridge selection needs: to highlight
   * a logical range you find where its indices land visually
   * (see {@link logicalToVisualRuns}); to hit-test a click you read
   * `indices[visualColumn]` back to a logical offset.
   */
  public static reorderIndices(text: string): number[] {
    if (text.length === 0) return [];
    const embed = bidi.getEmbeddingLevels(text);
    return bidi.getReorderedIndices(text, embed);
  }

  /**
   * Map a logical range `[start, end)` to the set of contiguous VISUAL runs it
   * occupies, merged and sorted left-to-right. For pure LTR/RTL text this is a
   * single run; across a direction boundary it splits into the visually
   * disjoint rectangles a correct bidi selection must paint.
   */
  public static logicalToVisualRuns(text: string, start: number, end: number): VisualRun[] {
    const indices = BidiResolver.reorderIndices(text);
    const runs: VisualRun[] = [];
    let runStart = -1;
    for (let v = 0; v <= indices.length; v++) {
      const inRange = v < indices.length && indices[v] >= start && indices[v] < end;
      if (inRange && runStart === -1) {
        runStart = v;
      } else if (!inRange && runStart !== -1) {
        runs.push({ visualStart: runStart, visualEnd: v });
        runStart = -1;
      }
    }
    return runs;
  }

  /**
   * Reorder `nodes` (a single contiguous line run) into VISUAL order in place,
   * per UAX #9 L1+L2. Uses bidi-js's `getReorderSegments` over the run's own
   * substring and reconstructed levels — the same authoritative algorithm as
   * {@link reorderIndices}, so a full-line reorder and a per-run reorder agree.
   * Kept as an in-place mutation for `LayoutEngine`'s run pipeline, which reads
   * back each node's new position after this returns.
   *
   * `baseLevel` is the paragraph base (0/1); it drives the L1 reset of trailing
   * whitespace and segment separators to the paragraph direction.
   */
  public static reorderVisual<T extends BidiNode>(nodes: T[], baseLevel: number): void {
    const len = nodes.length;
    if (len === 0) return;

    const str = nodes.map((n) => n.char).join('');
    const levels = Uint8Array.from(nodes, (n) => n.level & 0x7f);
    for (const [segStart, segEnd] of BidiResolver.reorderSegments(str, levels, baseLevel)) {
      let left = segStart;
      let right = segEnd;
      while (left < right) {
        const tmp = nodes[left];
        nodes[left] = nodes[right];
        nodes[right] = tmp;
        left++;
        right--;
      }
    }
  }

  /**
   * The UAX #9 L2 reversal segments for one visual line: each `[start, end]` is
   * an inclusive index range (over the run's own positions) that must be
   * reversed to turn logical order into visual order. Exposed separately from
   * {@link reorderVisual} so a caller holding parallel typed arrays (the zero-GC
   * layout buffer) can apply the same permutation in place without allocating a
   * node object per glyph.
   *
   * `levels` are the per-position resolved embedding levels; `baseLevel` is the
   * paragraph base (0 = LTR, 1 = RTL). String indices are UTF-16 code units and
   * the layout pipeline emits one entry per code point — every char here is BMP
   * (control/format aside), so index == position holds.
   */
  public static reorderSegments(
    str: string,
    levels: Uint8Array,
    baseLevel: number,
  ): Array<[number, number]> {
    const len = str.length;
    if (len === 0) return [];
    // bidi-js reorders against paragraph-shaped embedding data; synthesize it
    // from the run's own resolved levels + the paragraph base so L1 resets to
    // the correct direction.
    const embed = {
      levels,
      paragraphs: [{ start: 0, end: len - 1, level: baseLevel }],
    };
    return bidi.getReorderSegments(str, embed, 0, len - 1);
  }
}
