import { describe, it, expect } from 'vitest';
import { LayoutEngine, type GlyphMeasurer, type StyledSpan } from '../src/layout/LayoutEngine';

// Width ∝ fontSize so size differences are observable; every char is 0.5em wide.
const measurer: GlyphMeasurer = { measure: (_char, fontSize) => fontSize * 0.5 };
const EMPTY_ATLAS = {};

function engine(maxWidth = 1000, maxHeight = 1000): LayoutEngine {
  return new LayoutEngine(maxWidth, maxHeight, measurer);
}

describe('prepareRich — inline styled runs', () => {
  it('a single unstyled span matches the plain prepare() structure', () => {
    const e = engine();
    const plain = e.prepare('hello world', EMPTY_ATLAS, 20);
    const rich = e.prepareRich([{ text: 'hello world' }], EMPTY_ATLAS, 20);
    expect(rich.paragraphs.length).toBe(plain.paragraphs.length);
    expect(rich.paragraphs[0].words.map((w) => w.glyphs.map((g) => g.char).join(''))).toEqual(
      plain.paragraphs[0].words.map((w) => w.glyphs.map((g) => g.char).join('')),
    );
  });

  it('attaches each run’s style to its glyphs', () => {
    const e = engine();
    const rich = e.prepareRich(
      [
        { text: 'red ', style: { color: '#f00' } },
        { text: 'bold', style: { bold: true, color: '#00f' } },
      ],
      EMPTY_ATLAS,
      20,
    );
    const glyphs = rich.paragraphs[0].words.flatMap((w) => w.glyphs);
    const r = glyphs.find((g) => g.char === 'r')!;
    const b = glyphs.find((g) => g.char === 'b')!;
    expect(r.style?.color).toBe('#f00');
    expect(b.style?.bold).toBe(true);
    expect(b.style?.color).toBe('#00f');
  });

  it('supports a style change in the middle of a word (He + llo bold)', () => {
    const e = engine();
    const rich = e.prepareRich(
      [{ text: 'He' }, { text: 'llo', style: { bold: true } }],
      EMPTY_ATLAS,
      20,
    );
    const glyphs = rich.paragraphs[0].words.flatMap((w) => w.glyphs);
    expect(glyphs.map((g) => g.char).join('')).toBe('Hello');
    expect(glyphs[0].style?.bold).toBeFalsy(); // H
    expect(glyphs[1].style?.bold).toBeFalsy(); // e
    expect(glyphs[2].style?.bold).toBe(true); // l
    expect(glyphs[4].style?.bold).toBe(true); // o
  });

  it('measures each run at its own fontSize (bigger run ⇒ wider glyphs)', () => {
    const e = engine();
    const rich = e.prepareRich(
      [{ text: 'a' }, { text: 'b', style: { fontSize: 40 } }],
      EMPTY_ATLAS,
      20,
    );
    const glyphs = rich.paragraphs[0].words.flatMap((w) => w.glyphs);
    const a = glyphs.find((g) => g.char === 'a')!;
    const b = glyphs.find((g) => g.char === 'b')!;
    expect(a.width).toBeCloseTo(10); // 20 * 0.5
    expect(b.width).toBeCloseTo(20); // 40 * 0.5
  });

  it('splits on newlines inside a span', () => {
    const e = engine();
    const rich = e.prepareRich([{ text: 'a\nb', style: { color: '#0f0' } }], EMPTY_ATLAS, 20);
    expect(rich.paragraphs.length).toBe(2);
    expect(rich.paragraphs[0].words.flatMap((w) => w.glyphs)[0].style?.color).toBe('#0f0');
  });
});

describe('layoutPrepared — styled output', () => {
  it('propagates glyph style onto the positioned nodes', () => {
    const e = engine();
    const result = e.layoutPrepared(
      e.prepareRich([{ text: 'hi', style: { color: '#abc' } }], EMPTY_ATLAS, 20),
    );
    expect(result.nodes.length).toBe(2);
    expect(result.nodes.every((n) => n.style?.color === '#abc')).toBe(true);
  });

  it('baseline-aligns mixed sizes on a line (smaller glyph dropped to the baseline)', () => {
    const e = engine();
    const result = e.layoutPrepared(
      e.prepareRich(
        [
          { text: 'A', style: { fontSize: 40 } },
          { text: 'b', style: { fontSize: 20 } },
        ],
        EMPTY_ATLAS,
        20,
      ),
    );
    const A = result.nodes.find((n) => n.char === 'A')!;
    const b = result.nodes.find((n) => n.char === 'b')!;
    // Line max size = 40 → A sits at the top (y=0); b is dropped by (40-20)=20.
    expect(A.y).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(20);
    expect(A.height).toBeCloseTo(40);
    expect(b.height).toBeCloseTo(20);
  });

  it('leaves the plain (unstyled) layout byte-for-byte unchanged', () => {
    const e = engine();
    const plain = e.layoutText('hello world', EMPTY_ATLAS, 20);
    expect(plain.nodes[0].y).toBeCloseTo(0);
    expect(plain.nodes[0].style).toBeUndefined();
    expect(plain.nodes[0].height).toBeCloseTo(20);
  });
});
