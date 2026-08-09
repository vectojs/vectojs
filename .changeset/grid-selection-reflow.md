---
'@vectojs/core': patch
---

Keep a text selection alive when a projected grid reflows.

Resizing the window, changing the device pixel ratio, or zooming re-breaks every
line of a grid-projected block, so every carrier line is replaced even though the
selected characters are still on screen. The grid path released the selection
whenever the line holding it was rebuilt, which wiped a selection the user could
still see.

The selection is now snapshotted as offsets into `grid.source` — stable against
line breaking and against the windowed carrier range — and re-anchored after the
rebuild. When the selected text really did leave the projection (the window
scrolled past it) the offsets no longer resolve and the selection is still
released, so a `Range` is never left pointing into detached carriers.
