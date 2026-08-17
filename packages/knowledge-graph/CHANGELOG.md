# @vectojs/knowledge-graph

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
