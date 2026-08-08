---
"@vectojs/core": patch
---

fix(core): inflate Circle/Rect getBounds() to include stroke width

When `stroke` is present, `getBounds()` now inflates the returned bounds by `strokeWidth / 2` to include the full stroke in culling calculations. Previously, strokes at viewport edges were clipped because the bounds only covered the fill geometry.

Unit test: `packages/core/test/ShapeStrokeBounds.test.ts`
