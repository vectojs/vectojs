# @vectojs/animation

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
