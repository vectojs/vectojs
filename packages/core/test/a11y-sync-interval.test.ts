// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scene, Entity } from '../src';

/**
 * #467: `a11ySyncInterval` must throttle the a11y shadow-DOM sync while an
 * animation is in flight. The `a11yPendingSyncAfterAnimation` bypass exists to
 * flush one final sync after motion settles — during a continuous animation it
 * re-armed every frame and defeated the interval, syncing ~every frame instead
 * of at the configured cadence.
 */
class Box extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        if (prop === 'globalAlpha') return 1;
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

let clock = 0;
function tickMs(scene: Scene, dtMs: number): void {
  clock += dtMs;
  (scene as unknown as { loop: (t: number) => void }).loop(clock);
}

describe('a11y sync interval during animation', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('throttles syncs to the configured interval while an animation runs', () => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas, { a11ySyncInterval: 100 });
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    scene.maxFPS = 0;

    const e = new Box();
    e.interactive = true;
    e.width = 10;
    e.height = 10;
    scene.add(e);
    e.animate({ x: 300 }, 2000);

    const syncs = vi.spyOn(scene as unknown as { syncA11y: (root: Entity) => void }, 'syncA11y');

    // ~120 rendered frames of 16.67 ms across a 2000 ms animation.
    for (let t = 0; t < 2000; t += 16.67) {
      tickMs(scene, 16.67);
    }

    // syncA11y recurses into children, so count only the root-level passes.
    const rootPasses = syncs.mock.calls.filter((c) => c[0] === (scene as any).root).length;

    // 100 ms interval → ~20 root passes. Before the fix the pending flag
    // re-armed every frame and all ~120 frames synced.
    expect(syncs).toHaveBeenCalled();
    expect(rootPasses).toBeGreaterThanOrEqual(10);
    expect(rootPasses).toBeLessThanOrEqual(25);
  });

  it('flushes one pending sync after the animation settles', () => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas, { a11ySyncInterval: 100 });
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    scene.maxFPS = 0;

    const e = new Box();
    e.interactive = true;
    e.width = 10;
    e.height = 10;
    scene.add(e);
    e.animate({ x: 300 }, 200);

    const syncs = vi.spyOn(scene as unknown as { syncA11y: (root: Entity) => void }, 'syncA11y');

    // Tick past the animation end plus several frames at rest.
    for (let t = 0; t < 500; t += 16.67) {
      tickMs(scene, 16.67);
    }

    // The final state must be visible to assistive tech even though the last
    // rendered frame did not land on an interval boundary.
    expect(syncs).toHaveBeenCalled();
  });
});
