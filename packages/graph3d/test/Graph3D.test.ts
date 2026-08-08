import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Graph3D } from '../src/Graph3D';
import type { GraphData } from '../src/types';

const DATA: GraphData = {
  nodes: [{ id: 'a', color: '#ff0000' }, { id: 'b', val: 8 }, { id: 'c' }],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

const POSITIONS = new Float32Array([
  1,
  2,
  3, // a
  -4,
  5,
  -6, // b
  7,
  -8,
  9, // c
]);

const findInstancedMesh = (graph: Graph3D): THREE.InstancedMesh =>
  graph.group.children.find(
    (child): child is THREE.InstancedMesh =>
      (child as THREE.InstancedMesh).isInstancedMesh === true,
  )!;

const findLineSegments = (graph: Graph3D): THREE.LineSegments =>
  graph.group.children.find(
    (child): child is THREE.LineSegments => (child as THREE.LineSegments).isLineSegments === true,
  )!;

describe('Graph3D', () => {
  it('builds one instanced mesh for all nodes and one line segments for all links', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);

    expect(graph.group.children).toHaveLength(2);
    expect(findInstancedMesh(graph).count).toBe(3);
    const linePositions = findLineSegments(graph).geometry.getAttribute('position');
    expect(linePositions.count).toBe(4); // 2 links × 2 endpoints
    graph.dispose();
  });

  it('writes layout positions into instance matrices and link endpoints', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    findInstancedMesh(graph).getMatrixAt(1, matrix);
    position.setFromMatrixPosition(matrix);
    expect([position.x, position.y, position.z]).toEqual([-4, 5, -6]);

    const line = findLineSegments(graph).geometry.getAttribute('position').array as Float32Array;
    // Link b→c: endpoints are node 1 then node 2.
    expect(Array.from(line.slice(6, 12))).toEqual([-4, 5, -6, 7, -8, 9]);
    graph.dispose();
  });

  it('scales node instances by the cube root of val', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    findInstancedMesh(graph).getMatrixAt(1, matrix);
    scale.setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(Math.cbrt(8));

    findInstancedMesh(graph).getMatrixAt(0, matrix);
    scale.setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(1);
    graph.dispose();
  });

  it('applies per-node colors with a default fallback', () => {
    const graph = new Graph3D({ nodeColor: '#00ff00' });
    graph.setGraphData(DATA);

    const color = new THREE.Color();
    findInstancedMesh(graph).getColorAt(0, color);
    expect(color.getHexString()).toBe('ff0000');
    findInstancedMesh(graph).getColorAt(2, color);
    expect(color.getHexString()).toBe('00ff00');
    graph.dispose();
  });

  it('rebuilds meshes when graph data is replaced', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.setGraphData({ nodes: [{ id: 'only' }], links: [] });

    expect(graph.group.children).toHaveLength(1);
    expect(findInstancedMesh(graph).count).toBe(1);
    graph.dispose();
  });

  it('throws on links referencing unknown node ids', () => {
    const graph = new Graph3D();
    expect(() =>
      graph.setGraphData({
        nodes: [{ id: 'a' }],
        links: [{ source: 'a', target: 'ghost' }],
      }),
    ).toThrow(/unknown node id/);
  });

  it('dispose empties the group', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.dispose();
    expect(graph.group.children).toHaveLength(0);
  });

  it('getNodePosition reads back the applied instance position', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const out = new THREE.Vector3();
    expect(graph.getNodePosition(2, out)).toBe(out);
    expect([out.x, out.y, out.z]).toEqual([7, -8, 9]);
    graph.dispose();
  });

  it('getNodePosition returns null for out-of-range indices', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    const out = new THREE.Vector3();
    expect(graph.getNodePosition(-1, out)).toBeNull();
    expect(graph.getNodePosition(99, out)).toBeNull();
    graph.dispose();
  });

  it('pickNode returns the struck node index for a ray through it', () => {
    const graph = new Graph3D({ nodeRadius: 4 });
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    // Aim a ray straight down -Z through node 1 at (-4, 5, -6).
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(-4, 5, 100), new THREE.Vector3(0, 0, -1));
    expect(graph.pickNode(raycaster)).toBe(1);
    graph.dispose();
  });

  it('pickNode returns null when the ray misses every node', () => {
    const graph = new Graph3D({ nodeRadius: 4 });
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(1000, 1000, 1000), new THREE.Vector3(0, 0, -1));
    expect(graph.pickNode(raycaster)).toBeNull();
    graph.dispose();
  });

  it('pickNode returns null before any graph data is set', () => {
    const graph = new Graph3D();
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(graph.pickNode(raycaster)).toBeNull();
  });
});

describe('Graph3D.applyPositions undersized array', () => {
  /** 3 nodes need 9 floats; this supplies 6, so node 2 would read past the end. */
  const SHORT = new Float32Array([1, 2, 3, -4, 5, -6]);

  it('writes no NaN transform and leaves the bounding sphere finite', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    graph.applyPositions(SHORT);
    warn.mockRestore();

    const mesh = findInstancedMesh(graph);
    // Every instance matrix element stays finite. Before the guard, node 2 read
    // three `undefined`s and `setPosition` wrote NaN into its matrix.
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      for (const element of matrix.elements) expect(Number.isFinite(element)).toBe(true);
    }
    // A NaN sphere is the damaging part: frustum culling rejects the whole mesh,
    // so one missing tail position blanks the entire graph.
    const sphere = mesh.boundingSphere!;
    expect(Number.isFinite(sphere.radius)).toBe(true);
    expect(Number.isFinite(sphere.center.x)).toBe(true);
    expect(Number.isFinite(sphere.center.y)).toBe(true);
    expect(Number.isFinite(sphere.center.z)).toBe(true);
    graph.dispose();
  });

  it('leaves the previous good positions in place rather than partially writing', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);
    graph.applyPositions(POSITIONS);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    graph.applyPositions(SHORT);
    warn.mockRestore();

    // Node 1 keeps the position from the last valid call — the guard returns
    // before writing anything, so there is no half-applied frame.
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    findInstancedMesh(graph).getMatrixAt(1, matrix);
    position.setFromMatrixPosition(matrix);
    expect([position.x, position.y, position.z]).toEqual([-4, 5, -6]);
    graph.dispose();
  });

  it('warns once per setGraphData, not once per frame', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // applyPositions is a per-frame layout callback: an unlatched warn would
    // emit at the display refresh rate and bury the rest of the console.
    for (let i = 0; i < 5; i++) graph.applyPositions(SHORT);
    expect(warn).toHaveBeenCalledTimes(1);

    // A new graph is a new caller contract, so the latch resets.
    graph.setGraphData(DATA);
    graph.applyPositions(SHORT);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    graph.dispose();
  });

  it('accepts an array longer than the node count', () => {
    const graph = new Graph3D();
    graph.setGraphData(DATA);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    graph.applyPositions(new Float32Array([...POSITIONS, 99, 99, 99]));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    findInstancedMesh(graph).getMatrixAt(2, matrix);
    position.setFromMatrixPosition(matrix);
    expect([position.x, position.y, position.z]).toEqual([7, -8, 9]);
    graph.dispose();
  });

  it('does not warn for an empty graph applied an empty array', () => {
    const graph = new Graph3D();
    graph.setGraphData({ nodes: [], links: [] });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    graph.applyPositions(new Float32Array(0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    graph.dispose();
  });
});
