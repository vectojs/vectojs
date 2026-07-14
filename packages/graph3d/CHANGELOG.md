# @vectojs/graph3d

## 0.1.0

### Minor Changes

- aee301f: Initial release: 3D force-directed graph visualization package. Ships the `GraphLayout` interface (worker-friendly contract — positions out as one flat transferable `Float32Array` of xyz triplets in node order), a `D3ForceLayout` adapter over d3-force-3d (the engine behind 3d-force-graph; honors `fx`/`fy`/`fz` pins, never mutates caller node objects, caller-driven synchronous stepping with cooling detection), and an instanced `Graph3D` Three.js renderer — one `InstancedMesh` for all nodes with per-instance color and ∛`val` radius scaling plus one `LineSegments` for all links, two draw calls regardless of graph size. `three` is a peer dependency.
