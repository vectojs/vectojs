import { describe, expect, it } from 'vitest';

import { BarnesHutQuadtree } from './BarnesHutQuadtree';

describe('BarnesHutQuadtree', () => {
  it('retains every coincident point with a far outlier', () => {
    const count = 64;
    const positions = new Float32Array(count * 2);
    positions[(count - 1) * 2] = 100;
    const charges = new Float32Array(count).fill(1);
    const tree = new BarnesHutQuadtree();
    tree.build(positions, charges, count);
    const nearby: number[] = [];
    const force = new Float64Array(2);
    tree.forEachNearby(0, 0, 0.01, (point) => nearby.push(point));

    expect(nearby.sort((a, b) => a - b)).toEqual(
      Array.from({ length: count - 1 }, (_, index) => index),
    );
    tree.force(100, 0, 0, count - 1, force);
    expect(force[0]).toBeCloseTo(63 / 10_000, 8);
  });

  it('keeps coincident pair dynamics symmetric', () => {
    const tree = new BarnesHutQuadtree();
    tree.build(new Float32Array([0, 0, 0, 0]), new Float32Array([1, 1]), 2);
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    tree.force(0, 0, 0, 0, a);
    tree.force(0, 0, 0, 1, b);

    expect(a[0]).toBeCloseTo(-b[0], 10);
    expect(a[1]).toBeCloseTo(-b[1], 10);
    expect(Math.hypot(...a)).toBeGreaterThan(0);
  });

  it('matches exact all-pairs force when theta is zero', () => {
    const positions = new Float32Array([-4, 2, 1, -3, 5, 7, 9, -1, -6, -8]);
    const charges = new Float32Array([1, 2, 3, 4, 5]);
    const tree = new BarnesHutQuadtree();
    tree.build(positions, charges, charges.length);

    for (let query = 0; query < charges.length; query++) {
      let expectedX = 0;
      let expectedY = 0;
      for (let point = 0; point < charges.length; point++) {
        if (point === query) continue;
        const dx = positions[point * 2] - positions[query * 2];
        const dy = positions[point * 2 + 1] - positions[query * 2 + 1];
        const distanceSquared = Math.max(dx * dx + dy * dy, 1e-6);
        const factor = -charges[point] / (distanceSquared * Math.sqrt(distanceSquared));
        expectedX += dx * factor;
        expectedY += dy * factor;
      }
      const actual = new Float64Array(2);
      tree.force(positions[query * 2], positions[query * 2 + 1], 0, query, actual);
      expect(actual[0]).toBeCloseTo(expectedX, 12);
      expect(actual[1]).toBeCloseTo(expectedY, 12);
    }
  });
});
