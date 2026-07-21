# @vectojs/text

## 0.1.0

### Minor Changes

- 3a623c1: Introduce `@vectojs/text` as a standalone package of renderer-agnostic
  text-shaping primitives: `BidiResolver`, `ArabicShaper`, `Typography`
  (CSS-parity line-box metrics), `MSDFFont`, and `PreparedContentGrid`. Extracted
  from `@vectojs/core` (they have no dependency on the scene graph or a renderer).
  The `Entity`-based `MSDFTextEntity` / `SVGEntity` stay in `@vectojs/core`, which
  re-exports everything here for backward compatibility.
