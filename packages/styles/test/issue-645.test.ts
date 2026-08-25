import { afterEach, describe, expect, it } from 'vitest';
import type { Entity } from '@vectojs/core';
import { applyStyle, setTheme, style, tokens } from '../src/index';

type AnyEntity = Entity & Record<string, unknown>;

function stub(fields: Record<string, unknown>): AnyEntity {
  return { scene: null, constructor: { name: 'Stub' }, ...fields } as AnyEntity;
}

// Regression coverage for GH-645: `var(--token, fallback)` matched neither the
// anchored VAR_RE nor HAS_VAR_RE (which requires `)` right after the key), so
// the raw string was written through to mapped fields — Canvas2D silently kept
// the previous paint — and the key went untracked for theme switches. The fix
// detects the fallback form explicitly and fails loudly, per the GH-608
// doctrine that unrecognized var() usage must never pass through silently.
const reset = tokens({
  accent: '#000000',
  gap: 2,
  rgb: '255, 0, 0',
});

afterEach(() => {
  setTheme(reset);
});

describe('GH-645: var() fallback form', () => {
  const theme = tokens({ ...reset.tokens, accent: '#2563eb' });

  it('rejects an anchored fallback reference on a mapped field', () => {
    setTheme(theme);
    const e = stub({ bg: 'previous' });
    expect(() => applyStyle(e, style({ backgroundColor: 'var(--accent, #fff)' }))).toThrow(
      /fallback/,
    );
    // Nothing was written through: pre-fix the raw string reached the field
    // and Canvas2D silently kept the previous paint.
    expect(e.bg).toBe('previous');
  });

  it('rejects a fallback embedded in a composite string', () => {
    setTheme(theme);
    const e = stub({ bg: 'previous' });
    expect(() =>
      applyStyle(e, style({ backgroundColor: 'rgba(var(--accent, #fff), 0.4)' })),
    ).toThrow(/fallback/);
    expect(e.bg).toBe('previous');
  });

  it('rejects a fallback arriving through a token', () => {
    const withSurface = tokens({ ...reset.tokens, surface: 'var(--accent, #fff)' });
    setTheme(withSurface);
    const e = stub({ bg: 'previous' });
    expect(() => applyStyle(e, style({ backgroundColor: 'var(--surface)' }))).toThrow(/fallback/);
    expect(e.bg).toBe('previous');
  });

  it('rejects a fallback in a padding axis', () => {
    setTheme(theme);
    const e = stub({});
    expect(() => applyStyle(e, style({ padding: { x: 'var(--gap, 4px)' } }))).toThrow(/fallback/);
  });

  it('names the offending value in the error', () => {
    setTheme(theme);
    const e = stub({});
    expect(() => applyStyle(e, style({ color: 'var(--accent, #fff)' }))).toThrow(
      /var\(--accent, #fff\)/,
    );
  });

  it('rejects a fallback with whitespace after the opening paren', () => {
    setTheme(theme);
    const e = stub({ bg: 'previous' });
    // Authors do write stray spaces inside var(); the fallback detector used
    // to require `--` immediately after the paren, so 'var( --accent, #fff)'
    // matched nothing and passed through silently unresolved (#753 follow-up).
    expect(() => applyStyle(e, style({ backgroundColor: 'var( --accent, #fff)' }))).toThrow(
      /fallback/,
    );
    expect(e.bg).toBe('previous');
  });

  it('still resolves plain references and composites without fallbacks', () => {
    setTheme(theme);
    const e = stub({ bg: '', color: '' });
    applyStyle(e, style({ backgroundColor: 'var(--accent)', color: 'rgba(var(--rgb), 0.5)' }));
    expect(e.bg).toBe('#2563eb');
    expect(e.color).toBe('rgba(255, 0, 0, 0.5)');
  });
});
