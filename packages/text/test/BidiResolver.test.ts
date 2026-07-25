import { describe, it, expect } from 'vitest';
import { BidiResolver } from '../src/BidiResolver';

describe('BidiResolver', () => {
  it('should detect base paragraph level and resolve directional levels', () => {
    // "hello" -> LTR, level 0
    const ltrLevels = BidiResolver.resolveLevels('hello');
    expect(ltrLevels[0]).toBe(0);

    // Hebrew: "שלوم" (0x05E9, 0x05DC, 0x05D5, 0x05DD) -> RTL, level 1
    const rtlLevels = BidiResolver.resolveLevels('\u05E9\u05DC\u05D5\u05DD');
    expect(rtlLevels[0]).toBe(1);
  });

  it('should reorder visual elements and reset trailing whitespace levels (L1)', () => {
    interface DummyNode {
      char: string;
      level: number;
    }
    // Mixed RTL line: "A B" where base level is 1
    // Visual order should reverse the RTL segment but keep trailing space aligned
    const nodes: DummyNode[] = [
      { char: '\u05E9', level: 1 },
      { char: ' ', level: 1 }, // WS
      { char: '\u05DC', level: 1 },
      { char: ' ', level: 1 }, // Trailing whitespace
    ];

    BidiResolver.reorderVisual(nodes, 1);

    // Level L1 reset trailing space to base level 1, reorder reverses elements:
    // Visual ordering from 1 to maxLevel (1):
    // Trailing whitespace level is reset to base level 1.
    // Nodes levels are: 1, 1, 1, 1 (all >= 1). So the whole line gets reversed:
    // index 0 -> index 3 (which is ' '), index 1 -> index 2 (which is '\u05DC'), index 2 -> index 1 (' '), index 3 -> index 0 ('\u05E9').
    expect(nodes[0].char).toBe(' ');
    expect(nodes[1].char).toBe('\u05DC');
    expect(nodes[2].char).toBe(' ');
    expect(nodes[3].char).toBe('\u05E9');
  });

  it('should handle dynamic nesting stack and overflow counter up to 125 levels', () => {
    // RLE = 0x202B, PDF = 0x202C
    // Construct a deeply nested string with 127 RLE control push characters and 127 PDF pop characters.
    let text = '';
    for (let i = 0; i < 127; i++) {
      text += '\u202B';
    }
    text += 'A';
    for (let i = 0; i < 127; i++) {
      text += '\u202C';
    }

    const levels = BidiResolver.resolveLevels(text);
    // Explicit embedding levels stop at 125, but UAX #9 implicit resolution
    // may raise an L character inside the deepest odd embedding to 126.
    expect(levels[127]).toBe(126);
  });

  describe('reorderIndices (source↔visual permutation)', () => {
    it('is identity for pure LTR', () => {
      expect(BidiResolver.reorderIndices('abcd')).toEqual([0, 1, 2, 3]);
    });

    it('fully reverses pure RTL', () => {
      // Hebrew "שלום" reads right-to-left, so visual col 0 is the LAST logical char.
      expect(BidiResolver.reorderIndices('\u05E9\u05DC\u05D5\u05DD')).toEqual([3, 2, 1, 0]);
    });

    it('keeps an embedded LTR run in reading order inside RTL', () => {
      // "שלום abc": RTL base; the Latin "abc" (logical 5,6,7) stays L-to-R but
      // sits at the visual LEFT, with the Hebrew reversed to its right.
      const idx = BidiResolver.reorderIndices('\u05E9\u05DC\u05D5\u05DD abc');
      expect(idx).toEqual([5, 6, 7, 4, 3, 2, 1, 0]);
    });

    it('returns [] for empty text', () => {
      expect(BidiResolver.reorderIndices('')).toEqual([]);
    });

    it('is a genuine permutation (every logical index appears once)', () => {
      const text = 'abc \u05E9\u05DC\u05D5 123 \u05DD\u05D8 xyz';
      const idx = BidiResolver.reorderIndices(text);
      expect(idx.length).toBe(text.length);
      expect([...idx].sort((a, b) => a - b)).toEqual(
        Array.from({ length: text.length }, (_, i) => i),
      );
    });
  });

  describe('logicalToVisualRuns (selection rectangle mapping)', () => {
    it('maps an LTR logical range to one contiguous visual run', () => {
      // Select "bc" (logical [1,3)) in "abcd" → visual [1,3).
      expect(BidiResolver.logicalToVisualRuns('abcd', 1, 3)).toEqual([
        { visualStart: 1, visualEnd: 3 },
      ]);
    });

    it('maps an RTL logical range to the mirrored visual run', () => {
      // "שלום": select logical [0,2) (first two Hebrew chars) → they sit at the
      // visual RIGHT, columns [2,4).
      expect(BidiResolver.logicalToVisualRuns('\u05E9\u05DC\u05D5\u05DD', 0, 2)).toEqual([
        { visualStart: 2, visualEnd: 4 },
      ]);
    });

    it('splits a range that straddles a direction boundary into disjoint runs', () => {
      // "שלום abc" (visual: a b c SP ם ו ל ש → indices [5,6,7,4,3,2,1,0]).
      // Select logical [3,6) = "ם"(3) + " "(4) + "a"(5): "ם"/space are at the
      // RTL side (visual 3,4 wait) — verify it's the union of the visual columns
      // holding logical 3,4,5, merged into contiguous runs.
      const runs = BidiResolver.logicalToVisualRuns('\u05E9\u05DC\u05D5\u05DD abc', 3, 6);
      // Reconstruct: which visual columns hold logical 3,4,5?
      const idx = BidiResolver.reorderIndices('\u05E9\u05DC\u05D5\u05DD abc');
      const cols = idx
        .map((l, v) => ({ l, v }))
        .filter(({ l }) => l >= 3 && l < 6)
        .map(({ v }) => v)
        .sort((a, b) => a - b);
      // The runs must cover exactly those columns.
      const covered: number[] = [];
      for (const r of runs) for (let v = r.visualStart; v < r.visualEnd; v++) covered.push(v);
      expect(covered.sort((a, b) => a - b)).toEqual(cols);
      // And this range genuinely straddles the boundary → more than one run.
      expect(runs.length).toBeGreaterThan(1);
    });

    it('returns no runs for an empty logical range', () => {
      expect(BidiResolver.logicalToVisualRuns('abcd', 2, 2)).toEqual([]);
    });
  });

  describe('reorderVisual matches reorderIndices (per-run == full-line)', () => {
    interface Node {
      char: string;
      level: number;
    }
    function nodesFor(text: string): { nodes: Node[]; base: number } {
      const levels = BidiResolver.resolveLevels(text);
      const base = BidiResolver.getBaseLevel(text);
      const nodes = [...text].map((char, i) => ({ char, level: levels[i] }));
      return { nodes, base };
    }

    for (const text of [
      'abcd',
      '\u05E9\u05DC\u05D5\u05DD',
      '\u05E9\u05DC\u05D5\u05DD abc',
      'abc \u05E9\u05DC\u05D5 xyz',
      '\u0645\u0631\u062D\u0628\u0627 42', // Arabic "marhaba 42"
    ]) {
      it(`in-place reorder of "${text}" equals the reorderIndices order`, () => {
        const { nodes, base } = nodesFor(text);
        BidiResolver.reorderVisual(nodes, base);
        const viaIndices = BidiResolver.reorderIndices(text).map((l) => [...text][l]);
        expect(nodes.map((n) => n.char)).toEqual(viaIndices);
      });
    }
  });
});
