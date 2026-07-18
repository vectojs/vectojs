import { describe, it, expect } from 'vitest';
import { ComputeParticleEntity } from '../src/tree/ComputeParticleEntity';

describe('ComputeParticleEntity', () => {
  it('should initialize with options and disperse particles', () => {
    const entity = new ComputeParticleEntity({
      maxParticles: 100,
      springK: 0.1,
      damping: 0.9,
      size: 5,
      color: '#ff0000',
    });

    expect(entity.maxParticles).toBe(100);
    expect(entity.springK).toBe(0.1);
    expect(entity.damping).toBe(0.9);
    expect(entity.size).toBe(5);
    expect(entity.baseColor).toBe('#ff0000');
    expect(entity.particleData.length).toBe(100 * 8);

    entity.initRandomParticles(800, 600);
    // Expect coordinates within bounds
    for (let i = 0; i < 100; i++) {
      const px = entity.particleData[i * 8];
      const py = entity.particleData[i * 8 + 1];
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(800);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(600);

      // origin should match initial position
      expect(entity.particleData[i * 8 + 4]).toBe(px);
      expect(entity.particleData[i * 8 + 5]).toBe(py);
      // perpetual particles should have life = -1.0
      expect(entity.particleData[i * 8 + 7]).toBe(-1.0);
    }
  });

  it('should run CPU fallback integration loop and handle collisions/explosions', () => {
    const entity = new ComputeParticleEntity({
      maxParticles: 3,
      springK: 0.1,
      damping: 0.9,
      bounceDamping: 0.5,
      maxVelocity: 100,
    });

    // Particle 0: Spring force + life decay
    // position at (100, 100), origin at (110, 100)
    entity.particleData[0] = 100;
    entity.particleData[1] = 100;
    entity.particleData[2] = 0; // vx
    entity.particleData[3] = 0; // vy
    entity.particleData[4] = 110; // ox
    entity.particleData[5] = 100; // oy
    entity.particleData[6] = 4;
    entity.particleData[7] = 1.0; // life

    // Particle 1: Elastic boundary bouncing + bounds clamping
    // position near right boundary (799, 100), moving fast right
    entity.particleData[8] = 799;
    entity.particleData[9] = 100;
    entity.particleData[10] = 200; // vx (will be capped to 100)
    entity.particleData[11] = 0; // vy
    entity.particleData[12] = 799; // ox
    entity.particleData[13] = 100; // oy
    entity.particleData[14] = 4;
    entity.particleData[15] = -1.0; // perpetual

    // Particle 2: Explosion impulse
    // position at (100, 100), origin at (100, 100)
    entity.particleData[16] = 100;
    entity.particleData[17] = 100;
    entity.particleData[18] = 0; // vx
    entity.particleData[19] = 0; // vy
    entity.particleData[20] = 100; // ox
    entity.particleData[21] = 100; // oy
    entity.particleData[22] = 4;
    entity.particleData[23] = -1.0;

    // Trigger an explosion at (95, 100) with force 10
    entity.triggerExplosion(95, 100, 10);

    // Step simulation
    // Using dt = 0.05 to ensure boundary crossings and clear differences
    entity.updateCPU(0.05, -9999, -9999, 800, 600);

    // Particle 0:
    // Spring force = (110 - 100) * 0.1 = 1.0. New vx = (0 + 1 * 0.05) * 0.9 = 0.045
    // New px = 100 + 0.045 * 0.05 = 100.00225
    expect(entity.particleData[0]).toBeGreaterThan(100);
    expect(entity.particleData[7]).toBeCloseTo(1.0 - 0.05 * 0.5, 5); // life decayed

    // Particle 1:
    // Initial velocity 200 capped to 100.
    // Integrated position (without clamp/bounce): 799 + 100 * 0.05 = 804.
    // Since 804 >= 800, it should bounce:
    // nvx becomes -nvx * bounceDamping = -100 * 0.5 = -50.
    // Position clamped to 800.
    expect(entity.particleData[8]).toBe(800);
    expect(entity.particleData[10]).toBe(-50);

    // Particle 2:
    // Expl center (95, 100), particle at (100, 100).
    // dx = 95 - 100 = -5, dy = 0. dist = 5.
    // forceMag = (150 - 5) * 10 = 1450.
    // fx_expl = -(-5 / 5) * 1450 = 1450.
    // New vx = (0 + 1450 * 0.05) * 0.9 = 65.25. (Will be capped to 100, but let's check direction / change)
    expect(entity.particleData[18]).toBeGreaterThan(0);
  });

  describe('hasPendingAnimations', () => {
    it('returns true while particles have meaningful velocity', () => {
      const entity = new ComputeParticleEntity({ maxParticles: 2 });
      // particle 0: fast-moving
      entity.particleData[2] = 10; // vx
      entity.particleData[7] = -1.0; // alive
      expect(entity.hasPendingAnimations()).toBe(true);
    });

    it('returns true while a particle sits away from its spring origin, even at zero velocity', () => {
      const entity = new ComputeParticleEntity({ maxParticles: 1 });
      entity.particleData[0] = 100; // px
      entity.particleData[1] = 100; // py
      entity.particleData[2] = 0; // vx
      entity.particleData[3] = 0; // vy
      entity.particleData[4] = 150; // ox (far from px)
      entity.particleData[5] = 100; // oy
      entity.particleData[7] = -1.0; // alive
      expect(entity.hasPendingAnimations()).toBe(true);
    });

    it('returns false once every live particle is at rest at its origin', () => {
      const entity = new ComputeParticleEntity({ maxParticles: 3 });
      entity.initRandomParticles(800, 600); // sets position === origin, velocity 0
      expect(entity.hasPendingAnimations()).toBe(false);
    });

    it('returns false when all particles are dead (life === 0)', () => {
      const entity = new ComputeParticleEntity({ maxParticles: 2 });
      entity.particleData[2] = 999; // vx on a dead particle should be ignored
      entity.particleData[7] = 0; // life === 0 -> dead
      expect(entity.hasPendingAnimations()).toBe(false);
    });

    it('returns true while an explosion is pending, even before the next updateCPU tick applies it', () => {
      const entity = new ComputeParticleEntity({ maxParticles: 1 });
      entity.initRandomParticles(800, 600);
      expect(entity.hasPendingAnimations()).toBe(false);
      entity.triggerExplosion(10, 10, 100);
      expect(entity.hasPendingAnimations()).toBe(true);
    });

    it('a below-threshold residual velocity/offset does not keep the scene animating forever', () => {
      // A spring+damping system asymptotically approaches (never exactly
      // reaches) zero velocity/offset — this is the exact case the epsilon
      // thresholds exist to handle, so the idle throttle can still engage.
      const entity = new ComputeParticleEntity({ maxParticles: 1 });
      entity.particleData[0] = 100.01; // px — 0.01px from origin
      entity.particleData[1] = 100;
      entity.particleData[2] = 0.01; // vx — negligible residual velocity
      entity.particleData[3] = 0;
      entity.particleData[4] = 100; // ox
      entity.particleData[5] = 100;
      entity.particleData[7] = -1.0;
      expect(entity.hasPendingAnimations()).toBe(false);
    });
  });
});
