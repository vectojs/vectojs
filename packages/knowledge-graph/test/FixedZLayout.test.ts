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
      // x/y should have moved from the default seed for at least some nodes
    }
    // Not all zeros in xy (simulation did work)
    const span = Math.max(pos[0]!, pos[3]!, pos[6]!) - Math.min(pos[0]!, pos[3]!, pos[6]!);
    expect(span).toBeGreaterThan(0);
    layout.dispose();
  });
});
