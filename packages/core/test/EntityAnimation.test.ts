import { describe, it, expect } from 'vitest';
import { Entity } from '../src/tree/Entity';

class TestEntity extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
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

  it('legacy animate(props, ms) still tweens with the easeOutQuad curve', () => {
    const e = new TestEntity();
    e.animate({ x: 100 }, 100);
    e.update(0, 0); // startTime init
    e.update(50, 50);
    expect(e.x).toBeCloseTo(100 * (0.5 * (2 - 0.5)), 4); // easeOutQuad(0.5)
  });
});
