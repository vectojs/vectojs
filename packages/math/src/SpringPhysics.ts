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
  public velocity: number = 0;

  private stiffnessValue: number = 180;
  private dampingValue: number = 12;

  private readonly valEpsilon = 0.005;
  private readonly velEpsilon = 0.005;
  private massValue: number = 1;

  constructor(initial: number) {
    // Same policy as the mutation-path validation below: a non-finite initial
    // value or target poisons every comparison in `isAtRest()` (NaN compares
    // false), so the spring would never report rest and an await on completion
    // would hang forever. Throw at construction instead.
    if (!Number.isFinite(initial)) {
      throw new Error(`SpringPhysics initial value must be finite (received ${String(initial)})`);
    }
    this.value = initial;
    this.targetValue = initial;
  }

  /**
   * Spring constant k. Must be a finite number > 0: negative stiffness inverts
   * the restoring force (`-k·(x - target)` pushes away from the target) and
   * zero or non-finite stiffness either freezes the integration or drives the
   * state to NaN — in every case `isAtRest()` can never turn true again.
   */
  public get stiffness(): number {
    return this.stiffnessValue;
  }

  public set stiffness(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `SpringPhysics.stiffness must be a finite number > 0 (received ${String(value)})`,
      );
    }
    this.stiffnessValue = value;
  }

  /**
   * Damping coefficient c. Must be a finite number > 0: damping ≤ 0 removes
   * the energy drain or actively amplifies oscillation, and a non-finite
   * coefficient writes NaN into the velocity on the first update — both wedge
   * the spring permanently.
   */
  public get damping(): number {
    return this.dampingValue;
  }

  public set damping(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `SpringPhysics.damping must be a finite number > 0 (received ${String(value)})`,
      );
    }
    this.dampingValue = value;
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

  public get target(): number {
    return this.targetValue;
  }

  /**
   * Rest position. Must be finite: a NaN target makes every `isAtRest()`
   * comparison false forever (the spring can never settle) and an infinite
   * target integrates an unbounded runaway. Invalid assignments throw at
   * mutation time, matching the stiffness/damping/mass policy.
   */
  public set target(value: number) {
    if (!Number.isFinite(value)) {
      throw new Error(`SpringPhysics.target must be a finite number (received ${String(value)})`);
    }
    this.targetValue = value;
  }

  private targetValue: number;

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
