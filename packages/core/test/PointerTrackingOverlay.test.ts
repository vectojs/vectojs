// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene } from '../src';

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

// Canvas at viewport (0,0), 1:1 CSS→logical, so clientX/Y == scene x/y.
function mockRect(el: HTMLElement, box: Partial<DOMRect>) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...box,
  } as DOMRect);
}

describe('scene.mouseX/Y tracking over projection/a11y overlays', () => {
  let parent: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let scene: Scene;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    parent = document.createElement('div');
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    mockRect(canvas, {});
    scene = new Scene(canvas, { disableWindowResize: true });
    scene.width = 800;
    scene.height = 600;
  });

  afterEach(() => {
    scene.destroy();
    parent.remove();
  });

  it('binds pointer listeners to the parent container, not the canvas', () => {
    expect((scene as any).pointerEventTarget).toBe(parent);
  });

  it('updates mouseX/mouseY from a pointermove anywhere in the container (incl. over a projection element)', () => {
    // A transparent projection div layered above the canvas, pointer-events:auto.
    const projection = document.createElement('div');
    projection.style.pointerEvents = 'auto';
    parent.appendChild(projection);

    // The move fires on the projection child; it bubbles to the parent listener.
    projection.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), {
        clientX: 320,
        clientY: 240,
      }),
    );

    expect((scene as any).mouseX).toBe(320);
    expect((scene as any).mouseY).toBe(240);
  });

  it('resets mouse position when the pointer leaves the whole container', () => {
    parent.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), {
        clientX: 100,
        clientY: 100,
      }),
    );
    expect((scene as any).mouseX).toBe(100);

    parent.dispatchEvent(new Event('pointerleave'));
    expect((scene as any).mouseX).toBe(-9999);
    expect((scene as any).mouseY).toBe(-9999);
  });

  it('detaches the parent listeners on destroy', () => {
    const removeSpy = vi.spyOn(parent, 'removeEventListener');
    scene.destroy();
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerleave', expect.any(Function));
    expect((scene as any).pointerEventTarget).toBeNull();
  });
});
