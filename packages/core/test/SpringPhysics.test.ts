import { describe, it, expect } from 'vitest';
import { SpringPhysics } from '../src/math/SpringPhysics';

describe('SpringPhysics', () => {
  it('converges to target and goes to rest', () => {
    const spring = new SpringPhysics(0);
    spring.target = 100;

    // Simulate update over 150 frames of 16ms (~2.4s)
    for (let i = 0; i < 150; i++) {
      spring.update(0.016);
    }
    expect(spring.isAtRest()).toBe(true);
    expect(spring.value).toBeCloseTo(100, 1);
    expect(spring.velocity).toBeCloseTo(0, 1);
  });

  it('instantly returns at rest when target matches value', () => {
    const spring = new SpringPhysics(50);
    expect(spring.isAtRest()).toBe(true);
    spring.update(0.016);
    expect(spring.value).toBe(50);
    expect(spring.velocity).toBe(0);
  });
});
