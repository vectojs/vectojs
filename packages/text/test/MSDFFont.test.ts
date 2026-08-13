import { describe, it, expect } from 'vitest';
import { MSDFFont, type MSDFFontData } from '../src/MSDFFont';

/**
 * A tiny hand-built font in the `msdf-atlas-gen` JSON layout (the de-facto MSDF
 * format): `planeBounds` in em units (y-up, relative to the baseline),
 * `atlasBounds` in atlas pixels, `yOrigin: 'bottom'`. Atlas is 100×100 so pixel
 * ÷ 100 reads straight off as a UV.
 */
const FONT: MSDFFontData = {
  atlas: {
    type: 'msdf',
    distanceRange: 4,
    size: 32,
    width: 100,
    height: 100,
    yOrigin: 'bottom',
  },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
  glyphs: [
    {
      unicode: 65, // 'A'
      advance: 0.6,
      planeBounds: { left: 0.0, bottom: 0.0, right: 0.5, top: 0.7 },
      atlasBounds: { left: 10, bottom: 20, right: 60, top: 90 },
    },
    {
      unicode: 66, // 'B'
      advance: 0.5,
      planeBounds: { left: 0.1, bottom: 0.0, right: 0.5, top: 0.7 },
      atlasBounds: { left: 10, bottom: 20, right: 50, top: 90 },
    },
    { unicode: 32, advance: 0.25 }, // space: advances, no quad
  ],
  kerning: [{ unicode1: 65, unicode2: 66, advance: -0.05 }],
};

