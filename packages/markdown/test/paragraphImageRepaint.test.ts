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

/**
 * A scene stand-in that counts `markDirty()` rather than rendering.
 *
 * `detachA11y` is a no-op rather than absent: `Entity.remove` calls it
 * unconditionally on an attached child, so any test that destroys a subtree
 * (`setContent`, a reconcile) throws on a stub without it.
 */
function countingScene(): {
  markDirty: () => void;
  detachA11y: () => void;
  markDirtyCalls: number;
} {
  const scene = {
    markDirtyCalls: 0,
    markDirty(): void {
      scene.markDirtyCalls++;
    },
    detachA11y(): void {},
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

/**
 * Every entity from `md` down to the image, inclusive.
 *
 * The chain is the point of these tests: an image is never a direct child of
 * `content`, and each intermediate container caches its own height. A fix that
 * only re-lays out `content` leaves every level in between stale.
 */
function chainToImage(md: Markdown): { y: number; width: number; height: number }[] {
  const path: { y: number; width: number; height: number }[] = [];
  const walk = (entity: { children?: unknown[] }): boolean => {
    path.push(entity as unknown as { y: number; width: number; height: number });
    if ('src' in entity && 'bitmap' in entity) return true;
    for (const child of entity.children ?? []) {
      if (walk(child as { children?: unknown[] })) return true;
    }
    path.pop();
    return false;
  };
  walk(md as unknown as { children?: unknown[] });
  return path;
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

/**
 * A decode that corrects the guessed 16:10 box has to re-position every block
 * below the image, or the next paragraph renders on top of the image's lower
 * portion.
 *
 * The guessed box for `maxWidth: 600` is `600 * 0.6 = 480`; a 600x900 portrait
 * corrects to 900, so a document that fails to relayout leaves the following
 * paragraph 420px too high. Every case below asserts on the *sibling's* position
 * rather than on the image's own height: the image resizing itself was never the
 * broken half.
 */
describe('paragraph image relayout', () => {
  // Each context wraps the image differently, and every wrapper caches a height.
  // `Stack.layout()` is not recursive, so a fix that only re-lays out `content`
  // passes the standalone case and silently fails the wrapped ones — which is why
  // all five are enumerated rather than represented by one.
  const contexts: [name: string, markdown: string][] = [
    ['a standalone paragraph image', '![alt](http://example.test/p.jpg)\n\nAfter.'],
    ['an image leading a list item', '- text ![alt](http://example.test/p.jpg)\n\nAfter.'],
    [
      'an image on its own line in a list item',
      '- text\n\n  ![alt](http://example.test/p.jpg)\n\nAfter.',
    ],
    ['an image in a blockquote', '> ![alt](http://example.test/p.jpg)\n\nAfter.'],
    ['an image sharing a paragraph with text', 'lead ![alt](http://example.test/p.jpg)\n\nAfter.'],
  ];

  for (const [name, markdown] of contexts) {
    it(`moves the following block below ${name}`, () => {
      withStubImage(600, 900, (fire) => {
        const md = new Markdown(markdown, { maxWidth: 600 });
        attachScene(md);
        const imageBlock = md.content.children[0];
        const following = md.content.children[1];
        const yBeforeDecode = following.y;
        fire();

        // Read the corrected height rather than asserting 900: an indented
        // context (list item, blockquote) clamps the image to `maxWidth` minus
        // its indent, so the 1.5 aspect ratio lands on a smaller box — 876 for a
        // blockquote's 16px indent. The invariant under test is that the blocks
        // agree with whatever box the image ended up with.
        const imageHeight = imageEntityOf(md)?.height ?? 0;
        expect(imageHeight).toBeGreaterThan(480); // the guess it had to beat

        // The block owning the image has to grow to contain it, and the following
        // block has to clear that grown box. Asserting only that `y` increased
        // would pass on a partial fix that resized one level but not the rest.
        expect(imageBlock.height).toBeGreaterThanOrEqual(imageHeight);
        expect(following.y).toBeGreaterThan(yBeforeDecode);
        expect(following.y).toBeGreaterThanOrEqual(imageBlock.height);
      });
    });

    it(`re-sizes every container between the image and content for ${name}`, () => {
      withStubImage(600, 900, (fire) => {
        const md = new Markdown(markdown, { maxWidth: 600 });
        attachScene(md);
        fire();

        // No ancestor may report a height smaller than the image it contains. A
        // single stale level here is exactly the overlap bug.
        const chain = chainToImage(md);
        expect(chain.length).toBeGreaterThan(2);
        const imageHeight = chain[chain.length - 1].height;
        expect(imageHeight).toBeGreaterThan(480);
        for (const ancestor of chain) {
          expect(ancestor.height).toBeGreaterThanOrEqual(imageHeight);
        }
      });
    });
  }

  it('leaves layout untouched when the corrected box matches the guess', () => {
    // 600x360 *is* the 16:10 guess for width 600, so there is nothing to correct
    // and no relayout should be spent — an unconditional pass would cost one full
    // layout per image on every document.
    withStubImage(600, 360, (fire) => {
      const md = new Markdown('![alt](http://example.test/sixteen-ten.jpg)\n\nAfter.', {
        maxWidth: 600,
      });
      attachScene(md);
      const following = md.content.children[1];
      const yBeforeDecode = following.y;
      let layoutUpdates = 0;
      md.onLayoutUpdated = () => layoutUpdates++;
      fire();

      expect(following.y).toBe(yBeforeDecode);
      expect(layoutUpdates).toBe(0);
    });
  });

  it('does not relayout when the bitmap reports a zero dimension', () => {
    // The zero-dimension source keeps its guessed box by design (see the repaint
    // suite above), so the box never changes and no relayout is owed either.
    withStubImage(0, 0, (fire) => {
      const md = new Markdown('![alt](http://example.test/zero.svg)\n\nAfter.', { maxWidth: 600 });
      attachScene(md);
      const following = md.content.children[1];
      const yBeforeDecode = following.y;
      let layoutUpdates = 0;
      md.onLayoutUpdated = () => layoutUpdates++;
      fire();

      expect(following.y).toBe(yBeforeDecode);
      expect(layoutUpdates).toBe(0);
    });
  });

  it('notifies the host exactly once per correcting decode', () => {
    withStubImage(600, 900, (fire) => {
      const md = new Markdown('![alt](http://example.test/p.jpg)\n\nAfter.', { maxWidth: 600 });
      attachScene(md);
      let layoutUpdates = 0;
      md.onLayoutUpdated = () => layoutUpdates++;
      fire();
      expect(layoutUpdates).toBe(1);
      // A second notification for the same bitmap would re-run layout for a box
      // that is already correct.
      fire();
      expect(layoutUpdates).toBe(1);
    });
  });

  it('publishes the corrected component height to the host', () => {
    withStubImage(600, 900, (fire) => {
      const md = new Markdown('![alt](http://example.test/p.jpg)\n\nAfter.', { maxWidth: 600 });
      attachScene(md);
      const heightBeforeDecode = md.height;
      fire();
      // `md.height` is what a host container scrolls and sizes against, so it has
      // to follow `content`, not just the internal boxes.
      expect(md.height).toBeGreaterThan(heightBeforeDecode);
      expect(md.height).toBe(md.content.height);
    });
  });

  it('sizes a list-item lead-image wrapper at construction, before any decode', () => {
    // Regression in its own right: `listItemBlockStack`'s `leadImages` wrapper was
    // the one wrapper-image site in the file that never had `width`/`height`
    // assigned, so the outer Stack treated it as a zero-height block even while
    // the guessed box was still current.
    withStubImage(600, 900, () => {
      const md = new Markdown('- text ![alt](http://example.test/p.jpg)', { maxWidth: 600 });
      attachScene(md);
      for (const ancestor of chainToImage(md)) {
        expect(ancestor.height).toBeGreaterThan(0);
      }
    });
  });

  it('does not relayout an image detached from the tree before its decode lands', () => {
    withStubImage(600, 900, (fire) => {
      const md = new Markdown('![alt](http://example.test/p.jpg)\n\nAfter.', { maxWidth: 600 });
      attachScene(md);
      let layoutUpdates = 0;
      md.onLayoutUpdated = () => layoutUpdates++;
      // A rebuild (setContent, a streamed reconcile) can replace the subtree while
      // a decode is still in flight. Re-deriving this component's box from a tree
      // the image no longer belongs to would publish a size for content that is
      // not on screen.
      md.setContent('Replaced, no image.');
      expect(() => fire()).not.toThrow();
      expect(layoutUpdates).toBe(0);
    });
  });
});
