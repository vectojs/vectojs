import { describe, expect, it } from 'vitest';
import { VectoForceLayout } from '../src/layout/VectoForceLayout';
import type { GraphData } from '../src/types';

const distance = (positions: Float32Array, a: number, b: number): number => {
  const dx = positions[a * 3] - positions[b * 3];
  const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
  const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
  return Math.hypot(dx, dy, dz);
};

/** A small ring graph, handy for exercising links + repulsion together. */
function ring(n: number): GraphData {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
  const links = Array.from({ length: n }, (_, i) => ({
    source: i,
    target: (i + 1) % n,
  }));
  return { nodes, links };
}

describe('VectoForceLayout — GraphLayout contract', () => {
  it('exposes one xyz triplet per node, in node order', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b' }],
    });
    expect(layout.positions).toHaveLength(9);
    layout.dispose();
  });

  it('moves nodes when stepped and eventually cools', () => {
    const layout = new VectoForceLayout();
    layout.setGraph(ring(6));
    const before = layout.positions.slice();
    expect(layout.step()).toBe(true);
    expect(layout.positions).not.toEqual(before);
    expect(layout.step(2000)).toBe(false); // alpha decays to alphaMin
    layout.dispose();
  });

  it('pulls linked nodes closer together than unlinked ones', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'lone' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.step(2000);
    expect(distance(layout.positions, 0, 1)).toBeLessThan(distance(layout.positions, 0, 2));
    layout.dispose();
  });

  it('never mutates the caller node objects', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const data: GraphData = { nodes, links: [{ source: 'a', target: 'b' }] };
    const layout = new VectoForceLayout();
    layout.setGraph(data);
    layout.step(50);
    expect(Object.keys(nodes[0])).toEqual(['id']);
    expect(Object.keys(nodes[1])).toEqual(['id']);
    layout.dispose();
  });

  it('honors x/y/z initial position seeds', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a', x: 10, y: -5, z: 3 }, { id: 'b' }],
      links: [],
    });
    expect(Array.from(layout.positions.slice(0, 3))).toEqual([10, -5, 3]);
  });

  it('honors fx/fy/fz pins', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'pinned', fx: 10, fy: -5, fz: 3 }, { id: 'free' }],
      links: [{ source: 'pinned', target: 'free' }],
    });
    layout.step(200);
    expect(layout.positions[0]).toBeCloseTo(10);
    expect(layout.positions[1]).toBeCloseTo(-5);
    expect(layout.positions[2]).toBeCloseTo(3);
    layout.dispose();
  });

  it('supports replacing the graph via setGraph', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.setGraph({
      nodes: [{ id: 'x' }, { id: 'y' }],
      links: [{ source: 'x', target: 'y' }],
    });
    expect(layout.positions).toHaveLength(6);
    expect(layout.step()).toBe(true);
    layout.dispose();
  });

  it('throws when used after dispose', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.dispose();
    expect(() => layout.step()).toThrow(/disposed/);
    expect(() => layout.setGraph({ nodes: [], links: [] })).toThrow(/disposed/);
  });

  it('pinNode holds a node fixed across steps', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.pinNode(0, 42, -17, 8);
    expect(layout.positions[0]).toBeCloseTo(42);
    expect(layout.positions[1]).toBeCloseTo(-17);
    expect(layout.positions[2]).toBeCloseTo(8);
    layout.step(200);
    expect(layout.positions[0]).toBeCloseTo(42);
    expect(layout.positions[1]).toBeCloseTo(-17);
    expect(layout.positions[2]).toBeCloseTo(8);
    layout.dispose();
  });

  it('unpinNode releases a pinned node back to free simulation', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.pinNode(0, 100, 0, 0);
    layout.step(50);
    expect(layout.positions[0]).toBeCloseTo(100);
    layout.unpinNode(0);
    layout.reheat(1);
    layout.step(400);
    expect(layout.positions[0]).not.toBeCloseTo(100);
    layout.dispose();
  });

  it('ignores pin/unpin for out-of-range indices without throwing', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    expect(() => layout.pinNode(5, 1, 2, 3)).not.toThrow();
    expect(() => layout.unpinNode(-1)).not.toThrow();
    layout.dispose();
  });

  it('reheat lets a cooled simulation move again', () => {
    const layout = new VectoForceLayout();
    layout.setGraph(ring(4));
    expect(layout.step(3000)).toBe(false);
    layout.reheat();
    expect(layout.step()).toBe(true);
    layout.dispose();
  });

  it('pin/unpin/reheat throw after dispose', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.dispose();
    expect(() => layout.pinNode(0, 1, 2, 3)).toThrow(/disposed/);
    expect(() => layout.unpinNode(0)).toThrow(/disposed/);
    expect(() => layout.reheat()).toThrow(/disposed/);
  });
});

