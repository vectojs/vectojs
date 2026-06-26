// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

// Install a counting Canvas2D stub BEFORE measure.ts lazily grabs a context, so
// we can observe how often the native measureText is actually hit.
let measureCalls = 0;
const fakeCtx = {
  font: '',
  measureText: (t: string) => {
    measureCalls++;
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
});
