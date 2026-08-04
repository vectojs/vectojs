---
"@vectojs/core": minor
"@vectojs/ui": minor
"@vectojs/markdown": minor
---

Add dirty-tracked content projection sync.

`Scene` re-derived every resident block's DOM text projection on every synced
frame, even when nothing had changed. Measured on a 1500-resident-block document
in real headed Chrome, a sync whose projected text was byte-identical before and
after still cost 17.875 ms, because `getContentProjection()` — an O(glyphs) build
— ran once per block and its result was re-diffed against the DOM.

`Entity.getContentEpoch()` is new, optional API: return a number that changes
whenever the entity's projected content changes, and `Scene` will skip the block
entirely — before the projection call — while both that epoch and the entity's
geometry are unchanged. The default returns `null`, which keeps the previous
behaviour exactly, so this is opt-in and no existing subclass is affected.

`Text`, `RichText`, `CodeBlock`, `TextEntity` and `MSDFTextEntity` now implement
it, so text-heavy and streaming scenes get the reduction without any code change.
Only the blocks that actually changed are re-projected; a streaming tail block
costs one rebuild instead of one per resident block.
