// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { SplineEntity, polySegmentToBezier } from '../src/components/SplineEntity';
import type { SplineDocument } from '../src/components/SplineEntity';
import sampleJson from './fixtures/sample-spline.json';

const sample = sampleJson as SplineDocument;

// A mock renderer recording the fallback (per-frame curve) draw path.
function mockRenderer() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setGlobalAlpha: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => ({})),
  };
}

describe('polySegmentToBezier', () => {
  it('converts cubic polynomial coefficients to bezier control points', () => {
    // x = 0 + 3t + 0 + 0 ; y = 0 + 0 + 0 + 0  -> straight segment from (0,0) to (3,0)
    const b = polySegmentToBezier({
      start_t: 0,
      end_t: 1,
      x_poly: [0, 3, 0, 0],
      y_poly: [0, 0, 0, 0],
    });
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
    expect(b.cp1x).toBeCloseTo(1); // 0 + 3/3
    expect(b.cp2x).toBeCloseTo(2); // 0 + 2*3/3 + 0/3
    expect(b.x3).toBeCloseTo(3); // 0+3+0+0
    expect(b.y3).toBeCloseTo(0);
  });
});

describe('SplineEntity', () => {
  it('takes bounds from bounding_box and exposes them via getBounds()', () => {
    const e = new SplineEntity(sample);
    const [minX, minY, maxX, maxY] = sample.bounding_box!;
    const b = e.getBounds()!;
    expect(b.x).toBeCloseTo(minX);
    expect(b.y).toBeCloseTo(minY);
    expect(b.width).toBeCloseTo(maxX - minX);
    expect(b.height).toBeCloseTo(maxY - minY);
    expect(e.width).toBeCloseTo(maxX - minX);
  });

  it('computes bounds from segments when bounding_box is absent', () => {
    const doc: SplineDocument = {
      type: 'Spline',
      equations: [
        {
          color_rgb: null,
          data: [{ start_t: 0, end_t: 1, x_poly: [10, 0, 0, 0], y_poly: [20, 0, 0, 0] }],
        },
      ],
    };
    const e = new SplineEntity(doc);
    const b = e.getBounds()!;
    expect(b.x).toBeCloseTo(10);
    expect(b.y).toBeCloseTo(20);
  });

  it('AABB hit-test against world bounds', () => {
    const e = new SplineEntity(sample).setPosition(100, 100);
    const [minX, minY, maxX, maxY] = sample.bounding_box!;
    expect(e.isPointInside(100 + minX + 1, 100 + minY + 1)).toBe(true);
    expect(e.isPointInside(100 + maxX + 5, 100 + maxY + 5)).toBe(false);
    expect(e.isPointInside(0, 0)).toBe(false);
  });

  it('fallback render strokes each segment (no OffscreenCanvas)', () => {
    const e = new SplineEntity(sample, { cache: false });
    const r = mockRenderer();
    e.render(r as any);
    expect(r.moveTo).toHaveBeenCalled();
    expect(r.bezierCurveTo).toHaveBeenCalled();
    expect(r.stroke).toHaveBeenCalled();
    expect(r.drawImage).not.toHaveBeenCalled();
  });

  it('cached render bakes once and drawImage()s the offscreen canvas', () => {
    // Stub OffscreenCanvas with a 2D context recorder.
    const bakeCtx = {
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
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return bakeCtx;
      }
    }
    const prev = (globalThis as any).OffscreenCanvas;
    (globalThis as any).OffscreenCanvas = FakeOffscreen as any;
    try {
      const e = new SplineEntity(sample); // cache defaults true
      const r = mockRenderer();
      e.render(r as any);
      e.render(r as any);
      expect(bakeCtx.stroke).toHaveBeenCalledTimes(sample.equations.length); // baked once
      expect(r.drawImage).toHaveBeenCalledTimes(2); // blitted each frame
      expect(r.bezierCurveTo).not.toHaveBeenCalled(); // not the fallback path
    } finally {
      (globalThis as any).OffscreenCanvas = prev;
    }
  });

  it('null color falls back to defaultColor; [r,g,b] becomes an rgb() string', () => {
    const e = new SplineEntity(
      { type: 'Spline', equations: [{ color_rgb: [1, 0, 0], data: sample.equations[0].data }] },
      { cache: false },
    );
    const r = mockRenderer();
    e.render(r as any);
    expect(r.stroke).toHaveBeenCalledWith('rgb(255, 0, 0)', expect.any(Number));
  });

  it('defaults to interactive = true for a11y shadow event dispatch', () => {
    const e = new SplineEntity(sample);
    expect(e.interactive).toBe(true);
  });

  it('showBounds defaults to false', () => {
    const e = new SplineEntity(sample);
    expect(e.showBounds).toBe(false);
  });

  it('renders bounding-box outline when showBounds is true', () => {
    const e = new SplineEntity(sample, { cache: false });
    e.showBounds = true;
    const r = mockRenderer();
    e.render(r as any);
    // roundRect is called for the bounds overlay
    expect(r.roundRect).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      4,
    );
    // stroke is called at least once for the bounding box
    expect(r.stroke).toHaveBeenCalledWith('rgba(0, 150, 255, 0.8)', 2);
  });

  it('does NOT render bounding-box outline when showBounds is false', () => {
    const e = new SplineEntity(sample, { cache: false });
    e.showBounds = false;
    const r = mockRenderer();
    e.render(r as any);
    // roundRect should not be called for bounds overlay
    expect(r.roundRect).not.toHaveBeenCalled();
  });
});
