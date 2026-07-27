// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { GlyphRasterAtlas } from '../src/renderer/GlyphRasterAtlas';

/**
 * jsdom has no real text rasterizer: `measureText` returns width 0 and no
 * `actualBoundingBox*`, so the production metric path cannot be exercised here.
 * These stubs give deterministic metrics so the packing, keying, eviction and
 * fallback logic — the parts with actual branches — are testable. The pixel
 * output is verified on real hardware by `benchmarks/raster-cache/` instead.
 */
function stubCanvas2D(charWidth = 9, ascent = 12, descent = 4): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  };
  proto.getContext = function (id: string) {
    if (id !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      canvas: this,
      measureText: (t: string) => ({
        width: t.length * charWidth,
        actualBoundingBoxAscent: ascent,
        actualBoundingBoxDescent: descent,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: t.length * charWidth,
        fontBoundingBoxAscent: ascent,
        fontBoundingBoxDescent: descent,
      }),
      fillText: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
    };
  } as never;
}

const FONT = '15px monospace';

describe('GlyphRasterAtlas', () => {
  beforeEach(() => {
    stubCanvas2D();
  });

  it('rasterizes on first request and reuses the slot after', () => {
    const atlas = new GlyphRasterAtlas();
    const a = atlas.get(FONT, '#fff', 'a');
    const b = atlas.get(FONT, '#fff', 'a');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(atlas.stats).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('keys on font, colour and glyph independently', () => {
    const atlas = new GlyphRasterAtlas();
    const base = atlas.get(FONT, '#fff', 'a')!;
    const otherColor = atlas.get(FONT, '#f00', 'a')!;
    const otherGlyph = atlas.get(FONT, '#fff', 'b')!;
    const otherFont = atlas.get('16px monospace', '#fff', 'a')!;
    // Distinct keys must occupy distinct positions, or one would blit another's
    // pixels — the failure this cache would be most likely to hide.
    const positions = new Set(
      [base, otherColor, otherGlyph, otherFont].map((s) => `${s.sx},${s.sy}`),
    );
    expect(positions.size).toBe(4);
    expect(atlas.stats.size).toBe(4);
  });

  it('never overlaps slots while packing a full ASCII set', () => {
    const atlas = new GlyphRasterAtlas();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let code = 33; code < 127; code++) {
      const slot = atlas.get(FONT, '#fff', String.fromCharCode(code));
      expect(slot).not.toBeNull();
      rects.push({ x: slot!.sx, y: slot!.sy, w: slot!.sw, h: slot!.sh });
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const disjoint =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `slot ${i} overlaps ${j}`).toBe(true);
      }
    }
  });

  it('keeps every slot inside the atlas bounds', () => {
    const atlas = new GlyphRasterAtlas({ maxSize: 256 });
    for (let code = 33; code < 127; code++) {
      const slot = atlas.get(FONT, '#fff', String.fromCharCode(code));
      if (!slot) continue;
      expect(slot.sx).toBeGreaterThanOrEqual(0);
      expect(slot.sy).toBeGreaterThanOrEqual(0);
      expect(slot.sx + slot.sw).toBeLessThanOrEqual(256);
      expect(slot.sy + slot.sh).toBeLessThanOrEqual(256);
    }
  });

  it('resets and keeps serving when the atlas fills up', () => {
    // Small enough that a modest glyph set overflows and forces the reset path.
    const atlas = new GlyphRasterAtlas({ maxSize: 256 });
    let served = 0;
    for (let i = 0; i < 400; i++) {
      // Vary the colour so every request is a distinct key and the atlas cannot
      // satisfy them from existing slots.
      if (atlas.get(FONT, `#${(i % 4096).toString(16).padStart(3, '0')}`, 'x')) served++;
    }
    expect(atlas.stats.resets).toBeGreaterThan(0);
    // The point of the assertion: overflow must degrade to re-rasterizing, never
    // to returning null or throwing.
    expect(served).toBe(400);
  });

  it('places a glyph at the origin of a freshly reset atlas', () => {
    const atlas = new GlyphRasterAtlas();
    const first = atlas.get(FONT, '#fff', 'a')!;
    atlas.reset();
    const afterReset = atlas.get(FONT, '#fff', 'z')!;
    expect({ sx: afterReset.sx, sy: afterReset.sy }).toEqual({
      sx: first.sx,
      sy: first.sy,
    });
    expect(atlas.stats.size).toBe(1);
  });

  it('scales source rects by dpr but keeps destination size in CSS pixels', () => {
    const one = new GlyphRasterAtlas({ dpr: 1 }).get(FONT, '#fff', 'a')!;
    const two = new GlyphRasterAtlas({ dpr: 2 }).get(FONT, '#fff', 'a')!;
    expect(two.w).toBe(one.w);
    expect(two.h).toBe(one.h);
    expect(two.offsetX).toBe(one.offsetX);
    expect(two.offsetY).toBe(one.offsetY);
    // Source rect doubles: that is what keeps a HiDPI blit crisp.
    expect(two.sw).toBe(one.sw * 2);
    expect(two.sh).toBe(one.sh * 2);
  });

  it('rejects multi-character runs so callers fall back to fillText', () => {
    const atlas = new GlyphRasterAtlas();
    expect(atlas.get(FONT, '#fff', 'const answer = 42;')).toBeNull();
    expect(atlas.get(FONT, '#fff', '')).toBeNull();
    // A combining cluster is legitimately multi-code-unit and must be accepted.
    expect(atlas.get(FONT, '#fff', 'e\u0301')).not.toBeNull();
  });

  it('remembers a rejection instead of re-measuring it every frame', () => {
    const atlas = new GlyphRasterAtlas();
    const long = 'a whole line of code';
    atlas.get(FONT, '#fff', long);
    expect(atlas.stats.misses).toBe(1);
    atlas.get(FONT, '#fff', long);
    atlas.get(FONT, '#fff', long);
    // A remembered rejection returns before the miss counter, so `misses` staying
    // at 1 across three calls IS the evidence that the measure path ran once. It
    // counts as neither hit nor miss: it is not a served glyph, and counting it as
    // a miss would make a caller watching the hit rate believe the atlas was
    // thrashing while it is doing the cheapest possible thing.
    expect(atlas.stats).toMatchObject({ hits: 0, misses: 1, size: 1 });
  });

  it('rejects a glyph too large to ever pack', () => {
    stubCanvas2D(4000, 4000, 1000);
    const atlas = new GlyphRasterAtlas({ maxSize: 256 });
    expect(atlas.get(FONT, '#fff', 'W')).toBeNull();
    // Must not thrash: an unpackable glyph resets nothing.
    expect(atlas.stats.resets).toBe(0);
  });

  it('exposes no source before first use and a canvas after', () => {
    const atlas = new GlyphRasterAtlas();
    expect(atlas.source).toBeNull();
    atlas.get(FONT, '#fff', 'a');
    expect(atlas.source).not.toBeNull();
    atlas.destroy();
    expect(atlas.source).toBeNull();
    expect(atlas.stats).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });

  it('returns null in a context without document', () => {
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: unknown;
    };
    const saved = proto.getContext;
    proto.getContext = (() => null) as never;
    const atlas = new GlyphRasterAtlas();
    expect(atlas.get(FONT, '#fff', 'a')).toBeNull();
    proto.getContext = saved as never;
  });
});
