// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '../src/index';
import { Entity } from '../src/tree/Entity';

function fakeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return {
    canvas,
    scale: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setTransform: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(
      () =>
        ({
          width: 20,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }) as unknown as TextMetrics,
    ),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    stroke: vi.fn(),
    roundRect: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() }) as unknown as CanvasGradient),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
    getTransform: vi.fn(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as unknown as DOMMatrix),
  } as unknown as CanvasRenderingContext2D;
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas') as HTMLCanvasElement;
  (
    canvas as unknown as { getContext: (type: string) => CanvasRenderingContext2D | null }
  ).getContext = (() => fakeCtx(canvas)) as unknown as typeof canvas.getContext;
  // jsdom canvas has no style by default; add minimal
  (canvas as unknown as { style: CSSStyleDeclaration }).style = {
    width: '',
    height: '',
  } as unknown as CSSStyleDeclaration;
  return canvas;
}

class Box extends Entity {
  constructor() {
    super();
    this.interactive = true;
    this.width = 100;
    this.height = 100;
    this.x = 50;
    this.y = 50;
  }
  isPointInside(x: number, y: number): boolean {
    return x >= 0 && x <= 100 && y >= 0 && y <= 100;
  }
}

describe('Scene resize DPR transitions (CTX-0530)', () => {
  const originalDpr = (window as unknown as { devicePixelRatio: number }).devicePixelRatio;

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = originalDpr;
    document.body.innerHTML = '';
  });

  it('resizes backing store correctly across DPR 1 -> 1.1 -> 2', () => {
    const canvas = makeCanvas();
    document.body.appendChild(canvas);
    const scene = new Scene(canvas, { disableWindowResize: true });
    // initial DPR 1
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1;
    scene.resize(800, 600);
    expect(scene.width).toBe(800);
    expect(scene.height).toBe(600);
    expect(canvas.style.width).toBe('800px');
    expect(canvas.style.height).toBe('600px');
    // backing store at DPR 1 should be 800x600
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(scene.getRenderer().pixelRatio).toBe(1);

    const box = new Box();
    scene.add(box);
    // Box at 50,50 size 100 => covers 50-150
    expect(scene.findEntityAt(75, 75)).toBe(box);
    expect(scene.findEntityAt(200, 200)).toBeNull();

    // DPR 1.1000000685 (110% zoom) — logical size stays 800x600, backing scales
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1.1000000685453415;
    scene.resize(800, 600);
    expect(canvas.width).toBe(Math.round(800 * 1.1000000685453415));
    expect(canvas.height).toBe(Math.round(600 * 1.1000000685453415));
    expect(scene.getRenderer().pixelRatio).toBeCloseTo(1.1000000685, 5);
    // hit testing still works after DPR change
    expect(scene.findEntityAt(75, 75)).toBe(box);

    // DPR 2
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
    scene.resize(800, 600);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(scene.getRenderer().pixelRatio).toBe(2);
    expect(scene.findEntityAt(75, 75)).toBe(box);

    // NaN/Infinity DPR should not break — backing store falls back to 1
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = NaN as unknown as number;
    scene.resize(800, 600);
    expect(canvas.width).toBe(800);
    expect(scene.getRenderer().pixelRatio).toBe(1);

    (window as unknown as { devicePixelRatio: number }).devicePixelRatio =
      Infinity as unknown as number;
    scene.resize(800, 600);
    expect(canvas.width).toBe(800);
    expect(scene.getRenderer().pixelRatio).toBe(1);

    (window as unknown as { devicePixelRatio: number }).devicePixelRatio =
      Infinity as unknown as number;
    scene.resize(800, 600);
    expect(canvas.width).toBe(800);

    scene.destroy();
  });

  it('rejects NaN/Infinity dimensions and keeps previous size', () => {
    const canvas = makeCanvas();
    document.body.appendChild(canvas);
    const scene = new Scene(canvas, { disableWindowResize: true });
    scene.resize(800, 600);
    const prevW = scene.width;
    const prevH = scene.height;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scene.resize(NaN, 600);
    expect(scene.width).toBe(prevW);
    scene.resize(800, Infinity);
    expect(scene.height).toBe(prevH);
    scene.resize(-10, 600);
    expect(scene.width).toBe(prevW);
    warn.mockRestore();
    scene.destroy();
  });

  it('handles 0 height (mobile URL bar) without producing NaN canvas', () => {
    const canvas = makeCanvas();
    document.body.appendChild(canvas);
    const scene = new Scene(canvas, { disableWindowResize: true });
    scene.resize(800, 0);
    expect(scene.width).toBe(800);
    expect(scene.height).toBe(0);
    // backing store must be at least 1x1
    expect(canvas.width).toBeGreaterThanOrEqual(1);
    expect(canvas.height).toBeGreaterThanOrEqual(1);
    scene.destroy();
  });
});
