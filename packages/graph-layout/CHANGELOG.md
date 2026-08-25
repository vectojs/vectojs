# @vectojs/graph-layout

## 0.3.0

### Minor Changes

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

### Patch Changes

- ddf1fc5: Reject degenerate force-layout options that silently hung or froze simulations (#641).

  - **`alphaDecay: 0` no longer passes validation in `ForceLayout2D`.** The per-tick decay `alpha += (0 - alpha) * alphaDecay` became a no-op, `step()`'s `alpha >= alphaMin` guard stayed true forever, and hosts driving `while (layout.step()) requestAnimationFrame(loop)` never stopped — silent permanent CPU/GPU burn with no error. A non-positive decay now falls back to the default 0.0228.
  - **`repulsionDistanceMax: 0` no longer silently disables repulsion in `ForceLayout2D`.** A finite cutoff of 0 hit the force kernel's `maxDistance <= 0` early-return, switching repulsion off entirely while the types only documented "non-finite disables the cutoff". Any non-positive cutoff now means the same as `Infinity` (no cutoff).
  - **`VectoForceLayout` mirrors the decay guard.** It took `alphaDecay` raw with no validation at all; a literal 0 there had the same never-settles failure mode.

- 53d0cd6: Clear the graph-layout backlog (#659): single max-radius scan per collision tick, pinning docs

  - **`applyGridCollisions` takes the precomputed `maximumRadius`** instead of
    rescanning all radii internally — the caller already needed the same O(N)
    max-radius walk for its early-out, so collisions-enabled ticks ran it twice.
    The class lives under `src/internal/`, but the signature is visible in dist
    types, hence the patch bump.
  - **Docs**: `ForceLayout2D.pinNode` documents that this package pins by node ID
    (pins survive `removeNodes` compaction) while the 3D `GraphLayout` contract
    pins by node index, and that parallel-edge identity differs per stack
    (node-editor rejects duplicate endpoint quadruples; the graph/knowledge
    stacks treat parallel links as distinct edges).

  Fixes #659 (graph-layout items)

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
