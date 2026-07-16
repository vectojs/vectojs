import { describe, expect, it } from 'vitest';
import { D3ForceLayout } from '../src/layout/D3ForceLayout';
import type { GraphData } from '../src/types';

const distance = (positions: Float32Array, a: number, b: number): number => {
  const dx = positions[a * 3] - positions[b * 3];
  const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
  const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
  return Math.hypot(dx, dy, dz);
};

describe('D3ForceLayout', () => {
  it('exposes one xyz triplet per node, in node order', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b' }],
    });

    expect(layout.positions).toHaveLength(9);
    layout.dispose();
  });

  it('moves nodes when stepped and eventually cools', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      links: [
        { source: 1, target: 2 },
        { source: 2, target: 3 },
      ],
    });

    const before = layout.positions.slice();
    expect(layout.step()).toBe(true);
    expect(layout.positions).not.toEqual(before);

    // d3-force's default alpha decay cools in ~300 ticks.
    expect(layout.step(1000)).toBe(false);
    layout.dispose();
  });

  it('pulls linked nodes closer together than unlinked ones', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'lone' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.step(1000);

    const linked = distance(layout.positions, 0, 1);
    const unlinked = distance(layout.positions, 0, 2);
    expect(linked).toBeLessThan(unlinked);
    layout.dispose();
  });

  it('never mutates the caller node objects', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const data: GraphData = { nodes, links: [{ source: 'a', target: 'b' }] };
    const layout = new D3ForceLayout();
    layout.setGraph(data);
    layout.step(50);

    expect(Object.keys(nodes[0])).toEqual(['id']);
    expect(Object.keys(nodes[1])).toEqual(['id']);
    layout.dispose();
  });

  it('honors x/y/z initial position seeds', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a', x: 10, y: -5, z: 3 }, { id: 'b' }],
      links: [],
    });

    // Before any step, the seeded node sits exactly where it was declared.
    expect(Array.from(layout.positions.slice(0, 3))).toEqual([10, -5, 3]);
  });

  it('honors fx/fy/fz pins', () => {
    const layout = new D3ForceLayout();
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
    const layout = new D3ForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.setGraph({ nodes: [{ id: 'x' }, { id: 'y' }], links: [{ source: 'x', target: 'y' }] });

    expect(layout.positions).toHaveLength(6);
    expect(layout.step()).toBe(true);
    layout.dispose();
  });

  it('throws when used after dispose', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.dispose();

    expect(() => layout.step()).toThrow(/disposed/);
    expect(() => layout.setGraph({ nodes: [], links: [] })).toThrow(/disposed/);
  });

  it('pinNode holds a node at a fixed position across steps', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.pinNode(0, 42, -17, 8);

    // Immediately reflected in the exposed buffer, before any step.
    expect(layout.positions[0]).toBeCloseTo(42);
    expect(layout.positions[1]).toBeCloseTo(-17);
    expect(layout.positions[2]).toBeCloseTo(8);

    // And held there after the simulation runs.
    layout.step(200);
    expect(layout.positions[0]).toBeCloseTo(42);
    expect(layout.positions[1]).toBeCloseTo(-17);
    expect(layout.positions[2]).toBeCloseTo(8);
    layout.dispose();
  });

  it('unpinNode releases a pinned node back to free simulation', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.pinNode(0, 100, 0, 0);
    layout.step(50);
    expect(layout.positions[0]).toBeCloseTo(100);

    layout.unpinNode(0);
    layout.reheat(1);
    layout.step(300);
    // Freed and pulled toward its neighbor, no longer clamped at x=100.
    expect(layout.positions[0]).not.toBeCloseTo(100);
    layout.dispose();
  });

  it('ignores pin/unpin for out-of-range indices without throwing', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    expect(() => layout.pinNode(5, 1, 2, 3)).not.toThrow();
    expect(() => layout.unpinNode(-1)).not.toThrow();
    layout.dispose();
  });

  it('reheat lets a cooled simulation move again', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b' }],
    });
    expect(layout.step(2000)).toBe(false); // cooled

    layout.reheat();
    expect(layout.step()).toBe(true); // moving again
    layout.dispose();
  });

  it('pin/unpin/reheat throw after dispose', () => {
    const layout = new D3ForceLayout();
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.dispose();
    expect(() => layout.pinNode(0, 1, 2, 3)).toThrow(/disposed/);
    expect(() => layout.unpinNode(0)).toThrow(/disposed/);
    expect(() => layout.reheat()).toThrow(/disposed/);
  });
});
