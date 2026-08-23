---
'@vectojs/knowledge-graph': minor
---

Async safety and single-owner layout feeding in the knowledge-graph session/model layers.

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
