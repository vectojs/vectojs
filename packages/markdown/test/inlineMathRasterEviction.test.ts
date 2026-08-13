// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InlineObjectBox, InlineObjectSurface } from '@vectojs/core';
import { paintInlineMath, preloadMathJax, renderMathToSVGDataURI } from '../src/markdown-math';

/**
 * Bounds on the inline-math raster store (markdown-math.ts).
 *
 * The store is module-level and lives as long as the page, so a long-lived
 * document (a streamed chat, a re-themed feed) that paints thousands of
 * distinct formulas must not retain a decoded bitmap for each of them. Two
 * mechanisms keep it aligned with the bounded mathCache: dropping the raster
 * when its render is evicted from mathCache, and an LRU cap on the store
 * itself.
 *
 * Observed through decode count: jsdom has no `Image`, so the test stubs one
 * that records every `src` assignment. Each raster entry triggers exactly one
 * decode; a second decode of the same URI proves the entry was evicted in
 * between.
 */

class RecordingImage {
  static srcs: string[] = [];
  onload: (() => void) | null = null;
  set src(value: string) {
    RecordingImage.srcs.push(value);
  }
}

const surface = { drawImage: () => {} } as unknown as InlineObjectSurface;
const box = { x: 0, y: 0, width: 10, height: 10 } as InlineObjectBox;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inline math raster store bounds', () => {
  it('drops the raster of a render evicted from mathCache', async () => {
    await preloadMathJax();
    vi.stubGlobal('Image', RecordingImage);
    RecordingImage.srcs = [];

    const renders: Array<NonNullable<ReturnType<typeof renderMathToSVGDataURI>>> = [];
    for (let i = 0; i < 10; i++) {
      const r = renderMathToSVGDataURI(`x_{${i}}`, false, '#000');
      expect(r, `formula ${i} converts`).not.toBeNull();
      renders.push(r!);
    }

    // Paint the first formula while its render is still cached, creating a
    // raster entry.
    paintInlineMath(renders[0].uri, surface, box);
    const first = RecordingImage.srcs.filter((s) => s === renders[0].uri).length;
    expect(first).toBe(1);

    // 260 further conversions push renders[0] out of the bounded mathCache
    // (limit 256, oldest-first). The raster must go with it.
    for (let i = 10; i < 270; i++) {
      renderMathToSVGDataURI(`x_{${i}}`, false, '#000');
    }

    paintInlineMath(renders[0].uri, surface, box);
    const second = RecordingImage.srcs.filter((s) => s === renders[0].uri).length;
    expect(second).toBe(2); // a fresh entry re-decoded, not a survivor
  });

  it('caps the raster store, evicting the least-recently-painted bitmap', async () => {
    await preloadMathJax();
    vi.stubGlobal('Image', RecordingImage);
    RecordingImage.srcs = [];

    const renders: Array<NonNullable<ReturnType<typeof renderMathToSVGDataURI>>> = [];
    for (let i = 0; i < 270; i++) {
      const r = renderMathToSVGDataURI(`y_{${i}}`, false, '#000');
      expect(r, `formula ${i} converts`).not.toBeNull();
      renders.push(r!);
    }

    // Paint renders[0] once. Its render has already left mathCache (270 > 256
    // inserts), so only the raster cap can evict this entry.
    paintInlineMath(renders[0].uri, surface, box);

    // Painting 256 more distinct formulas fills the cap; renders[0] is the
    // oldest entry and must be evicted.
    for (let i = 1; i <= 256; i++) {
      paintInlineMath(renders[i].uri, surface, box);
    }

    paintInlineMath(renders[0].uri, surface, box);
    const count = RecordingImage.srcs.filter((s) => s === renders[0].uri).length;
    expect(count).toBe(2); // evicted by the cap, then re-decoded
  });
});
