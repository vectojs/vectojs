import { describe, it, expect } from 'vitest';
import {
  LayoutEngine,
  isComplexScript,
  type GlyphMeasurer,
  type StyledSpan,
  type PreparedText,
} from '../src/LayoutEngine';

// Width ∝ fontSize (0.5em/char) so widths are deterministic and comparable.
const measurer: GlyphMeasurer = { measure: (_char, fontSize) => fontSize * 0.5 };
const EMPTY_ATLAS = {};
const engine = () => new LayoutEngine(1000, 1000, measurer);

/** Flatten a prepared paragraph's glyphs for cheap structural comparison. */
function glyphDump(p: PreparedText) {
  return p.paragraphs.map((para) => ({
    isEmpty: para.isEmpty,
    baseLevel: para.baseLevel,
    fallbackToCanvas: para.fallbackToCanvas,
    words: para.words.map((w) => ({
      width: w.width,
      isWordLike: w.isWordLike,
      isWhitespace: w.isWhitespace,
      breakPoints: w.breakPoints,
      glyphs: w.glyphs.map((g) => ({
        char: g.char,
        width: g.width,
        level: g.level,
        sourceIndex: g.sourceIndex,
        sourceLength: g.sourceLength,
        color: g.style?.color,
        bold: g.style?.bold,
        fontSize: g.style?.fontSize,
      })),
    })),
  }));
}

/** A fresh engine that only ever shapes one exact text — the full-path oracle. */
function shapeCold(spans: StyledSpan[], fontSize = 20): PreparedText {
  return engine().prepareRich(spans, EMPTY_ATLAS, fontSize);
}

describe('isComplexScript gate', () => {
  it('treats ASCII / Latin / Cyrillic / Greek / CJK / punctuation as simple', () => {
    for (const s of [
      'hello world',
      'Ćma źdźbło',
      'Привет',
      'Ελληνικά',
      '日本語のテキスト',
      'a, b; c!',
    ]) {
      expect(isComplexScript(s)).toBe(false);
    }
  });

  it('flags RTL / Arabic / combining / ZWJ-emoji / bidi controls as complex', () => {
    expect(isComplexScript('مرحبا')).toBe(true); // Arabic
    expect(isComplexScript('שלום')).toBe(true); // Hebrew
    expect(isComplexScript('é')).toBe(true); // combining acute
    expect(isComplexScript('👍\u{1F3FF}')).toBe(true); // emoji + skin tone modifier
    expect(isComplexScript('a‍b')).toBe(true); // ZWJ
    expect(isComplexScript('a‮b')).toBe(true); // RTL override
    expect(isComplexScript('देवनागरी')).toBe(true); // Devanagari
  });
});

describe('prepareRich — incremental streaming fast path', () => {
  it('a growing simple paragraph matches a from-scratch shape at every step', () => {
    const e = engine();
    const full = 'The quick brown fox jumps over the lazy streaming dog again';
    // Feed it one char at a time, comparing each incremental result against a
    // cold from-scratch shape of the same prefix.
    for (let n = 1; n <= full.length; n++) {
      const text = full.slice(0, n);
      const incremental = e.prepareRich([{ text }], EMPTY_ATLAS, 20);
      const cold = shapeCold([{ text }], 20);
      expect(glyphDump(incremental)).toEqual(glyphDump(cold));
    }
  });

  it('a growing styled paragraph (bold/color runs) matches a from-scratch shape', () => {
    const e = engine();
    const build = (n: number): StyledSpan[] => {
      // Two runs whose boundary sits inside the growing text.
      const boldPart = 'boldword'.slice(0, Math.min(n, 8));
      const rest = n > 8 ? ' then plain tail words here'.slice(0, n - 8) : '';
      const spans: StyledSpan[] = [{ text: boldPart, style: { bold: true, color: '#f00' } }];
      if (rest) spans.push({ text: rest });
      return spans;
    };
    for (let n = 1; n <= 33; n++) {
      const spans = build(n);
      const incremental = e.prepareRich(spans, EMPTY_ATLAS, 20);
      const cold = shapeCold(spans, 20);
      expect(glyphDump(incremental)).toEqual(glyphDump(cold));
    }
  });

  it('CJK (no spaces) grows correctly char by char', () => {
    const e = engine();
    const full = '日本語のテキストが流れるように増えていく様子';
    for (let n = 1; n <= full.length; n++) {
      const text = full.slice(0, n);
      expect(glyphDump(e.prepareRich([{ text }], EMPTY_ATLAS, 20))).toEqual(
        glyphDump(shapeCold([{ text }], 20)),
      );
    }
  });

  it('falls back to the full shaper for RTL/Arabic and still shapes correctly', () => {
    const e = engine();
    // Grow an Arabic string; must equal a cold shape (the correct BiDi/joining
    // path) at every step — proving the fast path never mis-handles it.
    const full = 'مرحبا بالعالم';
    for (let n = 1; n <= full.length; n++) {
      const text = full.slice(0, n);
      expect(glyphDump(e.prepareRich([{ text }], EMPTY_ATLAS, 20))).toEqual(
        glyphDump(shapeCold([{ text }], 20)),
      );
    }
  });

  it('handles a simple→complex→simple transition without stale reuse', () => {
    const e = engine();
    // Simple, then Arabic (full path), then a simple extension of the simple
    // prefix — the incremental reuse must key off text, not history.
    expect(glyphDump(e.prepareRich([{ text: 'abc' }], EMPTY_ATLAS, 20))).toEqual(
      glyphDump(shapeCold([{ text: 'abc' }], 20)),
    );
    e.prepareRich([{ text: 'abc مرحبا' }], EMPTY_ATLAS, 20); // complex → full path
    expect(glyphDump(e.prepareRich([{ text: 'abcdef' }], EMPTY_ATLAS, 20))).toEqual(
      glyphDump(shapeCold([{ text: 'abcdef' }], 20)),
    );
  });

  it('shrinking / replacing text re-shapes correctly (no stale prefix)', () => {
    const e = engine();
    e.prepareRich([{ text: 'streaming words here' }], EMPTY_ATLAS, 20);
    // Now a shorter, different string that is NOT an extension.
    expect(glyphDump(e.prepareRich([{ text: 'other' }], EMPTY_ATLAS, 20))).toEqual(
      glyphDump(shapeCold([{ text: 'other' }], 20)),
    );
  });

  it('an appended word boundary lands at the right source offsets', () => {
    const e = engine();
    e.prepareRich([{ text: 'alpha beta' }], EMPTY_ATLAS, 20);
    const grown = e.prepareRich([{ text: 'alpha beta gamma' }], EMPTY_ATLAS, 20);
    const chars = grown.paragraphs[0].words.flatMap((w) => w.glyphs.map((g) => g.char)).join('');
    expect(chars).toBe('alpha beta gamma');
    // Every glyph's sourceIndex equals its position in the string.
    let i = 0;
    for (const w of grown.paragraphs[0].words) {
      for (const g of w.glyphs) {
        expect(g.sourceIndex).toBe(i);
        i += g.sourceLength;
      }
    }
    expect(i).toBe('alpha beta gamma'.length);
  });
});
