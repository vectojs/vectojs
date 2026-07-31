// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * `paragraphImage` must notify the scene when its bitmap decodes, whatever the
 * bitmap turns out to measure.
 *
 * The `markDirty()` call used to sit inside a `naturalWidth && naturalHeight`
 * check, so a source that loads successfully while reporting a zero dimension
 * left an `onDemand` scene unnotified. The display-math sibling already did this
 * unconditionally, with a comment naming the hazard; the two disagreed.
 *
 * These tests drive `onload` through a stubbed `globalThis.Image` because a real
 * decode is unobservable here: jsdom has an `Image` that settles neither
 * `onload` nor `onerror` for a `data:` URI (measured: neither within 400ms), and
 * Bun has no `Image` at all. The pixel-level proof lives in
 * `e2e/paragraph-image-repaint.e2e.ts`, which is also where the browser-measured
 * trigger is documented — an `<svg width="0" height="0">` is the one shape that
 * fires `onload` with `naturalWidth === 0`.
 */

interface StubImage {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Replace `globalThis.Image` with a stub whose decode is driven by hand, and
 * report the instances created so a test can fire the exact one it means.
 */
function withStubImage<T>(
  naturalWidth: number,
  naturalHeight: number,
  body: (fire: () => void) => T,
): T {
  const original = globalThis.Image;
  const created: StubImage[] = [];
  // @ts-expect-error installing a minimal stand-in for the decode path
  globalThis.Image = class {
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public naturalWidth = naturalWidth;
    public naturalHeight = naturalHeight;
    private _src = '';
    public get src(): string {
      return this._src;
    }
    public set src(value: string) {
      this._src = value;
      created.push(this as unknown as StubImage);
    }
  };
  try {
    return body(() => {
      for (const instance of created) instance.onload?.();
    });
  } finally {
    globalThis.Image = original;
  }
}

/** A scene stand-in that counts `markDirty()` rather than rendering. */
function countingScene(): { markDirty: () => void; markDirtyCalls: number } {
  const scene = {
    markDirtyCalls: 0,
    markDirty(): void {
      scene.markDirtyCalls++;
    },
  };
  return scene;
}

/**
 * Attach a counting scene the way `Scene.add` would.
 *
 * `Entity.scene` is a getter with no setter — it walks to `_scene`, falling back
 * to the parent chain — so the backing field is what a test has to set.
 */
function attachScene(md: Markdown): { markDirtyCalls: number } {
  const scene = countingScene();
  (md as unknown as { _scene: unknown })._scene = scene;
  return scene;
}

function imageEntityOf(md: Markdown): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  const walk = (entity: { children?: unknown[] }): void => {
    if ('src' in entity && 'bitmap' in entity) {
      found = entity as unknown as { width: number; height: number };
    }
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return found;
}

describe('paragraph image repaint', () => {
  it('marks the scene dirty when the bitmap reports a usable size', () => {
    withStubImage(80, 60, (fire) => {
      const md = new Markdown('before ![alt](http://example.test/a.svg) after', { width: 600 });
      const scene = attachScene(md);
      fire();
      expect(scene.markDirtyCalls).toBeGreaterThanOrEqual(1);
    });
  });

  it('marks the scene dirty even when the bitmap reports a zero dimension', () => {
    withStubImage(0, 0, (fire) => {
      const md = new Markdown('before ![alt](http://example.test/zero.svg) after', { width: 600 });
      const scene = attachScene(md);
      fire();
      // This is the regression. Before the fix the call sat inside the
      // naturalWidth guard and this was 0, so an onDemand scene never repainted.
      expect(scene.markDirtyCalls).toBeGreaterThanOrEqual(1);
    });
  });

  it('still corrects the box from the intrinsic size when one is available', () => {
    withStubImage(80, 60, (fire) => {
      const md = new Markdown('before ![alt](http://example.test/a.svg) after', { width: 600 });
      attachScene(md);
      fire();
      const image = imageEntityOf(md);
      expect(image).not.toBeNull();
      expect(image?.width).toBe(80);
      expect(image?.height).toBe(60);
    });
  });

  it('leaves the box at its guess when the bitmap reports zero', () => {
    withStubImage(0, 0, (fire) => {
      const md = new Markdown('before ![alt](http://example.test/zero.svg) after', { width: 600 });
      attachScene(md);
      const image = imageEntityOf(md);
      const guessedWidth = image?.width;
      fire();
      // Deliberate: sizing policy for a zero-dimension source is a separate
      // decision from notifying the scene. Collapsing the box here would delete
      // a reserved region on the strength of one browser quirk.
      expect(image?.width).toBe(guessedWidth);
    });
  });

  it('does not throw when no scene is attached', () => {
    withStubImage(80, 60, (fire) => {
      new Markdown('before ![alt](http://example.test/a.svg) after', {
        width: 600,
      });
      // A Markdown built but never added to a Scene still decodes. The optional
      // chain has to hold or the decode throws out of an image onload handler.
      expect(() => fire()).not.toThrow();
    });
  });
});
