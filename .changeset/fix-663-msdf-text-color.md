---
'@vectojs/core': patch
---

core: MSDFTextEntity now renders glyphs in the configured `color` on both the WebGL and Canvas2D paths (#663). Color is applied as a draw-time tint instead of being read from the worker-packed style bits (which are always white), so post-construction `entity.color` reassignment also takes effect.
