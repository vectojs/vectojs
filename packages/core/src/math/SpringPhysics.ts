// Explicit Euler is conditionally stable: one step is only safe while
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
  public mass: number = 1;

  private readonly valEpsilon = 0.005;
  private readonly velEpsilon = 0.005;

  constructor(initial: number) {
    this.value = initial;
    this.target = initial;
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
