// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { TextRasterCache } from '../src/renderer/TextRasterCache';

/**
 * jsdom has no real 2D raster backend: `getContext('2d')` returns null unless
 * we stub it. We install a minimal mock context whose `measureText` reports a
 * width (jsdom omits `actualBoundingBox*`, exercising the cache's metric
 * fallbacks) so we can assert cache/stat behavior without a canvas engine.
 */
function stubCanvas2D(): { fillText: ReturnType<typeof vi.fn> } {
  const fillText = vi.fn();
  const ctx = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    scale: vi.fn(),
    fillText,
    measureText: (t: string) => ({ width: t.length * 8 }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return { fillText };
}

describe('TextRasterCache', () => {
  it('rasterizes a run once and reuses it (hit/miss accounting)', () => {
    const { fillText } = stubCanvas2D();
    const cache = new TextRasterCache();

    const a = cache.get('16px sans-serif', '#fff', 'hello');
    const b = cache.get('16px sans-serif', '#fff', 'hello');

    expect(a).not.toBeNull();
    expect(b).toBe(a); // same cached object
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1, size: 1 });
    expect(fillText).toHaveBeenCalledTimes(1); // rasterized only once
  });

  it('keys on font, color, and text independently', () => {
    stubCanvas2D();
    const cache = new TextRasterCache();
    cache.get('16px sans-serif', '#fff', 'x');
    cache.get('18px sans-serif', '#fff', 'x'); // different font
    cache.get('16px sans-serif', '#f00', 'x'); // different color
    cache.get('16px sans-serif', '#fff', 'y'); // different text
    expect(cache.stats.size).toBe(4);
    expect(cache.stats.misses).toBe(4);
  });

  it('produces a positive-sized bitmap with baseline offsets', () => {
    stubCanvas2D();
    const cache = new TextRasterCache();
    const r = cache.get('16px sans-serif', '#fff', 'abc')!;
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.offsetY).toBeGreaterThan(0);
    expect(r.canvas.width).toBeGreaterThan(0);
  });

  it('evicts oldest entries past maxEntries', () => {
    stubCanvas2D();
    const cache = new TextRasterCache({ maxEntries: 10 });
    for (let i = 0; i < 12; i++) cache.get('16px sans-serif', '#fff', 'run' + i);
    // Overflow triggered eviction of the oldest ~10%, so size stays bounded.
    expect(cache.stats.size).toBeLessThanOrEqual(10);
  });

  it('scales the backing store by dpr while keeping CSS-pixel blit size', () => {
    stubCanvas2D();
    const css = new TextRasterCache({ dpr: 1 }).get('16px sans-serif', '#fff', 'hi')!;
    const hi = new TextRasterCache({ dpr: 2 }).get('16px sans-serif', '#fff', 'hi')!;
    expect(hi.width).toBe(css.width); // blit size unchanged
    expect(hi.canvas.width).toBeGreaterThan(css.canvas.width); // backing store bigger
  });

  it('clear() empties the cache and resets stats', () => {
    stubCanvas2D();
    const cache = new TextRasterCache();
    cache.get('16px sans-serif', '#fff', 'a');
    cache.clear();
    expect(cache.stats).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });

  it('returns null in a headless (no-2D-context) environment', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const cache = new TextRasterCache();
    expect(cache.get('16px sans-serif', '#fff', 'x')).toBeNull();
  });
});
