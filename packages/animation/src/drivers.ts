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
  return typeof c === 'object' && 'duration' in c;
}

/** Backs one animating property. Ticked in ms; writes `value`. */
export interface PropertyDriver {
  value: number;
  /** The current destination — applied exactly when the animation completes, so a
   * finished spring lands on target rather than within its rest epsilon. */
  readonly target: number;
  /** Change the destination. Spring keeps velocity; tween restarts from current value. */
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
  private readonly delay: number;
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
    this.delay = Math.max(0, Number.isFinite(cfg.delay) ? (cfg.delay ?? 0) : 0);
    this.easingName = typeof cfg.easing === 'function' ? null : (cfg.easing ?? 'easeOutQuad');
    this.ease = typeof cfg.easing === 'function' ? cfg.easing : Easing[cfg.easing ?? 'easeOutQuad'];
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
  get delayMs(): number {
    return this.delay;
  }

  retarget(to: number): void {
    this.from = this.value;
    this.to = to;
    this.elapsed = 0;
  }

  tick(dtMs: number): void {
    this.elapsed += dtMs;
    const active = this.elapsed - this.delay;
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
    return this.elapsed - this.delay >= this.duration;
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
    // Non-finite or non-positive config wedges the integrator permanently:
    // mass 0 divides the acceleration by zero (velocity → ±Infinity, every
    // later value NaN) and `isAtRest()` — NaN comparisons are false — never
    // turns true, so the property freezes off-target. Drop the invalid field
    // and keep the physics default instead.
    if (cfg.stiffness !== undefined && Number.isFinite(cfg.stiffness))
      this.spring.stiffness = cfg.stiffness;
    if (cfg.damping !== undefined && Number.isFinite(cfg.damping))
      this.spring.damping = cfg.damping;
    if (cfg.mass !== undefined && Number.isFinite(cfg.mass) && cfg.mass > 0)
      this.spring.mass = cfg.mass;
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
