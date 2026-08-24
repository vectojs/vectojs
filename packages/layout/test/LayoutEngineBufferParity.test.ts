import { describe, it, expect } from 'vitest';
import { LayoutEngine, GlyphAtlas, LayoutResultBuffer, TextRun } from '../src/LayoutEngine';

/**
 * The zero-GC buffer path (`layoutPreparedIntoBuffer`) must agree glyph-for-glyph
 * with the allocating path (`layoutPrepared`). It previously dropped two things:
 * BiDi visual reordering (RTL came out in logical order, left-aligned) and the
 * mixed-size shared baseline (every glyph got the paragraph fontSize as its
 * height, at the raw line top). These tests are differential: whatever
 * layoutPrepared produces is the reference.
 */
describe('LayoutEngine buffer path ↔ allocating path parity', () => {
  const atlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
    C: { width: 20, baseSize: 32, ast: null },
    ' ': { width: 10, baseSize: 32, ast: null },
    '\u05E9': { width: 20, baseSize: 32, ast: null }, // Hebrew Shin
    '\u05DC': { width: 20, baseSize: 32, ast: null }, // Hebrew Lamed
  };

  /** Assert the buffer matches the allocating result node-for-node. */
  function expectParity(engine: LayoutEngine, text: string, fontSize = 32): void {
    const nodes = engine.layoutText(text, atlas, fontSize).nodes;
    const buffer = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer(text, atlas, fontSize, buffer);

    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.chars[i]).toBe(nodes[i].char);
      expect(buffer.xs[i]).toBeCloseTo(nodes[i].x, 4);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y, 4);
      expect(buffer.ws[i]).toBeCloseTo(nodes[i].width, 4);
      expect(buffer.hs[i]).toBeCloseTo(nodes[i].height, 4);
    }
  }

  it('matches for plain LTR text', () => {
    expectParity(new LayoutEngine(100, 100), 'A B C');
  });

  it('matches for RTL text — visual reorder AND flush-right', () => {
    const engine = new LayoutEngine(100, 100);
    expectParity(engine, '\u05E9\u05DC');

    // Explicitly pin the expected RTL behavior in the buffer itself (mirrors
    // LayoutEngineBidi's assertions for the allocating path): Lamed is visually
    // first, Shin second, and the content ends flush at the wrap edge.
    const buffer = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer('\u05E9\u05DC', atlas, 32, buffer);
    expect(buffer.count).toBe(2);
    expect(buffer.chars[0]).toBe('\u05DC');
    expect(buffer.xs[0]).toBe(60);
    expect(buffer.chars[1]).toBe('\u05E9');
    expect(buffer.xs[1]).toBe(80);
    expect(buffer.xs[1] + buffer.ws[1]).toBe(100);
    // Levels are recorded so a consumer can tell direction per glyph.
    expect(buffer.levels[0] % 2).toBe(1);
  });

  it('matches for RTL with an unbounded width (no flush-right edge)', () => {
    expectParity(new LayoutEngine(1e9, 1e9), '\u05E9\u05DC');
  });

  it('matches for wrapped RTL across multiple lines', () => {
    expectParity(new LayoutEngine(50, 200), '\u05E9 \u05DC \u05E9');
  });

  it('matches for bidirectional (RTL base with an embedded LTR run)', () => {
    expectParity(new LayoutEngine(200, 200), '\u05E9\u05DC AB');
  });

  it('matches for LTR base with an embedded RTL run', () => {
    expectParity(new LayoutEngine(200, 200), 'AB \u05E9\u05DC');
  });

  it('matches for multi-paragraph text', () => {
    expectParity(new LayoutEngine(100, 300), 'A B\n\nC');
  });

  it('honors preserveLeadingSpaces like the allocating path (leading space kept)', () => {
    const engine = new LayoutEngine(100, 100);
    engine.preserveLeadingSpaces = true;
    // The allocating path keeps the leading space when the flag is set; the
    // zero-GC path skipped it unconditionally, so a consumer of the buffer
    // path lost glyphs the allocating path reports.
    const nodes = engine.layoutText(' A', atlas, 32).nodes;
    expect(nodes.map((n) => n.char)).toEqual([' ', 'A']);

    const buffer = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer(' A', atlas, 32, buffer);
    expect(buffer.count).toBe(2);
    expect(buffer.chars[0]).toBe(' ');
    expect(buffer.chars[1]).toBe('A');
    expect(buffer.xs[0]).toBeCloseTo(0);
    expect(buffer.xs[1]).toBeCloseTo(10);
  });

  it('keeps baselineShifts attached through the RTL reversal (prepareRich)', () => {
    const engine = new LayoutEngine(400, 200);
    // Two Hebrew runs with different shifts in one RTL paragraph: the L2
    // reversal swaps glyph slots, so each slot's y must be computed from the
    // shift of the glyph NOW occupying it (#668 had the shifts stay behind).
    const runs: TextRun[] = [
      { text: '\u05E9', style: { baselineShift: 4 } },
      { text: '\u05DC\u05E9', style: { baselineShift: -10 } },
    ];
    const prepared = engine.prepareRich(runs, atlas, 32);

    const nodes = engine.layoutPrepared(prepared).nodes;
    const buffer = new LayoutResultBuffer();
    engine.layoutPreparedIntoBuffer(prepared, buffer);

    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.chars[i]).toBe(nodes[i].char);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y, 4);
      expect(buffer.hs[i]).toBeCloseTo(nodes[i].height, 4);
    }
  });

  it('shares one baseline for mixed-size inline runs (prepareRich)', () => {
    const engine = new LayoutEngine(400, 200);
    const runs: TextRun[] = [{ text: 'A' }, { text: 'B', style: { fontSize: 64 } }, { text: 'C' }];
    const prepared = engine.prepareRich(runs, atlas, 32);

    const nodes = engine.layoutPrepared(prepared).nodes;
    const buffer = new LayoutResultBuffer();
    engine.layoutPreparedIntoBuffer(prepared, buffer);

    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.chars[i]).toBe(nodes[i].char);
      expect(buffer.xs[i]).toBeCloseTo(nodes[i].x, 4);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y, 4);
      expect(buffer.hs[i]).toBeCloseTo(nodes[i].height, 4);
    }
    // The tall run drives the line: smaller glyphs sit LOWER (larger y) so all
    // three share a baseline, and each glyph keeps its own size as height.
    const tall = buffer.hs.slice(0, buffer.count).indexOf(64);
    expect(tall).toBeGreaterThanOrEqual(0);
    expect(buffer.ys[tall]).toBeLessThan(buffer.ys[0]);
    expect(buffer.hs[0]).toBe(32);
  });
});
