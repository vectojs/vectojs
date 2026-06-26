---
'@vecto-ui/core': patch
---

Add texture-atlas sprite support to the WebGL point layer.

`PointRenderer` gains `setTexture(source)` and `addSprite(x, y, w, h, u0, v0, u1,
v1, color?, alpha?, rotation?)`: a textured-quad triangle batch that samples a
texture atlas with a multiply tint, drawn in one `TRIANGLES` call. This lets large
sets of custom glyphs / icons (e.g. emoji, `@`-style nodes) render on the GPU
instead of falling back to Canvas2D. `addSprite` is a no-op until a texture is set.
