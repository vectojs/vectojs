import { describe, it, expect } from 'vitest';
import { TweenDriver, SpringDriver } from '../src/drivers';
import type { EasingFn } from '../src/easing';

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

  it('wasmEasingId resolves to a stable id for a named easing, null for a custom EasingFn', () => {
    const named = new TweenDriver(0, 1, { duration: 100, easing: 'easeOutCubic' });
    expect(named.wasmEasingId).toBe(5); // matches EASING_IDS / anim.rs ease() order
    const custom = new TweenDriver(0, 1, { duration: 100, easing: (t) => t });
    expect(custom.wasmEasingId).toBeNull();
    const defaulted = new TweenDriver(0, 1, { duration: 100 }); // defaults to easeOutQuad
    expect(defaulted.wasmEasingId).toBe(2);
  });

  it('exposes allocation-free from/target/elapsed/duration/delay for the batched WASM gather', () => {
    const d = new TweenDriver(0, 10, { duration: 200, delay: 20, easing: 'linear' });
    d.tick(50);
    expect(d.fromValue).toBe(0);
    expect(d.target).toBe(10);
    expect(d.elapsedMs).toBe(50);
    expect(d.durationMs).toBe(200);
    expect(d.delayMs).toBe(20);
  });

  it('syncExternal overwrites value + elapsed so tick()/isDone() stay correct afterward', () => {
    const d = new TweenDriver(0, 100, { duration: 200, easing: 'linear' });
    // Simulate an externally-advanced step (e.g. a batched WASM tick) that
    // moved this tween to 75% complete without ever calling d.tick().
    d.syncExternal(75, 150);
    expect(d.value).toBe(75);
    expect(d.isDone()).toBe(false);
    d.tick(50); // remaining 25% -> done
    expect(d.isDone()).toBe(true);
    expect(d.value).toBeCloseTo(100, 6);
  });

  it('sanitizes a non-finite duration/delay instead of wedging the tween forever', () => {
    // `Math.max(1, NaN)` is NaN, so the old code ticked to a NaN value and
    // `isDone()` (elapsed >= NaN) never turned true — the property froze.
    const nanDuration = new TweenDriver(0, 100, { duration: Number.NaN });
    nanDuration.tick(500);
    expect(Number.isFinite(nanDuration.value)).toBe(true);
    expect(nanDuration.value).toBe(100);
    expect(nanDuration.isDone()).toBe(true);

    // A NaN delay makes `active = elapsed - NaN` NaN the same way.
    const nanDelay = new TweenDriver(0, 100, { duration: 50, delay: Number.NaN });
    nanDelay.tick(100);
    expect(nanDelay.value).toBe(100);
    expect(nanDelay.isDone()).toBe(true);
  });

  it('lands exactly on `to` even when a custom easing returns f(1) !== 1', () => {
    const ease: EasingFn = (t) => (t >= 1 ? 0.5 : t);
    const d = new TweenDriver(0, 100, { duration: 100, easing: ease });
    d.tick(50);
    expect(d.value).toBeCloseTo(50, 6);
    d.tick(100); // past the end: isDone() is true, so value must be `to`
    expect(d.isDone()).toBe(true);
    expect(d.value).toBe(100);
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

  it('drops a non-finite or non-positive mass instead of wedging the integrator', () => {
    // mass 0 divides the acceleration by zero: the first update writes ±Infinity
    // into the velocity, every later step is NaN, and `isAtRest()` (NaN < eps is
    // false) can never turn true — the property freezes off-target.
    const zeroMass = new SpringDriver(0, 100, { mass: 0 });
    for (let i = 0; i < 600 && !zeroMass.isDone(); i++) zeroMass.tick(16);
    expect(zeroMass.isDone()).toBe(true);
    zeroMass.tick(16);
    expect(zeroMass.value).toBeCloseTo(100, 3);

    const nanStiffness = new SpringDriver(0, 100, { stiffness: Number.NaN });
    for (let i = 0; i < 600 && !nanStiffness.isDone(); i++) nanStiffness.tick(16);
    expect(nanStiffness.isDone()).toBe(true);
    nanStiffness.tick(16);
    expect(nanStiffness.value).toBeCloseTo(100, 3);
  });

  it('exposes the underlying SpringPhysics (no copy) for the batched WASM gather', () => {
    const d = new SpringDriver(0, 1, { stiffness: 200, damping: 20, mass: 2 });
    d.tick(16);
    const g = d.physics;
    expect(g.target).toBe(1);
    expect(g.stiffness).toBe(200);
    expect(g.damping).toBe(20);
    expect(g.mass).toBe(2);
    expect(g.value).toBe(d.value);
  });

  it('syncExternal overwrites value + velocity so tick()/isDone()/retarget() stay correct afterward', () => {
    const d = new SpringDriver(0, 1, {});
    // Simulate an externally-advanced step (e.g. a batched WASM tick) that
    // landed the spring already at rest, without ever calling d.tick().
    d.syncExternal(1, 0);
    expect(d.value).toBe(1);
    expect(d.isDone()).toBe(true);
    d.retarget(2);
    expect(d.isDone()).toBe(false);
    for (let i = 0; i < 600 && !d.isDone(); i++) d.tick(16);
    expect(d.isDone()).toBe(true);
    expect(d.value).toBeCloseTo(2, 3);
  });
});
