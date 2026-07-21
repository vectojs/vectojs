// packages/core/test/easing.test.ts
import { describe, it, expect } from 'vitest';
import { Easing } from '../src/easing';

describe('Easing', () => {
  it('every curve maps 0->0 and 1->1', () => {
    for (const fn of Object.values(Easing)) {
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
    }
  });

  it('easeOutQuad equals the legacy hardcoded curve t*(2-t)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Easing.easeOutQuad(t)).toBeCloseTo(t * (2 - t), 9);
    }
  });

  it('linear is identity; easeInOutCubic is monotonic increasing', () => {
    expect(Easing.linear(0.42)).toBeCloseTo(0.42, 9);
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const v = Easing.easeInOutCubic(Math.min(t, 1));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('easeOutBack overshoots above 1 before settling', () => {
    const peak = Math.max(
      ...Array.from({ length: 99 }, (_, i) => Easing.easeOutBack((i + 1) / 100)),
    );
    expect(peak).toBeGreaterThan(1);
  });
});
