// Deliberately NOT jsdom: `measureText`'s DOM-free branch is the subject, and
// jsdom would supply a canvas context that bypasses it entirely.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFontMetrics, registerFontMetrics, registerMSDFFontMetrics } from '@vectojs/core';
import { familyOf, measureText } from '../src/measure';

/** Real Chrome `sans-serif` em advances, so expectations are ground truth. */
const CHROME_EM: Record<string, number> = {
  A: 0.66699,
  V: 0.66699,
  W: 0.94385,
  i: 0.22217,
};

const FONT_DATA = {
  atlas: {
    distanceRange: 2,
    size: 32,
    width: 64,
    height: 64,
    yOrigin: 'bottom' as const,
  },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
  glyphs: Object.entries(CHROME_EM).map(([char, advance]) => ({
    unicode: char.codePointAt(0) as number,
    advance,
  })),
  // The real measured A/V pair adjustment.
  kerning: [{ unicode1: 0x41, unicode2: 0x56, advance: -0.0752 }],
};

beforeEach(() => {
  clearFontMetrics();
});

afterEach(() => {
  clearFontMetrics();
});

describe('familyOf', () => {
  it('drops a leading px size', () => {
    expect(familyOf('16px sans-serif')).toBe('sans-serif');
  });

  it('drops a weight and a line-height', () => {
    expect(familyOf('600 20px/1.4 Inter, sans-serif')).toBe('Inter, sans-serif');
  });

  it('returns a bare family unchanged', () => {
    expect(familyOf('Inter')).toBe('Inter');
  });

  it('falls back to sans-serif for an empty family', () => {
    expect(familyOf('16px ')).toBe('sans-serif');
    expect(familyOf('')).toBe('sans-serif');
  });
});

describe('measureText without a DOM', () => {
  it('has no document, so this file really is testing the DOM-free path', () => {
    expect(typeof document).toBe('undefined');
  });

  it('falls back to 0.5em per char with nothing registered', () => {
    // Historical behaviour: 4 chars × 32px × 0.5.
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(64);
  });

  it('uses registered per-glyph advances', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    // Chrome measures 'WWWW' at 120.81px; the guess said 64 (−47%).
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(120.81, 1);
  });

  it('applies kerning through the whole-string path', () => {
    registerMSDFFontMetrics('sans-serif', FONT_DATA);
    // Summed advances would be (0.66699 + 0.66699) * 32 = 42.69; the real pair
    // kerns by -0.0752em, so Chrome measures 40.28. Only measureEm can see this
    // — the per-glyph GlyphMeasurer contract has no neighbouring character.
    expect(measureText('AV', '32px sans-serif')).toBeCloseTo(40.28, 1);
  });

  it('prefers measureEm over summed advances when a source offers both', () => {
    registerFontMetrics('Inter', {
      advanceEm: () => 1,
      measureEm: () => 0.25,
    });
    // Summing would give 4 × 32 = 128; measureEm gives 0.25 × 32 = 8.
    expect(measureText('AAAA', '32px Inter')).toBeCloseTo(8);
  });

  it('sums per-glyph advances when a source has no measureEm', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.5 });
    expect(measureText('AAAA', '32px Inter')).toBeCloseTo(64);
  });

  it('counts an astral character once, not as two surrogates', () => {
    // Iterating UTF-16 units would double-count and return 2 advances here.
    registerFontMetrics('Inter', { advanceEm: () => 0.5 });
    expect(measureText('\u{1F600}', '32px Inter')).toBeCloseTo(16);
  });

  it('falls back to 0.5em per glyph for a character the source lacks', () => {
    registerFontMetrics('Inter', {
      advanceEm: (c) => (c === 'A' ? 0.6 : undefined),
    });
    // 'A' at 0.6em plus 'Z' at the 0.5em default.
    expect(measureText('AZ', '32px Inter')).toBeCloseTo(0.6 * 32 + 16);
  });

  it('keeps the 0.5em fallback for an unregistered family', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.9 });
    expect(measureText('WWWW', '32px Roboto')).toBeCloseTo(64);
  });

  it('invalidates already-measured strings when metrics are registered', () => {
    // measureText memoizes (font, text) in a bounded LRU. Registering metrics
    // changes what the answer should be, exactly as a webfont finishing its load
    // does, so entries computed before it are stale. Without this the first
    // measurement of a string wins for the life of the process.
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(64);
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(120.81, 1);
  });

  it('invalidates again when metrics are cleared', () => {
    registerFontMetrics('sans-serif', { advanceEm: (c) => CHROME_EM[c] });
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(120.81, 1);
    clearFontMetrics();
    expect(measureText('WWWW', '32px sans-serif')).toBeCloseTo(64);
  });
});
