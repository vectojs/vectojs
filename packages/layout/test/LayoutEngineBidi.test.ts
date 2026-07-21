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

  it('should reorder RTL text visually on the line', () => {
    const engine = new LayoutEngine(100, 100);
    // Hebrew Shin Lamed -> "\u05E9\u05DC" (RTL run).
    // In LTR context, the line contains just RTL, so it reverses Shin Lamed to Lamed Shin.
    const result = engine.layoutText('\u05E9\u05DC', mockFontAtlas, 32);

    expect(result.nodes.length).toBe(2);
    // Since it was reversed visually:
    // First node at index 0 should be Lamed (\u05DC), second Shin (\u05E9)
    expect(result.nodes[0].char).toBe('\u05DC');
    expect(result.nodes[0].x).toBe(0);
    expect(result.nodes[1].char).toBe('\u05E9');
    expect(result.nodes[1].x).toBe(20);
  });
});
