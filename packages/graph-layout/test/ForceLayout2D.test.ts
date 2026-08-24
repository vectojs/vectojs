import { describe, expect, it } from 'vitest';

import { ForceLayout2D, type GraphData, type NodeId } from '../src';

const graph: GraphData = {
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

describe('ForceLayout2D', () => {
  it('is deterministic for the same seed and differs for another seed', () => {
    const a = new ForceLayout2D({ seed: 42 });
    const b = new ForceLayout2D({ seed: 42 });
    const c = new ForceLayout2D({ seed: 43 });
    a.setGraph(graph);
    b.setGraph(graph);
    c.setGraph(graph);
    a.step(20);
    b.step(20);
    c.step(20);

    expect([...a.positions]).toEqual([...b.positions]);
    expect([...a.positions]).not.toEqual([...c.positions]);

    const positionBuffer = a.positions;
    a.step();
    expect(a.positions).toBe(positionBuffer);

    a.setGraph(graph);
    b.setGraph(graph);
    a.step(20);
    b.step(20);
    expect([...a.positions]).toEqual([...b.positions]);
  });

  it('appends without changing existing positions, velocities, or pins', () => {
    const appended = new ForceLayout2D({ seed: 7, alphaDecay: 1e-6 });
    appended.setGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    appended.step(5);
    appended.pinNode('a', 12, -8);
    const before = [...appended.positions];

    appended.appendGraph({
      nodes: [{ id: 'c' }, { id: 'a', x: 999, y: 999 }],
      links: [{ source: 'b', target: 'c' }],
    });

    expect([...appended.positions.slice(0, 4)]).toEqual(before);
    appended.step();
    expect([...appended.positions.slice(0, 2)]).toEqual([12, -8]);

    const control = new ForceLayout2D({ seed: 7, alphaDecay: 1e-6 });
    control.setGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    control.step(5);
    control.pinNode('a', 12, -8);
    control.appendGraph({ nodes: [{ id: 'c' }], links: [{ source: 'b', target: 'c' }] });
    control.step();
    appended.unpinNode('a');
    control.unpinNode('a');
    appended.step();
    control.step();
    expect([...appended.positions]).toEqual([...control.positions]);
  });

  it('exposes stable ID/index mappings in position order', () => {
    const layout = new ForceLayout2D();
    layout.setGraph({ nodes: [{ id: 'a' }, { id: 2 }], links: [] });

    expect(layout.getNodeIds()).toEqual(['a', 2]);
    expect(layout.getNodeIndex('a')).toBe(0);
    expect(layout.getNodeIndex(2)).toBe(1);
    expect(layout.getNodeId(0)).toBe('a');
    expect(layout.getNodeId(1)).toBe(2);
    expect(layout.getNodeIndex('missing')).toBeUndefined();
    expect(layout.getNodeId(-1)).toBeUndefined();
    expect(layout.getNodeId(2)).toBeUndefined();

    const ids = layout.getNodeIds() as NodeId[];
    ids[0] = 'changed';
    expect(layout.getNodeIds()).toEqual(['a', 2]);

    layout.appendGraph({ nodes: [{ id: 'c' }], links: [] });
    expect(layout.getNodeIds()).toEqual(['a', 2, 'c']);
    expect(layout.getNodeIndex('c')).toBe(2);

    layout.removeNodes(['a']);
    expect(layout.getNodeIds()).toEqual([2, 'c']);
    expect(layout.getNodeIndex(2)).toBe(0);
    expect(layout.getNodeId(1)).toBe('c');
    expect(layout.getNodeIndex('a')).toBeUndefined();
  });

  it('makes link page replay dynamically idempotent', () => {
    const options = { repulsion: 0, centerStrength: 0, alphaDecay: 1e-6, seed: 11 };
    const page: GraphData = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b' }],
    };
    const replayed = new ForceLayout2D(options);
    const control = new ForceLayout2D(options);
    replayed.setGraph(page);
    control.setGraph(page);
    replayed.appendGraph(page);
    const replayedState = replayed as unknown as { linkCount: number };
    expect(replayedState.linkCount).toBe(1);
    replayed.step(10);
    control.step(10);
    expect([...replayed.positions]).toEqual([...control.positions]);
  });

  it('permits differentiated parallel links while deduplicating each identity', () => {
    const indices: number[] = [];
    const layout = new ForceLayout2D({
      linkStrength: (_link, index) => {
        indices.push(index);
        return 0.1;
      },
    });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [
        { id: 'primary', source: 'a', target: 'b' },
        { id: 'secondary', source: 'a', target: 'b' },
        { id: 'primary', source: 'a', target: 'b' },
      ],
    });
    layout.appendGraph({
      nodes: [],
      links: [
        { id: 'secondary', source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    });

    const state = layout as unknown as { linkCount: number };
    expect(state.linkCount).toBe(3);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('rejects duplicate IDs on replacement but ignores them during append', () => {
    const layout = new ForceLayout2D();
    layout.setGraph({ nodes: [{ id: 'kept' }], links: [] });
    expect(() =>
      layout.setGraph({ nodes: [{ id: 'duplicate' }, { id: 'duplicate' }], links: [] }),
    ).toThrow('duplicate node ID: duplicate');
    expect(layout.nodeCount).toBe(1);

    layout.appendGraph({ nodes: [{ id: 'kept', x: 999 }, { id: 'kept' }], links: [] });
    expect(layout.nodeCount).toBe(1);
  });

  it('separates nodes according to collision radii', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0,
      collisionRadius: (node) => Number(node.radius),
      collisionStrength: 1,
      velocityDecay: 0.7,
      alphaDecay: 1e-6,
    });
    layout.setGraph({
      nodes: [
        { id: 1, x: 0, y: 0, radius: 10 },
        { id: 2, x: 0, y: 0, radius: 15 },
      ],
      links: [],
    });
    layout.step(30);

    expect(
      Math.hypot(
        layout.positions[2] - layout.positions[0],
        layout.positions[3] - layout.positions[1],
      ),
    ).toBeGreaterThanOrEqual(24.9);
  });

  it('collides at predicted positions independent of radius ordering', () => {
    const run = (nodes: GraphData['nodes']) => {
      const layout = new ForceLayout2D({
        repulsion: 0,
        centerStrength: 0,
        collisionRadius: (node) => Number(node.radius),
        velocityDecay: 0.999999,
        alphaDecay: 1e-6,
      });
      layout.setGraph({ nodes, links: [] });
      const state = layout as unknown as {
        velocityX: Float32Array;
        velocityY: Float32Array;
      };
      state.velocityX[0] = Number(nodes[0].x) < 0 ? 9 : -9;
      state.velocityX[1] = Number(nodes[1].x) < 0 ? 9 : -9;
      layout.step();
      return [...layout.positions];
    };

    const forward = run([
      { id: 'zero', x: -10, y: 0, radius: 0 },
      { id: 'positive', x: 10, y: 0, radius: 5 },
    ]);
    const reverse = run([
      { id: 'positive', x: 10, y: 0, radius: 5 },
      { id: 'zero', x: -10, y: 0, radius: 0 },
    ]);
    expect(forward[0]).toBeLessThan(-1);
    expect([reverse[2], reverse[3], reverse[0], reverse[1]]).toEqual(forward);
  });

  it('moves only the free node when colliding with a pinned node', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0,
      collisionRadius: 10,
      velocityDecay: 0.999999,
      alphaDecay: 1e-6,
    });
    layout.setGraph({
      nodes: [
        { id: 'pinned', x: 0, y: 0, fx: 0, fy: 0 },
        { id: 'free', x: 1, y: 0 },
      ],
      links: [],
    });
    layout.step();

    expect([...layout.positions.slice(0, 2)]).toEqual([0, 0]);
    expect(layout.positions[2]).toBeGreaterThanOrEqual(19.9);
  });

  it('honors independent initial fx and fy pins', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0.1,
      velocityDecay: 0.9,
      alphaDecay: 1e-6,
    });
    layout.setGraph({
      nodes: [
        { id: 'x-only', x: 5, y: 20, fx: 5 },
        { id: 'y-only', x: 20, y: -7, fy: -7 },
      ],
      links: [],
    });
    layout.step(5);

    expect(layout.positions[0]).toBe(5);
    expect(layout.positions[1]).not.toBe(20);
    expect(layout.positions[2]).not.toBe(20);
    expect(layout.positions[3]).toBe(-7);
  });

  it('supports partial runtime pins and clearing one axis', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0.1,
      velocityDecay: 0.9,
      alphaDecay: 1e-6,
    });
    layout.setGraph({ nodes: [{ id: 'node', x: 5, y: 20 }], links: [] });

    layout.setNodePin('node', { x: 5 });
    layout.step(5);
    expect(layout.positions[0]).toBe(5);
    expect(layout.positions[1]).not.toBe(20);

    layout.setNodePin('node', { y: 12 });
    layout.clearNodePin('node', { x: true });
    layout.step();
    expect(layout.positions[1]).toBe(12);
    expect(layout.positions[0]).not.toBe(5);

    layout.clearNodePin('node', { y: true });
    layout.step();
    expect([...layout.positions].every(Number.isFinite)).toBe(true);
  });

  it('clears the corresponding velocity when changing runtime pins', () => {
    const layout = new ForceLayout2D({ repulsion: 0, centerStrength: 0, alphaDecay: 1e-6 });
    layout.setGraph({ nodes: [{ id: 'node', x: 0, y: 0 }], links: [] });
    const state = layout as unknown as { velocityX: Float32Array; velocityY: Float32Array };
    state.velocityX[0] = 7;
    state.velocityY[0] = -9;

    layout.setNodePin('node', { x: Infinity, y: NaN });

    expect(state.velocityX[0]).toBe(0);
    expect(state.velocityY[0]).toBe(0);
    expect([...layout.positions].every(Number.isFinite)).toBe(true);
  });

  it('limits many-body repulsion without affecting links or collisions', () => {
    const make = (repulsionDistanceMax: number, repulsion = 100, withLink = false) => {
      const layout = new ForceLayout2D({
        repulsion,
        repulsionDistanceMax,
        centerStrength: 0,
        collisionRadius: withLink ? 10 : 0,
        linkDistance: 20,
        linkStrength: 1,
        velocityDecay: 0.999999,
        alphaDecay: 1e-6,
      });
      layout.setGraph({
        nodes: [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 100, y: 0 },
        ],
        links: withLink ? [{ source: 'a', target: 'b' }] : [],
      });
      layout.step();
      return [...layout.positions];
    };

    const cutoff = make(10);
    const unlimited = make(Infinity);
    expect(cutoff[0]).toBeGreaterThan(unlimited[0]);
    expect(cutoff[2]).toBeLessThan(unlimited[2]);

    expect(make(10, 0, true)).toEqual(make(Infinity, 0, true));

    // A degenerate cutoff of 0 now means "no cutoff" like Infinity — it must
    // not silently disable repulsion (the old behavior early-returned out of
    // the force kernel, freezing the layout in place).
    const zero = new ForceLayout2D({
      repulsion: 100,
      repulsionDistanceMax: 0,
      centerStrength: 0,
      alphaDecay: 1e-6,
    });
    zero.setGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      links: [],
    });
    zero.step();
    expect([...zero.positions]).not.toEqual([0, 0, 100, 0]);

    const collision = new ForceLayout2D({
      repulsion: 100,
      repulsionDistanceMax: 0,
      centerStrength: 0,
      collisionRadius: 10,
      velocityDecay: 0.999999,
      alphaDecay: 1e-6,
    });
    collision.setGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1, y: 0 },
      ],
      links: [],
    });
    collision.step();
    expect(collision.positions[0]).toBeLessThan(0);
    expect(collision.positions[2]).toBeGreaterThan(1);
  });

  it('applies collision correction only along free axes', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0,
      collisionRadius: 10,
      velocityDecay: 0.999999,
      alphaDecay: 1e-6,
      seed: 3,
    });
    layout.setGraph({
      nodes: [
        { id: 'x-fixed', x: 0, y: 0, fx: 0 },
        { id: 'y-fixed', x: 1, y: 1, fy: 1 },
      ],
      links: [],
    });
    layout.step();

    expect(layout.positions[0]).toBe(0);
    expect(layout.positions[3]).toBe(1);
    expect(layout.positions[1]).toBeLessThan(0);
    expect(layout.positions[2]).toBeGreaterThan(1);
  });

  it('removes nodes and their links while preserving survivor state and pins', () => {
    const layout = new ForceLayout2D({ alphaDecay: 1e-6 });
    layout.setGraph(graph);
    layout.step(3);
    layout.pinNode('c', 30, 40);
    const survivor = [...layout.positions.slice(4, 6)];

    layout.removeNodes(['a', 'missing']);

    expect(layout.nodeCount).toBe(2);
    expect([...layout.positions.slice(2, 4)]).toEqual(survivor);
    layout.step();
    expect([...layout.positions.slice(2, 4)]).toEqual([30, 40]);
  });

  it('keeps ID-addressed pins on the same node across removeNodes compaction', () => {
    // Index-addressed pins silently retargeted after compaction: an old cached
    // index still passed the range check but named a different node.
    const layout = new ForceLayout2D({ repulsion: 300, centerStrength: 0, alphaDecay: 1e-6 });
    layout.setGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 50, y: 0 },
        { id: 'c', x: 100, y: 0 },
      ],
      links: [],
    });
    layout.pinNode('c', 500, -60);

    layout.removeNodes(['a']); // 'b' moves into slot 0, 'c' into slot 1

    // The pin followed node 'c', not whatever now occupies its old slot.
    layout.step(10);
    expect([...layout.positions.slice(2, 4)]).toEqual([500, -60]);
    expect(layout.positions[0]).not.toBe(500); // 'b' is free

    // Pins set AFTER compaction also land on the right node.
    layout.pinNode('b', -200, 40);
    layout.step();
    expect([...layout.positions.slice(0, 2)]).toEqual([-200, 40]);

    // Unpin by ID releases exactly that node.
    layout.unpinNode('c');
    layout.step(5);
    expect(layout.positions[2]).not.toBe(500);
  });

  it('ignores pins for unknown IDs without disturbing real ones', () => {
    const layout = new ForceLayout2D({ alphaDecay: 1e-6 });
    layout.setGraph({ nodes: [{ id: 'a' }], links: [] });
    layout.pinNode('ghost', 99, 99);
    layout.setNodePin('ghost', { x: 1 });
    layout.clearNodePin('ghost');
    layout.unpinNode('ghost');
    layout.step();
    expect(layout.positions[0]).not.toBe(99);
  });

  it('distinguishes numeric IDs from legacy indices when pinning', () => {
    const layout = new ForceLayout2D({ alphaDecay: 1e-6 });
    layout.setGraph({
      nodes: [
        { id: 10, x: 0, y: 0 },
        { id: 20, x: 30, y: 0 },
      ],
      links: [],
    });
    // ID 20 — not "index 1" semantics; resolves through the ID map.
    layout.pinNode(20, 7, 8);
    layout.step();
    expect([...layout.positions.slice(2, 4)]).toEqual([7, 8]);
    expect(layout.positions[0]).not.toBe(7);
    layout.unpinNode(10); // valid ID, just not pinned
    expect(layout.nodeCount).toBe(2);
  });

  it('throws on dangling and self links at every mutation boundary', () => {
    // Endpoint validation used to diverge: appendGraph soft-dropped dangling
    // and self links while updateLinks hard-threw. The policy is now uniform —
    // loud throws before any mutation.
    const layout = new ForceLayout2D();
    layout.setGraph({ nodes: [{ id: 'old' }], links: [] });
    expect(() =>
      layout.setGraph({
        nodes: [{ id: 'a' }, { id: 'b' }],
        links: [{ source: 'a', target: 'missing' }],
      }),
    ).toThrow(/unknown node "missing"|distinct known nodes.*"missing"/);
    expect(layout.getNodeIds()).toEqual(['old']); // failed replacement left state intact

    const loaded = new ForceLayout2D();
    loaded.setGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    expect(() => loaded.appendGraph({ nodes: [], links: [{ source: 'a', target: 'a' }] })).toThrow(
      /must reference two distinct known nodes/,
    );
    expect(() =>
      loaded.appendGraph({
        nodes: [{ id: 'c' }],
        links: [{ source: 'c', target: 'ghost' }],
      }),
    ).toThrow(/distinct known nodes.*"ghost"/);
    expect(() => loaded.updateLinks([{ source: 'a', target: 'a' }])).toThrow(
      /updateLinks: link endpoints must reference two distinct existing nodes/,
    );

    // The failed batch above must not have left a half-applied mutation.
    expect(loaded.getNodeIds()).toEqual(['a', 'b']);
    const state = loaded as unknown as { linkCount: number };
    expect(state.linkCount).toBe(0);
  });

  it('accepts forward-referenced endpoints within a single batch', () => {
    // Strictness applies per batch, not per link ordering: nodes later in the
    // same array satisfy links earlier in it.
    const layout = new ForceLayout2D();
    layout.appendGraph({
      nodes: [{ id: 'late' }, { id: 'early' }],
      links: [{ source: 'early', target: 'late' }],
    });
    const state = layout as unknown as { linkCount: number };
    expect(state.linkCount).toBe(1);
    expect(layout.getNodeIndex('late')).toBe(0); // input order preserved
    expect(layout.getNodeIndex('early')).toBe(1);
  });

  it('keeps positions finite when accessor values are malformed', () => {
    // Non-finite VALUES are clamped silently (they cannot be detected before
    // integration); endpoint identity problems throw instead.
    const layout = new ForceLayout2D({
      linkDistance: (link) => Number(link.distance),
      linkStrength: (link) => Number(link.strength),
    });
    layout.setGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ source: 'a', target: 'b', distance: 'bad', strength: Infinity }],
    });
    layout.step(100);

    expect([...layout.positions].every(Number.isFinite)).toBe(true);
  });

  it('supports numeric and accessor force options', () => {
    const seenNodes: string[] = [];
    const seenLinks: string[] = [];
    const layout = new ForceLayout2D({
      repulsion: (node) => {
        seenNodes.push(String(node.id));
        return 50;
      },
      collisionRadius: 2,
      linkDistance: (link) => {
        seenLinks.push(`${link.source}-${link.target}`);
        return 20;
      },
      linkStrength: 0.5,
    });
    layout.setGraph(graph);

    expect(seenNodes).toEqual(['a', 'b', 'c']);
    expect(seenLinks).toEqual(['a-b', 'b-c']);
  });

  it('uses stable global link accessor indices across paginated appends', () => {
    const indicesA: number[] = [];
    const indicesB: number[] = [];
    const make = (indices: number[]) =>
      new ForceLayout2D({
        repulsion: 0,
        centerStrength: 0,
        alphaDecay: 1e-6,
        linkDistance: (_link, index) => {
          indices.push(index);
          return 10 + index;
        },
        linkStrength: (_link, index) => 0.1 + index * 0.1,
      });
    const oneShot = make(indicesA);
    oneShot.setGraph(graph);
    const paginated = make(indicesB);
    paginated.setGraph({
      nodes: graph.nodes.slice(0, 2),
      links: graph.links.slice(0, 1),
    });
    paginated.appendGraph({ nodes: graph.nodes.slice(2), links: graph.links.slice(1) });
    paginated.reheat(1);
    oneShot.step(10);
    paginated.step(10);

    expect(indicesA).toEqual([0, 1]);
    expect(indicesB).toEqual([0, 1]);
    expect([...paginated.positions]).toEqual([...oneShot.positions]);
  });

  it('produces identical degree bias and dynamics for one-shot and paginated stars', () => {
    const star = makeStar(128);
    const options = { seed: 17, alphaDecay: 1e-6, collisionRadius: 1 };
    const oneShot = new ForceLayout2D(options);
    oneShot.setGraph(star);
    const paginated = new ForceLayout2D(options);
    paginated.setGraph({ nodes: star.nodes.slice(0, 2), links: star.links.slice(0, 1) });
    for (let start = 2; start < star.nodes.length; start += 17) {
      paginated.appendGraph({
        nodes: star.nodes.slice(start, start + 17),
        links: star.links.slice(start - 1, start - 1 + 17),
      });
    }
    oneShot.step(40);
    paginated.step(40);

    const oneShotState = oneShot as unknown as {
      linkSourceShare: Float32Array;
      linkTargetShare: Float32Array;
    };
    const paginatedState = paginated as unknown as {
      linkSourceShare: Float32Array;
      linkTargetShare: Float32Array;
    };
    expect([...paginatedState.linkSourceShare.slice(0, 127)]).toEqual([
      ...oneShotState.linkSourceShare.slice(0, 127),
    ]);
    expect([...paginatedState.linkTargetShare.slice(0, 127)]).toEqual([
      ...oneShotState.linkTargetShare.slice(0, 127),
    ]);
    expect([...paginated.positions]).toEqual([...oneShot.positions]);
  });

  it('bounds hub movement relative to leaves with degree-biased springs', () => {
    const count = 501;
    const nodes: GraphData['nodes'] = [{ id: 'hub', x: 0, y: 0 }];
    const links: GraphData['links'] = [];
    for (let index = 1; index < count; index++) {
      nodes.push({ id: index, x: 100 + (index % 13), y: index % 7 });
      links.push({ source: 'hub', target: index });
    }
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0,
      linkDistance: 20,
      linkStrength: 0.3,
      velocityDecay: 0.6,
      alphaDecay: 1e-6,
    });
    layout.setGraph({ nodes, links });
    const initial = [...layout.positions];
    layout.step();

    const hubMovement = Math.hypot(
      layout.positions[0] - initial[0],
      layout.positions[1] - initial[1],
    );
    let leafMovement = 0;
    for (let index = 1; index < count; index++) {
      leafMovement += Math.hypot(
        layout.positions[index * 2] - initial[index * 2],
        layout.positions[index * 2 + 1] - initial[index * 2 + 1],
      );
    }
    expect(hubMovement).toBeLessThan(leafMovement / (count - 1));
  });

  it('recomputes degree bias after node removal', () => {
    const layout = new ForceLayout2D({ repulsion: 0, centerStrength: 0, alphaDecay: 1e-6 });
    layout.setGraph({
      nodes: [{ id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'tail' }],
      links: [
        { source: 'hub', target: 'a' },
        { source: 'hub', target: 'b' },
        { source: 'a', target: 'tail' },
      ],
    });
    layout.removeNodes(['b']);

    const state = layout as unknown as {
      degree: Int32Array;
      linkSourceShare: Float32Array;
      linkTargetShare: Float32Array;
    };
    expect([...state.degree.slice(0, 3)]).toEqual([1, 2, 1]);
    expect(state.linkSourceShare[0]).toBeCloseTo(2 / 3);
    expect(state.linkTargetShare[0]).toBeCloseTo(1 / 3);
  });

  it('routes full spring correction to the movable endpoint on each axis', () => {
    const layout = new ForceLayout2D({
      repulsion: 0,
      centerStrength: 0,
      linkDistance: 10,
      linkStrength: 1,
      velocityDecay: 0.999999,
      alphaDecay: 1e-6,
    });
    layout.setGraph({
      nodes: [
        { id: 'fixed', x: 0, y: 0, fx: 0, fy: 0 },
        { id: 'free', x: 30, y: 0 },
      ],
      links: [{ source: 'fixed', target: 'free' }],
    });
    layout.step();

    expect([...layout.positions.slice(0, 2)]).toEqual([0, 0]);
    expect(layout.positions[2]).toBeCloseTo(10, 4);
  });

  it('keeps a large star finite, unsaturated, and spatially distributed', () => {
    const layout = new ForceLayout2D({ seed: 23, collisionRadius: 1 });
    layout.setGraph(makeStar(512));
    layout.step(120);

    const positions = [...layout.positions];
    expect(positions.every(Number.isFinite)).toBe(true);
    expect(Math.max(...positions.map(Math.abs))).toBeLessThan(1e6);
    const occupied = new Set<string>();
    for (let index = 0; index < layout.nodeCount; index++) {
      occupied.add(
        `${layout.positions[index * 2].toFixed(3)},${layout.positions[index * 2 + 1].toFixed(3)}`,
      );
    }
    expect(occupied.size).toBeGreaterThan(500);
  });

  it('clamps oversized inputs and repairs externally corrupted positions', () => {
    const layout = new ForceLayout2D({
      repulsion: () => 1e100,
      collisionRadius: () => 1e100,
      linkDistance: () => 1e100,
      linkStrength: () => 1e100,
    });
    layout.setGraph({
      nodes: [
        { id: 'a', x: 1e100, y: -1e100 },
        { id: 'b', fx: 1e100, fy: -1e100 },
      ],
      links: [{ source: 'a', target: 'b' }],
    });
    layout.pinNode('a', 1e100, -1e100);
    layout.positions[0] = Infinity;
    layout.positions[1] = NaN;
    layout.positions[2] = Infinity;
    layout.positions[3] = NaN;
    layout.step();

    expect([...layout.positions].every(Number.isFinite)).toBe(true);
    expect(Math.max(...layout.positions.map(Math.abs))).toBeLessThanOrEqual(3.4028235e38);
  });

  it('settles and can be reheated', () => {
    const layout = new ForceLayout2D({ alphaDecay: 0.5, alphaMin: 0.01 });
    layout.setGraph(graph);

    expect(layout.step(20)).toBe(false);
    layout.reheat(0.5);
    expect(layout.step()).toBe(true);
    expect(layout.step(Infinity)).toBe(true);
    expect(layout.step(NaN)).toBe(true);
    expect(layout.step(-5)).toBe(true);
  });

  it('never lowers alpha when reheated', () => {
    const layout = new ForceLayout2D({ alphaDecay: 0.1 });
    layout.setGraph(graph);
    layout.step();
    const state = layout as unknown as { alpha: number };
    expect(state.alpha).toBeCloseTo(0.9);
    layout.reheat(0.2);
    expect(state.alpha).toBeCloseTo(0.9);
    layout.reheat(0.95);
    expect(state.alpha).toBeCloseTo(0.95);
  });

  it('reuses capacity across small appends and grows geometrically', () => {
    const layout = new ForceLayout2D();
    layout.setGraph({ nodes: [{ id: 0 }], links: [] });
    const buffers = new Set<ArrayBuffer>();
    buffers.add(layout.positions.buffer);
    for (let i = 1; i < 100; i++) {
      layout.appendGraph({ nodes: [{ id: i }], links: [] });
      buffers.add(layout.positions.buffer);
    }

    expect(buffers.size).toBeLessThanOrEqual(8);
  });

  it('documents positions view replacement at topology boundaries', () => {
    const layout = new ForceLayout2D();
    layout.setGraph({ nodes: [{ id: 0 }], links: [] });
    const beforeStep = layout.positions;
    layout.step();
    expect(layout.positions).toBe(beforeStep);

    layout.appendGraph({ nodes: [{ id: 1 }], links: [] });
    expect(layout.positions).not.toBe(beforeStep);
    expect(layout.positions).toHaveLength(4);
    const beforeRemoval = layout.positions;
    layout.removeNodes([0]);
    expect(layout.positions).not.toBe(beforeRemoval);
    expect(layout.positions).toHaveLength(2);
  });

  it('disposes idempotently and rejects later use', () => {
    const layout = new ForceLayout2D();
    layout.setGraph(graph);
    layout.dispose();
    layout.dispose();

    expect(layout.positions).toHaveLength(0);
    expect(layout.nodeCount).toBe(0);
    expect(() => layout.step()).toThrow(/disposed/);
    expect(() => layout.setGraph(graph)).toThrow(/disposed/);
    expect(() => layout.appendGraph(graph)).toThrow(/disposed/);
    expect(() => layout.removeNodes(['a'])).toThrow(/disposed/);
    expect(() => layout.pinNode('a', 0, 0)).toThrow(/disposed/);
    expect(() => layout.unpinNode('a')).toThrow(/disposed/);
    expect(() => layout.reheat()).toThrow(/disposed/);
    expect(() => layout.getNodeIndex('a')).toThrow(/disposed/);
    expect(() => layout.getNodeId(0)).toThrow(/disposed/);
    expect(() => layout.getNodeIds()).toThrow(/disposed/);
  });

  it('falls back to the default decay when alphaDecay is 0 so host loops terminate', () => {
    const layout = new ForceLayout2D({ alphaDecay: 0 });
    // A literal 0 decay never cools alpha — step()'s guard would hold true
    // forever and hosts driving `while (layout.step()) raf(loop)` would burn
    // CPU permanently. The option must not survive validation.
    expect((layout as any).alphaDecay).toBeGreaterThan(0);

    layout.setGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    let ticks = 0;
    while (layout.step() && ticks < 5000) ticks++;
    expect(ticks).toBeLessThan(5000);
    expect(layout.step()).toBe(false);
  });

  it('treats repulsionDistanceMax <= 0 as no cutoff, not as disabled repulsion', () => {
    const layout = new ForceLayout2D({
      repulsionDistanceMax: 0,
      centerStrength: 0,
      alphaDecay: 1e-6,
    });
    // A finite cutoff of 0 early-returns out of the force kernel, silently
    // disabling all repulsion; the types only document non-finite as "no
    // cutoff", so a degenerate cutoff must mean the same.
    layout.setGraph({
      nodes: [
        { id: 'a', x: 100, y: 100 },
        { id: 'b', x: 100, y: 100 },
      ],
      links: [],
    });
    layout.step(10);
    const distance = Math.hypot(
      layout.positions[2] - layout.positions[0],
      layout.positions[3] - layout.positions[1],
    );
    expect(distance).toBeGreaterThan(1e-3);
  });
});

function makeStar(count: number): GraphData {
  return {
    nodes: Array.from({ length: count }, (_, index) => ({ id: index })),
    links: Array.from({ length: count - 1 }, (_, index) => ({ source: 0, target: index + 1 })),
  };
}
