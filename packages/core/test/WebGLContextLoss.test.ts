// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene } from '../src';
import type { PointRenderer } from '../src/renderer/WebGLPointRenderer';

// Minimal PointRenderer stub — records lifecycle so we can assert recovery.
function makeStubRenderer(): PointRenderer {
  return {
    maxDPR: undefined,
    resize: vi.fn(),
    begin: vi.fn(),
    addCircle: vi.fn(),
    flush: vi.fn(),
    destroy: vi.fn(),
  } as unknown as PointRenderer;
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

describe('WebGL point layer GPU context-loss recovery', () => {
  afterEach(() => {
    // Reset the static creator between tests.
    (Scene as any).webglCreator = null;
  });

  it('preventDefault on contextlost + recreate renderer on contextrestored', () => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const created: PointRenderer[] = [];
    Scene.registerWebGLPointRendererCreator(() => {
      const r = makeStubRenderer();
      created.push(r);
      return r;
    });

    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const scene = new Scene(canvas, { pointBackend: 'webgl' });

    // One renderer created at construction.
    expect(created).toHaveLength(1);
    const glCanvas = (scene as any).glCanvas as HTMLCanvasElement;
    expect(glCanvas).toBeTruthy();

    // Context lost: preventDefault must be called, renderer dropped.
    const lost = new Event('webglcontextlost', { cancelable: true });
    glCanvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect((scene as any).pointRenderer).toBeNull();
    expect(created[0].destroy).toHaveBeenCalled();

    // Context restored: a fresh renderer is built and sized.
    glCanvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(created).toHaveLength(2);
    expect((scene as any).pointRenderer).toBe(created[1]);
    expect(created[1].resize).toHaveBeenCalledWith(scene.width, scene.height);

    scene.destroy();
  });

  it('does not recreate the renderer after the scene is destroyed', () => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const created: PointRenderer[] = [];
    Scene.registerWebGLPointRendererCreator(() => {
      const r = makeStubRenderer();
      created.push(r);
      return r;
    });
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const scene = new Scene(canvas, { pointBackend: 'webgl' });
    const glCanvas = (scene as any).glCanvas as HTMLCanvasElement;
    expect(created).toHaveLength(1);

    scene.destroy();
    // The listeners were removed on destroy — a late restored event is inert.
    glCanvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(created).toHaveLength(1);
  });
});
