// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cssLineBoxBaseline } from '../src/Typography';
import { clearFontMetrics, registerFontMetrics } from '../src/fontMetrics';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

afterEach(() => {
  clearFontMetrics();
});

describe('cssLineBoxBaseline', () => {
  it('has a portable baseline fallback when browser font metrics are unavailable', () => {
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(19.2);
  });

  it('uses registered ascender/descender instead of the 0.8 guess', () => {
    // CSS centers the leading around the font's own ascent + descent, so with
    // ascent 12.8 and descent 3.2 in a 24px line box the baseline is
    // (24 - 12.8 - 3.2) / 2 + 12.8 = 16.8 — not the 19.2 the flat guess gives.
    registerFontMetrics('sans-serif', {
      advanceEm: () => 0.5,
      ascenderEm: 0.8,
      descenderEm: -0.2,
    });
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(16.8);
  });

  it('reads the family out of a full shorthand, line-height included', () => {
    registerFontMetrics('Inter', {
      advanceEm: () => 0.5,
      ascenderEm: 0.75,
      descenderEm: -0.25,
    });
    // ascent 15, descent 5, line box 30 ⇒ (30 - 15 - 5) / 2 + 15 = 20
    expect(cssLineBoxBaseline('600 20px/1.4 Inter', 30)).toBeCloseTo(20);
  });

  it('keeps the 0.8 fallback for a family with no registration', () => {
    registerFontMetrics('Inter', {
      advanceEm: () => 0.5,
      ascenderEm: 0.8,
      descenderEm: -0.2,
    });
    expect(cssLineBoxBaseline('16px Roboto', 24)).toBeCloseTo(19.2);
  });

  it('keeps the 0.8 fallback when a source carries advances but no vertical metrics', () => {
    // advanceEm is the only required field, so a horizontal-only source must not
    // be mistaken for one that can answer a baseline question.
    registerFontMetrics('sans-serif', { advanceEm: () => 0.5 });
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(19.2);
  });

  it('keeps the 0.8 fallback for a shorthand with no px size', () => {
    registerFontMetrics('sans-serif', {
      advanceEm: () => 0.5,
      ascenderEm: 0.8,
      descenderEm: -0.2,
    });
    expect(cssLineBoxBaseline('sans-serif', 24)).toBeCloseTo(19.2);
  });
});
