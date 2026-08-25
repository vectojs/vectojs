# @vectojs/math

## 0.1.2

### Patch Changes

- d08907c: Engines validation sweep (#610): loud boundary validation for math, animation, and graph-layout.

  **@vectojs/math**

  - `SpringPhysics.mass` now validates on assignment: a non-finite or non-positive value throws immediately instead of dividing the acceleration by zero and permanently wedging the integrator (`isAtRest()` could never turn true again).
  - `SpatialHashGrid.insert` throws on non-finite coordinates or negative width/height. Such boxes previously "registered" while enumerating zero cells, so no query could ever find them.
  - `SpatialHashGrid.remove` evicts emptied cells from the grid map, keeping incremental insert/remove cycles proportional to live content instead of accumulating every cell ever touched.

  **@vectojs/animation**

  - `SpringDriver` rejects non-finite or non-positive `stiffness`/`damping`/`mass` at construction instead of silently falling back to physics defaults — such springs diverge or never settle, hanging completion awaits forever.
  - `TweenDriver` rejects unknown easing-name strings at construction; they previously crashed with a bare `TypeError` on the first tick and broke `wasmEasingId`'s `number | null` contract.
  - `TweenDriver.retarget` no longer re-charges consumed delay: segments run on the monotonic elapsed clock, so rapid retargets can no longer starve an animation indefinitely. Retargeting during the initial delay still waits out only the remaining part.

  **@vectojs/graph-layout** (minor: public pin API changes)

  - Pin APIs (`pinNode`, `unpinNode`, `setNodePin`, `clearNodePin`) are now **ID-addressed** like every other node reference. Index-addressed pins silently retargeted to the wrong node after `removeNodes` compaction.
  - Link endpoint validation is unified and strict: `setGraph`/`appendGraph` now throw on dangling or self links (matching `updateLinks`) and validate the whole batch before mutating, so failed calls leave state unchanged.
  - Collision broad-phase bins points into power-of-two radius tiers with per-tier grids, bounding probe cost by local density instead of packing small nodes into cells sized by the largest hub (measured 352M → 2.3M pair-scans over three ticks at 12k points with one large hub; uniform-radius scenes stay within noise at ~1 ms/tick).
  - The collision tier offset tables are sized by tier span, not point count, so legal-but-extreme radius spreads can no longer overflow the counting sort.

- d08907c: Engines validation sweep (#610): loud boundary validation for math, animation, and graph-layout.

  **@vectojs/math**

  - `SpringPhysics.mass` now validates on assignment: a non-finite or non-positive value throws immediately instead of dividing the acceleration by zero and permanently wedging the integrator (`isAtRest()` could never turn true again).
  - `SpatialHashGrid.insert` throws on non-finite coordinates or negative width/height. Such boxes previously "registered" while enumerating zero cells, so no query could ever find them.
  - `SpatialHashGrid.remove` evicts emptied cells from the grid map, keeping incremental insert/remove cycles proportional to live content instead of accumulating every cell ever touched.

  **@vectojs/animation**

  - `SpringDriver` rejects non-finite or non-positive `stiffness`/`damping`/`mass` at construction instead of silently falling back to physics defaults — such springs diverge or never settle, hanging completion awaits forever.
  - `TweenDriver` rejects unknown easing-name strings at construction; they previously crashed with a bare `TypeError` on the first tick and broke `wasmEasingId`'s `number | null` contract.
  - `TweenDriver.retarget` no longer re-charges consumed delay: segments run on the monotonic elapsed clock, so rapid retargets can no longer starve an animation indefinitely. Retargeting during the initial delay still waits out only the remaining part.

  **@vectojs/graph-layout** (minor: public pin API changes)

  - Pin APIs (`pinNode`, `unpinNode`, `setNodePin`, `clearNodePin`) are now **ID-addressed** like every other node reference. Index-addressed pins silently retargeted to the wrong node after `removeNodes` compaction.
  - Link endpoint validation is unified and strict: `setGraph`/`appendGraph` now throw on dangling or self links (matching `updateLinks`) and validate the whole batch before mutating, so failed calls leave state unchanged.
  - Collision broad-phase bins points into power-of-two radius tiers with per-tier grids, bounding probe cost by local density instead of packing small nodes into cells sized by the largest hub (measured 197ms → 5ms per tick at 12k points with one large hub).
  - `removeLinks` resolves bare link IDs through a lazily built index, O(links + items) instead of O(items × links).

- ab46bbb: Backlog hardening for text/math/animation (#652): `TweenDriver.tick` ignores NaN/negative dt instead of poisoning the elapsed clock; `isTweenConfig(null)` returns false; `SpringPhysics` validates stiffness/damping/target and the initial value (throw at mutation, matching `mass`); `MSDFFont.layout` treats `\r\n` and lone `\r` as line breaks with no phantom CR advance; the typography baseline cache is LRU-bounded at 512 entries; documented `SpatialHashGrid.query` full-grid fallback semantics and settled public-API status of `createMSDFMetricsSource`/`hasFontMetrics`/`isSharedMeasuringContextAttached`.

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
