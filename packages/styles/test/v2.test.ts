import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entity } from '@vectojs/core';
import {
  applyStyle,
  css,
  DEFAULT_THEME,
  getTheme,
  PRESET_THEMES,
  setTheme,
  style,
  tokens,
} from '../src/index';

type AnyEntity = Entity & Record<string, unknown>;

function stub(fields: Record<string, unknown>): AnyEntity {
  return { scene: null, constructor: { name: 'Stub' }, ...fields } as AnyEntity;
}

function liveScene() {
  return { markDirty: vi.fn() };
}

afterEach(() => {
  setTheme(reset);
});

const themeA = tokens({ accent: '#111111', 'radius-md': 8, gap: 10 });
const themeB = tokens({ accent: '#eeeeee', 'radius-md': 16, gap: '12px' });
const reset = tokens({
  accent: '#000000',
  'radius-md': 1,
  gap: 2,
  weight: 500,
  'bad-size': 12,
  font: '16px Inter',
  fontFamily: 'Inter, sans-serif',
  fontSize: '16px',
  fontWeight: '400',
});

describe('css() merge', () => {
  it('later sources win and inputs are not mutated', () => {
    const a = style({ backgroundColor: '#000', padding: 4 });
    const b = style({ backgroundColor: '#fff' });
    const merged = css(a, b);
    expect(merged).toEqual({ backgroundColor: '#fff', padding: 4 });
    expect(a).toEqual({ backgroundColor: '#000', padding: 4 });
    expect(b).toEqual({ backgroundColor: '#fff' });
  });

  it('skips null/undefined/false sources', () => {
    expect(css(null, style({ color: '#000' }), false)).toEqual({ color: '#000' });
  });
});

describe('var() token resolution', () => {
  it('resolves tokens against the default (light) theme', () => {
    setTheme(DEFAULT_THEME);
    const e = stub({ bg: '', radius: 0, gap: 0, direction: 'vertical' });
    applyStyle(e, style({ backgroundColor: 'var(--accent)', borderRadius: 'var(--radius-md)' }));
    expect(e.bg).toBe(PRESET_THEMES.light.accent);
    expect(e.radius).toBe(PRESET_THEMES.light['radius-md']);
  });

  it('resolves numeric and px-string tokens through converters', () => {
    setTheme(themeA);
    const e = stub({ radius: 0, gap: 0, direction: 'vertical' });
    applyStyle(e, style({ borderRadius: 'var(--radius-md)', gap: 'var(--gap)' }));
    expect(e.radius).toBe(8);
    expect(e.gap).toBe(10);
    setTheme(themeB);
    expect(e.radius).toBe(16);
    expect(e.gap).toBe(12);
  });

  it('throws on an unknown token', () => {
    const e = stub({ bg: '' });
    expect(() => applyStyle(e, style({ backgroundColor: 'var(--nope)' }))).toThrow(
      /unknown token 'var\(--nope\)'/,
    );
  });

  it('resolves tokens inside padding objects', () => {
    setTheme(themeA);
    const e = stub({ paddingX: 0, paddingY: 0 });
    applyStyle(e, style({ padding: { x: 'var(--gap)', y: 4 } }));
    expect(e.paddingX).toBe(10);
    expect(e.paddingY).toBe(4);
  });
});

