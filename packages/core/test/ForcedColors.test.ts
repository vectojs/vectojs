// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src';

// A controllable matchMedia keyed by query string. `set(media, matches)` flips a
// query and fires its registered `change` listeners, mirroring the browser.
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
    set(media: string, matches: boolean) {
      for (const l of lists.slice()) {
        if (l.media === media) {
          l.mql.matches = matches;
          l.handler();
        }
      }
    },
    get(media: string) {
      return lists.find((l) => l.media === media)?.mql;
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

describe('forced-colors (High Contrast) awareness', () => {
  let scene: Scene;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
  });
  afterEach(() => {
    scene?.destroy();
  });

  it('exposes forcedColors reflecting the (forced-colors: active) query', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    // A forced-colors query was armed and starts inactive.
    expect(mm.get('(forced-colors: active)')).toBeDefined();
    expect(scene.forcedColors).toBe(false);

    mm.set('(forced-colors: active)', true);
    expect(scene.forcedColors).toBe(true);

    mm.set('(forced-colors: active)', false);
    expect(scene.forcedColors).toBe(false);
  });

  it('repaints when forced-colors toggles so components can swap to system colors', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    const markDirty = vi.spyOn(scene, 'markDirty');
    mm.set('(forced-colors: active)', true);

    expect(markDirty).toHaveBeenCalled();
  });

  it('removes the forced-colors listener on destroy', () => {
    const mm = installMatchMedia();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    scene = new Scene(canvas);

    const before = mm.lists.filter((l) => l.media === '(forced-colors: active)').length;
    expect(before).toBe(1);

    scene.destroy();
    const after = mm.lists.filter((l) => l.media === '(forced-colors: active)').length;
    expect(after).toBe(0);
  });
});
