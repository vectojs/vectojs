---
'@vectojs/math': patch
'@vectojs/animation': patch
'@vectojs/graph-layout': minor
---

Engines validation sweep (#610): loud boundary validation for math, animation, and graph-layout.

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
