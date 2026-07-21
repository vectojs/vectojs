// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createCanvasMeasurer } from '../src/measure';

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
