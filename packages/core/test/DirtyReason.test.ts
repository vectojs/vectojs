// @vitest-environment jsdom
// Dirty-reason attribution.
//
// `renderMode: 'onDemand'` exists so an idle scene costs nothing, but it silently
// degrades to always-on the moment something marks the scene dirty every frame —
// and `dirty === true` says nothing about the cause. Diagnosing that previously
// meant bisecting call sites by hand.
//
// These tests pin the contract that makes the diagnosis possible: attribution is
// off by default (so the hot path stays a single field write), records who and
// why when enabled, aggregates repeats by count, and is bounded.
import { describe, it, expect, vi } from 'vitest';
import { Scene, Entity } from '../src/index';

class Box extends Entity {
  constructor(id: string) {
    super(id);
    this.width = 40;
    this.height = 40;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 400,
    innerHeight: 300,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 8 });
        if (prop === 'canvas') return { width: 400, height: 300, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(400, 300);
  return scene;
}

describe('dirty-reason attribution', () => {
  it('is off by default and records nothing', () => {
    const scene = makeScene();
    expect(scene.dirtyTracking).toBe(false);

    scene.markDirty({ entity: 'x', reason: 'text-changed' });
    // Off means off: a source passed while disabled must not be retained, or the
    // map grows in production for no benefit.
    expect(scene.dirtyReasons).toEqual([]);
    scene.destroy();
  });

  it('records entity, reason and property when enabled', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({
      entity: 'label',
      reason: 'text-changed',
      property: 'spans',
    });

    const [entry] = scene.dirtyReasons;
    expect(entry).toMatchObject({
      entity: 'label',
      reason: 'text-changed',
      property: 'spans',
      count: 1,
    });
    scene.destroy();
  });

  it('aggregates repeats by count rather than listing each', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    for (let i = 0; i < 50; i++) {
      scene.markDirty({ entity: 'answer', reason: 'streaming-text' });
    }
    // Count is the whole point: a reason firing once per frame over hundreds of
    // frames is what keeps an onDemand scene awake, and a flat log would bury it.
    expect(scene.dirtyReasons).toHaveLength(1);
    expect(scene.dirtyReasons[0]!.count).toBe(50);
    scene.destroy();
  });

  it('sorts most frequent first, which is the diagnosis order', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({ entity: 'rare', reason: 'resize' });
    for (let i = 0; i < 10; i++) scene.markDirty({ entity: 'hot', reason: 'driver-tick' });

    const reasons = scene.dirtyReasons;
    expect(reasons[0]!.entity).toBe('hot');
    expect(reasons[0]!.count).toBe(10);
    scene.destroy();
  });

  it('separates distinct entities and properties', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({ entity: 'a', reason: 'moved', property: 'x' });
    scene.markDirty({ entity: 'a', reason: 'moved', property: 'y' });
    scene.markDirty({ entity: 'b', reason: 'moved', property: 'x' });
    // Collapsing these would make "which entity, which property" unanswerable —
    // exactly the question the feature exists to answer.
    expect(scene.dirtyReasons).toHaveLength(3);
    scene.destroy();
  });

  it('is bounded, so a unique-per-frame reason cannot grow it forever', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    for (let i = 0; i < 500; i++) {
      scene.markDirty({ entity: `e${i}`, reason: 'moved' });
    }
    // A scene that embeds an id in the reason would otherwise leak; eviction is
    // FIFO, the same tradeoff as the color cache.
    expect(scene.dirtyReasons.length).toBeLessThanOrEqual(200);
    scene.destroy();
  });

  it('disabling clears what was recorded', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({ entity: 'x', reason: 'moved' });
    expect(scene.dirtyReasons).toHaveLength(1);

    scene.setDirtyTracking(false);
    expect(scene.dirtyReasons).toEqual([]);
    scene.destroy();
  });

  it('clearDirtyReasons keeps tracking on', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    scene.markDirty({ entity: 'x', reason: 'moved' });
    scene.clearDirtyReasons();

    expect(scene.dirtyReasons).toEqual([]);
    expect(scene.dirtyTracking).toBe(true);
    scene.markDirty({ entity: 'y', reason: 'moved' });
    expect(scene.dirtyReasons).toHaveLength(1);
    scene.destroy();
  });

  it('attributes a real animation, which is the motivating case', async () => {
    const scene = makeScene();
    const box = new Box('mover');
    scene.add(box);
    scene.setDirtyTracking(true);

    void box.animateTo({ x: 100 }, { duration: 80, easing: 'linear' });
    for (let i = 0; i < 6; i++) scene.step(16.67);

    const reasons = scene.dirtyReasons.map((r) => r.reason);
    // An animation must be identifiable as the thing keeping the scene awake,
    // without the developer instrumenting anything themselves.
    expect(reasons.some((r) => r === 'animation-start' || r === 'driver-tick')).toBe(true);
    scene.destroy();
  });

  it('markDirty() with no source still works', () => {
    const scene = makeScene();
    scene.setDirtyTracking(true);
    // Every existing call site passes nothing; those must keep marking the scene
    // dirty, just without attribution.
    scene.markDirty();
    expect(scene.dirtyReasons).toEqual([]);
    scene.destroy();
  });
});