describe('setTheme() switching', () => {
  it('re-applies tracked var() styles and recolours the scene', () => {
    setTheme(themeA);
    const scene = liveScene();
    const e = stub({ bg: '', radius: 0 });
    e.scene = scene as never;
    applyStyle(e, style({ backgroundColor: 'var(--accent)', borderRadius: 'var(--radius-md)' }));
    expect(e.bg).toBe('#111111');
    expect(e.radius).toBe(8);

    setTheme(themeB);
    expect(e.bg).toBe('#eeeeee');
    expect(e.radius).toBe(16);
    expect(scene.markDirty).toHaveBeenCalledTimes(2);

    setTheme(themeA);
    expect(e.bg).toBe('#111111');
  });

  it('leaves styles without var() references untracked', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: '#ffffff' }));
    setTheme(themeB);
    expect(e.bg).toBe('#ffffff'); // untouched by the switch
  });

  it('throws on a token value that fails validation', () => {
    setTheme(themeA);
    const e = stub({ radius: 0 });
    applyStyle(e, style({ borderRadius: 'var(--radius-md)' }));
    const broken = tokens({ accent: '#999999', 'radius-md': '50%', gap: 4 });
    expect(() => setTheme(broken)).toThrow(/borderRadius/);
  });

  it('is atomic when the next theme is missing a tracked token (GH-485)', () => {
    setTheme(themeA);
    const e1 = stub({ bg: '' });
    const e2 = stub({ radius: 0 });
    applyStyle(e1, style({ backgroundColor: 'var(--accent)' }));
    applyStyle(e2, style({ borderRadius: 'var(--radius-md)' }));
    expect(e1.bg).toBe('#111111');
    expect(e2.radius).toBe(8);

    const partial = tokens({ accent: '#222222' }); // lacks --radius-md
    expect(() => setTheme(partial)).toThrow(/unknown token/);

    // The failed switch must leave everything fully under the previous theme:
    // theme not committed, neither entity restyled, tracking still intact.
    expect(getTheme()).toBe(themeA);
    expect(e1.bg).toBe('#111111');
    expect(e2.radius).toBe(8);

    // And a subsequent valid switch must still re-resolve every pair.
    setTheme(themeB);
    expect(e1.bg).toBe('#eeeeee');
    expect(e2.radius).toBe(16);
  });

  it('applying a new var() style after a switch registers under the new theme', () => {
    setTheme(themeA);
    setTheme(themeB);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    setTheme(themeA);
    expect(e.bg).toBe('#111111');
  });

  it('accumulates multiple var() styles on one entity (GH-451)', () => {
    setTheme(themeA);
    const scene = liveScene();
    const e = stub({ bg: '', color: '' });
    e.scene = scene as never;
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    applyStyle(e, style({ color: 'var(--accent)' }));
    expect(e.bg).toBe('#111111');
    expect(e.color).toBe('#111111');

    setTheme(themeB);
    expect(e.bg).toBe('#eeeeee');
    expect(e.color).toBe('#eeeeee');

    setTheme(themeA);
    expect(e.bg).toBe('#111111');
    expect(e.color).toBe('#111111');
  });

  it('does not clobber a later literal with an earlier var() on the same key (GH-451)', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    applyStyle(e, style({ backgroundColor: '#ffffff' }));
    expect(e.bg).toBe('#ffffff');

    setTheme(themeB);
    expect(e.bg).toBe('#ffffff'); // literal wins; the switch must not replay the old var
  });

  it('re-tracks a key when a var() re-replaces a literal (GH-451)', () => {
    setTheme(themeA);
    const e = stub({ bg: '' });
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    applyStyle(e, style({ backgroundColor: '#ffffff' }));
    applyStyle(e, style({ backgroundColor: 'var(--accent)' }));
    expect(e.bg).toBe('#111111');

    setTheme(themeB);
    expect(e.bg).toBe('#eeeeee');
  });

  it('tracks padding objects per key and drops them on a literal override (GH-451)', () => {
    setTheme(themeA);
    const e = stub({ paddingX: 0, paddingY: 0 });
    applyStyle(e, style({ padding: { x: 'var(--gap)', y: 2 } }));
    expect(e.paddingX).toBe(10);

    applyStyle(e, style({ padding: { x: 5, y: 2 } }));
    expect(e.paddingX).toBe(5);

    setTheme(themeB);
    expect(e.paddingX).toBe(5); // literal stays
  });
});

