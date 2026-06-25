import { describe, it, expect } from 'vitest';
import { LayoutEngine, GlyphAtlas, LayoutResultBuffer } from '../src/layout/LayoutEngine';

describe('LayoutEngine', () => {
  const mockFontAtlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
    C: { width: 20, baseSize: 32, ast: null },
    ' ': { width: 10, baseSize: 32, ast: null },
    你: { width: 32, baseSize: 32, ast: null },
    好: { width: 32, baseSize: 32, ast: null },
  };

  it('should layout text within max width', () => {
    const engine = new LayoutEngine(50, 100);
    // 'A B C' -> A(20) + ' '(10) + B(20) = 50. C should wrap.
    const result = engine.layoutText('A B C', mockFontAtlas, 32);

    expect(result.nodes.length).toBe(4); // A, ' ', B, C (' ' before C is stripped at start of line)

    const nodeA = result.nodes[0];
    expect(nodeA.char).toBe('A');
    expect(nodeA.x).toBe(0);
    expect(nodeA.y).toBe(0);

    const nodeB = result.nodes[2];
    expect(nodeB.char).toBe('B');
    expect(nodeB.x).toBe(30); // 20 + 10
    expect(nodeB.y).toBe(0);

    const nodeC = result.nodes[3]; // It's index 3 now!
    expect(nodeC.char).toBe('C');
    expect(nodeC.x).toBe(0); // Wrapped to next line
    expect(nodeC.y).toBe(48); // 32 * 1.5
  });

  it('should respect hard newlines', () => {
    const engine = new LayoutEngine(100, 200);
    const result = engine.layoutText('A\nB', mockFontAtlas, 32);

    const nodeA = result.nodes[0];
    const nodeB = result.nodes[1]; // Wait, split('\n') might discard \n

    expect(nodeA.char).toBe('A');
    expect(nodeA.y).toBe(0);
    expect(nodeB.char).toBe('B');
    expect(nodeB.y).toBe(48); // Next line
  });

  it('should skip layout in exclusion masks', () => {
    const engine = new LayoutEngine(100, 200);

    // Mask out the region x=[20, 50], so 'B' should be pushed
    const mask = (x: number, y: number, w: number, h: number) => {
      // If any part of the character overlaps [20, 50]
      return x < 50 && x + w > 20 && y === 0;
    };

    const result = engine.layoutText('ABC', mockFontAtlas, 32, mask);

    const nodeA = result.nodes[0]; // A at x=0
    const nodeB = result.nodes[1]; // B needs x=20, overlaps mask! should be pushed to x=50
    const nodeC = result.nodes[2]; // C at x=70

    expect(nodeA.char).toBe('A');
    expect(nodeA.x).toBe(0);

    expect(nodeB.char).toBe('B');
    expect(nodeB.x).toBe(60); // It skips by charWidth (20) until it clears the mask. 20 -> mask -> 40 -> mask -> 60 -> clear!

    expect(nodeC.char).toBe('C');
    expect(nodeC.x).toBe(80);
  });

  it('should handle empty string without crashing', () => {
    const engine = new LayoutEngine(200, 200);
    const result = engine.layoutText('', mockFontAtlas, 32);
    expect(result.nodes.length).toBe(0);
  });

  it('should advance CJK characters correctly', () => {
    const engine = new LayoutEngine(200, 200);
    const cjkAtlas: GlyphAtlas = {
      你: { width: 32, baseSize: 32, ast: null },
      好: { width: 32, baseSize: 32, ast: null },
    };
    const result = engine.layoutText('你好', cjkAtlas, 32);
    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].char).toBe('你');
    expect(result.nodes[0].x).toBe(0);
    expect(result.nodes[1].char).toBe('好');
    expect(result.nodes[1].x).toBe(32); // advances by glyph width
  });

  it('should layout text into buffer correctly', () => {
    const engine = new LayoutEngine(100, 200);
    const buffer = new LayoutResultBuffer();

    engine.layoutTextIntoBuffer('A B', mockFontAtlas, 32, buffer);
    expect(buffer.count).toBe(3); // 'A', ' ', 'B'
    expect(buffer.chars[0]).toBe('A');
    expect(buffer.xs[0]).toBe(0);
    expect(buffer.chars[1]).toBe(' ');
    expect(buffer.xs[1]).toBe(20);
    expect(buffer.chars[2]).toBe('B');
    expect(buffer.xs[2]).toBe(30);
  });
});
