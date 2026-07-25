// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

// Install a counting Canvas2D stub BEFORE measure.ts lazily grabs a context, so
// we can observe how often the native measureText is actually hit.
let measureCalls = 0;
/** Every string handed to the native measurer, so tests can assert that the
 *  SHAPED form (not the raw input) is what actually gets measured. */
const measured: string[] = [];
const fakeCtx = {
  font: '',
  measureText: (t: string) => {
    measureCalls++;
    measured.push(t);
    return { width: t.length * 7 };
  },
};
HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never;

import { measureText } from '../src/measure';

describe('measureText LRU cache', () => {
  beforeEach(() => {
    measureCalls = 0;
  });

  it('returns the canvas width and serves a repeat (text, font) from cache', () => {
    const a = measureText('hello', '16px sans-serif');
    const b = measureText('hello', '16px sans-serif');
    expect(a).toBe(5 * 7);
    expect(b).toBe(a);
    expect(measureCalls).toBe(1); // second call cached
  });

  it('keys on the font too, not just the text', () => {
    measureText('x', '16px serif');
    measureText('x', '20px serif'); // same text, different font → miss
    expect(measureCalls).toBe(2);
  });

  it('evicts least-recently-used entries when it grows past the cap', () => {
    measureText('seed', '16px sans-serif'); // 1 measure
    expect(measureCalls).toBe(1);
    // Flood with many distinct keys to push the cap and evict "seed".
    for (let i = 0; i < 2000; i++) measureText(`k${i}`, '16px sans-serif');
    measureCalls = 0;
    measureText('seed', '16px sans-serif'); // evicted → re-measured
    expect(measureCalls).toBe(1);
  });

  it('keeps a hot entry alive across evictions (true LRU, not FIFO)', () => {
    measureText('hot', '16px sans-serif');
    for (let i = 0; i < 1500; i++) {
      measureText(`q${i}`, '16px sans-serif');
      measureText('hot', '16px sans-serif'); // touch keeps it recent
    }
    measureCalls = 0;
    measureText('hot', '16px sans-serif'); // should still be cached
    expect(measureCalls).toBe(0);
  });

  describe('cache key is the raw text, shaping happens only on a miss', () => {
    // The LRU used to be keyed on the SHAPED text, so every cache HIT still ran
    // ArabicShaper.shapeArabic() first — ~60% of the whole hit cost, and pure
    // overhead for ASCII (shaping returns the input unchanged but still allocates
    // an index map). Keying on the raw text made a hit 12× cheaper.

    it('still measures Arabic in its CONTEXTUALLY SHAPED form', () => {
      // This is the contract the optimization must not break: joined Arabic
      // glyphs have different advances than the isolated codepoints, so what
      // reaches the canvas must be the shaped string, not the raw input.
      const raw = '\u0628\u0628\u0628'; // BEH ×3 → initial + medial + final
      measured.length = 0;
      measureText(raw, '16px sans-serif');

      expect(measured).toHaveLength(1);
      // The shaper rewrites these codepoints to presentation forms (U+FE…), so
      // the measured string must differ from the raw input.
      expect(measured[0]).not.toBe(raw);
      for (const ch of measured[0]!) {
        expect(ch.codePointAt(0)!).toBeGreaterThan(0xfe00);
      }
    });

    it('does not shape again on a cache hit', () => {
      const raw = '\u0628\u0628\u0628';
      measureText(raw, '18px sans-serif'); // miss → shapes + measures
      measured.length = 0;
      measureCalls = 0;

      measureText(raw, '18px sans-serif'); // hit → no measure, no shaping
      expect(measureCalls).toBe(0);
      expect(measured).toHaveLength(0);
    });

    it('serves ASCII hits without touching the canvas', () => {
      measureText('plain ascii', '16px sans-serif');
      measureCalls = 0;
      for (let i = 0; i < 20; i++) measureText('plain ascii', '16px sans-serif');
      expect(measureCalls).toBe(0);
    });
  });
});
