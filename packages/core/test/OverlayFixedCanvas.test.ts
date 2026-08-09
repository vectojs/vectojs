// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src';

/**
 * A `position: fixed` canvas is the standard full-viewport scene: the page
 * scrolls behind a pinned canvas. The browser composites that canvas against the
 * viewport instantly and off the main thread, but the overlay layers used to be
 * `position: absolute` — laid out against the scrolling document — so staying
 * aligned meant re-deriving `top` from the parent's rect and writing it once per
 * RENDERED frame.
 *
 * Any frame where scroll advanced but the render loop had not run yet therefore
 * left the overlay stale by that frame's whole scroll delta, and a selection
 * highlight visibly detached from its glyphs. Measured on a live full-viewport
 * scene under real key-driven smooth scroll over 630px: 661 frames, one of them
 * misaligned by 64.8px; with the overlay positioned like the canvas, 655 frames
 * and a worst misalignment of 0.000px.
 *
 * These tests pin the property that removes the per-frame dependency: the
 * overlay layers share the canvas's `position`, so their containing block is the
 * canvas's own and a scroll moves both or neither.
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

const rect = (left: number, top: number, width = 800, height = 600) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

describe('overlay layers follow the canvas positioning scheme', () => {
  let scene: Scene;
  let canvas: HTMLCanvasElement;
  let parent: HTMLDivElement;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  const sync = () => (scene as any).syncOverlayGeometry();
  const a11y = () => (scene as any).a11yRoot as HTMLElement;
  const portal = () => (scene as any).portalRoot as HTMLElement;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    parent = document.createElement('div');
    canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    scene = new Scene(canvas);
    scene.width = 800;
    scene.height = 600;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    scene.destroy();
    parent.remove();
  });

  it('positions the overlay fixed when the canvas is fixed', () => {
    canvas.style.position = 'fixed';
    (canvas as any).getBoundingClientRect = () => rect(0, 0);
    (parent as any).getBoundingClientRect = () => rect(0, 0);
    sync();

    expect(a11y().style.position).toBe('fixed');
    expect(portal().style.position).toBe('fixed');
  });

  it('keeps the overlay absolute for an in-flow canvas', () => {
    // The default embedding — a canvas that scrolls with the document — must keep
    // the parent-relative arithmetic, or it would detach from its own container.
    canvas.style.position = '';
    (canvas as any).getBoundingClientRect = () => rect(40, 60);
    (parent as any).getBoundingClientRect = () => rect(10, 20);
    sync();

    expect(a11y().style.position).toBe('absolute');
    // left/top stay parent-relative: 40-10 and 60-20.
    expect(a11y().style.left).toBe('30px');
    expect(a11y().style.top).toBe('40px');
  });

  it('needs no re-sync to stay aligned with a fixed canvas across a scroll', () => {
    // The regression itself. A fixed canvas keeps the same client rect while the
    // document scrolls, so the geometry written for the overlay must not depend
    // on any scroll-derived term. Simulate a scroll by moving the PARENT (which
    // is what scrolling does to an in-flow ancestor) and leaving the canvas rect
    // pinned, then re-sync: the written top must not have moved.
    canvas.style.position = 'fixed';
    (canvas as any).getBoundingClientRect = () => rect(0, 0);
    (parent as any).getBoundingClientRect = () => rect(0, 0);
    sync();
    const before = { left: a11y().style.left, top: a11y().style.top };

    // Document scrolled 630px: the fixed canvas is unmoved, the parent is not.
    (parent as any).getBoundingClientRect = () => rect(0, -630);
    Object.defineProperty(parent, 'scrollTop', { configurable: true, value: 0 });
    sync();

    expect({ left: a11y().style.left, top: a11y().style.top }).toEqual(before);
    expect(a11y().style.top).toBe('0px');
  });

  it('re-writes when the canvas positioning scheme changes after the first sync', () => {
    // The memo compares the geometry it wrote. A canvas that becomes fixed later
    // (a scroll-driven class, a fullscreen toggle) changes nothing else — same
    // box, same logical size — so `position` has to be part of the comparison or
    // the overlay would keep the stale scheme.
    (canvas as any).getBoundingClientRect = () => rect(0, 0);
    (parent as any).getBoundingClientRect = () => rect(0, 0);
    sync();
    expect(a11y().style.position).toBe('absolute');

    canvas.style.position = 'fixed';
    sync();
    expect(a11y().style.position).toBe('fixed');
  });
});
