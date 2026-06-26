---
'@vecto-ui/core': minor
---

Add GPU rectangle batching to the WebGL point layer.

- `Entity.getBatchRect()` (default `null`): a leaf entity that draws as a single
  solid rectangle returns `{ width, height, color }` to opt in. Honors world
  position, uniform scale, rotation, and opacity.
- `PointRenderer.addRect(...)`: rectangles are batched as an expanded triangle
  list (6 vertices/rect, rotation applied on the CPU) and drawn with one
  `drawArrays(TRIANGLES)`, alongside the existing `gl.POINTS` circles.

Only active with `pointBackend: 'webgl'`; otherwise these entities render
normally. Benchmarked ~1.9× over Canvas2D at 100k rects. (Implemented as a
triangle batch rather than instanced quads, which were dramatically slower on
software GL while equivalent on hardware.)
