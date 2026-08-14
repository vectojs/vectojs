import { describe, expect, it } from 'vitest';
import { FixedZLayout } from '../src/FixedZLayout';
import type { GraphData } from '@vectojs/graph3d';

const DATA: GraphData = {
  nodes: [{ id: 0 }, { id: 1 }, { id: 2 }],
  links: [
    { source: 0, target: 1 },
    { source: 1, target: 2 },
  ],
};

describe('FixedZLayout', () => {
  it('keeps every node at the configured z after stepping', () => {
    const layout = new FixedZLayout({ z: 0 });
    layout.setGraph(DATA);
    for (let i = 0; i < 30; i++) layout.step();
    const pos = layout.positions;
    for (let i = 0; i < 3; i++) {
      expect(pos[i * 3 + 2]).toBe(0);
      expect(Number.isFinite(pos[i * 3])).toBe(true);
      expect(Number.isFinite(pos[i * 3 + 1])).toBe(true);
    }
    // Not all zeros in xy (simulation did work)
    const span = Math.max(pos[0]!, pos[3]!, pos[6]!) - Math.min(pos[0]!, pos[3]!, pos[6]!);
    expect(span).toBeGreaterThan(0);
    layout.dispose();
  });

  it('stays finite for a dense bipartite cut under the session 2d preset', () => {
    // Mirrors KnowledgeGraphSession's 2d FixedZLayout options against a
    // star-like author→works neighborhood (the shape that NaN'd defaults).
    const works = Array.from({ length: 80 }, (_, i) => ({ id: `w${i}` }));
    const data: GraphData = {
      nodes: [{ id: 'author' }, ...works],
      links: works.map((w) => ({ source: 'author', target: w.id })),
    };
    const layout = new FixedZLayout({
      z: 0,
      repulsion: 25,
      linkDistance: 28,
      linkStrength: 0.15,
      velocityDecay: 0.3,
      centerStrength: 0.08,
      alphaDecay: 0.05,
    });
    layout.setGraph(data);
    for (let i = 0; i < 120; i++) layout.step();
    const pos = layout.positions;
    for (let i = 0; i < pos.length; i++) {
      expect(Number.isFinite(pos[i]!)).toBe(true);
    }
    layout.dispose();
  });
});
