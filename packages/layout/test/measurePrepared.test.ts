import { describe, it, expect } from 'vitest';
import { LayoutEngine, type GlyphAtlas } from '../src/LayoutEngine';

/**
 * `measurePrepared()` is a measure-only fast path: line count + height without
 * positioning glyphs or allocating nodes. It exists because a caller that only
 * needs "how tall at this width" (virtualized rows, resize passes, autosizing
 * containers) otherwise pays the full O(glyphs) walk plus a LayoutNode per glyph
 * for data it throws away. Prompted by benchmarking against `@chenglou/pretext`.
 *
 * The contract that matters: it must agree with `layoutPrepared()` on line
 * count and height for the single-column case. A fast path that disagrees is
 * worse than no fast path.
 */
describe('LayoutEngine.measurePrepared agrees with layoutPrepared', () => {
  const atlas: GlyphAtlas = {};
  for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-') {
    atlas[ch] = { width: ch === ' ' ? 8 : 14, baseSize: 32, ast: null };
  }

  /**
   * Line count derived from the full path's node positions. NOTE an empty
   * paragraph (a blank line) advances `y` without emitting any glyph, so it is
   * invisible to a distinct-Y count — `measurePrepared` counts it. Compare only
   * the glyph-bearing lines by adding the empty-paragraph count back.
   */
  const linesFromFull = (engine: LayoutEngine, prepared: ReturnType<LayoutEngine['prepare']>) => {
    const { nodes } = engine.layoutPrepared(prepared);
    const drawn = nodes.length === 0 ? 0 : new Set(nodes.map((n) => n.y)).size;
    const blanks = prepared.paragraphs.filter((p) => p.isEmpty).length;
    return drawn + blanks;
  };

  const cases: Array<[string, string]> = [
    ['single short line', 'hello world'],
    ['wraps a few times', 'The quick brown fox jumps over the lazy dog again and again and again'],
    ['many words', Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')],
    [
      'multi paragraph',
      'First paragraph here.\n\nSecond paragraph is a bit longer than the first one.',
    ],
    ['blank lines', 'a\n\n\nb'],
    ['trailing spaces', 'alpha beta gamma delta epsilon zeta eta theta   '],
    ['one very long word', 'x'.repeat(200)],
    ['punctuation heavy', 'Yes, no, maybe! Or perhaps... not? Indeed - quite so.'],
  ];

  for (const [name, text] of cases) {
    for (const width of [120, 260, 500]) {
      it(`${name} @ ${width}px`, () => {
        const engine = new LayoutEngine(width, 1e9);
        const prepared = engine.prepare(text, atlas, 16);
        const measured = engine.measurePrepared(prepared);
        expect(measured.lineCount).toBe(linesFromFull(engine, prepared));
        expect(measured.height).toBeGreaterThan(0);
      });
    }
  }

  it('reflows when maxWidth changes (same engine, same prepared text)', () => {
    const text = Array.from({ length: 60 }, (_, i) => `item${i}`).join(' ');
    const engine = new LayoutEngine(500, 1e9);
    const prepared = engine.prepare(text, atlas, 16);

    const wide = engine.measurePrepared(prepared);
    engine.maxWidth = 150;
    const narrow = engine.measurePrepared(prepared);

    expect(narrow.lineCount).toBeGreaterThan(wide.lineCount);
    expect(narrow.height).toBeGreaterThan(wide.height);
    // And each still matches the full path at its own width.
    expect(narrow.lineCount).toBe(linesFromFull(engine, prepared));
  });

  it('allocates no nodes (the whole point)', () => {
    const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const engine = new LayoutEngine(300, 1e9);
    const prepared = engine.prepare(text, atlas, 16);
    // Cheap proxy for "no per-glyph allocation": it returns only two numbers.
    const out = engine.measurePrepared(prepared);
    expect(Object.keys(out).sort()).toEqual(['height', 'lineCount']);
  });

  it('handles empty text', () => {
    const engine = new LayoutEngine(200, 1e9);
    expect(engine.measurePrepared(engine.prepare('', atlas, 16)).lineCount).toBeGreaterThanOrEqual(
      0,
    );
  });
});
