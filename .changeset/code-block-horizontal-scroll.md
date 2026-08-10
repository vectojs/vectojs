---
'@vectojs/markdown': minor
---

Make the tail of a long code line reachable

A fenced code block painted a long line straight through its own rounded
background and off the viewport edge, where it was hard-clipped. There was no
wrap and no horizontal scroll, so the tail of the line could not be reached by
any means — not by selection, not by scrolling, not by resizing. Measured in real
Chromium: **1016.984px** of a 161-cell line past a 360px box, roughly 3.8x the
box width.

`CodeBlock` now owns a horizontal scroll region:

- `render()` clips its glyphs to the block box, so nothing paints outside the
  background.
- A new `scrollX` / `maxScrollX` / `setScrollX()` API, clamped to the content.
- A wheel over the block scrolls it horizontally on **horizontal intent only** —
  a `deltaX` swipe, or `shift`+wheel for a mouse with no horizontal wheel. A plain
  vertical wheel belongs to the page, because a code block is an inline element in
  a scrolling document rather than a scroll container that owns its viewport.
  `ctrl`+wheel is left to browser zoom. `preventDefault` fires only when the
  offset actually changed, so a wheel at either end of travel still scrolls the
  page.

Overflow-not-wrap is unchanged, and so is the invariant `setWidth()` documents:
**`height` remains a function of line count alone**, and a width change still
rebuilds neither the grid nor the highlight. Code that is soft-wrapped instead was
considered and rejected — it would break that invariant and would re-wrap and
re-highlight a streamed block on every resize. See
`forge/decisions/code-block-overflow-2026-08.md`.

The scroll offset is consumed by the canvas painter and the DOM selection
carriers through one accessor in the same frame, so a scrolled block's native
selection stays over the glyphs it covers.

`CodeBlock` deliberately remains non-interactive: the wheel arrives through the
content-projection element it already has, so no accessibility node is created
that would stack above the transparent text mirror and swallow the mousedown that
starts a drag-selection.
