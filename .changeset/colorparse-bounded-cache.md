---
'@vectojs/core': patch
---

Bound `parseColorToRGBA`'s cache to the same 1000-entry LRU pattern already used by `@vectojs/ui`'s `measureText` cache. `BatchCircle`/`BatchRect` colors are read every frame, so a workload with many distinctly-colored, continuously-varying entities (an animated heatmap, a particle field with per-point color shifts) could mint a new unique color string every frame — the cache had no eviction and would grow unbounded for the life of the page.
