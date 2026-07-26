---
'@vectojs/core': patch
---

Draw all WebGL quad batches indexed (4 vertices + a shared static index buffer)
instead of expanding each quad to 6 vertices.

`flush()` already issues at most one draw call per primitive type, so draw-call
count was never the cost — the submit path is bandwidth-bound. Every quad was
uploading its two shared corners twice, which at 50,000 quads meant 9.16 MB per
frame.

Rects, sprites, glyphs and carved circle-quads now write 4 vertices and draw with
`drawElements` against one `ELEMENT_ARRAY_BUFFER` built once and regrown
geometrically (32-bit indices, since real scenes exceed the 16,383-quad ceiling a
`Uint16Array` would impose). Upload volume drops by a third and the JS fill drops
with it, since `writeQuad` writes 32 floats instead of 48.

Measured on real hardware (`benchmarks/flush-upload`, RTX 4060 Laptop, work plus
`gl.finish()`, median of 12), 6-vertex versus indexed:

| quads   | Chrome          | Firefox          |
| ------- | --------------- | ---------------- |
| 12,000  | 0.61 -> 0.09ms  | 2.66 -> 1.47ms   |
| 50,000  | 2.22 -> 0.87ms  | 9.02 -> 6.24ms   |
| 100,000 | 12.62 -> 3.12ms | 16.81 -> 10.88ms |

In the glyph path end to end (`benchmarks/glyph-batch`, 24,800 glyphs) the GPU
submit went 1.57 -> 0.42ms on Chrome (3.7x) and 1.91 -> 1.20ms on Firefox (1.6x),
with the JS accumulate phase also 1.7x faster on Chrome from the smaller write.

`addRect` additionally loses the per-quad closure and temporary arrays that
`addGlyph`/`addSprite`/`addCircle` shed previously.
