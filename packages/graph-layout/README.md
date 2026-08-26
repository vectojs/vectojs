# @vectojs/graph-layout

Renderer-agnostic, dependency-free 2D force simulation: a Barnes-Hut quadtree for repulsion, spring links, optional collision handling, incremental topology updates, and runtime pinning — with no renderer, no animation timer, and no peer dependency. It is the standalone 2D sibling of the layout engines inside `@vectojs/graph3d`: the host supplies graph data, calls `step()`, and reads interleaved XY coordinates from a live `Float32Array`, so the same layout can drive Canvas 2D, SVG, WebGL, WebGPU, or an off-main-thread renderer.

## Install

```bash
bun add @vectojs/graph-layout
```

No runtime dependencies; `sideEffects` is false.

## Usage

```ts
import { ForceLayout2D } from '@vectojs/graph-layout';

const layout = new ForceLayout2D({ linkDistance: 48, collisionRadius: 8 });
layout.setGraph({
  nodes: [{ id: 'center', fx: 0, fy: 0 }, { id: 'left' }, { id: 'right' }],
  links: [
    { source: 'center', target: 'left' },
    { source: 'center', target: 'right' },
  ],
});

function tick() {
  const active = layout.step(); // synchronous; false once alpha cools
  const p = layout.positions; // live view [x0, y0, x1, y1, ...]
  const i = layout.getNodeIndex('left')! * 2;
  console.log('left is at', p[i], p[i + 1]);
  if (active) requestAnimationFrame(tick);
}
tick();
```

## Highlights

- Barnes-Hut repulsion in expected O(N log N) plus springs in O(E) per tick; `theta` trades speed for accuracy, and the tiered collision broad-phase keeps probe cost bounded by local density rather than the largest radius.
- Strict endpoint validation: `setGraph()` and `appendGraph()` throw when a link references an unknown node or itself — dangling links are no longer dropped silently to hide data bugs — and `appendGraph()` validates the whole batch before mutating, so a rejected call leaves the previous graph intact.
- Incremental topology without full rebuilds: `appendGraph()` preserves positions, velocities, and pins with replay-idempotent pages; `removeNodes()` compacts survivors; `removeLinks()` never shifts a node index; `updateLinks()` re-evaluates distance/strength accessors only.
- Pins are ID-addressed like every other node reference: `setNodePin`/`clearNodePin` keep pointing at the same node across `removeNodes()` compaction (the 3D `GraphLayout` contract pins by index instead — translate when crossing stacks).
- Deterministic seeding via the `seed` option for nodes without finite initial coordinates; option accessors are evaluated once per accepted record, never per tick.
- The host owns scheduling: `step(iterations)` is synchronous and reports whether physics still needs a tick — it says nothing about whether your app should keep rendering. Reheat on drag start, not on every pointer move.
- d3-force migration path maps directly (`setGraph`, `step(k)`, `reheat(value)`, `setNodePin`) while dropping d3's internal timer and mutated-node-object output.

> Documents @vectojs/graph-layout@0.3.0.

## Documentation

- [`ForceLayout2D` reference](https://vectojs.org/reference/graph-layout/)
