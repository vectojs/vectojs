import { describe, expect, it } from 'vitest';
import { D3ForceLayout } from '../src/layout/D3ForceLayout';
import { VectoForceLayout } from '../src/layout/VectoForceLayout';

/**
 * Unknown link endpoints must fail identically across the three stacks.
 * Historically Graph3D.setGraphData threw, VectoForceLayout silently skipped
 * the link, and D3ForceLayout let the raw id reach d3-force-3d whose tick
 * reads `.x` off it — collapsing every position to NaN without an error.
 */
const DATA = {
  nodes: [
    { id: 'a', x: 0, y: 0, z: 0 },
    { id: 'b', x: 1, y: 1, z: 1 },
  ],
  links: [{ source: 'a', target: 'ghost' }],
} as never;

describe('unknown link endpoint policy is uniform (throw)', () => {
  it('VectoForceLayout throws instead of silently skipping', () => {
    const layout = new VectoForceLayout();
    expect(() => layout.setGraph(DATA)).toThrowError(/references an unknown node id/);
  });

  it('D3ForceLayout throws before mutating state', () => {
    const layout = new D3ForceLayout();
    expect(() => layout.setGraph(DATA)).toThrowError(/references an unknown node id/);
  });

  it('D3ForceLayout keeps the previous graph usable after a rejection', () => {
    const good = {
      nodes: [
        { id: 'a', x: 0, y: 0, z: 0 },
        { id: 'b', x: 1, y: 1, z: 1 },
      ],
      links: [{ source: 'a', target: 'b' }],
    } as never;
    const layout = new D3ForceLayout();
    layout.setGraph(good);
    expect(() => layout.setGraph(DATA)).toThrowError(/references an unknown node id/);
    // The rejected setGraphData must not have disturbed the running one.
    expect(layout.positions.length).toBe(6);
    expect(layout.step()).toBeTypeOf('boolean');
  });

  it('self-loops still skip in VectoForceLayout (no spring force)', () => {
    const selfLoop = {
      nodes: [
        { id: 'a', x: 0, y: 0, z: 0 },
        { id: 'b', x: 1, y: 1, z: 1 },
      ],
      links: [{ source: 'a', target: 'a' }],
    } as never;
    const layout = new VectoForceLayout();
    expect(() => layout.setGraph(selfLoop)).not.toThrow();
    layout.dispose();
  });

  it('dispose releases the WASM backend reference and octree scratch', () => {
    const layout = new VectoForceLayout();
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [],
    } as never);
    layout.dispose();
    expect(() => layout.step()).toThrowError(/disposed/);
  });
});
