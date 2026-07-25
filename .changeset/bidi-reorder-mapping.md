---
"@vectojs/text": minor
---

Rewrite `BidiResolver` onto bidi-js's authoritative UAX #9 reorder and expose the source↔visual mapping selection needs.

- **Complete L1**: `reorderVisual` previously hand-rolled the L1 whitespace/segment-separator reset and only reset a single trailing-whitespace run (a known partial-L1 gap). It now delegates to bidi-js's `getReorderSegments`, so trailing whitespace, tabs, and segment separators inside a run are reset to the paragraph direction correctly. Behavior is unchanged for the LTR/RTL/mixed cases the existing tests and layout pipeline already covered (verified against the full text/layout/ui suites); a per-run reorder now provably agrees with a full-line reorder.
- **New source↔visual mapping API** (the primitive correct RTL/Arabic selection rectangles are built from): `BidiResolver.reorderIndices(text)` returns the visual-order→logical-index permutation, and `BidiResolver.logicalToVisualRuns(text, start, end)` maps a logical range to the merged, left-to-right set of contiguous VISUAL runs it occupies — a single run for pure LTR/RTL, and the visually-disjoint rectangles a bidi selection must paint when the range straddles a direction boundary (e.g. Latin digits inside RTL Arabic).
- `reorderVisual` is now generic over `{ char; level }` (accepts any layout-node array) and the `BidiNode` / `VisualRun` types are exported.
