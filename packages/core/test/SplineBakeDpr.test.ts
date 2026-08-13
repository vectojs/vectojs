// @vitest-environment jsdom
//
// SplineEntity's baked bitmap must rasterize at the RENDERER's device-pixel
// ratio — the value the backing store is actually scaled by, including its
// maxDPR clamp — not the raw window ratio. And because the ratio is live
// (browser zoom, a monitor move), a change must RE-BAKE: a baked flag that
// ignores the ratio blits a bitmap at the wrong device density forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplineEntity, type SplineDocument } from '../src/index';

const DOC: SplineDocument = {
  type: 'Spline',
  equations: [
    {
      color_rgb: [1, 1, 1],
      data: [{ start_t: 0, end_t: 1, x_poly: [0, 100, 0, 0], y_poly: [0, 0, 0, 0] }],
    },
  ],
  bounding_box: [0, 0, 100, 100],
};

/** Every OffscreenCanvas the component creates, in order. */
const created: Array<{ width: number; height: number }> = [];
const scales: number[] = [];

function ctx2d() {
  return {
    scale: (s: number) => scales.push(s),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    stroke: vi.fn(),
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
  };
}

class FakeOffscreenCanvas {
  public width: number;
  public height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    created.push({ width, height });
  }
  getContext(): ReturnType<typeof ctx2d> {
    return ctx2d();
  }
}

function rendererWith(pixelRatio?: number) {
  const renderer = {
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    stroke: vi.fn(),
    ...(pixelRatio === undefined ? {} : { pixelRatio }),
  };
  return renderer;
}

const LOGICAL_W = 112; // ceil(100) + 2 * (lineWidth 4 + pad 2)
const LOGICAL_H = 112;

describe('SplineEntity bake device-pixel ratio', () => {
  beforeEach(() => {
    created.length = 0;
    scales.length = 0;
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
    (globalThis as { window?: unknown }).window = {
      devicePixelRatio: 3,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  });

  it('bakes at the renderer pixelRatio (maxDPR clamp), not the raw window ratio', () => {
    const s = new SplineEntity(DOC, { lineWidth: 4 });
    s.render(rendererWith(2) as never);

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ width: LOGICAL_W * 2, height: LOGICAL_H * 2 });
    expect(scales).toEqual([2]);
  });

  it('re-bakes when the renderer pixelRatio changes between frames', () => {
    const s = new SplineEntity(DOC, { lineWidth: 4 });
    s.render(rendererWith(2) as never);
    expect(created).toHaveLength(1);

    // Same entity, same geometry, but the backing store density changed (a
    // zoom, a maxDPR change, a monitor move) — the cached bitmap no longer
    // matches the destination density and must be re-rasterized.
    s.render(rendererWith(1) as never);
    expect(created).toHaveLength(2);
    expect(created[1]).toEqual({ width: LOGICAL_W, height: LOGICAL_H });
  });

  it('falls back to the window ratio for a renderer that exposes none', () => {
    const s = new SplineEntity(DOC, { lineWidth: 4 });
    s.render(rendererWith() as never);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ width: LOGICAL_W * 3, height: LOGICAL_H * 3 });
  });
});
