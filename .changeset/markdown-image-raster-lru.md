---
'@vectojs/markdown': patch
---

Fixes #699: the inline-image raster store no longer grows unbounded. `inlineImageRasters` was a module-level insert-only `Map`, so a long-lived page rendering documents with distinct image URLs pinned a decoded `HTMLImageElement` per URL until tab close — the exact growth pattern #521 capped on the math side. `ensureInlineImageRaster` now re-inserts on hit (recency order) and evicts the least-recently-used entry past a 256-entry cap; an evicted image simply re-decodes on its next paint.
