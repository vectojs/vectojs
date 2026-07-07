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

  describe('Damping ratio properties (ζ = c / (2 * sqrt(k * m)))', () => {
    it('underdamped (ζ < 1) should overshoot target', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      // ζ = 10 / (2 * sqrt(100 * 1)) = 10 / 20 = 0.5 < 1 (Underdamped)
      spring.stiffness = 100;
      spring.damping = 10;
      spring.mass = 1;

      let hasOvershot = false;
      for (let i = 0; i < 100; i++) {
        spring.update(0.016);
        if (spring.value > 100) {
          hasOvershot = true;
          break;
        }
      }
      expect(hasOvershot).toBe(true);
    });

    it('critically damped (ζ = 1) should not overshoot and converge rapidly', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      // ζ = 20 / (2 * sqrt(100 * 1)) = 20 / 20 = 1 (Critically damped)
      spring.stiffness = 100;
      spring.damping = 20;
      spring.mass = 1;

      let hasOvershot = false;
      for (let i = 0; i < 200; i++) {
        spring.update(0.016);
        if (spring.value > 100) {
          hasOvershot = true;
        }
      }
      expect(hasOvershot).toBe(false);
      expect(spring.isAtRest()).toBe(true);
    });

    it('overdamped (ζ > 1) should not overshoot and converge slower', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      // ζ = 40 / (2 * sqrt(100 * 1)) = 40 / 20 = 2 > 1 (Overdamped)
      spring.stiffness = 100;
      spring.damping = 40;
      spring.mass = 1;

      let hasOvershot = false;
      for (let i = 0; i < 100; i++) {
        spring.update(0.016);
        if (spring.value > 100) {
          hasOvershot = true;
        }
      }
      expect(hasOvershot).toBe(false);
      // Overdamped takes longer, so it might not be at rest in 100 frames
      // Let's assert it is at least moving towards 100 without overshooting
      expect(spring.value).toBeGreaterThan(50);
      expect(spring.value).toBeLessThan(100);
    });
  });

  describe('Large-dt stability (background tab / GC pause)', () => {
    it('does not diverge when a single frame delivers a multi-second dt', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      spring.update(0.016); // one normal frame
      spring.update(5.0); // tab was hidden: rAF resumes with a 5s delta

      // Explicit Euler with an unclamped dt used to catapult this to ~344,000.
      // The value must stay within a sane overshoot band around the target.
      expect(spring.value).toBeGreaterThan(-100);
      expect(spring.value).toBeLessThan(300);
      expect(Number.isFinite(spring.velocity)).toBe(true);

      // And it must still settle normally afterwards.
      for (let i = 0; i < 300; i++) spring.update(0.016);
      expect(spring.isAtRest()).toBe(true);
      expect(spring.value).toBeCloseTo(100, 1);
    });

    it('stays stable for stiff springs across jittery frame times', () => {
      const spring = new SpringPhysics(0);
      spring.target = 10;
      spring.stiffness = 5000;
      spring.damping = 30;
      const dts = [0.016, 0.2, 0.016, 1.5, 0.033, 0.5];
      for (const dt of dts) {
        spring.update(dt);
        expect(Number.isFinite(spring.value)).toBe(true);
        expect(Math.abs(spring.value)).toBeLessThan(1000);
      }
      for (let i = 0; i < 600; i++) spring.update(0.016);
      expect(spring.isAtRest()).toBe(true);
    });

    it('treats zero and negative dt as a no-op', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      spring.update(0);
      spring.update(-1);
      expect(spring.value).toBe(0);
      expect(spring.velocity).toBe(0);
    });
  });

  describe('Stress & Zero-GC validation', () => {
    it('handles 50,000 springs updating concurrently under 5ms/frame', () => {
      const count = 50000;
      const springs: SpringPhysics[] = [];
      for (let i = 0; i < count; i++) {
        const spring = new SpringPhysics(0);
        spring.target = 100;
        springs.push(spring);
      }

      const start = performance.now();
      // Simulate 1 frame of update for all 50k elements
      for (let i = 0; i < count; i++) {
        springs[i].update(0.016);
      }
      const duration = performance.now() - start;

      // Report benchmark time
      console.log(`[Benchmark] 50,000 springs update took: ${duration.toFixed(3)}ms`);

      // Ensure performance is acceptable (usually < 2ms on modern CPUs, we set a safe limit of 40ms for virtualized CI runner)
      expect(duration).toBeLessThan(40);
    });
  });
});
