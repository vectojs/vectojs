---
"@vectojs/layout": minor
"@vectojs/text": minor
---

Fix the zero-GC buffer layout path dropping BiDi reordering and the mixed-size
baseline. `LayoutEngine.layoutPreparedIntoBuffer` (the per-frame path for large
dynamic scenes) wrote glyphs in **logical** order at a single paragraph
`fontSize`, so RTL text came out reversed and left-aligned, and mixed-size inline
runs were positioned at the raw line top instead of a shared baseline — both
already correct in the allocating `layoutPrepared`.

The buffer path now mirrors it: per-line slots are reordered to visual order
(UAX #9 L2) with the whole line flushed right for an RTL paragraph, and each
glyph keeps its own size as `height` with a `(lineMax - size) * 0.8` baseline
offset. A `levels` array on `LayoutResultBuffer` records each glyph's resolved
embedding level (so consumers can tell direction per glyph). A pure-LTR line —
the common hot path — skips the reorder entirely and stays allocation-free.

`BidiResolver.reorderSegments(str, levels, baseLevel)` is new: it exposes the L2
reversal segments so a caller holding parallel typed arrays can apply the same
permutation in place without allocating a node per glyph. `reorderVisual` now
delegates to it (behavior unchanged).
