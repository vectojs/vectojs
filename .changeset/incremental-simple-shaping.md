---
'@vectojs/layout': patch
---

Add an incremental suffix-only shaping fast path to `LayoutEngine.prepareRich` for the streaming case: when a single simple-script paragraph (no RTL/Arabic/combining/emoji-sequence — see the new exported `isComplexScript`) grows by appending, its already-shaped prefix words are reused and only the new suffix is segmented/measured, instead of re-shaping the whole paragraph each call. This turns a growing paragraph's per-chunk shaping cost from O(length) into O(appended). Complex-script and multi-paragraph text fall through to the unchanged full shaper, so RTL/BiDi/Arabic output is byte-for-byte identical. Note: benefits pathological single huge paragraphs; realistic bounded-paragraph documents (each block a separate RichText) see little change since their per-block reshape is already small.
