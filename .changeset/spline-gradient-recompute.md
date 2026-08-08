---
"@vectojs/core": patch
---

fix(core): recompute SplineEntity.containsGradient when the document changes

`containsGradient` selects the render path — `render()` takes the bake path only
when it is false — but it was `private readonly`, computed once in the
constructor. The `doc` setter added in #402 invalidated the baked canvas, the
polylines and the bounds, yet left this flag stale.

Assigning a gradient-stroked document to an entity constructed from a
solid-color one therefore kept the flag at `false` and sent the gradient through
`bake()`, which has no gradient support and substitutes `defaultColor`: the
gradient rendered as a single flat color, and the per-frame `resolveColor()`
path that builds the actual `createLinearGradient` was never reached. No warning
was emitted. The reverse direction (gradient → solid) left the flag stale at
`true`, permanently disabling baking for an entity that had become bakeable.

The detection is extracted into `computeContainsGradient()` and called from both
the constructor and the `doc` setter, so the two cannot drift.

Unit test: `packages/core/test/SplineEntityCacheInvalidation.test.ts`
