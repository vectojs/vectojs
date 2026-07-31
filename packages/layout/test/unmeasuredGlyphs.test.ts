import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LayoutEngine,
  resetUnmeasuredGlyphCount,
  setUnmeasuredGlyphWarning,
  unmeasuredGlyphCount,
} from '../src/LayoutEngine';

const EMPTY_ATLAS = Object.freeze({});

/** Lay out `text` with the given measurer and return its measured width. */
function widthOf(measurer: Parameters<typeof LayoutEngine>[2] | null, text = 'Hello'): number {
  const engine = new LayoutEngine(1e9, 1e9, measurer ?? null);
  return engine.layoutPrepared(engine.prepare(text, EMPTY_ATLAS as never, 32)).totalWidth;
}

beforeEach(() => {
  resetUnmeasuredGlyphCount();
  setUnmeasuredGlyphWarning(false);
});

afterEach(() => {
  setUnmeasuredGlyphWarning(true);
  resetUnmeasuredGlyphCount();
});

describe('unmeasuredGlyphCount', () => {
  it('counts every glyph sized by the 0.5em guess', () => {
    expect(unmeasuredGlyphCount()).toBe(0);
    widthOf(null, 'Hello');
    // Six, not five: prepare() also measures '-' once per call for the
    // wrap-time hyphen width, and that advance is fabricated too.
    expect(unmeasuredGlyphCount()).toBe(6);
  });

  it('scales with the text length, so the tally is the real glyph count', () => {
    // Guards the constant above from being a coincidence: n chars ⇒ n + 1.
    widthOf(null, 'A');
    const one = unmeasuredGlyphCount();
    resetUnmeasuredGlyphCount();
    widthOf(null, 'AB');
    expect(unmeasuredGlyphCount()).toBe(one + 1);
  });

  it('stays zero when a measurer answers', () => {
    widthOf({ measure: (_c, fontSize) => fontSize * 0.6 }, 'Hello');
    expect(unmeasuredGlyphCount()).toBe(0);
  });

  it('distinguishes real degradation from fallbackToCanvas, which is always set here', () => {
    // fallbackToCanvas only reports an ATLAS miss, so it is true for both of
    // these — it cannot tell a measured layout from a fabricated one. That is
    // exactly why this counter exists.
    const measured = new LayoutEngine(1e9, 1e9, {
      measure: (_c, fs) => fs * 0.6,
    });
    const measuredPrep = measured.prepare('Hello', EMPTY_ATLAS as never, 32);
    expect(measuredPrep.fallbackToCanvas).toBe(true);
    expect(unmeasuredGlyphCount()).toBe(0);

    const guessed = new LayoutEngine(1e9, 1e9, null);
    const guessedPrep = guessed.prepare('Hello', EMPTY_ATLAS as never, 32);
    expect(guessedPrep.fallbackToCanvas).toBe(true);
    expect(unmeasuredGlyphCount()).toBeGreaterThan(0);
  });

  it('resetUnmeasuredGlyphCount clears the tally', () => {
    widthOf(null, 'Hello');
    expect(unmeasuredGlyphCount()).toBe(6);
    resetUnmeasuredGlyphCount();
    expect(unmeasuredGlyphCount()).toBe(0);
  });
});

describe('the unmeasured-glyph warning', () => {
  it('warns once, not once per glyph', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setUnmeasuredGlyphWarning(true);
      resetUnmeasuredGlyphCount();
      widthOf(null, 'Hello');
      widthOf(null, 'World');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('registerFontMetrics');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when a measurer answers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setUnmeasuredGlyphWarning(true);
      resetUnmeasuredGlyphCount();
      widthOf({ measure: (_c, fs) => fs * 0.6 }, 'Hello');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('can be silenced while the count keeps rising', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setUnmeasuredGlyphWarning(false);
      resetUnmeasuredGlyphCount();
      widthOf(null, 'Hello');
      expect(warn).not.toHaveBeenCalled();
      expect(unmeasuredGlyphCount()).toBe(6);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-arms after a reset, so a later regression is reported again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setUnmeasuredGlyphWarning(true);
      resetUnmeasuredGlyphCount();
      widthOf(null, 'Hello');
      resetUnmeasuredGlyphCount();
      widthOf(null, 'World');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
