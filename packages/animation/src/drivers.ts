import { SpringPhysics } from '@vectojs/math';
import { Easing, EASING_IDS, type EasingFn, type EasingName } from './easing';

export interface SpringConfig {
  stiffness?: number;
  damping?: number;
  mass?: number;
}
export interface TweenConfig {
  duration: number;
  easing?: EasingName | EasingFn;
  delay?: number;
}
/** A motion config. Presence of `duration` selects a tween; otherwise a spring. */
export type MotionConfig = 'spring' | SpringConfig | TweenConfig;

export function isTweenConfig(c: MotionConfig): c is TweenConfig {
  // `typeof null === 'object'`, so the null check must come first — this
  // discriminator exists for untrusted runtime configs and `'duration' in
  // null` throws a TypeError.
  return typeof c === 'object' && c !== null && 'duration' in c;
}

/** Backs one animating property. Ticked in ms; writes `value`. */
export interface PropertyDriver {
  value: number;
  /** The current destination — applied exactly when the animation completes, so a
   * finished spring lands on target rather than within its rest epsilon. */
  readonly target: number;
  /**
   * Change the destination. Spring keeps velocity; tween restarts from the
   * current value. The tween's startup delay is charged once on the monotonic
   * elapsed clock — a retarget never re-charges consumed delay, so rapid
   * retargets cannot starve the animation indefinitely.
   */
  retarget(to: number): void;
  tick(dtMs: number): void;
  isDone(): boolean;
  /**
   * Overwrite internal state to match an externally-advanced step (e.g. a
   * batched/offloaded tick that ran this driver's math elsewhere), so
   * `tick()`/`isDone()`/`retarget()`/`value` all stay correct on every call
   * afterward, regardless of who advanced the last step. `extra` carries a
   * kind-specific second piece of state: velocity for a spring, elapsed-ms
   * for a tween.
   */
  syncExternal(value: number, extra: number): void;
}

export class TweenDriver implements PropertyDriver {
  public value: number;
  private from: number;
  private to: number;
  private elapsed = 0;
  private readonly duration: number;
  /**
   * Start offset of the current segment on the monotonic `elapsed` clock.
   * Seeded with the configured delay; `retarget()` raises it to the clock
   * value at which the retarget happened, so consumed delay is never
   * re-charged and rapid retargets cannot starve the animation. Exposed to
   * the batched WASM gather through `delayMs`, so both engines advance a
   * segment with the same `active = elapsed - startOffset` formula.
   */
  private startAt: number;
  private readonly ease: EasingFn;
  /** Name of the resolved easing, or `null` for a custom `EasingFn` closure —
   *  a closure cannot cross into WASM, so `null` means "JS-tick only". */
  private readonly easingName: EasingName | null;

  constructor(from: number, to: number, cfg: TweenConfig) {
    this.value = from;
    this.from = from;
    this.to = to;
    // Non-finite config values wedge the driver permanently: `Math.max(1, NaN)`
    // is NaN, `active / NaN` is NaN, the tween's value freezes at NaN and
    // `isDone()` (elapsed >= NaN is false) never turns true. Clamp to the
    // minimum-1ms default the clamp already enforced for finite input.
    this.duration = Math.max(1, Number.isFinite(cfg.duration) ? cfg.duration : 1);
    this.startAt = Math.max(0, Number.isFinite(cfg.delay) ? (cfg.delay ?? 0) : 0);
    if (typeof cfg.easing === 'function') {
      this.easingName = null;
      this.ease = cfg.easing;
    } else {
      const name = cfg.easing ?? 'easeOutQuad';
      // A JS caller can pass any string at runtime; an unknown name would
      // resolve `Easing[name]` to undefined and crash with a bare TypeError
      // on the first tick, while `wasmEasingId` would return undefined and
      // break its `number | null` contract. Fail at config time instead.
      const resolved = (Easing as Record<string, EasingFn | undefined>)[name];
      if (typeof resolved !== 'function') {
        throw new Error(
          `TweenDriver: unknown easing name ${JSON.stringify(
            String(name),
          )}; expected one of ${Object.keys(Easing).join(', ')}`,
        );
      }
      this.easingName = name;
      this.ease = resolved;
    }
  }

  get target(): number {
    return this.to;
  }

  /** Numeric easing id for the batched WASM tween kernel, or `null` if this
   *  tween uses a custom `EasingFn` and must stay on the JS `tick()` path. */
  get wasmEasingId(): number | null {
    return this.easingName === null ? null : EASING_IDS[this.easingName];
  }

