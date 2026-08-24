import { describe, it, expect } from 'vitest';
import { Entity } from '../src/tree/Entity';

class TestEntity extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  snap(prop: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity', value: number): void {
    this.setImmediate(prop, value);
  }
}

describe('Entity animation', () => {
  it('assignment without a transition writes through instantly (back-compat)', () => {
    const e = new TestEntity();
    e.x = 123;
    expect(e.x).toBe(123);
    expect((e as unknown as { _drivers: Map<string, unknown> | null })._drivers?.size ?? 0).toBe(0);
  });

  it('setTransition makes a configured property animate on assignment', () => {
    const e = new TestEntity();
    e.setTransition({ x: { duration: 100, easing: 'linear' } });
    e.x = 100;
    expect(e.x).toBe(0); // not applied instantly
    e.update(50, 50);
    expect(e.x).toBeCloseTo(50, 6);
    e.update(50, 100);
    expect(e.x).toBeCloseTo(100, 6);
  });

  it('springTo resolves when at rest and lands exactly on target', async () => {
    const e = new TestEntity();
    const p = e.springTo({ opacity: 0 });
    let t = 0;
    const drivers = (e as unknown as { _drivers: Map<string, unknown> | null })._drivers;
    // `drivers` is a stable reference whose `.size` shrinks as `update()` retires
    // drivers — the binding is deliberately const, only the Map contents change.
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    for (let i = 0; i < 600 && (drivers?.size ?? 0) > 0; i++) e.update(16, (t += 16));
    await p;
    expect(e.opacity).toBe(0); // snapped exactly to target on completion
  });

  it('settles the previous Promise when an active property is retargeted', async () => {
    const e = new TestEntity();
    let firstSettled = false;
    const first = e
      .animateTo({ x: 100 }, { duration: 100, easing: 'linear' })
      .then(() => (firstSettled = true));
    e.update(25, 25);
    const second = e.animateTo({ x: 200 }, { duration: 100, easing: 'linear' });

    await first;
    expect(firstSettled).toBe(true);
    expect(e.x).toBeCloseTo(25);

    e.update(100, 125);
    await second;
    expect(e.x).toBe(200);
  });

  it('settles an imperative animation when a subclass replaces it immediately', async () => {
    const e = new TestEntity();
    const animation = e.animateTo({ x: 100 }, { duration: 100 });

    e.snap('x', 40);
    await animation;

    expect(e.x).toBe(40);
    expect(e.hasPendingAnimations()).toBe(false);
  });

  it('destroy() settles pending animateTo promises and clears drivers', async () => {
    const e = new TestEntity();
    const pending = e.animateTo({ x: 100 }, { duration: 1000, easing: 'linear' });
    e.update(16, 16);

    e.destroy();

    await pending; // must resolve, not hang forever
    expect((e as unknown as { _drivers: Map<string, unknown> | null })._drivers?.size ?? 0).toBe(0);
    expect(e.hasPendingAnimations()).toBe(false);
  });

  it('legacy animate(props, ms) still tweens with the easeOutQuad curve', () => {
    const e = new TestEntity();
    e.animate({ x: 100 }, 100);
    e.update(0, 0); // startTime init
    e.update(50, 50);
    expect(e.x).toBeCloseTo(100 * (0.5 * (2 - 0.5)), 4); // easeOutQuad(0.5)
  });

  it('legacy animate() does not spawn transition drivers for the same prop', () => {
    const e = new TestEntity();
    e.setTransition({ x: 'spring' }); // declarative transition configured…
    e.animate({ x: 100 }, 100); // …but the legacy tween must own this animation
    const drivers = (e as unknown as { _drivers: Map<string, unknown> | null })._drivers;
    let t = 0;
    for (let i = 0; i < 10; i++) {
      e.update(16, (t += 16));
      expect(drivers?.size ?? 0).toBe(0); // no per-frame driver spawn/retarget fight
    }
    expect(e.x).toBeCloseTo(100, 4); // tween completed normally
  });

  it('hasPendingAnimations() reports true while a property driver is active', () => {
    const e = new TestEntity();
    e.setTransition({ opacity: 'spring' });
    e.opacity = 0.2;
    expect(e.hasPendingAnimations()).toBe(true);
    let t = 0;
    const drivers = (e as unknown as { _drivers: Map<string, unknown> | null })._drivers;
    // `drivers` is a stable reference whose `.size` shrinks as `update()` retires
    // drivers — the binding is deliberately const, only the Map contents change.
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition
    for (let i = 0; i < 600 && (drivers?.size ?? 0) > 0; i++) e.update(16, (t += 16));
    expect(e.hasPendingAnimations()).toBe(false);
  });
});

describe('Entity animation — reduced motion', () => {
  function liveEntity(reduced: boolean): Entity {
    const e = new (class extends Entity {
      isPointInside(): boolean {
        return false;
      }
      render(): void {}
    })();
    (e as unknown as { _scene: unknown })._scene = {
      prefersReducedMotion: reduced,
      markDirty() {},
      _registerActiveDriverEntity() {},
    };
    return e;
  }
  const driverCount = (e: Entity) =>
    (e as unknown as { _drivers: Map<string, unknown> | null })._drivers?.size ?? 0;

  it('snaps movement props to target instantly when reduced motion is on', () => {
    const e = liveEntity(true);
    e.setTransition({ x: 'spring' });
    e.x = 500;
    expect(e.x).toBe(500); // no driver, instant
    expect(driverCount(e)).toBe(0);
  });

  it('still animates opacity (a fade) under reduced motion', () => {
    const e = liveEntity(true);
    e.setTransition({ opacity: { duration: 100, easing: 'linear' } });
    e.opacity = 0;
    expect(driverCount(e)).toBe(1); // fade preserved
  });
});

describe('Entity.animate degenerate durations', () => {
  it('zero-duration animate snaps to target instead of writing NaN and jamming the queue', () => {
    const e = new TestEntity();
    e.animate({ x: 100 }, 0);
    // The very first update used to compute 0/0 = NaN into x, then the
    // dequeue guard (NaN >= 1) kept the animation forever.
    e.update(16, 16);
    expect(Number.isNaN(e.x)).toBe(false);
    expect(e.x).toBe(100);

    // The queue must keep running afterwards.
    e.animate({ x: 200 }, 100);
    e.update(16, 32); // first tick starts the tween (progress 0)
    e.update(100, 132); // full duration elapsed
    expect(e.x).toBe(200);
  });

  it('negative and non-finite durations also snap to their targets', () => {
    const e = new TestEntity();
    e.animate({ opacity: 0.5 }, -10);
    e.update(16, 16);
    expect(e.opacity).toBe(0.5);

    const f = new TestEntity();
    f.animate({ y: 40 }, Infinity);
    f.update(16, 16);
    expect(f.y).toBe(40);

    // Both queues stay usable.
    e.animate({ y: 30 }, 50);
    e.update(16, 66); // first tick starts the tween (progress 0)
    e.update(50, 116); // full duration elapsed
    expect(e.y).toBe(30);
  });
});
