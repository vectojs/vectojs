# @vectojs/knowledge-graph

## 0.4.0

### Minor Changes

- 8e0c02a: Async safety and single-owner layout feeding in the knowledge-graph session/model layers.

  `KnowledgeGraphSession` gains an `onError` option. Selecting a node fires a
  background expand; when its loader rejects, the error was `void`-ed away inside
  the interaction callback and surfaced only as an unhandled rejection — no
  callback existed to observe it. Select-triggered expand failures are now routed
  to `onError(error, entity)` (with a `console.error` fallback), and never escape
  as unhandled rejections.

  The model is now the **single layout driver**. Both layers used to call
  `layout.setGraph` + `reheat(0.5)` on every expand, doubling the rebuild work and
  relying on two independently built identical node orderings for correctness.
  The model feeds the layout (one `setGraph` per rebuild, one `reheat` per
  expand); the session only mirrors `model.getGraphData()` into the renderer and
  keeps its picking indexes aligned with that canonical order.

  Ownership is clarified as creator-owns: `KnowledgeGraphModel.dispose()` no
  longer disposes the layout it merely borrows, so disposing a model cannot kill
  a layout still shared with a live session — the session disposes the layout it
  constructed. The session's dead parallel bookkeeping (`source`, entity/fact
  duplicates, position cache) is gone; warm-start positions are captured by the
  model via the existing public `captureLayoutPositions()`.

  Pagination progress and cursor safety fixes:

  - `ExpansionState.loaded` counts every fact delivered per batch instead of
    net-new facts, so paginated progress no longer stalls when neighborhoods
    overlap across pages.
  - `MemoryDataSource` cursors are version-stamped (`<version>:<offset>`);
    calling `load()` mid-pagination now invalidates outstanding cursors loudly
    (they throw) instead of silently slicing a different fact list.
  - `'both'` direction no longer double-lists self-loop facts (`source ===
target`) within one page.

- 53d0cd6: Clear the knowledge-graph backlog (#659): settle-only warm-start capture, in-flight expansion dedupe

  - **Warm-start positions are captured only when the layout settles**:
    `KnowledgeGraphSession.tick()` no longer calls `model.captureLayoutPositions()`
    every hot frame (one Map entry per node per frame); the model's own capture at
    rebuild time and the single settling-tick capture keep the cache correct.
  - **One shared expansion per id**: repeated selects on a node whose expansion
    fetch is still in flight are swallowed by an in-flight-id gate instead of
    firing `onExpand`/`onError` once per click for a single network fetch.
  - **Docs**: `FixedZLayout` notes that the `GraphLayout` contract pins by node
    index while graph-layout's `ForceLayout2D` pins by node ID (parallel-edge
    identity also diverges between stacks).
  - **Breaking**: `KgDataSource.getLabels` removed from the contract (never
    called by model or session) and the unused `toGraphData` identity-cast helper
    removed.

  Fixes #659 (knowledge-graph items)

### Patch Changes

- 80eb4b4: KnowledgeGraphSession async continuations stop when the session was disposed while their fetch was in flight. bootstrap/expand re-check disposal after each await and syncFromModel guards at the top, so a teardown race no longer drives the disposed Graph3D/camera (the constructor's fire-and-forget bootstrap made this routine).
- 7b8f4b0: Expanding an unknown id no longer materializes a phantom 'Unknown' entity. KgNeighborhood.entity is now optional (sources that don't know the id return no entity), MemoryDataSource returns no placeholder, and the model fails such expansions with a targeted error instead of permanently ingesting a fabricated node.
- Updated dependencies [ddf1fc5]
- Updated dependencies [64c3ca0]
- Updated dependencies [40c4bf6]
- Updated dependencies [14c8e49]
- Updated dependencies [69bb9fa]
  - @vectojs/graph3d@0.6.1

## 0.3.2

### Patch Changes

- Updated dependencies [3be9df8]
  - @vectojs/graph3d@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [88e7490]
- Updated dependencies [755549f]
  - @vectojs/graph3d@0.5.0

## 0.3.0

### Minor Changes

- 05def6b: Add a renderer-neutral paginated knowledge-graph model with expansion state, cancellation, and snapshots.

## 0.2.0

### Minor Changes

- 1bfc6fc: initial RDF-driven knowledge-graph domain layer on graph3d: KgDataSource adapter, MemoryDataSource, FixedZLayout, N3 Turtle parse, KnowledgeGraphSession (2d/3d)

### Patch Changes

- dd40f36: fix code-review findings: live camera getter + setCamera/setNodeCount on GraphInteraction; disable pan on node press; fitToPositions ignores non-finite points; knowledge-graph tick returns settled; expand warm-starts positions; MemoryDataSource/FixedZLayout stop mutating caller data; dispose clears all tables
- Updated dependencies [1bfc6fc]
- Updated dependencies [dd40f36]
  - @vectojs/graph3d@0.4.0