  // Allocation-free field reads for the batched WASM tween kernel's gather
  // step — a per-call wrapper object here would mean one extra allocation per
  // active tween per frame, exactly the kind of per-frame garbage the
  // integrated benchmark (benchmarks/anim-wasm-scene) found dominating the
  // gather cost.
  get fromValue(): number {
    return this.from;
  }
  get elapsedMs(): number {
    return this.elapsed;
  }
  get durationMs(): number {
    return this.duration;
  }
  /**
   * Effective start offset of the current segment on the elapsed clock — the
   * configured delay until it is first consumed, then the retarget moment.
   * The WASM gather feeds this into the same `active = elapsed - delay`
   * formula the JS `tick()` uses, keeping the two engines identical.
   */
  get delayMs(): number {
    return this.startAt;
  }

  retarget(to: number): void {
    this.from = this.value;
    this.to = to;
    // Keep the tween clock running: raise the segment start to "now" instead
    // of resetting `elapsed`, so a delay that has already been consumed (or a
    // tween already in flight) is not paid for a second time. Retargeting
    // during the initial delay keeps waiting out only the remaining part.
    if (this.elapsed > this.startAt) this.startAt = this.elapsed;
  }

  tick(dtMs: number): void {
    // Same guard `SpringPhysics.update` applies: a NaN dt poisons `elapsed`
    // forever (every later comparison is false, `isDone()` never turns true)
    // and a negative dt rewinds the monotonic clock, un-completing finished
    // tweens. Ignore the step instead of integrating garbage.
    if (!(dtMs > 0)) return;
    this.elapsed += dtMs;
    const active = this.elapsed - this.startAt;
    if (active <= 0) return;
    const p = Math.min(active / this.duration, 1);
    this.value = this.from + (this.to - this.from) * this.ease(p);
    // A custom `EasingFn` may not satisfy f(1) === 1 (the built-ins do), in
    // which case `isDone()` turning true and the value landing short of `to`
    // would disagree forever. Once the tween is complete the property must be
    // exactly the destination — the same contract a finished spring already
    // honors.
    if (active >= this.duration) this.value = this.to;
  }

  isDone(): boolean {
    return this.elapsed - this.startAt >= this.duration;
  }

  /** Write back a WASM-advanced (value, elapsedMs) pair. */
  syncExternal(value: number, elapsedMs: number): void {
    this.value = value;
    this.elapsed = elapsedMs;
  }
}

export class SpringDriver implements PropertyDriver {
  private spring: SpringPhysics;

  constructor(from: number, to: number, cfg: SpringConfig) {
    this.spring = new SpringPhysics(from);
    // Config validation is loud rather than lenient on purpose. A non-finite
    // or non-positive stiffness/damping/mass wedges the integrator permanently:
    // mass 0 divides the acceleration by zero (velocity → ±Infinity, every
    // later value NaN), damping ≤ 0 removes the energy drain or actively
    // amplifies it, and stiffness ≤ 0 pushes away from the target — in every
    // case `isAtRest()` never turns true and a completion await hangs forever.
    // Falling back to the physics default used to hide which config field was
    // bad; throwing at construction surfaces it immediately.
    this.spring.stiffness = positiveConfig(cfg.stiffness ?? 180, 'stiffness');
    this.spring.damping = positiveConfig(cfg.damping ?? 12, 'damping');
    this.spring.mass = positiveConfig(cfg.mass ?? 1, 'mass');
    this.spring.target = to;
  }

  get value(): number {
    return this.spring.value;
  }

  get target(): number {
    return this.spring.target;
  }

  retarget(to: number): void {
    this.spring.target = to; // velocity/value preserved -> continuous
  }

  tick(dtMs: number): void {
    this.spring.update(dtMs / 1000); // SpringPhysics integrates in seconds
  }

  isDone(): boolean {
    return this.spring.isAtRest();
  }

  /** Write back a WASM-advanced (value, velocity) pair. */
  syncExternal(value: number, velocity: number): void {
    this.spring.value = value;
    this.spring.velocity = velocity;
  }

  // Read-only access to the underlying spring physics for the batched WASM
  // kernel's gather step — returns the EXISTING SpringPhysics instance (whose
  // value/target/velocity/stiffness/damping/mass are all already public), not
  // a copy, so gathering one driver's state costs zero allocations instead of
  // one wrapper object per active spring per frame.
  get physics(): Readonly<SpringPhysics> {
    return this.spring;
  }
}

function positiveConfig(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `SpringDriver.${field} must be a finite number > 0 (received ${String(value)})`,
    );
  }
  return value;
}
