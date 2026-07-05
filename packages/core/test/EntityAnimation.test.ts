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
    expect((e as unknown as { _drivers: Map<string, unknown> })._drivers.size).toBe(0);
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
    const drivers = (e as unknown as { _drivers: Map<string, unknown> })._drivers;
    for (let i = 0; i < 600 && drivers.size > 0; i++) e.update(16, (t += 16));
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

  it('legacy animate(props, ms) still tweens with the easeOutQuad curve', () => {
    const e = new TestEntity();
    e.animate({ x: 100 }, 100);
    e.update(0, 0); // startTime init
    e.update(50, 50);
    expect(e.x).toBeCloseTo(100 * (0.5 * (2 - 0.5)), 4); // easeOutQuad(0.5)
  });

  it('hasPendingAnimations() reports true while a property driver is active', () => {
    const e = new TestEntity();
    e.setTransition({ opacity: 'spring' });
    e.opacity = 0.2;
    expect(e.hasPendingAnimations()).toBe(true);
    let t = 0;
    const drivers = (e as unknown as { _drivers: Map<string, unknown> })._drivers;
    for (let i = 0; i < 600 && drivers.size > 0; i++) e.update(16, (t += 16));
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
    };
    return e;
  }
  const driverCount = (e: Entity) =>
    (e as unknown as { _drivers: Map<string, unknown> })._drivers.size;

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
