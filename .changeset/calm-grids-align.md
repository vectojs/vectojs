---
'@vectojs/core': minor
'@vectojs/ui': minor
---

Share one source-aware prepared grid between CodeBlock canvas paint and semantic DOM projection. Grid geometry now preserves UTF-16 source ranges, grapheme clusters, tab stops, wide CJK/emoji cells, Arabic shaping, and bidi visual positions while retaining exact native copy/find text.

Calibrate projected grapheme carriers after font loading so Firefox font substitution, DPR, CSS zoom, transforms, and forced colors keep selection geometry aligned without synchronous layout reads in the projection hot path. Text-selection routing now uses prepared local caret boundaries for ink and blank regions, preserves Shift/word/line/reverse selection semantics, cleans up rebuilds and lost mouse releases, and keeps structural Table semantics from intercepting selectable cell projections.

Deduplicate cold font samples and reuse each line's source segmentation. On the release workstation, the 80,000-input-cluster preparation mean fell from 247.16 ms to 65.08 ms for ASCII and from 265.88 ms to 77.77 ms for mixed Unicode. `@vectojs/ui` 1.9 requires `@vectojs/core` 1.8 or newer within the 1.x line.
