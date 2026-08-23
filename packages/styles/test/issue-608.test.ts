import { afterEach, describe, expect, it } from 'vitest';
import type { Entity } from '@vectojs/core';
import { applyStyle, css, setTheme, style, tokens } from '../src/index';

type AnyEntity = Entity & Record<string, unknown>;

function stub(fields: Record<string, unknown>): AnyEntity {
  return { scene: null, constructor: { name: 'Stub' }, ...fields } as AnyEntity;
}

// Regression coverage for GH-608: composite var() values, extended font
// shorthand prefixes, runtime fontSize units, and css() nested-object sharing.
// Like v2.test.ts: tracked var() pairs are dry-run resolved against every
// later setTheme(), so `reset` must carry every token any test tracks.
const reset = tokens({
  accent: '#000000',
  'radius-md': 1,
  gap: 2,
  rgb: '255, 0, 0',
  alpha: 1,
  surface: 'rgba(var(--rgb), 1)',
  shadow: '0 0 4px rgba(var(--rgb), 0.6), 1px 1px 2px rgba(var(--rgb), 0.4)',
});

afterEach(() => {
  setTheme(reset);
});

describe('GH-608: composite var() strings', () => {
  const themeA = tokens({ ...reset.tokens, rgb: '17, 34, 51', alpha: 0.5 });
  const themeB = tokens({ ...reset.tokens, rgb: '238, 238, 238', alpha: 0.25 });

  it('substitutes embedded var() references inside a larger string', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    // The anchored VAR_RE missed this entirely: the raw 'rgba(var(--rgb), 0.4)'
    // was written to the field and Canvas2D silently kept the old value.
    applyStyle(e, style({ backgroundColor: 'rgba(var(--rgb), 0.4)' }));
    expect(e.bg).toBe('rgba(17, 34, 51, 0.4)');
  });

  it('stringifies numeric tokens substituted into a composite', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'rgba(var(--rgb), var(--alpha))' }));
    expect(e.bg).toBe('rgba(17, 34, 51, 0.5)');
  });

  it('throws on an unknown embedded token', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    expect(() => applyStyle(e, style({ backgroundColor: 'rgba(var(--nope), 0.4)' }))).toThrow(
      /unknown token 'var\(--nope\)'/,
    );
  });

  it('re-resolves composites when the theme switches', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'rgba(var(--rgb), var(--alpha))' }));
    expect(e.bg).toBe('rgba(17, 34, 51, 0.5)');
    setTheme(themeB);
    expect(e.bg).toBe('rgba(238, 238, 238, 0.25)');
  });

  it('stops tracking a key once its composite becomes literal', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'rgba(var(--rgb), 0.4)' }));
    applyStyle(e, style({ backgroundColor: '#ffffff' }));
    setTheme(themeB);
    expect(e.bg).toBe('#ffffff');
  });

  it('resolves composite tokens transitively', () => {
    setTheme(tokens({ ...themeA.tokens, surface: 'rgba(var(--rgb), 1)' }));
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'var(--surface)' }));
    expect(e.bg).toBe('rgba(17, 34, 51, 1)');
  });

  it('throws a targeted error on cycles routed through a composite token', () => {
    setTheme(tokens({ ...reset.tokens, a: 'rgba(var(--b), 1)', b: 'var(--a)' }));
    const e = stub({ bg: '' });
    expect(() => applyStyle(e, style({ backgroundColor: 'var(--a)' }))).toThrow(/circular/);
  });

  it('resolves each occurrence independently when one token appears twice', () => {
    setTheme(
      tokens({
        ...themeA.tokens,
        shadow: '0 0 4px rgba(var(--rgb), 0.6), 1px 1px 2px rgba(var(--rgb), 0.4)',
      }),
    );
    const e = stub({ bg: '' });
    // Two substitutions of the same token in one value share the resolution
    // pass and must not trip the cycle detector.
    applyStyle(e, style({ backgroundColor: 'var(--shadow)' }));
    expect(e.bg).toBe('0 0 4px rgba(17, 34, 51, 0.6), 1px 1px 2px rgba(17, 34, 51, 0.4)');
  });
});

describe('GH-608: font shorthand prefixes', () => {
  it('preserves an italic/weight prefix when the size changes', () => {
    const e = stub({ font: 'italic 700 16px Georgia' });
    applyStyle(e, style({ fontSize: '20px' }));
    expect(e.font).toBe('italic 700 20px Georgia');
  });

  it('preserves the line-height segment when the size changes', () => {
    const e = stub({ font: '16px/24px Inter' });
    applyStyle(e, style({ fontSize: '20px' }));
    expect(e.font).toBe('20px/24px Inter');
  });

  it('round-trips style, variant and weight prefixes', () => {
    const e = stub({ font: 'oblique small-caps 800 16px serif' });
    applyStyle(e, style({ fontFamily: 'Inter' }));
    expect(e.font).toBe('oblique small-caps 800 16px Inter');
  });

  it('throws loudly when unparseable junk precedes the size', () => {
    const e = stub({ font: 'ultra-condensed 700 16px serif' });
    expect(() => applyStyle(e, style({ fontWeight: 900 }))).toThrow(/ultra-condensed/);
  });

  it('normalizes a style-prefixed shorthand that lacks a size', () => {
    const e = stub({ font: 'italic Georgia' });
    applyStyle(e, style({ fontSize: '18px' }));
    expect(e.font).toBe('italic 18px Georgia');
  });
});

describe('GH-608: fontSize unit enforcement', () => {
  it('rejects non-px units from JS callers', () => {
    const e = stub({ font: '16px Inter' });
    expect(() => applyStyle(e, { fontSize: '2em' } as never)).toThrow(/fontSize.*px/);
  });

  it('rejects non-px units arriving through a token', () => {
    setTheme(tokens({ ...reset.tokens, big: '2rem' }));
    const e = stub({ font: '16px Inter' });
    expect(() => applyStyle(e, style({ fontSize: 'var(--big)' }))).toThrow(/fontSize.*px/);
  });
});

describe('GH-608: css() does not share nested padding objects', () => {
  it('copies per-axis padding objects into the merged result', () => {
    const base = style({ padding: { x: 1, y: 2 } as never, color: '#000' as never });
    const merged = css(base, {});
    expect(merged.padding).toEqual({ x: 1, y: 2 });
    expect(merged.padding).not.toBe(base.padding);
    (merged.padding as { x: number }).x = 99;
    expect((base.padding as { x: number }).x).toBe(1);
  });

  it('lets a later source replace the padding object wholesale', () => {
    const base = style({ padding: { x: 1, y: 2 } as never });
    const override = style({ padding: { x: 9 } as never });
    const merged = css(base, override);
    expect(merged.padding).toEqual({ x: 9 });
    // The result copies from every source — it never aliases an input.
    expect(merged.padding).not.toBe(override.padding);
    expect((override.padding as { x: number }).x).toBe(9);
  });

  it('leaves primitive padding values untouched', () => {
    const s = style({ padding: 12 });
    expect(css(s).padding).toBe(12);
  });
});
