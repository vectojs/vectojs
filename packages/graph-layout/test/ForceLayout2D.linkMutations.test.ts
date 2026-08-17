import { describe, expect, it } from 'vitest';

import { ForceLayout2D } from '../src';

type InternalState = {
  degree: Int32Array;
  linkCount: number;
  linkDistance: Float32Array;
  linkSourceShare: Float32Array;
  linkTargetShare: Float32Array;
  linkStrength: Float32Array;
  velocityX: Float32Array;
  velocityY: Float32Array;
};

function state(layout: ForceLayout2D): InternalState {
  return layout as unknown as InternalState;
}

describe('ForceLayout2D link mutations', () => {
  it('removes a link without changing node simulation state', () => {
    const layout = new ForceLayout2D({ alphaDecay: 0, seed: 4 });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    layout.step(4);
    layout.pinNode(2, 20, -10);

    const beforePositions = [...layout.positions];
    const beforeVelocityX = [...state(layout).velocityX];
    const beforeVelocityY = [...state(layout).velocityY];

    layout.removeLinks([{ source: 'a', target: 'b' }]);

    expect(state(layout).linkCount).toBe(1);
    expect([...layout.positions]).toEqual(beforePositions);
    expect([...state(layout).velocityX]).toEqual(beforeVelocityX);
    expect([...state(layout).velocityY]).toEqual(beforeVelocityY);
    layout.step();
    expect([...layout.positions.slice(4, 6)]).toEqual([20, -10]);
  });

  it('recomputes degree-biased spring shares after link removal', () => {
    const layout = new ForceLayout2D({ repulsion: 0, centerStrength: 0, alphaDecay: 0 });
    layout.setGraph({
      nodes: [{ id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'tail' }],
      links: [
        { source: 'hub', target: 'a' },
        { source: 'hub', target: 'b' },
        { source: 'a', target: 'tail' },
      ],
    });

    layout.removeLinks([{ source: 'hub', target: 'b' }]);
    const current = state(layout);
    expect([...current.degree.slice(0, 4)]).toEqual([1, 2, 0, 1]);
    expect(current.linkSourceShare[0]).toBeCloseTo(2 / 3);
    expect(current.linkTargetShare[0]).toBeCloseTo(1 / 3);
  });

  it('updates only the matching link accessor values', () => {
    const layout = new ForceLayout2D({
      linkDistance: (link) => Number(link.distance),
      linkStrength: (link) => Number(link.strength),
    });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [
        { source: 'a', target: 'b', distance: 20, strength: 0.2 },
        { source: 'b', target: 'c', distance: 40, strength: 0.4 },
      ],
    });
    const before = state(layout);
    expect([...before.linkDistance.slice(0, 2)]).toEqual([20, 40]);
    expect(before.linkStrength[0]).toBeCloseTo(0.2);
    expect(before.linkStrength[1]).toBeCloseTo(0.4);

    layout.updateLinks([{ source: 'a', target: 'b', distance: 80, strength: 0.8 }]);

    const after = state(layout);
    expect([...after.linkDistance.slice(0, 2)]).toEqual([80, 40]);
    expect(after.linkStrength[0]).toBeCloseTo(0.8);
    expect(after.linkStrength[1]).toBeCloseTo(0.4);
  });

  it('mutates parallel links independently by id and makes removal idempotent', () => {
    const layout = new ForceLayout2D({
      linkDistance: (link) => Number(link.distance),
    });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [
        { id: 'short', source: 'a', target: 'b', distance: 10 },
        { id: 'long', source: 'a', target: 'b', distance: 90 },
      ],
    });

    layout.updateLinks([{ id: 'long', source: 'a', target: 'b', distance: 120 }]);
    expect([...state(layout).linkDistance.slice(0, 2)]).toEqual([10, 120]);

    layout.removeLinks(['short']);
    layout.removeLinks(['short']);
    expect(state(layout).linkCount).toBe(1);
    expect(state(layout).linkDistance[0]).toBe(120);
  });

  it('keeps positions finite after removing every link', () => {
    const layout = new ForceLayout2D({ alphaDecay: 0, seed: 9 });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    layout.removeLinks([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    layout.step(20);

    expect([...layout.positions].every(Number.isFinite)).toBe(true);
    expect(state(layout).linkCount).toBe(0);
  });

  it('validates update batches before mutating any link', () => {
    const layout = new ForceLayout2D({
      linkDistance: (link) => Number(link.distance),
    });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b', distance: 20 }],
    });

    expect(() =>
      layout.updateLinks([
        { source: 'a', target: 'b', distance: 80 },
        { source: 'a', target: 'missing', distance: 100 },
      ]),
    ).toThrow();
    expect(state(layout).linkDistance[0]).toBe(20);
  });
});
