import { describe, it, expect } from 'vitest';
import { BidiResolver } from '../src/text/BidiResolver';

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
    // At A (index 127), level should be clamped to 125 (max nesting)
    expect(levels[127]).toBe(125);
  });
});
