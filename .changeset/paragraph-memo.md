---
'@vecto-ui/core': patch
---

Memoize `LayoutEngine.prepare()` at the paragraph level for fast incremental / streaming text.

`prepare()` rebuilt the whole `PreparedText` on every call, so streaming text (AI tokens, live logs) that re-prepares a growing string paid `O(document)` segmentation/measurement per update. Paragraphs are now memoized by `fontSize + text`, so unchanged paragraphs are reused by reference and only the changed one is rebuilt — per-update cost drops to `O(changed paragraph)`. The cache is invalidated when the font atlas changes, keeping glyph widths correct.
