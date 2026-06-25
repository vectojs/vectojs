// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { CanvasRenderer } from '../src/renderer/CanvasRenderer';

const mockCtx = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
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
  createLinearGradient: vi.fn(() => ({
    addColorStop: vi.fn(),
  })),
  // Mutable style state set by CanvasRenderer fill/stroke/fillText.
  fillStyle: '' as string,
  strokeStyle: '' as string,
  lineWidth: 1,
  lineCap: '' as string,
  lineJoin: '' as string,
  font: '',
  canvas: null as any,
};

const mockCanvas = {
  getContext: () => mockCtx,
  width: 0,
  height: 0,
  style: { width: '', height: '' },
};

mockCtx.canvas = mockCanvas;

(globalThis as any).window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 2,
  addEventListener: vi.fn(),
};

describe('CanvasRenderer', () => {
  it('constructor sets size with dpr scaling', () => {
    mockCtx.scale.mockClear();
    const renderer = new CanvasRenderer(mockCanvas as any);
    expect(renderer).toBeDefined();
    expect(mockCanvas.width).toBe(2048); // 1024 * 2 (dpr)
    expect(mockCanvas.height).toBe(1536); // 768 * 2 (dpr)
    expect(mockCtx.scale).toHaveBeenCalledWith(2, 2);
  });

  it('resize() updates size and canvas style', () => {
    mockCtx.scale.mockClear();
    const renderer = new CanvasRenderer(mockCanvas as any);
    renderer.resize(800, 600);
    expect(mockCanvas.width).toBe(1600); // 800 * 2
    expect(mockCanvas.height).toBe(1200); // 600 * 2
    expect(mockCanvas.style.width).toBe('800px');
    expect(mockCanvas.style.height).toBe('600px');
  });

  it('clear() delegates to clearRect()', () => {
    mockCtx.clearRect.mockClear();
    const renderer = new CanvasRenderer(mockCanvas as any);
    renderer.clear();
    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 1024, 768);
  });

  it('drawing path methods delegate to context', () => {
    const renderer = new CanvasRenderer(mockCanvas as any);

    mockCtx.beginPath.mockClear();
    renderer.beginPath();
    expect(mockCtx.beginPath).toHaveBeenCalled();

    mockCtx.moveTo.mockClear();
    renderer.moveTo(10, 20);
    expect(mockCtx.moveTo).toHaveBeenCalledWith(10, 20);

    mockCtx.lineTo.mockClear();
    renderer.lineTo(30, 40);
    expect(mockCtx.lineTo).toHaveBeenCalledWith(30, 40);

    mockCtx.bezierCurveTo.mockClear();
    renderer.bezierCurveTo(1, 2, 3, 4, 5, 6);
    expect(mockCtx.bezierCurveTo).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6);

    mockCtx.closePath.mockClear();
    renderer.closePath();
    expect(mockCtx.closePath).toHaveBeenCalled();

    mockCtx.arc.mockClear();
    renderer.arc(10, 20, 30, 0, Math.PI, true);
    expect(mockCtx.arc).toHaveBeenCalledWith(10, 20, 30, 0, Math.PI, true);

    mockCtx.roundRect.mockClear();
    renderer.roundRect(10, 20, 100, 200, 5);
    expect(mockCtx.roundRect).toHaveBeenCalledWith(10, 20, 100, 200, 5);

    mockCtx.drawImage.mockClear();
    const dummyImage = {} as any;
    renderer.drawImage(dummyImage, 0, 0, 100, 100);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(dummyImage, 0, 0, 100, 100);
  });

  it('fill() and stroke() apply colors', () => {
    const renderer = new CanvasRenderer(mockCanvas as any);

    mockCtx.fill.mockClear();
    renderer.fill('#ff0000');
    expect(mockCtx.fillStyle).toBe('#ff0000');
    expect(mockCtx.fill).toHaveBeenCalled();

    mockCtx.stroke.mockClear();
    renderer.stroke('#00ff00', 3);
    expect(mockCtx.strokeStyle).toBe('#00ff00');
    expect(mockCtx.lineWidth).toBe(3);
    expect(mockCtx.stroke).toHaveBeenCalled();
  });

  it('fillText() works', () => {
    const renderer = new CanvasRenderer(mockCanvas as any);
    mockCtx.fillText.mockClear();
    renderer.fillText('hello', 10, 20, '12px Arial', '#0000ff');
    expect(mockCtx.font).toBe('12px Arial');
    expect(mockCtx.fillStyle).toBe('#0000ff');
    expect(mockCtx.fillText).toHaveBeenCalledWith('hello', 10, 20);
  });

  it('createLinearGradient() sets stops and returns gradient', () => {
    const renderer = new CanvasRenderer(mockCanvas as any);
    const grad = renderer.createLinearGradient(0, 0, 100, 100, [
      { stop: 0, color: 'red' },
      { stop: 1, color: 'blue' },
    ]);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledWith(0, 0, 100, 100);
    expect(grad.addColorStop).toHaveBeenCalledTimes(2);
  });
});
