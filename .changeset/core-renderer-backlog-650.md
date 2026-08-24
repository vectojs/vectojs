---
'@vectojs/core': patch
---

Clear the core renderer backlog (#650): teardown symmetry, dispose hygiene, stroke elision, export font-size option

- **`SVGRenderer` accepts a `rootFontSize` option** (constructor, default 16)
  used to resolve `em`/`rem` sizes in `fillText`, and documents that `em` and
  `rem` share the root size while a percentage size falls back to the 16px
  default — exported text metrics no longer silently assume a non-default
  host page root.
- **`CanvasRenderer.stroke()` now elides style assignments** like `fill()`/
  `fillText()`: repeated identical strokes stop inflating the real-state-switch
  counter on stroke-heavy scenes.
- **`CanvasRenderer.dispose()` removes its `contextlost`/`contextrestored`
  listeners**, so a canvas outliving the renderer no longer retains it or
  resurrects disposed state after a GPU reset; `resize()` guards CSS style
  writes for SSR/stubbed canvases like the constructor already did.
- **`drawSprites` unbinds the VAO** at commit, matching its documented
  counterpart `drawGlyphs`.
- **Cache keys are length-prefixed** in `TextRasterCache` and
  `GlyphRasterAtlas`, so text containing U+0000 can no longer alias another
  (font, color, text) triple's cached raster/slot pixels.
- `recordComputePass` reuses a module-level uniform scratch instead of
  allocating per entity per frame; `SVGRenderer.dispose()` no longer clears
  the gradient cache twice.

Fixes #650
