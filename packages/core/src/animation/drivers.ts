import { SpringPhysics } from '../math/SpringPhysics';
import { Easing, type EasingFn, type EasingName } from './easing';

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
  /** Change the destination. Spring keeps velocity; tween restarts from current value. */
  retarget(to: number): void;
  tick(dtMs: number): void;
  isDone(): boolean;
}

export class TweenDriver implements PropertyDriver {
  public value: number;
  private from: number;
  private to: number;
  private elapsed = 0;
  private readonly duration: number;
  private readonly delay: number;
  private readonly ease: EasingFn;

  constructor(from: number, to: number, cfg: TweenConfig) {
    this.value = from;
    this.from = from;
    this.to = to;
    this.duration = Math.max(1, cfg.duration);
    this.delay = cfg.delay ?? 0;
    this.ease = typeof cfg.easing === 'function' ? cfg.easing : Easing[cfg.easing ?? 'easeOutQuad'];
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
  }

  isDone(): boolean {
    return this.elapsed - this.delay >= this.duration;
  }
}

export class SpringDriver implements PropertyDriver {
  private spring: SpringPhysics;

  constructor(from: number, to: number, cfg: SpringConfig) {
    this.spring = new SpringPhysics(from);
    if (cfg.stiffness !== undefined) this.spring.stiffness = cfg.stiffness;
    if (cfg.damping !== undefined) this.spring.damping = cfg.damping;
    if (cfg.mass !== undefined) this.spring.mass = cfg.mass;
    this.spring.target = to;
  }

  get value(): number {
    return this.spring.value;
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
}
