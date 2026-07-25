// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene } from '../src';

/**
 * `syncOverlayGeometry` runs every synced frame and used to unconditionally write
 * ten style properties per overlay layer, even when the canvas box, the logical
 * size, and the CSS↔logical scale were all unchanged — which is the normal case
 * (they only move on resize, zoom, or an ancestor scroll). Identical assignments
 * still touch the CSSOM, and the write set grows with every layer. It now
 * memoizes the geometry it last wrote and returns early when nothing moved.
 *
 * The risk this guards is a stale-memo bug: a layer created *after* the first
 * sync, or a real geometry change, must still be written.
 */
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

describe('syncOverlayGeometry skips unchanged frames', () => {
  let scene: Scene;
  let canvas: HTMLCanvasElement;
  let parent: HTMLDivElement;

  /** Count style writes on the a11y root by instrumenting its style object. */
  const countWrites = (fn: () => void): number => {
    const root = (scene as any).a11yRoot as HTMLElement;
    let writes = 0;
    const realStyle = root.style;
    Object.defineProperty(root, 'style', {
      configurable: true,
      get: () =>
        new Proxy(realStyle, {
          set(t, p, v) {
            writes++;
            (t as any)[p] = v;
            return true;
          },
        }),
    });
    try {
      fn();
    } finally {
      Object.defineProperty(root, 'style', {
        configurable: true,
        value: realStyle,
        writable: true,
      });
    }
    return writes;
  };

  const sync = () => (scene as any).syncOverlayGeometry();

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    parent = document.createElement('div');
    canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    scene = new Scene(canvas);
  });

  it('writes styles on the first sync', () => {
    (scene as any)._overlayGeometry = null;
    expect(countWrites(sync)).toBeGreaterThan(0);
  });

  it('writes nothing on a second sync with unchanged geometry', () => {
    sync(); // prime the memo
    expect(countWrites(sync)).toBe(0);
  });

  it('writes again when the logical size changes', () => {
    sync();
    scene.width = 1234;
    expect(countWrites(sync)).toBeGreaterThan(0);
  });

  it('writes again when ONLY the logical size changes (CSS box held fixed)', () => {
    // Pin the CSS box so `cssWidth`/`cssHeight` stay constant. Then the only
    // thing that differs is `this.width`/`this.height`, which changes the
    // CSS↔logical scale — so dropping those two from the memo comparison (and
    // relying on the box alone) must be caught here.
    const rect = {
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    (canvas as any).getBoundingClientRect = () => rect;
    (parent as any).getBoundingClientRect = () => rect;

    scene.width = 800;
    scene.height = 600;
    sync(); // prime with a known box + size
    expect(countWrites(sync)).toBe(0);

    // Same CSS box, different logical size → scale changed, must re-write.
    scene.width = 400;
    scene.height = 300;
    expect(countWrites(sync)).toBeGreaterThan(0);
  });

  it('writes again when the canvas box moves', () => {
    sync();
    // Simulate a layout shift (ancestor scrolled / element moved).
    (canvas as any).getBoundingClientRect = () => ({
      left: 40,
      top: 60,
      width: 800,
      height: 600,
      right: 840,
      bottom: 660,
      x: 40,
      y: 60,
      toJSON: () => ({}),
    });
    expect(countWrites(sync)).toBeGreaterThan(0);
  });

  it('still positions a layer created after the first sync', () => {
    sync();
    expect(countWrites(sync)).toBe(0); // memo is warm

    // A new overlay layer appears (WebGL/WebGPU created lazily) — the memo must
    // be invalidated so the fresh layer actually gets positioned.
    (scene as any)._overlayGeometry = null;
    expect(countWrites(sync)).toBeGreaterThan(0);
  });
});
