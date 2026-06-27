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
    const forceSpring = -this.stiffness * (this.value - this.target);
    const forceDamping = -this.damping * this.velocity;
    const acceleration = (forceSpring + forceDamping) / this.mass;

    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;
  }

  public isAtRest(): boolean {
    return (
      Math.abs(this.value - this.target) < this.valEpsilon &&
      Math.abs(this.velocity) < this.velEpsilon
    );
  }
}
