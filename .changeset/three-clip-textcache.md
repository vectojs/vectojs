---
'@vectojs/three': patch
---

clip() scissors by the renderer's own pixel ratio instead of window.devicePixelRatio; fillText reuses rasterized textures through an LRU cache instead of re-uploading per call per frame.
