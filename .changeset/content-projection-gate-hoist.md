---
"@vectojs/core": patch
---

Hoist the content-projection viewport gate above `getContentProjection()` in `Scene.syncContentProjection` (CTX-0024). Previously the projection was computed **unconditionally** for every block every synced frame and the viewport-virtualization gate ran afterward — since `getContentProjection()` is O(glyphs-in-block), a long or streaming document cost O(total document glyphs) per frame, the dominant driver of the streaming-into-Markdown FPS decay. The gate needs only the node/world-transform/margin, so it now runs first and off-viewport blocks cost O(1) (freed if already materialized, never projected otherwise).

Measured on real hardware (Chrome 150 + Firefox 153, `benchmarks/content-projection`): the gated per-frame sync stays flat as the document grows while the pre-fix path grows linearly — at 1600 blocks (~384k glyphs) the sync pass drops from 23.95 ms → 0.87 ms on Chrome (27.5×) and 16.54 ms → 0.56 ms on Firefox (29.5×). On-viewport rendering and selection are unchanged.
