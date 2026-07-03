import { describe, it, expect } from 'vitest';
import { TweenDriver, SpringDriver } from '../src/animation/drivers';

// Drivers tick in milliseconds (Entity passes dt in ms).
describe('TweenDriver', () => {
  it('starts at `from`, hits `to` exactly at duration, honors easing', () => {
    const d = new TweenDriver(0, 100, { duration: 200, easing: 'linear' });
    expect(d.value).toBe(0);
    d.tick(100); // half
    expect(d.value).toBeCloseTo(50, 6);
    expect(d.isDone()).toBe(false);
    d.tick(100); // full
    expect(d.value).toBeCloseTo(100, 6);
    expect(d.isDone()).toBe(true);
  });

  it('respects delay before moving', () => {
    const d = new TweenDriver(0, 10, { duration: 100, delay: 50, easing: 'linear' });
    d.tick(50); // still in delay
    expect(d.value).toBeCloseTo(0, 6);
    d.tick(50); // half of the actual tween
    expect(d.value).toBeCloseTo(5, 6);
  });

  it('retarget restarts from the current value', () => {
    const d = new TweenDriver(0, 100, { duration: 100, easing: 'linear' });
    d.tick(50); // value 50
    d.retarget(0);
    expect(d.isDone()).toBe(false);
    d.tick(100);
    expect(d.value).toBeCloseTo(0, 6);
  });
});

describe('SpringDriver', () => {
  it('converges to target and reports done at rest', () => {
    const d = new SpringDriver(0, 1, {});
    for (let i = 0; i < 600 && !d.isDone(); i++) d.tick(16);
    expect(d.isDone()).toBe(true);
    d.tick(16); // an at-rest spring snaps exactly to target on the next tick
    expect(d.value).toBeCloseTo(1, 3);
  });

  it('retarget preserves velocity (value stays continuous across the retarget)', () => {
    const d = new SpringDriver(0, 1, {});
    for (let i = 0; i < 5; i++) d.tick(16);
    const before = d.value;
    d.retarget(2);
    const after = d.value;
    expect(after).toBeCloseTo(before, 9); // no snap on retarget
  });
});
