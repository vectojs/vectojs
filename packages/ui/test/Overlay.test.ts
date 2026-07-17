// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Entity } from '@vectojs/core';
import { Overlay } from '../src/Overlay';

// Minimal concrete subclass for testing the base Overlay behavior.
class TestOverlay extends Overlay {
  constructor(width = 100, height = 60) {
    super({ width, height });
  }
}

describe('Overlay.showAtPoint', () => {
  beforeEach(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          beginPath: () => {},
          rect: () => {},
          clip: () => {},
          roundRect: () => {},
          fill: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };
  });

  it('silently no-ops when called on an unmounted instance with no source (backward compat)', () => {
    const overlay = new TestOverlay();
    // Bare constructor + bare showAtPoint: no scene resolvable. Behavior here
    // is preserved (silent no-op) so existing silent callers don't suddenly
    // throw; the new opt-in `source` arg is the way to make the bare pattern
    // work. Documents the historical footgun as a pinned regression test.
    expect(() => overlay.showAtPoint(50, 50)).not.toThrow();
    expect(overlay.parent).toBeNull();
    expect(overlay.visible).toBe(false);
  });

  it('auto-mounts and becomes visible when called with a source Scene (the bare-constructor fix)', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);

    const overlay = new TestOverlay();
    // Bare constructor + showAtPoint WITH source — should now work the first
    // time (no prior scene.add() needed). This is the documented usage
    // pattern the bug used to silently break.
    overlay.showAtPoint(50, 50, scene);

    expect(overlay.parent).toBe(scene.overlayRoot);
    expect(scene.overlayRoot.children).toContain(overlay);
    expect(overlay.visible).toBe(true);
    // opacity/scaleX/scaleY are registered as transitions in the constructor,
    // so they animate toward their target rather than jumping synchronously;
    // the synchronous proof of "showed" is `visible`, plus the non-animated
    // x/y which are plain assignments under no transition.
    expect(overlay.x).toBe(50);
    expect(overlay.y).toBe(50);
  });

  it('auto-mounts when called with a source Entity whose .scene is set', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);

    const host = new Entity('host');
    host.interactive = true;
    host.width = 40;
    host.height = 40;
    scene.add(host);

    const overlay = new TestOverlay();
    overlay.showAtPoint(10, 10, host);

    expect(overlay.parent).toBe(scene.overlayRoot);
    expect(overlay.visible).toBe(true);
  });

  it('works without source when already mounted (existing callers unchanged)', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);

    const overlay = new TestOverlay();
    scene.add(overlay);

    overlay.showAtPoint(100, 80);
    // Pre-mounted overlays stay in scene.root: showAtPoint's auto-mount is
    // guarded by `if (!this.parent)`, so an already-parented overlay is not
    // moved to overlayRoot. The synchronous proof that the call did work is
    // `visible` flipping true plus x/y being placed — matching the
    // pre-source-arg historical behavior used by existing callers.
    expect(overlay.parent).toBe(scene.root);
    expect(overlay.visible).toBe(true);
    expect(overlay.x).toBe(100);
    expect(overlay.y).toBe(80);
  });

  it('hide() drives the overlay back to hidden', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const overlay = new TestOverlay();
    overlay.showAtPoint(50, 50, scene);

    expect(overlay.visible).toBe(true);
    overlay.hide();
    expect(overlay.visible).toBe(false);
    // opacity animates back toward 0 via the registered transition; the
    // synchronous signal is `visible` flipping to false.
  });
});
