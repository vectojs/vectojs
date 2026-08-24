---
'@vectojs/three': patch
---

Gradient-filled fillText now keys its texture cache on the draw position. The gradient axis is translated into each raster's local space, so drawing the same text/font/gradient at a second location silently reused the first location's raster and showed wrong gradient colors; solid-color text still shares one raster across positions.
