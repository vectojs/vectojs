---
'@vectojs/core': patch
---

Reuse content-grid DOM carriers across revisions instead of rebuilding every line.

The grid projection called `replaceChildren()` and re-created one `<span>` per
cell whenever `grid.revision` changed. Streaming text bumps the revision on every
append, so a growing code block re-materialized its whole carrier grid each frame.
Each line now carries a signature of everything that determines its DOM and is
rebuilt only when that changes.

A streamed code block at 50 chunk/s now absorbs 94-98% of chunks, up from 64-66%;
`gridMaterialize` drops 4.8-16.5x. Also fixes a selection bug the old path had:
`clearContentGridState` released a selection on every revision bump, so selecting
text inside a still-streaming code block was impossible. Selection is now released
only when the line holding it is actually rebuilt.

Adds a `gridMaterialize` render phase.
