# @vectojs/animation

## 0.1.3

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
- Updated dependencies [d08907c]
- Updated dependencies [d08907c]
- Updated dependencies [ab46bbb]
  - @vectojs/math@0.1.2

## 0.1.2

### Patch Changes

- ec78b38: P3 fixes from the 2026-08-13 review (#495, #496):

  - `MSDFFont.layout` no longer replaces the kerning base with a combining mark: `prevCode` stays on the base glyph, so a kern pair like A→B still applies across `A\u0301B` instead of being silently dropped.
  - `createCanvasMeasurer.measure()` honors the `GlyphMeasurer` contract for per-run `fontFamily`/`bold`/`italic` overrides — it now measures (and caches) at the requested style instead of always returning base-font numbers, so inline `monospace`/bold runs break lines by their own metrics.
  - `LayoutEngine.layoutPreparedIntoBuffer` honors `preserveLeadingSpaces` like the allocating path; the zero-GC path previously skipped leading whitespace unconditionally.
  - `TweenDriver` sanitizes non-finite `duration`/`delay` (NaN config no longer wedges the value at NaN with `isDone()` forever false) and snaps to `to` exactly when complete, so a custom `EasingFn` with f(1) !== 1 can no longer finish off-target.
  - `SpringDriver` drops non-finite or non-positive spring config instead of feeding it to the integrator — `mass: 0` produced NaN velocity and a spring that could never reach rest.
  - DevTools: `selectFinding` resolves plugin audit rows to their entities (the unified row list the tree already showed); the transient "owned by parent" warning is inserted at the top of the inspect readout instead of being dropped as row 21 of 20; the full-scene a11y audit is cached across refresh ticks and recomputed on `structureVersion` changes instead of re-walking the tree every 500 ms; the a11y audit, reading-order query, and `inspectA11y` survive a throwing app-supplied `getA11yAttributes()` per entity; and the accessible name / duplicate-label audit uses the full announced string rather than the 80-char display preview, so long labels sharing a prefix no longer collide as false duplicates.

## 0.1.1

### Patch Changes

- 7b7b2b6: Make the built-in cubic and back easings (`easeInOutQuad`, `easeOutCubic`, `easeInOutCubic`, `easeOutBack`, `easeInOutBack`) compute integer powers via explicit multiplication instead of `Math.pow`. `Math.pow` is not specified to be correctly rounded and diverges in the last ULP across JS engines; plain IEEE-754 multiplication is deterministic everywhere. This makes easing output identical across V8/SpiderMonkey/JSC and lets the WASM batched-tween kernel (`@vectojs/core`) match `TweenDriver` bit-for-bit rather than to ~1e-9. Visual output is unchanged (differences were sub-ULP).
- Updated dependencies [778f0c9]
  - @vectojs/math@0.1.1

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/animation` as a standalone package: the shared `Easing`
  library plus `TweenDriver` and `SpringDriver` value drivers. Extracted from
  `@vectojs/core`; depends only on `@vectojs/math` for the spring integrator.
  `@vectojs/core` re-exports everything here for backward compatibility.

### Patch Changes

- Updated dependencies [3a623c1]
  - @vectojs/math@0.1.0
