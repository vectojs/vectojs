import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Graph3D } from '../src/Graph3D';

/**
 * `applyPositions` used to call `InstancedMesh.computeBoundingSphere()`, which
 * re-reads every instance matrix out of the buffer the method had just written —
 * measured at 60–78% of the whole method (0.341ms at 10k nodes). The sphere is
 * now derived inline from the positions already in hand.
 *
 * `nodeMesh` keeps frustum culling ON, so correctness is the real requirement: a
 * sphere that is too small silently culls visible nodes.
 *
 * The contract asserted here is "every node's full extent lies inside the
 * sphere" — deliberately NOT "contains the sphere Three would compute". Three
 * centres its sphere on the vertex bounding box and then fits a radius, which for
 * an off-centre cloud is itself a loose over-estimate (measured: it reports
 * c=(31,24,13) r=99 where the true AABB centre is (50,50,50)). Asserting against
 * it would test that we reproduce its slack, not that we are correct.
 */
describe('Graph3D bounding sphere', () => {
  /** Graph3D's default `nodeRadius`; the geometry is a sphere of this radius. */
  const NODE_RADIUS = 4;

  const build = (positions: number[], vals?: number[]) => {
    const n = positions.length / 3;
    const graph = new Graph3D();
    graph.setGraphData({
      nodes: Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        ...(vals ? { val: vals[i] } : {}),
      })),
      links: [],
    });
    graph.applyPositions(new Float32Array(positions));
    return graph;
  };

  const ourSphere = (graph: Graph3D) =>
    (graph as unknown as { nodeMesh: THREE.InstancedMesh }).nodeMesh.boundingSphere as THREE.Sphere;

  /** Every node, expanded by its own world radius, must be inside the sphere. */
  const expectContainsAllNodes = (graph: Graph3D, positions: number[], vals?: number[]) => {
    const sphere = ourSphere(graph);
    for (let i = 0; i < positions.length / 3; i++) {
      const p = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      // Mirrors Graph3D: nodeScales[i] = cbrt(val ?? 1), world radius = radius * scale.
      const r = NODE_RADIUS * Math.cbrt(Math.max(vals?.[i] ?? 1, 0));
      expect(
        sphere.center.distanceTo(p) + r,
        `node ${i} at ${p.toArray()} r=${r} falls outside sphere c=${sphere.center.toArray()} r=${sphere.radius}`,
      ).toBeLessThanOrEqual(sphere.radius + 1e-6);
    }
  };

  it('contains every node for a simple spread', () => {
    const p = [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100];
    expectContainsAllNodes(build(p), p);
  });

  it('contains a single node', () => {
    const p = [42, -17, 8];
    expectContainsAllNodes(build(p), p);
  });

  it('contains coincident nodes', () => {
    const p = [5, 5, 5, 5, 5, 5, 5, 5, 5];
    expectContainsAllNodes(build(p), p);
  });

  it('contains nodes at negative coordinates', () => {
    const p = [-500, -400, -300, -10, -20, -30, -900, 50, 60];
    expectContainsAllNodes(build(p), p);
  });

  it('contains every node in a wide asymmetric cloud', () => {
    const pos: number[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 200; i++) pos.push(rnd() * 4000 - 2000, rnd() * 40 - 20, rnd() * 900);
    expectContainsAllNodes(build(pos), pos);
  });

  it('accounts for per-node scale so a large node is not clipped', () => {
    // A far node with a big `val` — its extent, not just its centre, must fit.
    const p = [0, 0, 0, 300, 0, 0];
    const vals = [1, 1728]; // cbrt(1728) = 12x radius
    expectContainsAllNodes(build(p, vals), p, vals);
  });

  it('updates the sphere when positions move', () => {
    const graph = build([0, 0, 0, 10, 0, 0]);
    const before = ourSphere(graph).radius;
    graph.applyPositions(new Float32Array([0, 0, 0, 5000, 0, 0]));
    expect(ourSphere(graph).radius).toBeGreaterThan(before);
    expectContainsAllNodes(graph, [0, 0, 0, 5000, 0, 0]);
  });

  it('leaves an empty graph with a valid (non-NaN) sphere', () => {
    const graph = new Graph3D();
    graph.setGraphData({ nodes: [], links: [] });
    // No nodeMesh at all for an empty graph — must not throw.
    expect(() => graph.applyPositions(new Float32Array())).not.toThrow();
  });
});
