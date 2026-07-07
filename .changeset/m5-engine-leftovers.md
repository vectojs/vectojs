---
'@vectojs/core': patch
'@vectojs/three': patch
---

Engine cleanups: WebGL circles that gl.POINTS cannot represent (center near/off the viewport edge, or diameter beyond the GPU point-size cap) now render through a triangle-quad fallback instead of popping or shrinking; the Scene loop no longer re-walks the tree up to 4x per tick (animation/interactive flags are collected during the render walk); legacy animate() wakes idle onDemand scenes; ThreeRenderer caches drawImage textures per source with an invalidateImage() API.
