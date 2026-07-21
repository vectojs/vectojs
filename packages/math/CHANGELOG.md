# @vectojs/math

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/math` as a standalone package. It contains the
  `SpatialHashGrid` broad-phase and `SpringPhysics` integrator, extracted from
  `@vectojs/core` so they can be consumed without the scene-graph runtime.
  `@vectojs/core` re-exports both for backward compatibility.
