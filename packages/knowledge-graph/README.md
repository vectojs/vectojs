# @vectojs/knowledge-graph

RDF-driven knowledge-graph domain layer on `@vectojs/graph3d`: a lazy, paginated data-source contract, a renderer-neutral model that materializes a bounded cut of a much larger graph, and a session that wires source to layout to renderer. Rendering and force physics stay in graph3d — this package owns typed entities (`KgEntity`/`KgFact` with multi-language labels and provenance), deduplication, resumable expansion state, cancellation, and snapshots. It depends on `@vectojs/graph3d` and `n3` only, keeping the stack acyclic: hosts may use the headless model alone or the full Three.js session.

## Install

```bash
bun add @vectojs/knowledge-graph
```

`three` is a peer dependency; `@vectojs/graph3d` and `n3` are direct dependencies.

## Usage

```ts
import * as THREE from 'three';
import { KnowledgeGraphModel, MemoryDataSource } from '@vectojs/knowledge-graph/model';
import { KnowledgeGraphSession } from '@vectojs/knowledge-graph';

const source = new MemoryDataSource({
  entities: [
    { id: 'vectojs', type: 'Project', labels: { en: 'VectoJS' } },
    { id: 'core', type: 'Package', labels: { en: '@vectojs/core' } },
    { id: 'ui', type: 'Package', labels: { en: '@vectojs/ui' } },
  ],
  facts: [
    { source: 'vectojs', target: 'core', predicate: 'dependsOn' },
    { source: 'vectojs', target: 'ui', predicate: 'dependsOn' },
  ],
});

// Headless half: paginated, cancellable, snapshot-able.
const model = new KnowledgeGraphModel({ source, lang: 'en' });
await model.bootstrap(['vectojs']); // seeds + first pages per focus id
let result = await model.expand('vectojs'); // exactly one page per call
while (result.state.status === 'partial') result = await model.expand('vectojs');

// Session half: source → layout → Graph3D → camera → interaction.
const session = new KnowledgeGraphSession({
  domElement: document.querySelector('canvas')!,
  source,
  mode: '2d',
  focusIds: ['vectojs'],
});
session.attach(new THREE.Scene());
// host rAF loop: session.tick(); session.render(renderer);
```

## Highlights

- Lazy `KgDataSource` contract with opaque cursors, page limits, direction filters, and `AbortSignal`; `MemoryDataSource` is the reference implementation (O(degree) neighbor lookup, version-stamped cursors that throw loudly instead of slicing shifted fact lists after a reload).
- The `/model` subpath is the explicit headless boundary: data and expansion state with no DOM, canvas, Three.js scene, or animation timer.
- Bounded materialization: entities dedupe by ID with merged label maps, facts dedupe by ordered `(source, predicate, target)` triple; resident memory tracks loaded pages, never total graph size.
- Resumable expansion per node — concurrent calls for one ID share one promise, `cancelExpand` aborts through the source's signal, failures preserve cursor progress for retry.
- Versioned snapshots (`exportSnapshot`/`importSnapshot`) persist entities, facts, and resumable expansion metadata; unsupported versions throw before replacement.
- Reading is `getGraphData()` / `listEntities()` / `listFacts()` — the earlier `getLabels()` and `toGraphData()` helpers no longer exist.
- In `'2d'` mode the session drives `FixedZLayout` (planar wrapper over Barnes-Hut) with an orthographic camera; the model is the single layout driver, preserving finite XYZ positions by node ID as warm starts across expands.
- Select-to-expand is gated to one in-flight fetch per ID, and expand failures route to an `onError(error, entity)` handler instead of escaping as unhandled rejections; unknown IDs fail loudly rather than materializing phantom nodes.

> Documents @vectojs/knowledge-graph@0.4.0.

## Documentation

- [`KnowledgeGraphModel` reference](https://vectojs.org/reference/knowledge-graph-model/)
