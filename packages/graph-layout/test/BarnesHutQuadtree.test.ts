import { describe, expect, it } from 'vitest';

import { BarnesHutQuadtree } from '../src/internal/BarnesHutQuadtree';

describe('BarnesHutQuadtree', () => {
  it('retains every coincident point with a far outlier', () => {
    const count = 64;
    const positions = new Float32Array(count * 2);
    positions[(count - 1) * 2] = 100;
    const charges = new Float32Array(count).fill(1);
    const tree = new BarnesHutQuadtree();
    tree.build(positions, charges, count);
    // Retention contract, exercised through the collision kernel now that the
    // test-only forEachNearby traversal is gone: every one of the 63 coincident
    // points must participate (nonzero separation velocity), while the far
    // outlier stays untouched.
    const radii = new Float32Array(count).fill(1);
    const velocityX = new Float32Array(count);
    const velocityY = new Float32Array(count);
    const pinned = new Uint8Array(count);
    tree.applyGridCollisions(
      positions,
      count,
      radii,
      velocityX,
      velocityY,
      pinned,
      pinned,
      1,
      7,
      1,
    );
    for (let point = 0; point < count - 1; point++)
      expect(Math.hypot(velocityX[point]!, velocityY[point]!)).toBeGreaterThan(0);
    expect(velocityX[count - 1]).toBe(0);
    expect(velocityY[count - 1]).toBe(0);

    const force = new Float64Array(2);
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

  it('excludes points at and beyond the maximum force distance', () => {
    const tree = new BarnesHutQuadtree();
    tree.build(new Float32Array([0, 0, 3, 4, 6, 8]), new Float32Array([1, 1, 1]), 3);
    const force = new Float64Array(2);

    tree.force(0, 0, 0.9, 0, force, 5);

    expect(force[0]).toBe(0);
    expect(force[1]).toBe(0);
  });

  it('keeps collision cells distinct beyond signed 32-bit coordinates', () => {
    const tree = new BarnesHutQuadtree();
    const positions = new Float32Array([1e10, -1e10, 1e10, -1e10]);
    const radii = new Float32Array([1, 1]);
    tree.build(positions, new Float32Array(2), 2);
    const velocityX = new Float32Array(2);
    const velocityY = new Float32Array(2);
    tree.applyGridCollisions(
      positions,
      2,
      radii,
      velocityX,
      velocityY,
      new Uint8Array(2),
      new Uint8Array(2),
      1,
      7,
      1,
    );

    expect(Math.hypot(velocityX[0], velocityY[0])).toBeGreaterThan(0);
    expect(velocityX[0]).toBe(-velocityX[1]);
    expect(velocityY[0]).toBe(-velocityY[1]);
  });

  it('applies each collision pair once beyond safe integer cell coordinates', () => {
    const collide = (coordinate: number): number => {
      const tree = new BarnesHutQuadtree();
      const positions = new Float32Array([coordinate, coordinate, coordinate, coordinate]);
      const radii = new Float32Array([1, 1]);
      tree.build(positions, new Float32Array(2), 2);
      const velocityX = new Float32Array(2);
      const velocityY = new Float32Array(2);
      tree.applyGridCollisions(
        positions,
        2,
        radii,
        velocityX,
        velocityY,
        new Uint8Array(2),
        new Uint8Array(2),
        1,
        7,
        1,
      );
      return Math.hypot(velocityX[0], velocityY[0]);
    };

    expect(collide(1e20)).toBeCloseTo(collide(0), 5);
  });

  it('separates varied-radius coincident points through the grid collision path', () => {
    const tree = new BarnesHutQuadtree();
    const positions = new Float32Array([0, 0, 0, 0, 18, 0]);
    const radii = new Float32Array([10, 5, 2]);
    tree.build(positions, new Float32Array([0, 0, 0]), 3);
    const velocityX = new Float32Array(3);
    const velocityY = new Float32Array(3);
    tree.applyGridCollisions(
      positions,
      3,
      radii,
      velocityX,
      velocityY,
      new Uint8Array(3),
      new Uint8Array(3),
      1,
      7,
      10,
    );

    // Radii [10, 5, 2] span three tiers; the coincident (0,1) pair is resolved
    // by its smaller member probing the larger tier's grid, so the tie-break
    // direction applies with roles swapped relative to single-grid ordering.
    // Only separation itself — and node 2 staying untouched (18 > 10+2) — is
    // the contract.
    expect(velocityX[0]).toBeGreaterThan(0);
    expect(velocityX[1]).toBeLessThan(0);
    expect(velocityX[2]).toBe(0);
  });
});

describe('BarnesHutQuadtree tiered collision binning', () => {
  function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Independent O(n^2) reference for one collision pass over zero velocities. */
  function bruteForce(
    positions: Float32Array,
    radii: Float32Array,
    count: number,
    strength: number,
    seed: number,
  ): { vx: Float32Array; vy: Float32Array } {
    const vx = new Float64Array(count);
    const vy = new Float64Array(count);
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const minDistance = radii[a]! + radii[b]!;
        let dx = positions[b * 2]! - positions[a * 2]!;
        let dy = positions[b * 2 + 1]! - positions[a * 2 + 1]!;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= minDistance * minDistance) continue;
        let distance = Math.sqrt(distanceSquared);
        if (distance < 1e-6) {
          const low = Math.min(a, b) + 1;
          const high = Math.max(a, b) + 1;
          let state = (seed ^ Math.imul(low, 0x9e3779b9) ^ Math.imul(high, 0x85ebca6b)) >>> 0;
          state = (state + 0x6d2b79f5) | 0;
          let v = Math.imul(state ^ (state >>> 15), 1 | state);
          v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
          const angle = (((v ^ (v >>> 14)) >>> 0) / 4294967296) * Math.PI * 2;
          dx = Math.cos(angle) * 1e-6;
          dy = Math.sin(angle) * 1e-6;
          distance = 1e-6;
        }
        const overlap = ((minDistance - distance) / distance) * strength;
        vx[a] -= dx * overlap * 0.5;
        vy[a] -= dy * overlap * 0.5;
        vx[b] += dx * overlap * 0.5;
        vy[b] += dy * overlap * 0.5;
      }
    }
    return {
      vx: Float32Array.from(vx, Math.fround),
      vy: Float32Array.from(vy, Math.fround),
    };
  }

  it('matches the brute-force pair set on mixed-radius scenes across several ticks', () => {
    // Exercises same-tier, cross-tier and zero-radius pairs against an
    // independent all-pairs reference — a missed probe or double resolution
    // shows up immediately as divergent velocities.
    const random = mulberry32(42);
    const count = 60;
    const positions = new Float32Array(count * 2);
    const radii = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = random() * 120 - 60;
      positions[i * 2 + 1] = random() * 120 - 60;
      radii[i] = i % 17 === 0 ? 12 : i % 23 === 0 ? 0 : 0.5 + random() * 3.5;
    }
    radii[7] = 20; // dominant hub
    radii[13] = 0.25; // tiny node inside the hub's reach
    const tree = new BarnesHutQuadtree();
    tree.build(positions, new Float32Array(count), count);

    const velocityX = new Float32Array(count);
    const velocityY = new Float32Array(count);
    const pinnedX = new Uint8Array(count);
    const pinnedY = new Uint8Array(count);
    // Positions drift with the accumulated velocity each tick so later ticks
    // see a different spatial distribution than the first. Velocities persist
    // across ticks, so compare per-tick DELTAS against the fresh reference.
    for (let tick = 0; tick < 3; tick++) {
      const beforeX = Float32Array.from(velocityX);
      const beforeY = Float32Array.from(velocityY);
      tree.applyGridCollisions(
        positions,
        count,
        radii,
        velocityX,
        velocityY,
        pinnedX,
        pinnedY,
        1,
        7,
        Math.max(...radii),
      );
      const reference = bruteForce(positions, radii, count, 1, 7);
      for (let i = 0; i < count; i++) {
        expect(Math.abs(velocityX[i]! - beforeX[i]! - reference.vx[i]!)).toBeLessThan(2e-6);
        expect(Math.abs(velocityY[i]! - beforeY[i]! - reference.vy[i]!)).toBeLessThan(2e-6);
      }
      for (let i = 0; i < count; i++) {
        positions[i * 2] = Math.fround(positions[i * 2]! + velocityX[i]!);
        positions[i * 2 + 1] = Math.fround(positions[i * 2 + 1]! + velocityY[i]!);
      }
    }
  });

  it('conserves pairwise momentum on skewed radius distributions', () => {
    const random = mulberry32(9);
    const count = 80;
    const positions = new Float32Array(count * 2);
    const radii = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = random() * 100 - 50;
      positions[i * 2 + 1] = random() * 100 - 50;
      radii[i] = i === 0 ? 30 : random() * 4 + 1;
    }
    const tree = new BarnesHutQuadtree();
    tree.build(positions, new Float32Array(count), count);
    const velocityX = new Float32Array(count);
    const velocityY = new Float32Array(count);
    const pinnedX = new Uint8Array(count);
    const pinnedY = new Uint8Array(count);
    tree.applyGridCollisions(
      positions,
      count,
      radii,
      velocityX,
      velocityY,
      pinnedX,
      pinnedY,
      1,
      3,
      Math.max(...radii),
    );

    let momentumX = 0;
    let momentumY = 0;
    for (let i = 0; i < count; i++) {
      momentumX += velocityX[i]!;
      momentumY += velocityY[i]!;
    }
    // f32 rounding accumulates a small residual across ~80 points; systematic
    // pair asymmetry (a missed or doubled resolution) would be orders larger.
    expect(Math.abs(momentumX)).toBeLessThan(1e-5);
    expect(Math.abs(momentumY)).toBeLessThan(1e-5);
  });

  it('keeps the counting sort correct when few points span hundreds of tiers', () => {
    // f32 radii may legally range from subnormals to F32_MAX (~280 powers of
    // two). The offset/cursor tables were once sized from the POINT count, so
    // a scene like this one — nine points, tier span 151 — overflowed them and
    // silently dropped counting-sort increments, corrupting every tier slice.
    // Every point except the hub participates in at most one overlapping pair,
    // so per-pair deltas compare against the reference without meaningful
    // accumulation-order noise even at extreme force magnitudes.
    const count = 9;
    const positions = new Float32Array(count * 2);
    const radii = new Float32Array(count);
    const place = (i: number, x: number, y: number, r: number) => {
      positions[i * 2] = x;
      positions[i * 2 + 1] = y;
      radii[i] = r;
    };
    place(0, 0, 0, 1e6); // tier ~19 pair, deep overlap
    place(1, 1, 0, 1e6);
    place(2, 500, 500, 1e-20); // subnormal-adjacent tiers, tiny overlap
    place(3, 500 + 1e-21, 500, 1e-20);
    place(4, 900, 0, 3); // cross-tier pair 26 tiers apart
    place(5, 902, 0, 5e-8);
    place(6, 2000, 0, 1e15); // hub spanning everything
    place(7, 2000 + 1e10, 0, 1e-30); // inside the hub: cross-tier overlap
    place(8, 2000 - 5e9, 0, 0); // zero-radius initiator against the hub

    const tree = new BarnesHutQuadtree();
    tree.build(positions, new Float32Array(count), count);
    const velocityX = new Float32Array(count);
    const velocityY = new Float32Array(count);
    const pinned = new Uint8Array(count);
    tree.applyGridCollisions(
      positions,
      count,
      radii,
      velocityX,
      velocityY,
      pinned,
      pinned,
      1,
      7,
      Math.max(...radii),
    );

    const reference = bruteForce(positions, radii, count, 1, 7);
    for (let i = 0; i < count; i++) {
      const tolerance = Math.max(1e-6, Math.abs(reference.vx[i]!) * 1e-6);
      expect(Math.abs(velocityX[i]! - reference.vx[i]!)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(velocityY[i]! - reference.vy[i]!)).toBeLessThanOrEqual(
        Math.max(1e-6, Math.abs(reference.vy[i]!) * 1e-6),
      );
    }
    // At least the deep-overlap pair must have resolved — an all-zero result
    // would mean every tier slice came out empty, not that the math agreed.
    expect(Math.abs(velocityX[0]!)).toBeGreaterThan(0);
    expect(Math.abs(velocityX[1]!)).toBeGreaterThan(0);
  });

  it('bounds the per-tick cost of a hub-and-leaves scene (signal only)', () => {
    // The old single grid sized by the maximum radius packed every leaf into
    // cells spanning the hub: measured 12ms -> 197ms per tick from 3k to 12k
    // points. Tiered bins keep the cost near-linear. Wall-clock numbers are
    // shared-CPU-noisy under parallel runs, so this is logged as a signal, not
    // gated — track regressions via the dedicated benchmarks instead.
    const build = (small: number) => {
      const n = small + 1;
      const positions = new Float32Array(n * 2);
      const radii = new Float32Array(n);
      for (let i = 0; i < small; i++) {
        positions[i * 2] = -200 + (i % 64) * 6.3;
        positions[i * 2 + 1] = -150 + (Math.floor(i / 64) % 48) * 6.3;
        radii[i] = 2;
      }
      positions[small * 2] = 0;
      positions[small * 2 + 1] = 0;
      radii[small] = 80;
      return { n, positions, radii };
    };
    const scene = build(3000);
    const tree = new BarnesHutQuadtree();
    tree.build(scene.positions, new Float32Array(scene.n), scene.n);
    const velocityX = new Float32Array(scene.n);
    const velocityY = new Float32Array(scene.n);
    const pinned = new Uint8Array(scene.n);
    const start = performance.now();
    for (let tick = 0; tick < 10; tick++) {
      tree.applyGridCollisions(
        scene.positions,
        scene.n,
        scene.radii,
        velocityX,
        velocityY,
        pinned,
        pinned,
        1,
        7,
        Math.max(...scene.radii),
      );
    }
    console.log(
      `[Signal] tiered collisions, 3001 pts (1 hub r=80): ${((performance.now() - start) / 10).toFixed(2)} ms/tick`,
    );
  });
});
