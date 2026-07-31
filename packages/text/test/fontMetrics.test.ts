import { afterEach, describe, expect, it } from 'vitest';
import { MSDFFont } from '../src/MSDFFont';
import {
  clearFontMetrics,
  createMSDFMetricsSource,
  getFontMetrics,
  hasFontMetrics,
  registerFontMetrics,
  registerMSDFFontMetrics,
  type FontMetricsSource,
} from '../src/fontMetrics';

/**
 * A minimal `msdf-atlas-gen` document. Advances are the real Chrome
 * `sans-serif` em advances for these glyphs, and the kerning pair is the real
 * measured `A`/`V` adjustment, so the numbers below are ground truth rather
 * than invented.
 */
const FONT_DATA = {
  atlas: {
    distanceRange: 2,
    size: 32,
    width: 64,
    height: 64,
    yOrigin: 'bottom' as const,
  },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 0x41, advance: 0.66699 }, // A
    { unicode: 0x56, advance: 0.66699 }, // V
    { unicode: 0x69, advance: 0.22217 }, // i
    { unicode: 0x20, advance: 0.26123 }, // space
  ],
  kerning: [{ unicode1: 0x41, unicode2: 0x56, advance: -0.0752 }],
};

afterEach(() => {
  clearFontMetrics();
});

describe('registerFontMetrics', () => {
  it('registers and resolves a source by family name', () => {
    const source: FontMetricsSource = { advanceEm: () => 0.5 };
    expect(hasFontMetrics()).toBe(false);
    registerFontMetrics('Inter', source);
    expect(hasFontMetrics()).toBe(true);
    expect(getFontMetrics('Inter')).toBe(source);
  });

  it('matches case-insensitively and ignores quotes, as CSS does', () => {
    const source: FontMetricsSource = { advanceEm: () => 0.5 };
    registerFontMetrics('Noto Sans', source);
    expect(getFontMetrics('noto sans')).toBe(source);
    expect(getFontMetrics('NOTO SANS')).toBe(source);
    expect(getFontMetrics('"Noto Sans"')).toBe(source);
    expect(getFontMetrics("'Noto Sans'")).toBe(source);
  });

  it('keys a comma-separated list on its first family only', () => {
    const source: FontMetricsSource = { advanceEm: () => 0.5 };
    registerFontMetrics('Inter, sans-serif', source);
    // The registration is for Inter; the rest of the list is a renderer concern.
    expect(getFontMetrics('Inter')).toBe(source);
    expect(getFontMetrics('Inter, Helvetica')).toBe(source);
    expect(getFontMetrics('sans-serif')).toBeUndefined();
  });

  it('returns undefined for an unregistered family', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.5 });
    expect(getFontMetrics('Comic Sans MS')).toBeUndefined();
  });

  it('replaces a previous registration for the same family', () => {
    const first: FontMetricsSource = { advanceEm: () => 0.4 };
    const second: FontMetricsSource = { advanceEm: () => 0.9 };
    registerFontMetrics('Inter', first);
    registerFontMetrics('inter', second);
    expect(getFontMetrics('Inter')).toBe(second);
  });

  it('clearFontMetrics drops every registration', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.5 });
    registerFontMetrics('Roboto', { advanceEm: () => 0.5 });
    clearFontMetrics();
    expect(hasFontMetrics()).toBe(false);
    expect(getFontMetrics('Inter')).toBeUndefined();
  });
});

describe('createMSDFMetricsSource', () => {
  it('reports per-glyph advances in em units', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    expect(source.advanceEm('A')).toBeCloseTo(0.66699, 5);
    expect(source.advanceEm('i')).toBeCloseTo(0.22217, 5);
  });

  it('returns undefined for a glyph the font has no entry for', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    // The caller falls back for this one glyph rather than for the whole run.
    expect(source.advanceEm('Z')).toBeUndefined();
  });

  it('exposes the font ascender and descender for baseline resolution', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    expect(source.ascenderEm).toBeCloseTo(0.8);
    expect(source.descenderEm).toBeCloseTo(-0.2);
  });

  it('measureEm applies kerning, so it is smaller than the sum of advances', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    const summed = source.advanceEm('A')! + source.advanceEm('V')!;
    const kerned = source.measureEm!('AV')!;
    expect(kerned).toBeLessThan(summed);
    // The pair adjustment is -0.0752em, and it is the whole difference.
    expect(summed - kerned).toBeCloseTo(0.0752, 4);
  });

  it('measureEm agrees with summed advances when no pair kerns', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    expect(source.measureEm!('ii')).toBeCloseTo(source.advanceEm('i')! * 2, 5);
  });

  it('measureEm of the empty string is zero', () => {
    const source = createMSDFMetricsSource(MSDFFont.parse(FONT_DATA));
    expect(source.measureEm!('')).toBe(0);
  });
});

describe('registerMSDFFontMetrics', () => {
  it('accepts a parsed MSDFFont', () => {
    registerMSDFFontMetrics('Inter', MSDFFont.parse(FONT_DATA));
    expect(getFontMetrics('Inter')?.advanceEm('A')).toBeCloseTo(0.66699, 5);
  });

  it('accepts raw font data', () => {
    registerMSDFFontMetrics('Inter', FONT_DATA);
    expect(getFontMetrics('Inter')?.advanceEm('A')).toBeCloseTo(0.66699, 5);
  });

  it('accepts a JSON string, so a metrics-only file needs no pre-parsing', () => {
    registerMSDFFontMetrics('Inter', JSON.stringify(FONT_DATA));
    expect(getFontMetrics('Inter')?.advanceEm('A')).toBeCloseTo(0.66699, 5);
  });
});
