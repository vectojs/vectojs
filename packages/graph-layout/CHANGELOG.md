# @vectojs/graph-layout

## 0.2.1

### Patch Changes

- 2173665: Optimize Barnes-Hut cutoff and collision traversal for large 2D graphs.

## 0.2.0

### Minor Changes

- 1b9aa40: Add incremental link removal and accessor-value update APIs to `ForceLayout2D`.
- 8ff2624: Add partial-axis node pinning and a maximum distance cutoff for many-body repulsion.

### Patch Changes

- 5951433: Expose `ForceLayout2D` node ID/index lookup methods for mapping position slots to persistent graph node IDs.

## 0.1.0

### Minor Changes

- bbcb81b: Add a renderer-agnostic, incremental 2D Barnes-Hut force layout with deterministic placement, collision, accessor-based forces, pinning, and paginated graph updates.
