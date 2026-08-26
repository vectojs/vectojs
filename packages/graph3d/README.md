# @vectojs/graph3d

3D force-directed graph visualization for VectoJS: a pluggable `GraphLayout` contract whose positions leave as one flat `Float32Array` of xyz triplets (worker-transferable with zero copy), plus `Graph3D`, an instanced Three.js renderer that draws any graph in exactly two draw calls. It sits in the middle of the graph stack — layout engines (`VectoForceLayout`, `D3ForceLayout`) behind the contract, `@vectojs/knowledge-graph` and host applications on top — and peers only on `three`; it never manages your `WebGLRenderer`, camera, or controls.

## Install

```bash
bun add @vectojs/graph3d
```

`three` is a peer dependency. `d3-force-3d` ships as a direct dependency for `D3ForceLayout`; the default `VectoForceLayout` needs nothing beyond this package.

## Usage

```ts
import * as THREE from 'three';
import { Graph3D, VectoForceLayout } from '@vectojs/graph3d';

const data = {
  nodes: [{ id: 'a', val: 4 }, { id: 'b' }, { id: 'c' }],
  links: [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
  ],
};

const layout = new VectoForceLayout();
layout.setGraph(data);

const graph = new Graph3D();
graph.setGraphData(data); // throws if a link references an unknown node id

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 200;
const renderer = new THREE.WebGLRenderer();
document.body.appendChild(renderer.domElement);
scene.add(graph.group);

(function animate() {
  const active = layout.step(); // false once alpha cools below threshold
  graph.applyPositions(layout.positions);
  renderer.render(scene, camera);
  if (active) requestAnimationFrame(animate);
})();
```

Unknown link endpoints throw uniformly — in `Graph3D.setGraphData`, `VectoForceLayout.setGraph`, and `D3ForceLayout.setGraph` — before the previous graph is cleared or any state mutates, so a bad input can never leave a half-swapped scene or a silent line to the origin.

## Highlights

- Worker-friendly by construction: `positions` is a single `Float32Array` of xyz triplets, transferable across `postMessage` with zero copy, and `applyPositions()` never learns where the buffer came from.
- Total renderer/layout separation: `Graph3D` never imports a layout, layouts never import Three.js; swapping engines is a one-line change at the call site.
- Two draw calls regardless of node count: one `InstancedMesh` for all nodes (per-instance color, radius proportional to the cube root of `val`) and one `LineSegments` for all links, under a single `THREE.Group`.
- In-house Barnes-Hut octree layout (`VectoForceLayout`) with an optional Rust/WASM kernel behind the `@vectojs/graph3d/wasm` subpath that silently falls back to bit-identical JS on any load failure; `D3ForceLayout` adapts d3-force-3d.
- Uniform throw-on-unknown-id policy across renderer and both layouts, validated before any state mutation.
- `GraphCamera` bundles a 2D orthographic pan/zoom view and a 3D perspective orbit view behind one live `camera` getter, with `fitToPositions` framing; `GraphInteraction` adds hover, select, and drag-to-pin with control hand-off.
- Node objects are never mutated — domain properties ride along untouched; `fx`/`fy`/`fz` pin nodes by index.

> Documents @vectojs/graph3d@0.6.1.

## Documentation

- [Overview](https://vectojs.org/reference/graph3d/)
- [`GraphLayout`, `VectoForceLayout`, `D3ForceLayout`](https://vectojs.org/reference/graph3d-layout/)
- [`Graph3D` and picking](https://vectojs.org/reference/graph3d-renderer/)
