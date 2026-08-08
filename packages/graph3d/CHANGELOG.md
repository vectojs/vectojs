# @vectojs/graph3d

## 0.3.1

### Patch Changes

- be312a6: fix(graph3d): skip Graph3D.applyPositions on an undersized positions array

  `positions[i]` past the end of a `Float32Array` is `undefined`, not `0`, so a
  `positions` array shorter than `nodeCount * 3` wrote NaN instance matrices and a
  NaN bounding sphere. The NaN sphere makes frustum culling reject the whole
  instanced mesh, so the graph blanked entirely rather than losing only the
  missing tail.

  `applyPositions` now validates `positions.length >= nodeCount * 3` up front and
  returns without writing anything, so there is no half-applied frame. The warning
  is latched (once per `setGraphData`) because this is a per-frame layout callback
  — an unlatched `console.warn` would emit at the display refresh rate.

  Unit test: `packages/graph3d/test/Graph3D.test.ts`

## 0.3.0

### Minor Changes

- 6bdd1dc: Add `VectoForceLayout` — an in-house, dependency-free 3D force-directed graph layout, offered as an alternative `GraphLayout` to the `d3-force-3d`-backed `D3ForceLayout`.

  It is a **new force model**, not a d3 adapter: repulsion is an in-house **Barnes-Hut octree** N-body (O(N log N) per tick), combined with link springs, an origin-centering pull, velocity-decay integration, and alpha cooling. It is deterministic (a seeded PRNG places un-seeded nodes, so a given graph lays out identically every run), computes in f32 throughout, and implements the full `GraphLayout` contract including `pinNode`/`unpinNode`/`reheat` for interactive drag. It has **no runtime dependency on d3-force-3d** — apps that don't need d3 can drop it.

  Real-hardware benchmark (`benchmarks/graph-layout`, per-tick cost vs `D3ForceLayout` on the same graph, Chrome 150 + Firefox 153): **4.2–7.2× faster on Chrome, 5.0–8.3× on Firefox** across 500–5000 nodes, with the margin widening as the graph grows (the Barnes-Hut O(N log N) advantage). A matching Rust/WASM kernel that accelerates this exact model (differential-tested against it) is a planned follow-up.

### Patch Changes

- 778f0c9: Two measured per-frame fixes from the remaining micro-walk survey (the third
  item, Tabs' per-frame visibility scan, was measured at 0.5–2.0µs/frame for 60
  tabs and deliberately left alone):

  - **`SpatialHashGrid` degraded as O(area / cellSize²)** (`@vectojs/math`). Cell
    enumeration touched every cell an AABB covered, so one large box was
    pathological: measured **789µs per query** over a 10000×10000 region and
    **1.2ms to insert** a single 6400×6400 box at cellSize 64 — a single
    screen-sized entity could blow the frame budget by itself. Boxes spanning more
    than 64 cells now go to an oversized list and are AABB-tested directly, and an
    oversized _query_ walks the occupied cells (bounded by real content) instead of
    its own area. `clear()` now also empties that list — it previously would have
    leaked oversized entries into every later frame. Verified differentially
    against an exhaustive AABB scan: the broad phase never misses a true overlap.
  - **`Graph3D.applyPositions` computed its bounding sphere in a second pass**
    (`@vectojs/graph3d`). `InstancedMesh.computeBoundingSphere()` re-reads every
    instance matrix out of the buffer the method has just written, and measured at
    **60–78% of the whole method** (more than the matrix-write loop it follows).
    The sphere is now derived inline from the positions already in hand:
    **2.4× faster** at 500 nodes, **3.2×** at 2000, **2.3×** at 10000 (0.567 →
    0.248ms). `nodeMesh` keeps frustum culling on, so the sphere stays
    conservative — it expands by each instance's true world radius
    (`nodeRadius × cbrt(val)`, not the scale alone) and uses the AABB circumradius,
    asserted by containing every node's full extent.

## 0.2.1

### Patch Changes

- 9711fdf: Make GraphInteraction robust to pointer events that start or end off-canvas:

  - A pointer release whose press never touched the canvas no longer fires
    `onSelect(null)` — clicking unrelated UI elsewhere on the page no longer
    deselects the current node.
  - `pointercancel` (touch scroll takeover, pen out of range) now ends an active
    drag, re-enables the host's controls, and fires `onDragEnd`; previously the
    drag stayed stuck and controls stayed disabled because a cancelled pointer
    never delivers `pointerup`.
  - Drags capture the pointer so the node keeps tracking while the cursor is
    outside the canvas.
  - `dragReheat: 0` now skips the `reheat` call entirely, as documented.
  - `D3ForceLayout.setGraph` honors `x`/`y`/`z` initial position seeds on nodes
    (in addition to `fx`/`fy`/`fz` pins), so pre-seeded graphs start
    deterministically.

## 0.2.0

### Minor Changes

- 8036672: Add node picking and drag-to-pin, so interactive 3D graphs no longer have to hand-roll raycasting against the instanced node mesh.

  - `Graph3D.pickNode(raycaster)` — hit-test the node cloud with a caller-configured `THREE.Raycaster` and get back the struck node's index (aligned with `GraphData.nodes`), or `null` on a miss. Only the instanced node mesh is tested; links are never picked.
  - `Graph3D.getNodePosition(index, target)` — read a node's current world position (as last written by `applyPositions`) straight from its instance matrix into `target`, or `null` for an out-of-range index.
  - `GraphLayout.pinNode`/`unpinNode`/`reheat` — optional runtime pin controls on the layout contract. `D3ForceLayout` implements them over d3-force's `fx`/`fy`/`fz`, letting a node be clamped to a live position and the simulation reheated to settle around it.
  - `GraphInteraction` — a small pointer-events helper that turns raw `pointermove`/`pointerdown`/`pointerup` over a `Graph3D` into `onHover`/`onSelect` and drag-to-pin (`onDragStart`/`onDrag`/`onDragEnd`), with a `setControlsEnabled` hook so the host can suspend its `OrbitControls` during a drag. Drag is feature-detected: without a pin-capable layout, presses fall back to select. It owns only its pointer listeners — no scene, render loop, or controls.

  All additive and backward-compatible; the existing `Graph3D`/`D3ForceLayout`/`GraphLayout` surface is unchanged.

## 0.1.0

### Minor Changes

- aee301f: Initial release: 3D force-directed graph visualization package. Ships the `GraphLayout` interface (worker-friendly contract — positions out as one flat transferable `Float32Array` of xyz triplets in node order), a `D3ForceLayout` adapter over d3-force-3d (the engine behind 3d-force-graph; honors `fx`/`fy`/`fz` pins, never mutates caller node objects, caller-driven synchronous stepping with cooling detection), and an instanced `Graph3D` Three.js renderer — one `InstancedMesh` for all nodes with per-instance color and ∛`val` radius scaling plus one `LineSegments` for all links, two draw calls regardless of graph size. `three` is a peer dependency.
