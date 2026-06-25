---
'@vecto-ui/core': minor
---

Add `SplineEntity` — first-class rendering of vectomancy's native `Spline` JSON
(piecewise-cubic curves) directly to canvas:

- Converts polynomial segments to cubic Béziers (`polySegmentToBezier`), draws all
  equations, and supports per-equation solid `[r,g,b]` colors and linear gradients.
- Bounds come from the document's `bounding_box` (or are computed), so the entity
  participates in viewport culling via `getBounds()`.
- Bakes to an `OffscreenCanvas` by default for 60fps blitting, with a per-frame
  curve-drawing fallback when `OffscreenCanvas` is unavailable.
- AABB hit-testing with a `hitTestCurve()` seam for future curve-accurate picking.
- `loadSpline(url)` helper to fetch + parse a spline document.
