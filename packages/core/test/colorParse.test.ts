// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { parseColorToRGBA } from '../src/renderer/colorParse';

describe('parseColorToRGBA', () => {
  it('parses #rgb shorthand to normalized rgba', () => {
    const [r, g, b, a] = parseColorToRGBA('#f00');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(1);
  });

  it('parses #rrggbb', () => {
    const [r, g, b, a] = parseColorToRGBA('#38bdf8');
    expect(r).toBeCloseTo(0x38 / 255);
    expect(g).toBeCloseTo(0xbd / 255);
    expect(b).toBeCloseTo(0xf8 / 255);
    expect(a).toBe(1);
  });

  it('parses #rrggbbaa with alpha', () => {
    const [, , , a] = parseColorToRGBA('#ff000080');
    expect(a).toBeCloseTo(0x80 / 255, 2);
  });

  it('parses rgb() and rgba()', () => {
    expect(parseColorToRGBA('rgb(255, 128, 0)')).toEqual([1, expect.closeTo(128 / 255), 0, 1]);
    const [, , , a] = parseColorToRGBA('rgba(0, 0, 0, 0.5)');
    expect(a).toBeCloseTo(0.5);
  });

  it('parses percentage alpha in rgba() (legacy comma syntax)', () => {
    const [r, g, b, a] = parseColorToRGBA('rgba(255, 0, 0, 50%)');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(0.5); // 50% → 0.5, not 50
  });

  it('parses modern space-separated rgb() with slash alpha', () => {
    const [r, g, b, a] = parseColorToRGBA('rgb(255 0 0 / 50%)');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(0.5);
  });

  it('parses modern slash alpha as a 0..1 number', () => {
    const [, , , a] = parseColorToRGBA('rgb(0 0 0 / 0.25)');
    expect(a).toBeCloseTo(0.25);
  });

  it('clamps out-of-range channels and alpha to [0, 1] (matching CSS/Canvas)', () => {
    expect(parseColorToRGBA('rgb(300, -5, 0)')).toEqual([1, 0, 0, 1]);
    const [, , , a] = parseColorToRGBA('rgba(0, 0, 0, 1.5)');
    expect(a).toBe(1);
  });

  it('caches repeated lookups (same array identity)', () => {
    const a = parseColorToRGBA('#123456');
    const b = parseColorToRGBA('#123456');
    expect(a).toBe(b); // cached, not re-parsed
  });

  it('evicts least-recently-used entries instead of growing unbounded', () => {
    // Point-cloud/particle rendering reads a color every frame (see
    // Entity.getBatchCircle's doc comment), so a workload with thousands of
    // distinctly-colored, continuously-varying entities can mint a new unique
    // color string every frame — this cache must not remember all of them
    // forever.
    const seed = parseColorToRGBA('#123456');
    for (let i = 0; i < 2000; i++) {
      parseColorToRGBA(`#${(i % 0xffffff).toString(16).padStart(6, '0')}`);
    }
    const reparsed = parseColorToRGBA('#123456');
    expect(reparsed).not.toBe(seed); // evicted -> freshly parsed, new array
    expect(reparsed).toEqual(seed); // but numerically the same color
  });

  it('falls back to a 1x1 canvas for named colors when DOM is present', () => {
    // jsdom canvas getContext is stubbed elsewhere; provide a deterministic stub here.
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([0, 128, 0, 255]) }));
    const ctx = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData,
    };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => ctx,
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement);
    try {
      const [r, g, b, a] = parseColorToRGBA('seagreen');
      expect(r).toBeCloseTo(0);
      expect(g).toBeCloseTo(128 / 255);
      expect(b).toBeCloseTo(0);
      expect(a).toBeCloseTo(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('clears the shared 1x1 canvas before each fallback parse (no alpha compositing)', async () => {
    // Fresh module so the cached fallbackCtx from earlier tests doesn't leak in.
    vi.resetModules();
    const clearRect = vi.fn();
    const fillRect = vi.fn();
    const ctx = {
      fillStyle: '',
      clearRect,
      fillRect,
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([255, 0, 0, 128]) })),
    };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement);
    try {
      const mod = await import('../src/renderer/colorParse');
      mod.parseColorToRGBA('some-semitransparent-named-color');
      // A semi-transparent fill over a dirty canvas blends with the previous
      // parse's pixel; the canvas must be cleared first, every time.
      expect(clearRect).toHaveBeenCalledWith(0, 0, 1, 1);
      expect(clearRect.mock.invocationCallOrder[0]).toBeLessThan(
        fillRect.mock.invocationCallOrder[0],
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('returns opaque black for unparseable input without DOM', () => {
    const prev = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(parseColorToRGBA('not-a-color-xyz')).toEqual([0, 0, 0, 1]);
    } finally {
      (globalThis as { document?: unknown }).document = prev;
    }
  });
});
