import { describe, it, expect, vi } from 'vitest';
import {
  LayoutEngine,
  GlyphAtlas,
  LayoutResultBuffer,
  type GlyphMeasurer,
} from '../src/layout/LayoutEngine';

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
    const mask = (x: number, y: number, w: number, _h: number) => {
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

  it('totalWidth reflects the longest line, not maxWidth', () => {
    const engine = new LayoutEngine(500, 200);
    // 'A B' fits on one line: A(20) + ' '(10) + B(20) = 50, well under maxWidth 500.
    const result = engine.layoutText('A B', mockFontAtlas, 32);
    expect(result.totalWidth).toBe(50);
  });

  it('totalWidth is the max across multiple lines', () => {
    const engine = new LayoutEngine(200, 200);
    // 'AB\nA': line1 'AB' = 40, line2 'A' = 20 -> longest line is 40 (< maxWidth 200,
    // so a buggy `return maxWidth` would give 200, not 40).
    const result = engine.layoutText('AB\nA', mockFontAtlas, 32);
    expect(result.totalWidth).toBe(40);
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

  it('preserves astral emoji as complete grapheme nodes', () => {
    const measured: string[] = [];
    const engine = new LayoutEngine(200, 200, {
      measure(char, fontSize) {
        measured.push(char);
        return fontSize;
      },
    });

    const result = engine.layoutText('A😁B', {}, 16);

    expect(result.nodes.map((node) => node.char)).toEqual(['A', '😁', 'B']);
    expect(measured).toContain('😁');
    expect(measured).not.toContain('\ud83d');
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

  it('preserves astral emoji in the zero-GC buffer path', () => {
    const engine = new LayoutEngine(200, 200);
    const buffer = new LayoutResultBuffer();

    engine.layoutTextIntoBuffer('A😁B', {}, 16, buffer);

    expect(buffer.count).toBe(3);
    expect(buffer.chars.slice(0, buffer.count)).toEqual(['A', '😁', 'B']);
  });
});

describe('LayoutEngine — real font metrics via measurer', () => {
  // A measurer that advances 0.8em per glyph — distinguishable from both the
  // atlas and the 0.5em hard fallback.
  const measurer: GlyphMeasurer = { measure: (_char, fontSize) => fontSize * 0.8 };

  it('uses the injected measurer for glyphs missing from the atlas (not the 0.5em fallback)', () => {
    const engine = new LayoutEngine(1000, 1000, measurer);
    const result = engine.layoutText('AB', {}, 10); // empty atlas
    expect(result.nodes[0].width).toBeCloseTo(8); // 10 * 0.8, not 5
    expect(result.nodes[1].x).toBeCloseTo(8); // B advanced past A's measured width
  });

  it('falls back to 0.5em only when neither atlas nor measurer has the glyph', () => {
    const engine = new LayoutEngine(1000, 1000); // no measurer
    const result = engine.layoutText('A', {}, 10);
    expect(result.nodes[0].width).toBeCloseTo(5); // 10 * 0.5
  });

  it('prefers the atlas over the measurer when both can resolve the glyph', () => {
    const atlas: GlyphAtlas = { A: { width: 4, baseSize: 10, ast: null } };
    const engine = new LayoutEngine(1000, 1000, measurer);
    const result = engine.layoutText('A', atlas, 10);
    expect(result.nodes[0].width).toBeCloseTo(4); // atlas exact, not measurer's 8
  });

  it('applies the measurer in layoutTextIntoBuffer too', () => {
    const engine = new LayoutEngine(1000, 1000, measurer);
    const buffer = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer('AB', {}, 10, buffer);
    expect(buffer.ws[0]).toBeCloseTo(8);
    expect(buffer.xs[1]).toBeCloseTo(8);
  });
});

describe('LayoutEngine — cold/hot split (prepare / layoutPrepared)', () => {
  const atlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
    C: { width: 20, baseSize: 32, ast: null },
    ' ': { width: 10, baseSize: 32, ast: null },
  };

  it('layoutPrepared matches layoutText exactly (wrapping)', () => {
    const engine = new LayoutEngine(50, 100);
    const direct = engine.layoutText('A B C', atlas, 32);
    const viaPrepared = engine.layoutPrepared(engine.prepare('A B C', atlas, 32));
    expect(viaPrepared).toEqual(direct);
  });

  it('layoutPrepared matches layoutText for newlines and CJK', () => {
    const engine = new LayoutEngine(100, 200);
    expect(engine.layoutPrepared(engine.prepare('A\nB', atlas, 32))).toEqual(
      engine.layoutText('A\nB', atlas, 32),
    );
    const cjk: GlyphAtlas = {
      你: { width: 32, baseSize: 32, ast: null },
      好: { width: 32, baseSize: 32, ast: null },
    };
    expect(engine.layoutPrepared(engine.prepare('你好', cjk, 32))).toEqual(
      engine.layoutText('你好', cjk, 32),
    );
  });

  it('preserves astral emoji in rich text prepared runs', () => {
    const engine = new LayoutEngine(200, 200);
    const prepared = engine.prepareRich([{ text: 'Hi 😁', style: { color: '#22d3ee' } }], {}, 16);
    const result = engine.layoutPrepared(prepared);

    expect(result.nodes.map((node) => node.char).join('')).toBe('Hi 😁');
  });

  it('the hot path does NOT re-segment or re-measure', () => {
    let measureCalls = 0;
    const counting: GlyphMeasurer = {
      measure: (_c, fs) => {
        measureCalls++;
        return fs * 0.5;
      },
    };
    const engine = new LayoutEngine(1000, 1000, counting);
    const segSpy = vi.spyOn(Intl.Segmenter.prototype, 'segment');

    const prepared = engine.prepare('hello world', {}, 10);
    const measuredInPrepare = measureCalls;
    const segInPrepare = segSpy.mock.calls.length;
    expect(measuredInPrepare).toBeGreaterThan(0); // cold pass does the work
    expect(segInPrepare).toBeGreaterThan(0);

    engine.layoutPrepared(prepared);
    engine.layoutPrepared(prepared);
    expect(measureCalls).toBe(measuredInPrepare); // hot pass adds zero measurement
    expect(segSpy.mock.calls.length).toBe(segInPrepare); // and zero segmentation
    segSpy.mockRestore();
  });

  it('reflows prepared text at a new width without re-measuring', () => {
    let measureCalls = 0;
    const m: GlyphMeasurer = {
      measure: () => {
        measureCalls++;
        return 20;
      },
    };
    const engine = new LayoutEngine(1000, 1000, m);
    const prepared = engine.prepare('A B C', {}, 32);
    const wide = engine.layoutPrepared(prepared);
    const afterPrepare = measureCalls;
    expect(Math.max(...wide.nodes.map((n) => n.y))).toBe(0); // one line

    engine.maxWidth = 50; // narrow → must wrap, reusing the SAME prepared data
    const narrow = engine.layoutPrepared(prepared);
    expect(Math.max(...narrow.nodes.map((n) => n.y))).toBeGreaterThan(0); // wrapped
    expect(measureCalls).toBe(afterPrepare); // no re-measurement on reflow
  });

  it('layoutPreparedIntoBuffer matches layoutTextIntoBuffer', () => {
    const engine = new LayoutEngine(100, 200);
    const b1 = new LayoutResultBuffer();
    const b2 = new LayoutResultBuffer();
    engine.layoutTextIntoBuffer('A B', atlas, 32, b1);
    engine.layoutPreparedIntoBuffer(engine.prepare('A B', atlas, 32), b2);
    expect(b2.count).toBe(b1.count);
    for (let i = 0; i < b1.count; i++) {
      expect(b2.chars[i]).toBe(b1.chars[i]);
      expect(b2.xs[i]).toBe(b1.xs[i]);
      expect(b2.ys[i]).toBe(b1.ys[i]);
    }
  });
});

describe('LayoutEngine.prepare — paragraph memoization (streaming/incremental)', () => {
  const atlas: GlyphAtlas = {
    A: { width: 20, baseSize: 32, ast: null },
    B: { width: 20, baseSize: 32, ast: null },
    C: { width: 20, baseSize: 32, ast: null },
  };

  it('reuses unchanged paragraphs and only rebuilds the changed one', () => {
    const engine = new LayoutEngine(1000, 1000);
    const p1 = engine.prepare('AB\nCA', atlas, 32);
    const p2 = engine.prepare('AB\nCAB', atlas, 32); // only the 2nd paragraph changed

    expect(p2.paragraphs[0]).toBe(p1.paragraphs[0]); // unchanged → same object reused
    expect(p2.paragraphs[1]).not.toBe(p1.paragraphs[1]); // changed → rebuilt
  });

  it('keys the cache on fontSize (different size → fresh, scaled widths)', () => {
    const engine = new LayoutEngine(1000, 1000);
    const a = engine.prepare('AB', atlas, 32).paragraphs[0];
    const b = engine.prepare('AB', atlas, 16).paragraphs[0];

    expect(b).not.toBe(a);
    expect(b.words[0].glyphs[0].width).toBeCloseTo(10); // 20 * (16/32)
  });

  it('invalidates the cache when the font atlas changes', () => {
    const engine = new LayoutEngine(1000, 1000);
    const a = engine.prepare('A', { A: { width: 20, baseSize: 32, ast: null } }, 32).paragraphs[0];
    const b = engine.prepare('A', { A: { width: 40, baseSize: 32, ast: null } }, 32).paragraphs[0];

    expect(b).not.toBe(a);
    expect(b.words[0].glyphs[0].width).toBeCloseTo(40);
  });
});

describe('LayoutEngine justification', () => {
  const atlas: GlyphAtlas = {
    a: { width: 10, baseSize: 32, ast: null },
    b: { width: 10, baseSize: 32, ast: null },
    c: { width: 10, baseSize: 32, ast: null },
    d: { width: 10, baseSize: 32, ast: null },
    ' ': { width: 10, baseSize: 32, ast: null },
    你: { width: 20, baseSize: 32, ast: null },
    好: { width: 20, baseSize: 32, ast: null },
    世: { width: 20, baseSize: 32, ast: null },
    界: { width: 20, baseSize: 32, ast: null },
    了: { width: 20, baseSize: 32, ast: null },
  };

  it('stretches spaces so wrapped lines end flush at maxWidth', () => {
    const engine = new LayoutEngine(100, 400);
    engine.textAlign = 'justify';
    // "aa bb cc dd": line 1 fits "aa bb cc" (80px), "dd" wraps.
    const result = engine.layoutText('aa bb cc dd', atlas, 32);

    const line1 = result.nodes.filter((n) => n.y === 0 && n.char.trim() !== '');
    const lastGlyph = line1[line1.length - 1];
    expect(lastGlyph.char).toBe('c');
    // Slack 20px over 2 spaces → line ends flush at 100.
    expect(lastGlyph.x + lastGlyph.width).toBeCloseTo(100, 5);

    // The last line of the paragraph stays ragged-left.
    const line2 = result.nodes.filter((n) => n.y > 0);
    expect(line2[0].char).toBe('d');
    expect(line2[0].x).toBe(0);
  });

  it('distributes inter-character slack for CJK lines without spaces', () => {
    const engine = new LayoutEngine(90, 400);
    engine.textAlign = 'justify';
    // 5 glyphs × 20px; 4 fit per line (80px), the 5th wraps.
    const result = engine.layoutText('你好世界了', atlas, 32);

    const line1 = result.nodes.filter((n) => n.y === 0);
    expect(line1).toHaveLength(4);
    const last = line1[line1.length - 1];
    expect(last.x + last.width).toBeCloseTo(90, 5); // flush right edge
    // Even spacing: gaps of 10/3 px between glyphs.
    expect(line1[1].x).toBeCloseTo(20 + 10 / 3, 5);
  });

  it('defaults to left alignment (byte-identical layout)', () => {
    const left = new LayoutEngine(100, 400);
    const result = left.layoutText('aa bb cc dd', atlas, 32);
    const line1 = result.nodes.filter((n) => n.y === 0 && n.char.trim() !== '');
    const last = line1[line1.length - 1];
    expect(last.x + last.width).toBeCloseTo(80, 5); // ragged
  });
});

describe('LayoutEngine hyphenation', () => {
  const atlas: GlyphAtlas = {
    h: { width: 10, baseSize: 32, ast: null },
    y: { width: 10, baseSize: 32, ast: null },
    p: { width: 10, baseSize: 32, ast: null },
    e: { width: 10, baseSize: 32, ast: null },
    n: { width: 10, baseSize: 32, ast: null },
    a: { width: 10, baseSize: 32, ast: null },
    t: { width: 10, baseSize: 32, ast: null },
    i: { width: 10, baseSize: 32, ast: null },
    o: { width: 10, baseSize: 32, ast: null },
    '-': { width: 6, baseSize: 32, ast: null },
    '\u00ad': { width: 0, baseSize: 32, ast: null },
  };

  it('breaks at soft hyphens (U+00AD) and renders a visible hyphen at the break', () => {
    const engine = new LayoutEngine(66, 400);
    // "hyphen\u00adation": prefix "hyphen" = 60px + hyphen 6px = 66 fits exactly.
    const result = engine.layoutText('hyphen\u00adation', atlas, 32);

    const line1 = result.nodes.filter((n) => n.y === 0);
    expect(line1.map((n) => n.char).join('')).toBe('hyphen-');
    const line2 = result.nodes.filter((n) => n.y > 0);
    expect(line2.map((n) => n.char).join('')).toBe('ation');
    expect(line2[0].x).toBe(0);
  });

  it('unused soft hyphens are invisible (no width, no glyph)', () => {
    const engine = new LayoutEngine(400, 400);
    const result = engine.layoutText('hyphen\u00adation', atlas, 32);
    expect(result.nodes.map((n) => n.char).join('')).toBe('hyphenation');
    expect(result.totalWidth).toBe(110); // 11 letters × 10px, no hyphen width
  });

  it('a pluggable hyphenator provides break opportunities for plain words', () => {
    const engine = new LayoutEngine(66, 400);
    engine.hyphenate = (word) => (word === 'hyphenation' ? ['hyphen', 'ation'] : [word]);
    const result = engine.layoutText('hyphenation', atlas, 32);

    const line1 = result.nodes.filter((n) => n.y === 0);
    expect(line1.map((n) => n.char).join('')).toBe('hyphen-');
    const line2 = result.nodes.filter((n) => n.y > 0);
    expect(line2.map((n) => n.char).join('')).toBe('ation');
  });
});
