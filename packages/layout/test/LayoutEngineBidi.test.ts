import { describe, it, expect } from 'vitest';
import { LayoutEngine, GlyphAtlas } from '../src/LayoutEngine';

describe('LayoutEngine BiDi Integration', () => {
  const mockFontAtlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
    ' ': { width: 10, baseSize: 32, ast: null },
    '\u05E9': { width: 20, baseSize: 32, ast: null }, // Hebrew Shin
    '\u05DC': { width: 20, baseSize: 32, ast: null }, // Hebrew Lamed
  };

  it('should shape Arabic text in prepare pass and reorder layout in hot pass', () => {
    const engine = new LayoutEngine(1000, 1000);
    // Standard LTR Arabic "كتب" (K-T-B) -> \u0643\u062A\u0628
    const prepared = engine.prepare('\u0643\u062A\u0628', 32, mockFontAtlas);

    // Check that contextual shaping has modified the glyph characters in Cold Pass:
    // Kaf initial is \uFEDB
    expect(prepared.paragraphs[0].words[0].glyphs[0].char).toBe('\uFEDB');

    // Run layoutPrepared (Hot Pass). Since mockFontAtlas has no Arabic shaped forms,
    // it will resolve fallbackToCanvas = true.
    const result = engine.layoutPrepared(prepared);
    expect(result.fallbackToCanvas).toBe(true);
  });

  it('should reorder RTL text visually AND sit flush-right on the line', () => {
    const engine = new LayoutEngine(100, 100);
    // Hebrew Shin Lamed -> "\u05E9\u05DC" (RTL run, base level 1).
    // Visual reorder reverses Shin Lamed to Lamed Shin, AND the whole line is
    // right-aligned: 2 glyphs × 20 = 40 wide, wrap width 100 → shift right 60.
    const result = engine.layoutText('\u05E9\u05DC', mockFontAtlas, 32);

    expect(result.nodes.length).toBe(2);
    // Lamed first (visual left), Shin second (visual right), both shifted right.
    expect(result.nodes[0].char).toBe('\u05DC');
    expect(result.nodes[0].x).toBe(60);
    expect(result.nodes[1].char).toBe('\u05E9');
    expect(result.nodes[1].x).toBe(80);
    // Content ends flush at the wrap edge.
    expect(result.nodes[1].x + result.nodes[1].width).toBe(100);
  });

  it('keeps LTR text left-aligned (no RTL shift)', () => {
    const engine = new LayoutEngine(100, 100);
    const result = engine.layoutText('AB', mockFontAtlas, 32);
    expect(result.nodes[0].char).toBe('A');
    expect(result.nodes[0].x).toBe(0); // LTR unchanged: starts at left origin
    expect(result.nodes[1].x).toBe(20);
  });

  it('does not right-shift RTL when width is unbounded (no edge to align to)', () => {
    const engine = new LayoutEngine(1e9, 1e9); // Text without an explicit maxWidth
    const result = engine.layoutText('\u05E9\u05DC', mockFontAtlas, 32);
    // No finite wrap width → nothing to flush against; stays at the origin.
    expect(result.nodes[0].x).toBe(0);
    expect(result.nodes[1].x).toBe(20);
  });

  it('right-aligns each wrapped RTL line independently', () => {
    // Width fits two glyphs (40) plus a space (10) = 50 per line; three RTL
    // words of one glyph each, space-separated, wrap across lines and each
    // visual line must end flush at the right edge.
    const engine = new LayoutEngine(50, 200);
    const result = engine.layoutText('\u05E9 \u05DC \u05E9', mockFontAtlas, 32);
    // Group by y (line), assert each line's rightmost glyph ends at ~50.
    const byY = new Map<number, { x: number; width: number }[]>();
    for (const n of result.nodes) {
      if (n.char.trim() === '') continue;
      const arr = byY.get(n.y) ?? [];
      arr.push({ x: n.x, width: n.width });
      byY.set(n.y, arr);
    }
    expect(byY.size).toBeGreaterThan(1); // actually wrapped
    for (const glyphs of byY.values()) {
      const right = Math.max(...glyphs.map((g) => g.x + g.width));
      expect(right).toBeCloseTo(50, 0);
    }
  });
});
