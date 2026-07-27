---
'@vectojs/core': minor
'@vectojs/markdown': patch
---

Add `GlyphRasterAtlas`, a texture atlas of rasterized glyphs for grids that draw
a bounded glyph set thousands of times per frame, plus an optional
`IRenderer.drawImageRect` (9-argument `drawImage`) that `CanvasRenderer`
implements and `SVGRenderer` deliberately omits.

`CodeBlock` now blits its grid from a shared atlas where the renderer supports a
source-rect draw, falling back to `fillText` otherwise. Measured 1.32-2.22x
(Chrome) and 1.42-1.87x (Firefox) against the renderer's own font/fillStyle-cached
`fillText` path.

Named `GlyphRasterAtlas` because `@vectojs/layout` already exports a `GlyphAtlas`
interface for vector path metrics, which the core barrel re-exports.
