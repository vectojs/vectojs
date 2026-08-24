import { describe, it, expect } from 'vitest';
import { TweenDriver, SpringDriver, isTweenConfig } from '../src/drivers';
import type { EasingFn } from '../src/easing';
import type { SpringConfig } from '../src/drivers';

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

  it('ignores NaN and negative dt instead of poisoning the elapsed clock', () => {
    const d = new TweenDriver(0, 100, { duration: 200, easing: 'linear' });
    // One tick(NaN) used to make `elapsed` NaN forever: every later value was
    // NaN and `isDone()` never turned true.
    d.tick(Number.NaN);
    expect(d.value).toBe(0);
    expect(d.isDone()).toBe(false);
    // A negative dt rewound the monotonic clock, un-completing finished tweens.
    d.tick(100);
    d.tick(100);
    expect(d.isDone()).toBe(true);
    expect(d.value).toBeCloseTo(100, 6);
    d.tick(-50);
    expect(d.isDone()).toBe(true);
    expect(d.value).toBeCloseTo(100, 6);
  });

  describe('isTweenConfig', () => {
    it('returns false for null instead of throwing on `in null`', () => {
      // `typeof null === 'object'`, so `'duration' in null` threw a TypeError
      // in the exact discriminator built for untrusted runtime configs.
      expect(isTweenConfig(null as never)).toBe(false);
      expect(isTweenConfig(undefined as never)).toBe(false);
    });

    it('discriminates springs from tweens', () => {
      expect(isTweenConfig({ duration: 200 })).toBe(true);
      expect(isTweenConfig({ stiffness: 180 })).toBe(false);
    });
  });

  it('respects delay before moving', () => {
    const d = new TweenDriver(0, 10, { duration: 100, delay: 50, easing: 'linear' });
    d.tick(50); // still in delay
    expect(d.value).toBeCloseTo(0, 6);
    d.tick(50); // half of the actual tween
    expect(d.value).toBeCloseTo(5, 6);
  });

  it('rejects unknown easing names at construction instead of crashing on first tick', () => {
    // `Easing['easeOtuQaud']` used to resolve to undefined: the first tick
    // died with a bare TypeError and `wasmEasingId` returned undefined,
    // breaking its `number | null` contract.
    expect(
      () => new TweenDriver(0, 100, { duration: 100, easing: 'easeOtuQaud' as never }),
    ).toThrow(/unknown easing name "easeOtuQaud"/);
    expect(
      () => new TweenDriver(0, 100, { duration: 100, easing: 'not-an-easing' as never }),
    ).toThrow(/expected one of/);
  });

  it('keeps consumed delay consumed across retargets (no starvation)', () => {
    // The old retarget reset `elapsed`, fully re-charging the startup delay on
    // every retarget — rapid retargets plus a delay starved the tween forever.
    const d = new TweenDriver(0, 10, { duration: 100, delay: 50, easing: 'linear' });
    d.tick(60); // delay paid (50) + 10ms of motion
    expect(d.value).toBeCloseTo(1, 6);
    d.retarget(20);
    expect(d.delayMs).toBe(60); // segment start moved to "now": zero re-charge
    d.tick(100); // one fresh duration completes the new segment immediately
    expect(d.isDone()).toBe(true);
    expect(d.value).toBe(20);

    // Retargeting mid-flight starts the new segment immediately.
    const e = new TweenDriver(0, 100, { duration: 100, easing: 'linear' });
    for (let i = 0; i < 5; i++) {
      e.tick(16); // rapid successive retargets must still make progress
      e.retarget(e.target + 1);
      const before = e.value;
      e.tick(8);
      expect(e.value).toBeGreaterThan(before - 1e-9); // never frozen
    }
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      e.tick(16);
      done = e.isDone();
    }
    expect(done).toBe(true);
  });

  it('retarget during the initial delay waits out only the remaining part', () => {
    const d = new TweenDriver(0, 10, { duration: 100, delay: 50, easing: 'linear' });
    d.tick(20); // 20 of the 50ms delay consumed
    d.retarget(5);
    d.tick(29);
    expect(d.value).toBeCloseTo(0, 9); // still inside the remaining 30ms delay
    d.tick(2);
    expect(d.value).toBeGreaterThan(0); // segment now animating toward 5
    d.tick(100);
    expect(d.value).toBe(5);
    expect(d.isDone()).toBe(true);
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

  it('rejects non-finite or non-positive spring config at construction', () => {
    // Any of these wedges the integrator permanently — mass 0 divides the
    // acceleration by zero (velocity → ±Infinity → NaN), damping ≤ 0 never
    // settles or diverges, stiffness ≤ 0 pushes away from the target — and
    // `isDone()` can then never turn true, hanging completion awaits. The
    // driver used to silently fall back to physics defaults, hiding which
    // field was bad; it now throws with the field named.
    const badConfigs: Array<[SpringConfig, RegExp]> = [
      [{ mass: 0 }, /mass must be a finite number > 0 \(received 0\)/],
      [{ mass: -2 }, /mass must be a finite number > 0 \(received -2\)/],
      [{ stiffness: Number.NaN }, /stiffness must be a finite number > 0/],
      [{ stiffness: 0 }, /stiffness must be a finite number > 0 \(received 0\)/],
      [{ damping: -1 }, /damping must be a finite number > 0 \(received -1\)/],
      [{ damping: Number.POSITIVE_INFINITY }, /damping must be a finite number > 0/],
    ];
    for (const [cfg, message] of badConfigs) {
      expect(() => new SpringDriver(0, 100, cfg)).toThrow(message);
    }

    // Valid configs still converge exactly as before.
    const d = new SpringDriver(0, 100, { mass: 4 });
    for (let i = 0; i < 1200 && !d.isDone(); i++) d.tick(16);
    expect(d.isDone()).toBe(true);
    d.tick(16);
    expect(d.value).toBeCloseTo(100, 3);
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
