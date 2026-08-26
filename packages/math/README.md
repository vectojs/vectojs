# @vectojs/math

`@vectojs/math` is a leaf package of the VectoJS graph with zero dependencies: the spatial and
physics primitives that were extracted from `@vectojs/core` so they can be consumed without the
scene-graph runtime — `SpatialHashGrid`, a uniform-grid broad-phase for neighbor and hit queries,
and `SpringPhysics`, a single-value critically-tunable spring integrator. `@vectojs/core` depends
on and re-exports it, and `SpringDriver` in `@vectojs/animation` is built on this integrator.

## Install

```bash
bun add @vectojs/math
```

## Usage

```ts
import { SpatialHashGrid, SpringPhysics } from '@vectojs/math';

const grid = new SpatialHashGrid(64);
const spring = new SpringPhysics(0);

function frame(dtSeconds: number) {
  // Broad-phase pattern: clear once, insert dynamics, query per hit test.
  grid.clear();
  grid.insert('player', 100, 100, 32, 32);
  grid.insert('coin', 140, 110, 16, 16);
  const hits = grid.query(96, 96, 48, 48); // Set<string> of candidate ids

  // Spring toward a target; integrate in seconds.
  spring.stiffness = 180;
  spring.damping = 12;
  spring.target = 240;
  spring.update(dtSeconds);
  if (spring.isAtRest()) console.log('settled at', spring.value, 'hits:', [...hits]);
}
```

## Highlights

- `SpatialHashGrid(cellSize = 64)` buckets axis-aligned boxes into uniform cells; `query(x, y, w, h)`
  returns only the ids that could overlap a region instead of scanning every entity.
- Frame-friendly contract: `insert()` re-keys stale cells so it is safe to call every frame, and
  `clear()` / `remove(id)` / `clear()` keep dynamic scenes allocation-stable.
- `SpringPhysics(initial)` integrates a single value in seconds with fixed internal substeps
  (max 1/120 s per step, frame delta clamped to 0.25 s), staying stable across frame drops.
- Tunable stiffness/damping/mass setters validate loudly — non-finite or non-positive values throw
  rather than silently wedging the integrator.
- `isAtRest()` reports when velocity and distance-to-target decay below rest thresholds, so callers
  can stop ticking and completion promises resolve exactly on target.
- This is the same primitive behind `Entity.springTo()` in Core and `SpringDriver` in
  `@vectojs/animation`; use it directly for values outside the six animatable Entity props.

> Documents @vectojs/math@0.1.2.

## Documentation

- [Math utilities reference](https://vectojs.org/reference/core-math/)
- [Physics & animation guide](https://vectojs.org/learn/physics-engine/)
