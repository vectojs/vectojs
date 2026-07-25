---
"@vectojs/three": patch
---

Bound `ThreeRenderer`'s image-texture cache. `drawImage` cached one `THREE.Texture` per source keyed by identity, but the cache had no size limit — a long-running scene that draws many distinct images (or transient per-frame canvases that are never `invalidateImage`'d) accumulated GPU textures without bound. The cache now caps at 256 entries (mirroring the existing text-texture cache): a cache hit re-inserts the source as most-recently-used, and once the cap is exceeded the least-recently-used texture is disposed and evicted.
