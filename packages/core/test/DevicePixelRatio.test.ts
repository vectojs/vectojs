// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src';

// A controllable matchMedia: records listeners per query and lets a test fire a
// `change`. Mirrors the browser contract Scene.watchDevicePixelRatio relies on.
function installMatchMedia() {
  const lists: Array<{ media: string; handler: () => void; mql: any }> = [];
  (window as any).matchMedia = (media: string) => {
    const mql: any = {
      media,
      matches: false,
      addEventListener: (_type: string, handler: () => void) => {
        lists.push({ media, handler, mql });
      },
      removeEventListener: (_type: string, handler: () => void) => {
        const i = lists.findIndex((l) => l.handler === handler);
        if (i >= 0) lists.splice(i, 1);
      },
    };
    return mql;
  };
  return {
    lists,
    fireChange() {
      // Snapshot first: a handler re-arms by pushing a fresh query onto `lists`
      // mid-iteration, so iterate a copy to avoid firing the just-added one.
      for (const l of lists.slice()) l.handler();
    },
  };
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('runtime devicePixelRatio change', () => {
  let scene: Scene;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    (window as any).devicePixelRatio = 1;
  });
  afterEach(() => {
    scene?.destroy();
  });

  it('re-runs resize when the (resolution) media query fires (monitor move / zoom)', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    // A dpr query was armed.
    expect(mm.lists.length).toBeGreaterThan(0);
    const resizeSpy = vi.spyOn(scene, 'resize');

    // Simulate DPR change → the change handler re-applies the scale.
    (window as any).devicePixelRatio = 2;
    mm.fireChange();

    expect(resizeSpy).toHaveBeenCalledWith(scene.width, scene.height);
  });

  it('repaints synchronously on a DPR change, before the browser can composite', () => {
    // `resize` assigns `canvas.width`/`canvas.height`, which per spec CLEARS the
    // backing store. Only marking dirty leaves the canvas transparent until the
    // next rAF, so a full-viewport scene flashes its page background on every
    // zoom step. The repaint has to happen in this same task.
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    const renderSpy = vi.spyOn(scene, 'render');
    (window as any).devicePixelRatio = 2;
    mm.fireChange();

    // Synchronously, not on a later frame.
    expect(renderSpy).toHaveBeenCalled();
  });

  it('skips the repaint while the drawing context is lost', () => {
    // Every draw call is a no-op against a lost context, and its own
    // `contextrestored` handler owns the repaint.
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    const renderer = scene.getRenderer() as { isContextLost?: () => boolean };
    renderer.isContextLost = () => true;
    const renderSpy = vi.spyOn(scene, 'render');

    (window as any).devicePixelRatio = 2;
    mm.fireChange();

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('re-arms a fresh query for the new DPR after a change', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    const firstQuery = mm.lists[mm.lists.length - 1]!.media;
    expect(firstQuery).toContain('1dppx');

    (window as any).devicePixelRatio = 1.5;
    mm.fireChange();

    // A new query for 1.5dppx is now armed (old one detached).
    const armed = mm.lists.map((l) => l.media);
    expect(armed.some((m) => m.includes('1.5dppx'))).toBe(true);
  });

  it('detaches the dpr listener on destroy', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);
    expect(mm.lists.length).toBeGreaterThan(0);

    scene.destroy();
    expect(mm.lists.length).toBe(0);
  });

  it('sizes the WebGPU particle canvas backing store by DPR (crisp on HiDPI)', () => {
    (window as any).devicePixelRatio = 2;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);
    // Inject a fake gpuCanvas (the WebGPU init path only runs with a real GPU).
    const gpu = document.createElement('canvas');
    (scene as any).gpuCanvas = gpu;

    scene.resize(400, 300);
    // Backing store at logical × DPR; CSS box at logical size.
    expect(gpu.width).toBe(800);
    expect(gpu.height).toBe(600);
    expect(gpu.style.width).toBe('400px');
    expect(gpu.style.height).toBe('300px');
  });

  it('honors maxDPR when sizing the WebGPU particle canvas', () => {
    (window as any).devicePixelRatio = 3;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxDPR: 2 });
    const gpu = document.createElement('canvas');
    (scene as any).gpuCanvas = gpu;

    scene.resize(100, 100);
    expect(gpu.width).toBe(200); // clamped to maxDPR 2, not 3
    expect(gpu.height).toBe(200);
  });
});

describe('embedded (disableWindowResize) canvas ResizeObserver', () => {
  let scene: Scene;
  const observed: Array<{ cb: ResizeObserverCallback; el: Element }> = [];
  let origRO: typeof ResizeObserver;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    (window as any).devicePixelRatio = 1;
    observed.length = 0;
    origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observed.push({ cb: this.cb, el });
      }
      unobserve() {}
      disconnect() {
        const i = observed.findIndex((o) => o.cb === this.cb);
        if (i >= 0) observed.splice(i, 1);
      }
    } as never;
  });
  afterEach(() => {
    scene?.destroy();
    globalThis.ResizeObserver = origRO;
  });

  it('resizes the scene when the observed canvas element changes size', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas, {
      disableWindowResize: true,
      width: 100,
      height: 80,
    });
    expect(observed.length).toBe(1);
    expect(observed[0].el).toBe(canvas);

    const resizeSpy = vi.spyOn(scene, 'resize');
    // Simulate the element resizing to 250×160.
    observed[0].cb(
      [{ contentRect: { width: 250, height: 160 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(resizeSpy).toHaveBeenCalledWith(250, 160);
  });

  it('ignores a no-op size report (same dimensions)', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas, {
      disableWindowResize: true,
      width: 120,
      height: 90,
    });
    const resizeSpy = vi.spyOn(scene, 'resize');
    // Report the scene's CURRENT size back — nothing changed, so no resize().
    observed[0].cb(
      [
        {
          contentRect: { width: scene.width, height: scene.height },
        } as ResizeObserverEntry,
      ],
      {} as ResizeObserver,
    );
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('disconnects the observer on destroy', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas, {
      disableWindowResize: true,
      width: 100,
      height: 80,
    });
    expect(observed.length).toBe(1);
    scene.destroy();
    expect(observed.length).toBe(0);
  });
});