describe('VectoForceLayout — in-house model specifics', () => {
  it('is deterministic: same seed + graph → identical layout', () => {
    const g = ring(30);
    const a = new VectoForceLayout({ seed: 7 });
    const b = new VectoForceLayout({ seed: 7 });
    a.setGraph(g);
    b.setGraph(g);
    a.step(100);
    b.step(100);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    a.dispose();
    b.dispose();
  });

  it('different seeds give different initial placements', () => {
    const g = ring(20);
    const a = new VectoForceLayout({ seed: 1 });
    const b = new VectoForceLayout({ seed: 2 });
    a.setGraph(g);
    b.setGraph(g);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
    a.dispose();
    b.dispose();
  });

  it('repulsion pushes an unlinked cloud apart (mean pairwise distance grows)', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const layout = new VectoForceLayout({ seed: 3, centerStrength: 0 });
    layout.setGraph({ nodes, links: [] });
    const spread = (p: Float32Array) => {
      let s = 0;
      let c = 0;
      for (let i = 0; i < 40; i++)
        for (let j = i + 1; j < 40; j++) {
          s += distance(p, i, j);
          c++;
        }
      return s / c;
    };
    const before = spread(layout.positions.slice());
    layout.step(60);
    expect(spread(layout.positions)).toBeGreaterThan(before);
    layout.dispose();
  });

  it('Barnes-Hut (theta=0.9) approximates exact all-pairs (theta=0) on a single tick', () => {
    // BH is an approximation of the exact N-body. Comparing accumulated
    // positions after many ticks is meaningless — the two trajectories diverge
    // chaotically even though each is individually valid. The right check is a
    // SINGLE tick from identical state: the per-node displacement BH produces
    // must be close to the exact all-pairs displacement.
    const g = ring(80);
    const exact = new VectoForceLayout({ seed: 11, theta: 0 });
    const bh = new VectoForceLayout({ seed: 11, theta: 0.9 });
    exact.setGraph(g);
    bh.setGraph(g);
    // Both start from the identical seeded layout; step once.
    exact.step(1);
    bh.step(1);
    // Mean per-node position difference after one tick, relative to the ring's
    // ~10*∛80 ≈ 46-unit scale, should be small (a few %).
    let sum = 0;
    for (let i = 0; i < 80; i++) {
      const dx = exact.positions[i * 3] - bh.positions[i * 3];
      const dy = exact.positions[i * 3 + 1] - bh.positions[i * 3 + 1];
      const dz = exact.positions[i * 3 + 2] - bh.positions[i * 3 + 2];
      sum += Math.hypot(dx, dy, dz);
    }
    const meanDrift = sum / 80;
    expect(meanDrift).toBeLessThan(1.0); // « the ~46-unit layout scale
    exact.dispose();
    bh.dispose();
  });

  it('scales to thousands of nodes without producing NaN/Infinity', () => {
    const n = 3000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
    const links = Array.from({ length: n - 1 }, (_, i) => ({
      source: i,
      target: i + 1,
    }));
    const layout = new VectoForceLayout({ seed: 5 });
    layout.setGraph({ nodes, links });
    layout.step(20);
    for (let i = 0; i < layout.positions.length; i++) {
      expect(Number.isFinite(layout.positions[i])).toBe(true);
    }
    layout.dispose();
  });

  it('empty graph is a no-op', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({ nodes: [], links: [] });
    expect(layout.positions).toHaveLength(0);
    expect(layout.step()).toBe(false);
    layout.dispose();
  });
});
