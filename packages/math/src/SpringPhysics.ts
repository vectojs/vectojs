// Semi-implicit (symplectic) Euler — velocity is integrated before position —
// is conditionally stable: one step is only safe while
// dt·√(k/m) stays small. rAF pauses in background tabs, so the first frame
// after returning can deliver seconds of dt — integrated as a single step,
// that catapults the value to ~10⁵ and the spring oscillates wildly. We cap
// the total simulated time per call (an animation "jumps ahead" at most this
// far after a long pause) and integrate it in fixed substeps.
const MAX_FRAME_DT = 0.25; // seconds of spring time simulated per update() call
const MAX_STEP_DT = 1 / 120; // stable for stiffness/mass ratios up to ~5.7e4

export class SpringPhysics {
  public value: number;
  public target: number;
  public velocity: number = 0;

  public stiffness: number = 180;
  public damping: number = 12;

  private readonly valEpsilon = 0.005;
  private readonly velEpsilon = 0.005;
  private massValue: number = 1;

  constructor(initial: number) {
    this.value = initial;
    this.target = initial;
  }

  /**
   * Inertial mass. Must be a finite number > 0: the acceleration divides by
   * mass every substep, so a zero (or negative, or non-finite) mass writes
   * ±Infinity into the velocity on the first update, every later value decays
   * to NaN, and `isAtRest()` — NaN comparisons are false — can never turn true
   * again. The spring would be wedged permanently, so invalid assignments
   * throw at mutation time instead of silently poisoning the integration.
   */
  public get mass(): number {
    return this.massValue;
  }

  public set mass(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`SpringPhysics.mass must be a finite number > 0 (received ${String(value)})`);
    }
    this.massValue = value;
  }

  public update(dt: number): void {
    if (this.isAtRest()) {
      this.value = this.target;
      this.velocity = 0;
      return;
    }
    if (!(dt > 0)) return; // rejects 0, negatives, and NaN

    let remaining = dt < MAX_FRAME_DT ? dt : MAX_FRAME_DT;
    while (remaining > 0) {
      const step = remaining < MAX_STEP_DT ? remaining : MAX_STEP_DT;
      const forceSpring = -this.stiffness * (this.value - this.target);
      const forceDamping = -this.damping * this.velocity;
      const acceleration = (forceSpring + forceDamping) / this.mass;

      this.velocity += acceleration * step;
      this.value += this.velocity * step;
      remaining -= step;

      if (this.isAtRest()) {
        this.value = this.target;
        this.velocity = 0;
        return;
      }
    }
  }

  public isAtRest(): boolean {
    return (
      Math.abs(this.value - this.target) < this.valEpsilon &&
      Math.abs(this.velocity) < this.velEpsilon
    );
  }
}
