// Deliberately NOT jsdom, unlike Typography.test.ts. That file stubs
// `getContext` to null, which exercises the `!typographyContext` branch — but
// `document` still exists there, so the `typeof document === 'undefined'` branch
// is never reached. Mutating that branch failed zero tests until this file
// existed, which is exactly the kind of gap a stub can hide.
import { afterEach, describe, expect, it } from 'vitest';
import { cssLineBoxBaseline } from '../src/Typography';
import { clearFontMetrics, registerFontMetrics } from '../src/fontMetrics';

afterEach(() => {
  clearFontMetrics();
});

describe('cssLineBoxBaseline with no document at all', () => {
  it('has no document, so this file really is testing the DOM-free path', () => {
    expect(typeof document).toBe('undefined');
  });

  it('keeps the 0.8 fallback with nothing registered', () => {
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(19.2);
  });

  it('uses registered vertical metrics when they are available', () => {
    registerFontMetrics('sans-serif', {
      advanceEm: () => 0.5,
      ascenderEm: 0.8,
      descenderEm: -0.2,
    });
    // ascent 12.8, descent 3.2, line box 24 ⇒ (24 - 12.8 - 3.2) / 2 + 12.8.
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(16.8);
  });

  it('ignores a source that has advances but no vertical metrics', () => {
    registerFontMetrics('sans-serif', { advanceEm: () => 0.5 });
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(19.2);
  });
});
