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
});
