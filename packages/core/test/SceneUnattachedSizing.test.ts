// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '../src/index';

// jsdom doesn't implement canvas getContext; the shared font measurer takes its
// portable null-fallback silently. Scene.resize() reaches the renderer's
// `ctx.canvas`, though, so each canvas gets a minimal fake 2D context with a
// `canvas` back-reference (same shape as the mocks in Scene.test.ts).
function fakeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return {
    canvas,
    scale: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(
      () =>
        ({
          width: 20,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }) as TextMetrics,
    ),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getContext = (() => fakeCtx(canvas)) as unknown as typeof canvas.getContext;
  return canvas;
}

/** Deterministic ResizeObserver stand-in: jsdom has neither layout nor RO, so
 *  tests fire the callback explicitly to simulate the canvas gaining a box. */
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  fire(width: number, height: number): void {
    const entry = {
      contentRect: {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      },
    };
    this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe('Scene sizing for unattached canvases (#817)', () => {
  beforeEach(() => {
    StubResizeObserver.instances.length = 0;
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('starts a detached canvas at 0×0 instead of inheriting the window viewport', () => {
    const canvas = makeCanvas();
    const scene = new Scene(canvas);
    expect(scene.width).toBe(0);
    expect(scene.height).toBe(0);
  });

  it('keeps the window viewport when the canvas is attached at construction', () => {
    const canvas = makeCanvas();
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    expect(scene.width).toBe(window.innerWidth);
    expect(scene.height).toBe(window.innerHeight);
  });

  it('adopts the window viewport once the attached canvas gains layout', () => {
    const canvas = makeCanvas();
    const scene = new Scene(canvas);
    expect(scene.width).toBe(0);

    document.body.appendChild(canvas);
    const ro = StubResizeObserver.instances.at(-1)!;
    ro.fire(800, 600);

    // Full-window contract: adoption mirrors the window resize handler —
    // window dims, not the element box.
    expect(scene.width).toBe(window.innerWidth);
    expect(scene.height).toBe(window.innerHeight);
  });

  it('ignores zero-sized layout boxes and stays latched until a real one arrives', () => {
    const canvas = makeCanvas();
    const scene = new Scene(canvas);
    document.body.appendChild(canvas);
    const ro = StubResizeObserver.instances.at(-1)!;

    ro.fire(0, 0); // attached but hidden (display:none ancestor), no layout yet
    expect(scene.width).toBe(0);
    expect(scene.height).toBe(0);
    expect(ro.disconnected).toBe(false);

    ro.fire(800, 600);
    expect(scene.width).toBe(window.innerWidth);
  });

  it('respects an explicit resize() issued before attachment', () => {
    const canvas = makeCanvas();
    const scene = new Scene(canvas);
    scene.resize(400, 300);

    document.body.appendChild(canvas);
    const ro = StubResizeObserver.instances.at(-1)!;
    ro.fire(800, 600);

    expect(scene.width).toBe(400);
    expect(scene.height).toBe(300);
  });

  it('disconnects the latch observer after adoption and on destroy()', () => {
    const canvas = makeCanvas();
    const scene = new Scene(canvas);
    const ro = StubResizeObserver.instances.at(-1)!;

    scene.destroy();
    expect(ro.disconnected).toBe(true);

    const canvas2 = makeCanvas();
    const scene2 = new Scene(canvas2);
    document.body.appendChild(canvas2);
    const ro2 = StubResizeObserver.instances.at(-1)!;
    ro2.fire(800, 600);
    expect(scene2.width).toBe(window.innerWidth);
    expect(ro2.disconnected).toBe(true);
    scene2.destroy();
  });

  it('leaves disableWindowResize scenes untouched (inline style precedence)', () => {
    const canvas = makeCanvas();
    canvas.style.width = '320px';
    canvas.style.height = '240px';
    const scene = new Scene(canvas, { disableWindowResize: true });
    expect(scene.width).toBe(320);
    expect(scene.height).toBe(240);
    scene.destroy();
  });
});
