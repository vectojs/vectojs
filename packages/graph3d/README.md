# @vectojs/graph3d

3D force-directed graph visualization for [VectoJS](https://vectojs.org): pluggable layout engines behind one `GraphLayout` interface, plus an instanced Three.js renderer that draws any graph in two draw calls.

## Install

```bash
bun add @vectojs/graph3d three
```

## Usage

```ts
import { D3ForceLayout, Graph3D } from '@vectojs/graph3d';
import * as THREE from 'three';

const data = {
  nodes: [{ id: 'vectojs', val: 8, color: '#4f9cff' }, { id: 'core' }, { id: 'ui' }],
  links: [
    { source: 'vectojs', target: 'core' },
    { source: 'vectojs', target: 'ui' },
  ],
};

const layout = new D3ForceLayout();
layout.setGraph(data);

const graph = new Graph3D();
graph.setGraphData(data);
scene.add(graph.group);

function animate() {
  const active = layout.step();
  graph.applyPositions(layout.positions);
  renderer.render(scene, camera);
  if (active) requestAnimationFrame(animate);
}
animate();
```

## Design

- **`GraphLayout`** — the layout contract: positions out as one flat `Float32Array` of xyz triplets, so an engine can run in a Web Worker and stream its buffer across as a transferable. `D3ForceLayout` adapts [d3-force-3d](https://github.com/vasturiano/d3-force-3d) (the engine behind 3d-force-graph); more adapters (ngraph) and DAG modes are planned.
- **`Graph3D`** — one `InstancedMesh` for all nodes (per-instance color, radius ∝ ∛`val`) and one `LineSegments` for all links, under a single `THREE.Group`. It consumes any `GraphLayout`-shaped positions buffer and knows nothing about how they were computed.
- Node objects are never mutated; domain properties ride along untouched. `fx`/`fy`/`fz` pin nodes in place.

Interactive in-world node cards and HUD components built on `@vectojs/ui` + `@vectojs/three` (scene-to-texture billboards that keep working in WebXR) are the next layer on this package's roadmap.

## License

MIT