describe('MSDFFont', () => {
  it('parses the atlas distance range', () => {
    const font = MSDFFont.parse(JSON.stringify(FONT));
    expect(font.distanceRange).toBe(4);
    expect(font.atlasWidth).toBe(100);
    expect(font.atlasHeight).toBe(100);
  });

  it('lays out one glyph: em→px quad and atlas px→UV (yOrigin bottom flips v)', () => {
    const font = new MSDFFont(FONT);
    const { glyphs, width } = font.layout('A', 100); // size 100px, origin (0,0)

    expect(glyphs).toHaveLength(1);
    const g = glyphs[0];
    // baseline = y + ascender*size = 0 + 0.8*100 = 80
    // x = 0 + left(0)*100; w = (right−left)*100 = 50
    // y(top) = baseline − top*size = 80 − 70 = 10; h = (top−bottom)*100 = 70
    expect(g).toMatchObject({ char: 'A', x: 0, y: 10, w: 50, h: 70 });
    // u = atlasX/100; v flips because yOrigin is bottom: v = 1 − atlasY/100
    expect(g.u0).toBeCloseTo(0.1); // 10/100
    expect(g.u1).toBeCloseTo(0.6); // 60/100
    expect(g.v0).toBeCloseTo(0.1); // 1 − 90/100  (top edge)
    expect(g.v1).toBeCloseTo(0.8); // 1 − 20/100  (bottom edge)
    // width is the total advance (pen), not the visual extent: advance*size = 60
    expect(width).toBeCloseTo(60);
  });

  it('advances the pen and applies kerning between glyphs', () => {
    const font = new MSDFFont(FONT);
    const { glyphs, width } = font.layout('AB', 100);
    expect(glyphs).toHaveLength(2);
    // A advances 0.6, kern(A,B) = −0.05 → pen at (0.6−0.05)*100 = 55 before B
    // B.left = 55 + 0.1*100 = 65
    expect(glyphs[1].x).toBeCloseTo(65);
    // total advance = 55 + 0.5*100 = 105
    expect(width).toBeCloseTo(105);
  });

  it('treats whitespace as advance-only (no quad)', () => {
    const font = new MSDFFont(FONT);
    const { glyphs, width } = font.layout('A B', 100);
    expect(glyphs.map((g) => g.char)).toEqual(['A', 'B']); // space produced no quad
    // A(60) + space(25) → pen 85; B advance 50 → 135
    expect(width).toBeCloseTo(135);
    expect(glyphs[1].x).toBeCloseTo(85 + 10); // B.left at pen 85 + 0.1*100
  });

  it('wraps on newline: second line baseline drops by lineHeight, height counts lines', () => {
    const font = new MSDFFont(FONT);
    const { glyphs, width, height } = font.layout('A\nB', 100);
    expect(glyphs).toHaveLength(2);
    // line 1 baseline = 80 + lineHeight*size = 80 + 125 = 205
    // B.y(top) = 205 − 0.7*100 = 135; B.x resets to 0 + 0.1*100 = 10
    expect(glyphs[1].char).toBe('B');
    expect(glyphs[1].x).toBeCloseTo(10);
    expect(glyphs[1].y).toBeCloseTo(135);
    expect(height).toBeCloseTo(250); // 2 lines × 1.25 × 100
    expect(width).toBeCloseTo(60); // widest line (line 0 advance)
  });

  it('emits no quad for a missing glyph but still reserves its advance', () => {
    const font = new MSDFFont(FONT);
    const { glyphs, width } = font.layout('AZ', 100); // 'Z' not in font
    // No quad can be drawn for 'Z' (nothing in the atlas)…
    expect(glyphs).toHaveLength(1);
    // …but the pen must still move, or every following glyph shifts left and
    // `width` under-reports. Falls back to the font's space advance (0.25em).
    expect(width).toBeCloseTo(85); // A (0.6) + missing (0.25) = 0.85em
  });

  it('keeps following glyphs in place across a missing glyph', () => {
    const font = new MSDFFont(FONT);
    const withMissing = font.layout('AZB', 100).glyphs;
    // 'A' then 'B' are drawn; 'B' sits after A's advance + the missing advance
    // (no kerning: the missing glyph breaks the A→B pair).
    expect(withMissing.map((g) => g.char)).toEqual(['A', 'B']);
    expect(withMissing[1].x).toBeCloseTo(0.6 * 100 + 0.25 * 100 + 0.1 * 100);
  });

  it('gives a nonspacing combining mark zero advance so it stacks on its base', () => {
    // U+0301 COMBINING ACUTE ACCENT, present in the atlas but (as some atlases
    // do) reporting a full advance — it must not move the pen.
    const withMark: MSDFFontData = {
      ...FONT,
      glyphs: [
        ...FONT.glyphs,
        {
          unicode: 0x0301,
          advance: 0.4,
          planeBounds: { left: 0.1, bottom: 0.5, right: 0.3, top: 0.8 },
          atlasBounds: { left: 10, bottom: 50, right: 30, top: 80 },
        },
      ],
    };
    const font = new MSDFFont(withMark);
    const { glyphs, width } = font.layout('A\u0301B', 100);
    // All three quads exist (the mark is drawn)…
    expect(glyphs.map((g) => g.char)).toEqual(['A', '\u0301', 'B']);
    // …but the mark advanced 0, so 'B' sits right after 'A'. The mark must not
    // replace the kerning base either: kern(A,B) = −0.05 still applies, or
    // `prevCode` pointed at the mark and the pair was silently dropped —
    // pen = A(0.6) + kern(−0.05) = 0.55em, B.left at pen + 0.1em = 65.
    expect(glyphs[2].x).toBeCloseTo(65);
    expect(width).toBeCloseTo(0.6 * 100 - 0.05 * 100 + 0.5 * 100);
  });

  it('reserves no advance for a missing nonspacing mark', () => {
    const font = new MSDFFont(FONT); // U+0301 absent here
    // A missing combining mark is still zero-width — it must NOT take the
    // missing-glyph fallback advance.
    expect(font.layout('A\u0301', 100).width).toBeCloseTo(60);
  });

  it('honors a custom origin and letter spacing', () => {
    const font = new MSDFFont(FONT);
    const { glyphs } = font.layout('AB', 100, {
      x: 5,
      y: 0,
      letterSpacing: 10,
    });
    expect(glyphs[0].x).toBeCloseTo(5); // first glyph at origin x
    // pen after A = 5 + 0.6*100 + kern(−5) + letterSpacing(10) = 5 + 60 − 5 + 10 = 70
    expect(glyphs[1].x).toBeCloseTo(70 + 10); // B.left = pen + 0.1*100
  });

  it('assigns unique font IDs and implements getGlyph lookup', () => {
    const font1 = new MSDFFont(FONT);
    const font2 = new MSDFFont(FONT);
    expect(font1.id).toBeDefined();
    expect(font2.id).toBeDefined();
    expect(font1.id).not.toBe(font2.id);

    const glyph = font1.getGlyph(65); // ASCII 'A'
    expect(glyph).toBeDefined();
    expect(glyph?.unicode).toBe(65);
  });
});
