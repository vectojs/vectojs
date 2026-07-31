// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { clearFontMetrics, registerFontMetrics } from '@vectojs/text';
import { createCanvasMeasurer, createMetricsMeasurer, resolveGlyphMeasurer } from '../src/measure';

/**
 * Stub `document.createElement('canvas')` so the measurer gets a deterministic
 * 2D context whose `measureText` width is controlled by `widthOf`.
 */
function stubCanvas(widthOf: (s: string) => number) {
  const measureText = vi.fn((s: string) => ({ width: widthOf(s) }));
  const ctx = {
    set font(_v: string) {},
    measureText,
  };
  const spy = vi.spyOn(document, 'createElement').mockReturnValue({
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement);
  return { measureText, restore: () => spy.mockRestore() };
}

describe('createCanvasMeasurer', () => {
  it('measures a grapheme advance via canvas and scales linearly with fontSize', () => {
    const { restore } = stubCanvas((s) => s.length * 10); // 10px per char at baseSize
    try {
      const m = createCanvasMeasurer('sans-serif', 100);
      expect(m).not.toBeNull();
      // base advance 10 at baseSize 100 → fontSize 50 ⇒ 5, fontSize 100 ⇒ 10
      expect(m!.measure('A', 50)).toBeCloseTo(5);
      expect(m!.measure('A', 100)).toBeCloseTo(10);
    } finally {
      restore();
    }
  });

  it('caches per-char measurement (measures each unique grapheme once)', () => {
    const { measureText, restore } = stubCanvas(() => 12);
    try {
      const m = createCanvasMeasurer()!;
      m.measure('A', 20);
      m.measure('A', 40); // cached — different size reuses the base width
      m.measure('B', 20);
      expect(measureText).toHaveBeenCalledTimes(2); // A once, B once
    } finally {
      restore();
    }
  });

  it('returns null when no DOM is available (portable fallback)', () => {
    const prev = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(createCanvasMeasurer()).toBeNull();
    } finally {
      (globalThis as { document?: unknown }).document = prev;
    }
  });

  it('returns null when the canvas has no 2D context', () => {
    const spy = vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => null,
    } as unknown as HTMLCanvasElement);
    try {
      expect(createCanvasMeasurer()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

afterEach(() => {
  clearFontMetrics();
});

/** Run `fn` with no `document`, restoring it afterwards. */
function withoutDom<T>(fn: () => T): T {
  const prev = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = undefined;
  try {
    return fn();
  } finally {
    (globalThis as { document?: unknown }).document = prev;
  }
}

describe('createMetricsMeasurer', () => {
  it('returns null when the family has no registered metrics', () => {
    expect(createMetricsMeasurer('Inter')).toBeNull();
  });

  it('scales a registered em advance by fontSize', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32)).toBeCloseTo(19.2);
    expect(m.measure('A', 16)).toBeCloseTo(9.6);
  });

  it('works with no DOM at all, unlike the canvas measurer', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    withoutDom(() => {
      expect(createCanvasMeasurer('Inter')).toBeNull();
      expect(createMetricsMeasurer('Inter')!.measure('A', 32)).toBeCloseTo(19.2);
    });
  });

  it('falls back to 0.5em for a single glyph the source has no advance for', () => {
    // One missing codepoint must not disqualify the whole run's metrics.
    registerFontMetrics('Inter', { advanceEm: (c) => (c === 'A' ? 0.6 : undefined) });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32)).toBeCloseTo(19.2);
    expect(m.measure('Z', 32)).toBeCloseTo(16);
  });

  it('honors a per-run family override', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    registerFontMetrics('Courier', { advanceEm: () => 0.4 });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32, 'Courier')).toBeCloseTo(12.8);
  });

  it('falls back to the base source for an unregistered run family', () => {
    // The wrong font's real metrics still beat a flat half-em.
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32, 'Nonexistent')).toBeCloseTo(19.2);
  });

  it('sees a replaced registration rather than pinning the first source', () => {
    // Capturing the source at construction made this return the old advance
    // forever, which matters because `TextEntity` memoizes its measurer for the
    // whole process — one stale capture would pin every entity.
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32)).toBeCloseTo(19.2);
    registerFontMetrics('Inter', { advanceEm: () => 0.3 });
    expect(m.measure('A', 32)).toBeCloseTo(9.6);
  });

  it('sees a cleared registry and reverts to 0.5em', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    const m = createMetricsMeasurer('Inter')!;
    expect(m.measure('A', 32)).toBeCloseTo(19.2);
    clearFontMetrics();
    expect(m.measure('A', 32)).toBeCloseTo(16);
  });

  it('sees a run family registered after the measurer was built', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    const m = createMetricsMeasurer('Inter')!;
    // Falls back to the base source while Courier is unknown...
    expect(m.measure('A', 32, 'Courier')).toBeCloseTo(19.2);
    registerFontMetrics('Courier', { advanceEm: () => 0.4 });
    // ...and picks it up once registered, rather than caching the fallback.
    expect(m.measure('A', 32, 'Courier')).toBeCloseTo(12.8);
  });
});

describe('resolveGlyphMeasurer', () => {
  it('prefers canvas over registered metrics, so a browser is unaffected', () => {
    const { restore } = stubCanvas(() => 10); // 10px per char at baseSize 100
    try {
      registerFontMetrics('Inter', { advanceEm: () => 3 }); // absurd on purpose
      const m = resolveGlyphMeasurer('Inter', 100)!;
      expect(m.measure('A', 100)).toBeCloseTo(10);
    } finally {
      restore();
    }
  });

  it('falls back to registered metrics when there is no canvas', () => {
    registerFontMetrics('Inter', { advanceEm: () => 0.6 });
    withoutDom(() => {
      expect(resolveGlyphMeasurer('Inter')!.measure('A', 32)).toBeCloseTo(19.2);
    });
  });

  it('returns null when neither source can answer', () => {
    withoutDom(() => {
      expect(resolveGlyphMeasurer('Inter')).toBeNull();
    });
  });
});
