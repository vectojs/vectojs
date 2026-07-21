# @vectojs/animation

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/animation` as a standalone package: the shared `Easing`
  library plus `TweenDriver` and `SpringDriver` value drivers. Extracted from
  `@vectojs/core`; depends only on `@vectojs/math` for the spring integrator.
  `@vectojs/core` re-exports everything here for backward compatibility.

### Patch Changes

- Updated dependencies [3a623c1]
  - @vectojs/math@0.1.0
