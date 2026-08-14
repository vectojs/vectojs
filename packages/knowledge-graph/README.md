# `@vectojs/knowledge-graph`

RDF-driven **domain layer** on [`@vectojs/graph3d`](../graph3d). Rendering and force layout stay in graph3d; this package adds:

- `KgDataSource` — lazy `getNodes` / `getNeighbors` adapter contract
- `MemoryDataSource` — in-memory implementation for tests and small graphs
- `KgEntity` / `KgFact` — typed entities with multi-language labels + provenance
- `FixedZLayout` — planar (z = const) wrapper around `VectoForceLayout` for 2D
- `parseRdfTurtle` — N3-backed Turtle → `KgGraphData`
- `KnowledgeGraphSession` — wires source → layout → `Graph3D` → `GraphCamera` → `GraphInteraction`

## Install

```bash
bun add @vectojs/knowledge-graph three
```

`three` is a peer; `@vectojs/graph3d` and `n3` are direct dependencies.

## Minimal 2D session

```ts
import * as THREE from 'three';
import { KnowledgeGraphSession, MemoryDataSource, parseRdfTurtle } from '@vectojs/knowledge-graph';

const data = parseRdfTurtle(myTurtle);
const source = new MemoryDataSource(data);
const canvas = document.querySelector('canvas')!;

const session = new KnowledgeGraphSession({
  domElement: canvas,
  source,
  mode: '2d',
  focusIds: [data.entities[0]!.id],
});

const renderer = new THREE.WebGLRenderer({ canvas });
const scene = new THREE.Scene();
session.attach(scene);

function frame() {
  session.tick();
  session.render(renderer);
  requestAnimationFrame(frame);
}
frame();
```

## Design rules

- **Acyclic deps:** `knowledge-graph → graph3d` only (plus `n3` / `three`).
- **a11y is onDemand-only** in the host app — do not project one DOM node per entity.
- **No WASM force kernel** here; layout performance lives in graph3d's JS Barnes-Hut.

See `references/graph/RESEARCH.md` in the workspace for the ecosystem baseline.
