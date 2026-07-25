// @vitest-environment jsdom
// Canvas2D context loss (GPU reset / memory pressure) must not permanently blank
// the canvas: the renderer skips drawing while lost, and re-acquires + repaints
// on `contextrestored`. `contextlost` MUST be preventDefault-ed or the browser
// never fires `contextrestored`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvasRenderer } from '../src/renderer/CanvasRenderer';

function fakeCtx() {
  const calls: Record<string, number> = {};
  const rec = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const ctx = new Proxy({ calls } as any, {
    get(t, prop) {
      if (prop === 'calls') return t.calls;
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 8 });
      if (prop === 'canvas') return { width: 0, height: 0, style: {} };
      return rec(String(prop));
    },
    set: () => true,
  });
  return ctx as unknown as CanvasRenderingContext2D & {
    calls: Record<string, number>;
  };
}

describe('CanvasRenderer — Canvas2D context loss recovery', () => {
  let canvas: HTMLCanvasElement;
  beforeEach(() => {
    canvas = document.createElement('canvas');
    (canvas as any).getContext = () => fakeCtx();
  });

  it('preventDefault()s contextlost so the browser will restore', () => {
    const r = new CanvasRenderer(canvas, { width: 100, height: 100 });
    expect(r.isContextLost?.()).toBe(false);
    const e = new Event('contextlost', { cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(r.isContextLost?.()).toBe(true);
  });

  it('skips clear() while the context is lost, resumes after restore', () => {
    const r = new CanvasRenderer(canvas, { width: 100, height: 100 });
    const before = r.getContext() as any;
    r.clear();
    const clearedWhileOk = before.calls.clearRect ?? 0;
    expect(clearedWhileOk).toBeGreaterThan(0);

    canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
    const lostCtx = r.getContext() as any;
    const baseline = lostCtx.calls.clearRect ?? 0;
    r.clear(); // no-op while lost
    expect(lostCtx.calls.clearRect ?? 0).toBe(baseline);

    canvas.dispatchEvent(new Event('contextrestored'));
    expect(r.isContextLost?.()).toBe(false);
    const newCtx = r.getContext() as any;
    r.clear();
    expect(newCtx.calls.clearRect ?? 0).toBeGreaterThan(0); // drawing again
  });

  it('re-acquires a fresh 2D context + fires the restored callback', () => {
    const r = new CanvasRenderer(canvas, { width: 100, height: 100 });
    const restored = vi.fn();
    r.onContextRestored?.(restored);
    const ctxBefore = r.getContext();

    canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('contextrestored'));

    expect(restored).toHaveBeenCalledOnce();
    expect(r.getContext()).not.toBe(ctxBefore); // fresh context
    expect(r.isContextLost?.()).toBe(false);
  });
});
