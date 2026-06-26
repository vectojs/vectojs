---
'@vecto-ui/core': minor
---

Add an opt-in WebGL2 point-cloud layer — the GPU lever for 100k+ point clouds
that Canvas2D can't reach.

- `new Scene(canvas, { pointBackend: 'webgl' })` renders every `getBatchCircle()`
  entity through a stacked WebGL2 `gl.POINTS` layer in a single draw call. Defaults
  to `'canvas'`; auto-falls back to the Canvas2D batch when WebGL2 is unavailable.
- New `createWebGLPointRenderer(canvas)` / `PointRenderer` and `parseColorToRGBA`
  exports.
- Benchmarked (software GL): 100k circles 7→25 fps (3.5×); 500k–1M point clouds
  become feasible. Hardware GPU is faster still.

Tradeoff: GL points form one composited layer above the 2D content (no per-entity
painter interleaving with 2D draws). Default scenes are unaffected.
