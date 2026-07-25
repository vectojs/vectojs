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
});