describe('font composition', () => {
  it('composes fontFamily/fontSize/fontWeight into the font string', () => {
    const e = stub({ font: '16px Inter' });
    applyStyle(e, style({ fontFamily: 'Roboto', fontSize: '18px', fontWeight: 700 }));
    expect(e.font).toBe('700 18px Roboto');
  });

  it('replaces only the given segments, preserving the rest', () => {
    const e = stub({ font: '700 16px Inter' });
    applyStyle(e, style({ fontSize: '20px' }));
    expect(e.font).toBe('700 20px Inter');
    applyStyle(e, style({ fontFamily: 'ui-monospace' }));
    expect(e.font).toBe('700 20px ui-monospace');
  });

  it('starts from 16px sans-serif when the entity has no font', () => {
    const e = stub({ font: '' });
    applyStyle(e, style({ fontFamily: 'Inter' }));
    expect(e.font).toBe('16px Inter');
  });

  it('rejects a bare-number fontSize token (GH-452)', () => {
    const e = stub({ font: '16px Inter' });
    const broken = tokens({
      accent: '#000000',
      'bad-size': 18,
      'radius-md': 8,
      gap: 4,
      fontFamily: 'Inter',
      fontSize: '16px',
      fontWeight: '400',
    });
    setTheme(broken);
    expect(() => applyStyle(e, style({ fontSize: 'var(--bad-size)' }))).toThrow(/unit-bearing/);
    setTheme(reset);
  });

  it('parses a long digit run with a bad unit in linear time (code-scanning ReDoS)', () => {
    // Regression for the js/polynomial-redos alert on SIZE_RE. A 20k digit
    // run with a non-unit suffix must fail the size parse fast — this test
    // would time out under the old `\d+\.?\d*` backtracking, which enumerates
    // O(n²) split points across the adjacent digit classes.
    const e = stub({ font: '16px Inter' });
    const long = '9'.repeat(20000) + 'zzz';
    expect(() => applyStyle(e, style({ fontSize: long }))).not.toThrow();
  });

  it('rejects a font shorthand leaked into fontFamily (GH-452)', () => {
    setTheme(reset);
    const e = stub({ font: '16px Inter' });
    expect(() => applyStyle(e, style({ fontFamily: 'var(--font)' }))).toThrow(
      /looks like a font shorthand/,
    );
  });

  it('resolves preset font segment tokens into a valid shorthand (GH-452)', () => {
    const lightFull = tokens({ ...PRESET_THEMES.light, gap: 2, weight: 500, 'bad-size': 12 });
    setTheme(lightFull);
    const e = stub({ font: '' });
    applyStyle(
      e,
      style({
        fontFamily: 'var(--fontFamily)',
        fontSize: 'var(--fontSize)',
        fontWeight: 'var(--fontWeight)',
      }),
    );
    expect(e.font).toBe('400 16px Inter, sans-serif');
  });

  it('resolves a number fontWeight token through String() (GH-452)', () => {
    const e = stub({ font: '16px Inter' });
    const withWeight = tokens({
      accent: '#000000',
      weight: 600,
      'radius-md': 8,
      gap: 4,
      fontFamily: 'Inter',
      fontSize: '16px',
      fontWeight: '400',
    });
    setTheme(withWeight);
    applyStyle(e, style({ fontWeight: 'var(--weight)' }));
    expect(e.font).toBe('600 16px Inter');
    setTheme(reset);
  });

  it('is skipped on entities without a font field', () => {
    const e = stub({ bg: '' });
    const { applied } = applyStyle(e, style({ fontSize: '20px', backgroundColor: '#000' }));
    expect(e).not.toHaveProperty('font');
    expect(applied).toEqual(['backgroundColor']);
  });
});

describe('padding object', () => {
  it('writes paddingX/paddingY when the fields exist', () => {
    const e = stub({ paddingX: 0, paddingY: 0, padding: 0 });
    const { applied } = applyStyle(e, style({ padding: { x: 16, y: '8px' } }));
    expect(e.paddingX).toBe(16);
    expect(e.paddingY).toBe(8);
    expect(e.padding).toBe(0);
    expect(applied).toEqual(['padding']);
  });

  it('is skipped on entities without per-axis fields', () => {
    const e = stub({ padding: 0 });
    const { applied } = applyStyle(e, style({ padding: { x: 16, y: 8 } }));
    expect(e.padding).toBe(0);
    expect(applied).toEqual([]);
  });

  it('rejects invalid axis values', () => {
    const e = stub({ paddingX: 0, paddingY: 0 });
    expect(() => applyStyle(e, style({ padding: { x: '50%' } }))).toThrow(/padding\.x/);
  });
});
