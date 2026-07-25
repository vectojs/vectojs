# @vectojs/math

## 0.1.1

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

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/math` as a standalone package. It contains the
  `SpatialHashGrid` broad-phase and `SpringPhysics` integrator, extracted from
  `@vectojs/core` so they can be consumed without the scene-graph runtime.
  `@vectojs/core` re-exports both for backward compatibility.
