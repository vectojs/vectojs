---
"@vectojs/core": patch
---

fix(core): SplineEntity cache invalidation on doc/lineWidth changes

Converted `doc` and `lineWidth` from plain public fields to getter/setter pairs that invalidate cached state (baked canvas, flattened polylines) on mutation. Previously, assigning `lineWidth = 10` post-construction changed hit geometry but not the drawn stroke — visual and hit geometry silently diverged.

Unit test: `packages/core/test/SplineEntityCacheInvalidation.test.ts`
